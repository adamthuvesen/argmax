// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  ipcSchemas,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import { REGISTERED_IPC_CHANNELS, withValidation } from "../ipc.js";
import type { registerIpcHandlers as RegisterIpcHandlersFn } from "../ipc.js";

/**
 * Each registered channel must have a corresponding schema in
 * `ipcSchemas`. New channels added to `registerIpcHandlers` will fail this
 * test until a schema entry is added — the failing scaffold required by 8.6.
 */
describe("IPC channel schema coverage", () => {
  it("registers a schema for every channel in REGISTERED_IPC_CHANNELS", () => {
    const schemaKeys = new Set(Object.keys(ipcSchemas));
    const missing = REGISTERED_IPC_CHANNELS.filter((channel) => !schemaKeys.has(channel));
    expect(missing).toEqual([]);
  });

  it("registers a channel for every schema entry", () => {
    const channelSet = new Set(REGISTERED_IPC_CHANNELS);
    const orphans = (Object.keys(ipcSchemas) as IpcChannel[]).filter((channel) => !channelSet.has(channel));
    expect(orphans).toEqual([]);
  });
});

/**
 * SPEC P6.04 — tighten the contract beyond "schema exists by name." Walk the
 * preload bridge source for every `ipcRenderer.invoke("channel-name", …)`
 * call and assert that name appears in `REGISTERED_IPC_CHANNELS`. A new
 * registered channel that nobody added a preload method for would otherwise
 * remain silently uncallable from the renderer.
 */
describe("IPC preload coverage", () => {
  it("every channel invoked by preload is registered + schema-backed", () => {
    const preloadSource = readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../../main/preload.ts"),
      "utf8"
    );
    const matches = preloadSource.matchAll(/ipcRenderer\.invoke\(\s*["']([^"']+)["']/g);
    const invokedChannels = new Set<string>();
    for (const match of matches) {
      if (match[1]) invokedChannels.add(match[1]);
    }
    // The preload's push-only event channels (`dashboard:delta`, `terminal:*`,
    // `menu:command`) are subscribed via `ipcRenderer.on`, not invoke — so
    // they don't land in this set and don't belong in REGISTERED_IPC_CHANNELS.
    const registeredSet = new Set<string>(REGISTERED_IPC_CHANNELS);
    const unregistered = [...invokedChannels].filter((channel) => !registeredSet.has(channel));
    expect(unregistered).toEqual([]);
  });
});

/**
 * The withValidation adapter is what guarantees that every payload-bearing
 * handler rejects bad inputs with a structured `INVALID_INPUT` error before
 * the service is ever invoked. Tests below exercise that contract per channel.
 */
