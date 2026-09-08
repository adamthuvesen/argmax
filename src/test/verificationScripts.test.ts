import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { parseDoctorArgs } from "../../scripts/doctor.mjs";
import { parseScratchArgs } from "../../scripts/scratch-app.mjs";
import { parseVerifyArgs } from "../../scripts/verify.mjs";
import { checkoutFingerprint, runChecked } from "../../scripts/verification/common.mjs";
import { redact } from "../../scripts/verification/evidence.mjs";

const temporaryDirectories: string[] = [];
const fixture = fileURLToPath(new URL("../../scripts/verification/provider-fixture.mjs", import.meta.url));
const fixtureEnvironment = {
  ...process.env,
  ARGMAX_VERIFICATION_LOG: "",
  ARGMAX_VERIFICATION_CONTROL_DIR: "",
};

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not receive a TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

it("initializes the Claude fixture and reads its prompt without waiting for stdin EOF", async () => {
  const child = spawn(process.execPath, [fixture, "-p", "--input-format", "stream-json", "--permission-prompt-tool", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: fixtureEnvironment,
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const timeout = setTimeout(() => child.kill(), 2500);
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  let initialized = false;
  let emittedSystemInit = false;
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  try {
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "argmax-initialize", request: { subtype: "initialize", hooks: null } })}\n`);
    for await (const line of lines) {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === "control_response") {
        expect(message.response).toMatchObject({ subtype: "success", request_id: "argmax-initialize" });
        initialized = true;
        child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "[argmax-verification:provider-error]" } })}\n`);
      } else if (message.type === "system" && message.subtype === "init") {
        emittedSystemInit = true;
      }
    }
    const code = await exited;
    expect(initialized).toBe(true);
    expect(emittedSystemInit).toBe(true);
    expect(code).toBe(42);
    expect(stderr).toContain("Verification provider failed as requested.");
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.kill();
    await exited;
  }
}, 3000);

it("serves Codex app-server events while stdin remains open", async () => {
  const child = spawn(process.execPath, [fixture, "app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: fixtureEnvironment,
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const timeout = setTimeout(() => child.kill(), 3000);
  const lines = createInterface({ input: child.stdout });
  const messages: Array<Record<string, unknown>> = [];
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/start", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId: "argmax-verification-conversation",
        input: [{ type: "text", text: "[argmax-verification:persistent-codex-subagent:first]" }],
      },
    })}\n`);
    for await (const line of lines) {
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      if (message.method === "turn/completed") break;
    }
    expect(child.exitCode).toBeNull();
    const payload = JSON.stringify(messages);
    expect(payload).toContain('"id":1,"result"');
    expect(payload).toContain('"tool":"spawnAgent"');
    expect(payload).toContain('"tool":"wait"');
    expect(payload).toContain('"status":"pendingInit"');
    expect(payload).toContain('"019f2214-c736-7f60-bb78-75b6ecff57a3":{"status":"completed"');
    expect(payload).toContain("Verification persistent Codex child first response.");
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.kill();
    await exited;
  }
}, 4000);

it("serves OpenCode task events over authenticated HTTP and SSE", async () => {
  const port = await availablePort();
  const username = "verification-user";
  const password = "verification-password";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const child = spawn(process.execPath, [fixture, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "ERROR"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...fixtureEnvironment, OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password },
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const timeout = setTimeout(() => child.kill(), 4000);
  const headers = { Authorization: authorization, "Content-Type": "application/json" };
  try {
    let health: Response | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        health = await fetch(`http://127.0.0.1:${port}/global/health`, { headers });
        if (health.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(health?.ok).toBe(true);
    const events = await fetch(`http://127.0.0.1:${port}/event`, { headers });
    expect(events.ok).toBe(true);
    const session = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(await session.json()).toEqual({ id: "argmax-verification-conversation" });
    const prompt = await fetch(`http://127.0.0.1:${port}/session/argmax-verification-conversation/prompt_async`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parts: [{ type: "text", text: "[argmax-verification:persistent-opencode-subagent:first]" }] }),
    });
    expect(await prompt.json()).toBe(true);

    const reader = events.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let payload = "";
    while (!payload.includes('"session.status"')) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      payload += decoder.decode(chunk.value, { stream: true });
    }
    await reader!.cancel();
    expect(child.exitCode).toBeNull();
    expect(payload).toContain('"server.connected"');
    expect(payload).toContain('"tool":"task"');
    expect(payload).toContain("Verification persistent OpenCode child first response.");
    expect(payload).toContain('"type":"idle"');
  } finally {
    clearTimeout(timeout);
    child.kill();
    await exited;
  }
}, 5000);

