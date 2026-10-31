import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sessionId = `agent-hooks-test-${process.pid}`;
const tempRoot = mkdtempSync(path.join(tmpdir(), "argmax-hook-test-"));

function runHook(name: string, input: unknown) {
  return spawnSync("node", [`scripts/agent-hooks/${name}.mjs`], {
    cwd: ROOT,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tempRoot }
  });
}

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("agent hooks", () => {
  it.each([
    ["Claude Code", { tool_name: "Edit", tool_input: { file_path: path.join(ROOT, "src/shared/ipcSchemas.ts") } }],
    [
      "Codex",
      { tool_name: "apply_patch", cwd: ROOT, tool_input: { command: "*** Begin Patch\n*** Update File: src/shared/ipcSchemas.ts\n" } }
    ]
  ])("refuses a generated file from %s and names the generator", (_client, input) => {
    const result = runHook("pre-tool-use", input);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("npm run generate:bindings");
  });

  it.each([
    "git add -A",
    "git add .",
    "git add -- .",
    "git add -u",
    "git stash",
    "git stash pop",
    "git checkout .",
    "git checkout -- src/a.ts",
    "git checkout HEAD -- src/a.ts",
    "git restore src/a.ts",
    "git -C . restore .",
    "git restore --staged --worktree .",
    "cd src && git add -A"
  ])(
    "refuses %s",
    (command) => {
      expect(runHook("pre-tool-use", { tool_name: "Bash", tool_input: { command } }).status).toBe(2);
    }
  );

  it.each([
    "git add src/a.ts",
    "git restore --staged src/a.ts",
    "git restore -S src/a.ts",
    "git status",
    "git stash list",
    "git checkout main",
    "git checkout -b feature",
    'git commit -m "docs: never run git add -A"'
  ])("allows %s", (command) => {
    expect(runHook("pre-tool-use", { tool_name: "Bash", tool_input: { command } }).status).toBe(0);
  });

  it("does not read a patch's text as a command", () => {
    const command = "*** Begin Patch\n*** Update File: docs/testing.md\n+Do not run git stash.\n";
    expect(runHook("pre-tool-use", { tool_name: "apply_patch", cwd: ROOT, tool_input: { command } }).status).toBe(0);
  });

  it("gives the subsystem rule once per session after an edit", () => {
    const input = {
      session_id: sessionId,
      tool_name: "Edit",
      tool_input: { file_path: path.join(ROOT, "src-tauri/src/routing/table.rs") }
    };
    const first = JSON.parse(runHook("post-tool-use", input).stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(first.hookSpecificOutput.additionalContext).toContain("docs/routing.md");
    expect(runHook("post-tool-use", input).stdout).toBe("");
  });

  it("reports a lint failure at turn end", () => {
    const sourceName = `zzAgentHookLint${process.pid}.ts`;
    const source = path.join(ROOT, "src/renderer/lib", sourceName);
    const stopSession = `${sessionId}-lint`;
    writeFileSync(source, "export const id = crypto.randomUUID();\n");
    try {
      runHook("post-tool-use", { session_id: stopSession, tool_name: "Write", tool_input: { file_path: source } });
      const blocked = JSON.parse(runHook("stop", { session_id: stopSession }).stdout) as { reason: string };
      expect(blocked.reason).toContain("no-restricted-properties");
    } finally {
      if (existsSync(source)) rmSync(source);
    }
  }, 120_000);

  it("sends the agent back when a file it edited fails, and lets a second stop pass", () => {
    const sourceName = `zzAgentHookFixture${process.pid}.ts`;
    const source = path.join(ROOT, "src/renderer/lib", sourceName);
    const stopSession = `${sessionId}-stop`;
    writeFileSync(source, "export const broken: number = 'text';\n");
    try {
      runHook("post-tool-use", { session_id: stopSession, tool_name: "Write", tool_input: { file_path: source } });
      const blocked = JSON.parse(runHook("stop", { session_id: stopSession }).stdout) as { decision: string; reason: string };
      expect(blocked.decision).toBe("block");
      expect(blocked.reason).toContain(sourceName);
      expect(runHook("stop", { session_id: stopSession, stop_hook_active: true }).stdout).toBe("");
      expect(runHook("stop", { session_id: stopSession }).stdout).toBe("");
    } finally {
      if (existsSync(source)) rmSync(source);
    }
  }, 120_000);
});