describe("withValidation", () => {
  it("rejects malformed input with code=INVALID_INPUT and zod issues", async () => {
    const handler = withValidation(ipcSchemas["projects:register"], () => {
      throw new Error("service should not be invoked");
    });
    await expect(handler(null, { repoPath: 42 })).rejects.toMatchObject({
      message: "INVALID_INPUT",
      code: "INVALID_INPUT"
    });
  });

  it("does not invoke the service when validation fails", async () => {
    let invoked = false;
    const handler = withValidation(ipcSchemas["providers:resize"], () => {
      invoked = true;
      return { ok: true };
    });
    await expect(handler(null, { sessionId: "", cols: -1, rows: 0 })).rejects.toBeInstanceOf(Error);
    expect(invoked).toBe(false);
  });

  it("forwards parsed input to the service when validation passes", async () => {
    let received: unknown;
    const handler = withValidation(ipcSchemas["providers:resize"], (input) => {
      received = input;
      return { ok: true } as const;
    });
    const result = await handler(null, { sessionId: "session-1", cols: 120, rows: 40 });
    expect(result).toEqual({ ok: true });
    expect(received).toEqual({ sessionId: "session-1", cols: 120, rows: 40 });
  });

  it("preserves zod issues on the thrown error so the renderer can render them", async () => {
    const handler = withValidation(ipcSchemas["providers:send-input"], () => ({ ok: true }) as const);
    try {
      await handler(null, { sessionId: "", input: "" });
      expect.fail("expected validation rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const issues = (error as { issues?: unknown }).issues;
      expect(Array.isArray(issues)).toBe(true);
      // The original ZodError is wrapped, but its issues survive on the new error.
      expect(issues).not.toEqual([]);
    }
  });

  it("does not re-wrap non-Zod errors thrown during parse", async () => {
    const buggySchema = {
      parse: () => {
        throw new RangeError("synthetic non-zod error");
      }
    } as unknown as (typeof ipcSchemas)["projects:register"];
    const handler = withValidation(buggySchema, () => {
      throw new Error("service should not be invoked");
    });
    await expect(handler(null, {})).rejects.toBeInstanceOf(RangeError);
  });
});

/**
 * Spot-check rejection rules per channel. We use the schema directly here
 * since `ipcMain.handle` is electron-only; the renderer-bound contract is
 * "structured INVALID_INPUT rejection" and that's covered above. These
 * channel-by-channel cases verify the rejection rules from 1.7 are wired in.
 */
describe("IPC channel rejection rules", () => {
  it("rejects providers:launch prompts containing newlines", () => {
    const result = ipcSchemas["providers:launch"].safeParse({
      sessionId: "session-1",
      provider: "claude",
      prompt: "first line\nsecond line",
      workspacePath: "/tmp/work",
      cols: 80,
      rows: 24
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("rejects review:load-diff filePath that escapes the workspace", () => {
    const result = ipcSchemas["review:load-diff"].safeParse([
      "00000000-0000-0000-0000-000000000000",
      "../escape.txt"
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects review:load-diff filePath with a leading dash", () => {
    const result = ipcSchemas["review:load-diff"].safeParse([
      "00000000-0000-0000-0000-000000000000",
      "-rf"
    ]);
    expect(result.success).toBe(false);
  });

  it("accepts review:load-diff with a relative filePath", () => {
    const result = ipcSchemas["review:load-diff"].safeParse([
      "00000000-0000-0000-0000-000000000000",
      "src/main/index.ts"
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts review:load-diff with an undefined filePath (full diff)", () => {
    // Renderer invokes IPC positionally, so undefined filePath surfaces as the
    // second tuple slot rather than a missing position.
    const result = ipcSchemas["review:load-diff"].safeParse([
      "00000000-0000-0000-0000-000000000000",
      undefined
    ]);
    expect(result.success).toBe(true);
  });
});

/**
 * Audit-2026-05-11 argv-injection guard: the projects:switch-branch handler
 * must pass the user-controlled branch ref followed by `--` so git cannot
 * mistake the value for a flag or pathspec. The zod schema rejects leading
 * dashes; this test is the defense-in-depth check on the runtime call shape.
 */
describe("projects:switch-branch invokes git with the `--` argv separator", () => {
  let captured: Array<{ channel: string; handler: (event: unknown, ...args: unknown[]) => unknown }>;
  let gitCalls: Array<{ cwd: string; args: string[] }>;
  let registerIpcHandlers: typeof RegisterIpcHandlersFn;

  beforeEach(async () => {
    captured = [];
    gitCalls = [];

    vi.resetModules();

    vi.doMock("electron", () => ({
      app: { getPath: () => "/tmp" },
      dialog: {},
      ipcMain: {
        handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
          captured.push({ channel, handler });
        }
      },
      shell: {}
    }));

    vi.doMock("../git/exec.js", () => ({
      runGitText: vi.fn((cwd: string, args: string[]) => {
        gitCalls.push({ cwd, args });
        return Promise.resolve("");
      }),
      runGitMaybe: vi.fn(() => Promise.resolve("")),
      runGitBuffer: vi.fn(() => Promise.resolve(Buffer.alloc(0)))
    }));

    registerIpcHandlers = (await import("../ipc.js")).registerIpcHandlers;
  });

  afterEach(() => {
    vi.doUnmock("electron");
    vi.doUnmock("../git/exec.js");
  });

  it("appends `--` after the validated branch ref", async () => {
    const stubDatabase = {
      getProject: () => ({ repoPath: "/tmp/repo" }),
      updateProjectBranch: (_projectId: string, branch: string) => ({ id: _projectId, currentBranch: branch })
    } as unknown as Parameters<typeof registerIpcHandlers>[0];
    const stubProviders = {} as unknown as Parameters<typeof registerIpcHandlers>[1];
    const stubTerminals = {} as unknown as Parameters<typeof registerIpcHandlers>[2];
    const stubMcpAuth = {} as unknown as Parameters<typeof registerIpcHandlers>[3];

    registerIpcHandlers(stubDatabase, stubProviders, stubTerminals, stubMcpAuth);

    const entry = captured.find((c) => c.channel === "projects:switch-branch");
    expect(entry).toBeDefined();
    await entry!.handler(null, { projectId: "p-1", branch: "feature/foo" });

    const checkout = gitCalls.find((c) => c.args[0] === "checkout");
    expect(checkout).toBeDefined();
    expect(checkout!.args).toEqual(["checkout", "feature/foo", "--"]);
  });

  it("returns the actual ipcMain.handle registrations, not the schema-derived list (audit-2026-05-14 M15)", () => {
    const stubDatabase = {} as unknown as Parameters<typeof registerIpcHandlers>[0];
    const stubProviders = {} as unknown as Parameters<typeof registerIpcHandlers>[1];
    const stubTerminals = {} as unknown as Parameters<typeof registerIpcHandlers>[2];
    const stubMcpAuth = {} as unknown as Parameters<typeof registerIpcHandlers>[3];

    const registered = registerIpcHandlers(stubDatabase, stubProviders, stubTerminals, stubMcpAuth);

    expect(registered).toEqual(captured.map((entry) => entry.channel));
    expect(new Set(registered)).toEqual(new Set(REGISTERED_IPC_CHANNELS));
  });
});