it("serves Cursor task lifecycle events through ACP", async () => {
  const child = spawn(process.execPath, [fixture, "--force", "acp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: fixtureEnvironment,
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const timeout = setTimeout(() => child.kill(), 3000);
  const lines = createInterface({ input: child.stdout });
  const messages: Array<Record<string, unknown>> = [];
  try {
    for (const request of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "session/new", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "argmax-verification-conversation",
          prompt: [{ type: "text", text: "[argmax-verification:persistent-cursor-subagent:first]" }],
        },
      },
    ]) child.stdin.write(`${JSON.stringify(request)}\n`);

    for await (const line of lines) {
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      if (message.id === 3) break;
    }
    expect(child.exitCode).toBeNull();
    const payload = JSON.stringify(messages);
    expect(payload).toContain('"sessionUpdate":"tool_call"');
    expect(payload).toContain('"_toolName":"task"');
    expect(payload).toContain('"agentId":"f29e3566-30af-4903-b054-b382fa3754e4"');
    expect(payload).toContain('"sessionUpdate":"tool_call_update"');
    expect(payload).toContain('"rawOutput":{"success"');
    expect(payload).toContain('"agentId":"077b8dfb-bb6b-4603-b718-b0ffa9808ef2"');
    expect(payload).toContain('"id":3,"result":{"stopReason":"end_turn"}');
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.kill();
    await exited;
  }
}, 4000);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("verification script arguments", () => {
  it("defaults to the deterministic resume scenario with required native verification", () => {
    expect(parseVerifyArgs([])).toMatchObject({
      scenario: "chat-resume",
      native: "required",
      keep: false,
    });
  });

  it("rejects unknown scenarios and invalid scratch ports", () => {
    expect(() => parseVerifyArgs(["--scenario", "live-provider"])).toThrow(/scenario/);
    expect(parseVerifyArgs(["--scenario", "persistent-subagent", "--native", "off"])).toMatchObject({
      scenario: "persistent-subagent",
      native: "off",
    });
    expect(parseVerifyArgs(["--scenario", "persistent-codex-subagent", "--native", "off"])).toMatchObject({
      scenario: "persistent-codex-subagent",
      native: "off",
    });
    expect(parseVerifyArgs(["--scenario", "persistent-opencode-subagent", "--native", "off"])).toMatchObject({
      scenario: "persistent-opencode-subagent",
      native: "off",
    });
    expect(parseVerifyArgs(["--scenario", "persistent-cursor-subagent", "--native", "off"])).toMatchObject({
      scenario: "persistent-cursor-subagent",
      native: "off",
    });
    expect(() => parseVerifyArgs(["--out"])).toThrow(/requires a value/);
    expect(() => parseScratchArgs(["--port", "70000"])).toThrow(/between 1 and 65535/);
    expect(() => parseScratchArgs(["--data-dir"])).toThrow(/requires a value/);
    expect(() => parseDoctorArgs(["--out"])).toThrow(/requires a value/);
  });

  it("parses explicit evidence destinations", () => {
    expect(parseDoctorArgs(["--out", "scratch/doctor.json"])).toEqual({ output: "scratch/doctor.json" });
  });
});

describe("verification evidence", () => {
  it("redacts nested credentials, bearer values, and pairing tokens", () => {
    expect(
      redact({
        token: "pairing-token",
        nested: { apiKey: "provider-key" },
        message: 'Authorization: Bearer abc.def and http://localhost/#token=secret {"ARGMAX_SESSION_CONTROL_TOKEN":"control-secret"} {\\"ARGMAX_SESSION_LAUNCH_TOKEN\\":\\"escaped-secret\\"}',
      }),
    ).toEqual({
      token: "[redacted]",
      nested: { apiKey: "[redacted]" },
      message: 'Authorization: Bearer [redacted] and http://localhost/#token=[redacted] {"ARGMAX_SESSION_CONTROL_TOKEN":"[redacted]"} {\\"ARGMAX_SESSION_LAUNCH_TOKEN\\":\\"[redacted]\\"}',
    });
  });

  it("fingerprints untracked content and symlink identity without following the target", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "argmax-fingerprint-test-"));
    temporaryDirectories.push(repository);
    await runChecked("git", ["init", "-q"], { cwd: repository });
    await writeFile(path.join(repository, "tracked.txt"), "one\n");
    await runChecked("git", ["add", "tracked.txt"], { cwd: repository });
    await runChecked("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture"], {
      cwd: repository,
    });
    const first = await checkoutFingerprint(repository);

    await writeFile(path.join(repository, "untracked.txt"), "two\n");
    const second = await checkoutFingerprint(repository);
    expect(second.sha256).not.toBe(first.sha256);

    await symlink("missing-outside-target", path.join(repository, "link"));
    const third = await checkoutFingerprint(repository);
    expect(third.sha256).not.toBe(second.sha256);
  });
});
