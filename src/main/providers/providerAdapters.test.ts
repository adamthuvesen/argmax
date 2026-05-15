// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { IDisposable, IPty, IPtyForkOptions } from "node-pty";
import { describe, expect, it } from "vitest";
import { createProviderAdapters, type ProcessSpawner, type PtySpawner } from "./providerAdapters.js";
import type { ProviderDiscoveryRunner } from "./providerDiscovery.js";
import { providerShell } from "./providerEnvironment.js";
import type { ProviderEvent, ProviderLaunchInput } from "./providerTypes.js";

class FakePty implements IPty {
  readonly pid = 1234;
  readonly process = "fake-pty";
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  cols: number;
  rows: number;
  handleFlowControl = false;
  killed = false;

  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  readonly onData = (listener: (data: string) => void): IDisposable => {
    this.dataListeners.add(listener);
    return {
      dispose: () => this.dataListeners.delete(listener)
    };
  };

  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.exitListeners.add(listener);
    return {
      dispose: () => this.exitListeners.delete(listener)
    };
  };

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal });
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeCalls.push({ cols, rows });
  }

  write(data: string | Buffer): void {
    this.writes.push(data.toString());
  }

  kill(): void {
    this.killed = true;
  }

  clear(): void {}
  pause(): void {}
  resume(): void {}
}

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("provider PTY adapters", () => {
  it("launches Claude in a PTY from the selected workspace and emits output and successful exit events", async () => {
    const { adapters, ptys, spawnCalls } = createTestAdapters();
    const events: ProviderEvent[] = [];

    const handle = await adapters.get("claude")?.launch(launchInput("claude"), (event) => events.push(event));
    const pty = ptys[0];

    expect(handle?.provider).toBe("claude");
    expect(spawnCalls[0]).toMatchObject({
      file: providerShell(),
      args: ["-lc", "exec '/usr/local/bin/claude' '--model' 'haiku' '--permission-mode' 'bypassPermissions'"],
      cwd: "/repo/worktree",
      cols: 100,
      rows: 30
    });
    expect(pty.writes).toEqual(["Implement the task\r"]);

    pty.emitData("hello from claude");
    handle?.resize(120, 40);
    pty.emitExit(0);

    expect(pty.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
    expect(events.map((event) => event.type)).toEqual(["output", "exit"]);
    expect(events[0]).toMatchObject({ sessionId: "session-1", stream: "pty", message: "hello from claude" });
    expect(events[1]).toMatchObject({ sessionId: "session-1", stream: "system", exitCode: 0 });

    // Natural exit already disposed the handle; subsequent terminate() is a no-op.
    void handle?.terminate();
    expect(handle?.disposed).toBe(true);
  });

  it("strips ASCII control bytes from the launch prompt before writing to the PTY", async () => {
    const { adapters, ptys } = createTestAdapters();
    const input = launchInput("claude");
    // Prompt with embedded Ctrl-C (\x03), Ctrl-D (\x04), and an ESC sequence.
    // The ESC byte (\x1b) itself is what makes `[A` a "move-cursor-up" command;
    // stripping the ESC leaves only printable `[A` text, which is harmless.
    input.prompt = "Run\x03 the\x04 task\x1b[A";
    await adapters.get("claude")?.launch(input, () => undefined);
    const pty = ptys[0];
    expect(pty.writes).toEqual(["Run the task[A\r"]);
  });

  it("terminate() resolves only after the child actually exits", async () => {
    const { adapters, ptys } = createTestAdapters();
    const handle = await adapters.get("claude")?.launch(launchInput("claude"), () => undefined);
    const pty = ptys[0];
    expect(handle).toBeDefined();
    if (!handle) return;

    let resolved = false;
    const termPromise = handle.terminate().then(() => {
      resolved = true;
    });

    // SIGTERM has been requested but onExit hasn't fired yet — the promise
    // must not resolve until the underlying process actually exits.
    await Promise.resolve();
    expect(resolved).toBe(false);

    pty.emitExit(0);
    await termPromise;
    expect(resolved).toBe(true);

    // Idempotent re-entry: a second terminate returns the same resolved promise.
    await expect(handle.terminate()).resolves.toBeUndefined();
  });

  it("is idempotent on terminate and drops events after disposal", async () => {
    const { adapters, ptys } = createTestAdapters();
    const events: ProviderEvent[] = [];

    const handle = await adapters.get("claude")?.launch(launchInput("claude"), (event) => events.push(event));
    const pty = ptys[0];
    expect(handle).toBeDefined();
    if (!handle) return;

    void handle.terminate();
    expect(handle.disposed).toBe(true);
    expect(pty.killed).toBe(true);

    // Second terminate is a no-op; should not throw or re-kill.
    void handle.terminate();

    // Racing emissions after disposal are dropped.
    pty.emitData("late data");
    pty.emitExit(0);
    expect(events.length).toBe(0);
  });

  it("launches Codex in a PTY from the selected workspace", async () => {
    const { adapters, spawnCalls } = createTestAdapters();

    await adapters.get("codex")?.launch(launchInput("codex"), () => undefined);

    expect(spawnCalls[0]).toMatchObject({
      file: providerShell(),
      args: [
        "-lc",
        "exec '/usr/local/bin/codex' '--model' 'gpt-5.3-codex-spark' '-c' 'model_reasoning_effort=\"low\"' '--dangerously-bypass-approvals-and-sandbox'"
      ],
      cwd: "/repo/worktree"
    });
  });

  it("blocks launch with setup guidance when a provider binary is missing", async () => {
    const runner: ProviderDiscoveryRunner = {
      resolveBinary: () => Promise.resolve(null),
      readVersion: () => Promise.resolve(null)
    };
    const adapters = createProviderAdapters(runner, () => new FakePty(80, 24));

    await expect(adapters.get("codex")?.launch(launchInput("codex"), () => undefined)).rejects.toThrow("Codex CLI");
  });

  it("emits failed exit events for non-zero provider exits", async () => {
    const { adapters, ptys } = createTestAdapters();
    const events: ProviderEvent[] = [];

    await adapters.get("claude")?.launch(launchInput("claude"), (event) => events.push(event));
    ptys[0].emitExit(7);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      stream: "system",
      exitCode: 7,
      message: "Claude Code exited with code 7."
    });
  });

  it("drops the Claude bypass flag when permissionMode is ask-each-time", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();
    await adapters
      .get("claude")
      ?.launch({ ...launchInput("claude"), mode: "structured-json", permissionMode: "ask-each-time" }, () => undefined);
    processes[0].emit("exit", 0, null);

    const args = processSpawnCalls[0]?.args ?? [];
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("bypassPermissions");
  });

  it("drops the Codex bypass flag when permissionMode is ask-each-time", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();
    await adapters
      .get("codex")
      ?.launch({ ...launchInput("codex"), mode: "structured-json", permissionMode: "ask-each-time" }, () => undefined);
    processes[0].emit("exit", 0, null);

    const args = processSpawnCalls[0]?.args ?? [];
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("injects --append-system-prompt for Claude structured launches when reasoningEffort is high", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();
    await adapters
      .get("claude")
      ?.launch({ ...launchInput("claude"), mode: "structured-json", reasoningEffort: "high" }, () => undefined);
    processes[0].emit("exit", 0, null);

    const args = processSpawnCalls[0]?.args ?? [];
    expect(args).toContain("--append-system-prompt");
    const promptIndex = args.indexOf("--append-system-prompt");
    expect(args[promptIndex + 1]).toContain("Reason deeply");
  });

  it("injects --append-system-prompt for Claude interactive PTY launches when reasoningEffort is medium", async () => {
    const { adapters, ptys, spawnCalls } = createTestAdapters();
    await adapters
      .get("claude")
      ?.launch({ ...launchInput("claude"), reasoningEffort: "medium" }, () => undefined);
    ptys[0].emitExit(0);

    const command = spawnCalls[0]?.args[1] ?? "";
    expect(command).toContain("--append-system-prompt");
    expect(command).toContain("Reason carefully");
  });

  it("omits --append-system-prompt for Claude when no reasoningEffort is set", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();
    await adapters
      .get("claude")
      ?.launch({ ...launchInput("claude"), mode: "structured-json", reasoningEffort: undefined }, () => undefined);
    processes[0].emit("exit", 0, null);

    const args = processSpawnCalls[0]?.args ?? [];
    expect(args).not.toContain("--append-system-prompt");
  });

  it("launches Claude structured plan turns with Claude plan permissions", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();
    await adapters
      .get("claude")
      ?.launch({ ...launchInput("claude"), mode: "structured-json", agentMode: "plan" }, () => undefined);
    processes[0].emit("exit", 0, null);

    const args = processSpawnCalls[0]?.args ?? [];
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).not.toContain("bypassPermissions");
  });

  it("launches Claude structured probes with stream-json verbose output", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();
    const events: ProviderEvent[] = [];

    await adapters.get("claude")?.launch({ ...launchInput("claude"), mode: "structured-json" }, (event) =>
      events.push(event)
    );
    processes[0].stdout.write('{"type":"assistant","message":"done"}\n');
    processes[0].emit("exit", 0, null);

    expect(processSpawnCalls[0]).toMatchObject({
      file: "/usr/local/bin/claude",
      args: [
        "-p",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "haiku",
        "--session-id",
        "session-1",
        "--output-format",
        "stream-json",
        "--verbose",
        "Implement the task"
      ],
      cwd: "/repo/worktree"
    });
    expect(processes[0].stdin.writableEnded).toBe(true);
    expect(events.map((event) => event.stream)).toEqual(["stdout", "system"]);
    expect(events[1]).toMatchObject({ type: "exit", exitCode: 0 });
  });

  it("launches Codex structured probes with exec JSONL output", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();
    const events: ProviderEvent[] = [];

    await adapters.get("codex")?.launch({ ...launchInput("codex"), mode: "structured-json" }, (event) =>
      events.push(event)
    );
    processes[0].stderr.write("warning\n");
    processes[0].emit("exit", 1, null);

    expect(processSpawnCalls[0]).toMatchObject({
      file: "/usr/local/bin/codex",
      args: [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        "gpt-5.3-codex-spark",
        "-c",
        "model_reasoning_effort=\"low\"",
        "-c",
        "model_reasoning_summary=\"none\"",
        "-"
      ],
      cwd: "/repo/worktree"
    });
    expect(String(processes[0].stdin.read())).toBe("Implement the task");
    expect(processes[0].stdin.writableEnded).toBe(true);
    expect(events[0]).toMatchObject({ type: "output", stream: "stderr", message: "warning\n" });
    expect(events[1]).toMatchObject({ type: "error", exitCode: 1 });
  });

  it("sends Codex structured plan turns with a plan-only prompt prefix", async () => {
    const { adapters, processes } = createTestAdapters();

    await adapters
      .get("codex")
      ?.launch({ ...launchInput("codex"), mode: "structured-json", agentMode: "plan" }, () => undefined);
    processes[0].emit("exit", 0, null);

    const stdin = String(processes[0].stdin.read());
    expect(stdin).toContain("Plan mode:");
    expect(stdin).toContain("Implement the task");
  });

  it("resumes Claude structured sessions with the provider conversation id", async () => {
    const { adapters, processSpawnCalls } = createTestAdapters();

    await adapters.get("claude")?.launch(
      { ...launchInput("claude"), mode: "structured-json", resumeConversationId: "claude-session-1" },
      () => undefined
    );

    expect(processSpawnCalls[0]).toMatchObject({
      file: "/usr/local/bin/claude",
      args: [
        "-p",
        "--resume",
        "claude-session-1",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "haiku",
        "--output-format",
        "stream-json",
        "--verbose",
        "Implement the task"
      ],
      cwd: "/repo/worktree"
    });
  });

  it("launches Cursor structured probes with stream-json and bypass flags", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();

    await adapters.get("cursor")?.launch(launchInput("cursor"), () => undefined);
    processes[0].emit("exit", 0, null);

    expect(processSpawnCalls[0]).toMatchObject({
      file: "/usr/local/bin/cursor-agent",
      args: [
        "agent",
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--force",
        "--trust",
        "--model",
        "composer-2",
        "Implement the task"
      ],
      cwd: "/repo/worktree"
    });
    // Prompt is passed as positional arg, not via stdin.
    expect(processes[0].stdin.writableEnded).toBe(true);
  });

  it("launches Cursor structured plan turns with --plan", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();

    await adapters.get("cursor")?.launch({ ...launchInput("cursor"), agentMode: "plan" }, () => undefined);
    processes[0].emit("exit", 0, null);

    expect(processSpawnCalls[0]?.args).toContain("--plan");
  });

  it("drops the Cursor bypass flags when permissionMode is ask-each-time", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();
    await adapters
      .get("cursor")
      ?.launch({ ...launchInput("cursor"), permissionMode: "ask-each-time" }, () => undefined);
    processes[0].emit("exit", 0, null);

    const args = processSpawnCalls[0]?.args ?? [];
    expect(args).not.toContain("--force");
    expect(args).not.toContain("--trust");
  });

  it("resumes Cursor structured sessions with --resume <session_id>", async () => {
    const { adapters, processSpawnCalls } = createTestAdapters();

    await adapters
      .get("cursor")
      ?.launch({ ...launchInput("cursor"), resumeConversationId: "cursor-chat-123" }, () => undefined);

    expect(processSpawnCalls[0]).toMatchObject({
      file: "/usr/local/bin/cursor-agent",
      args: [
        "agent",
        "-p",
        "--resume",
        "cursor-chat-123",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--force",
        "--trust",
        "--model",
        "composer-2",
        "Implement the task"
      ],
      cwd: "/repo/worktree"
    });
  });

  it("rejects Cursor interactive launches with a clear error", async () => {
    const { adapters } = createTestAdapters();
    await expect(
      adapters.get("cursor")?.launch({ ...launchInput("cursor"), mode: "interactive-pty" }, () => undefined)
    ).rejects.toThrow("Cursor interactive mode");
  });

  it("resumes Codex structured sessions with the provider conversation id", async () => {
    const { adapters, processes, processSpawnCalls } = createTestAdapters();

    await adapters.get("codex")?.launch(
      { ...launchInput("codex"), mode: "structured-json", resumeConversationId: "thread-1" },
      () => undefined
    );

    expect(processSpawnCalls[0]).toMatchObject({
      file: "/usr/local/bin/codex",
      args: [
        "exec",
        "resume",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        "gpt-5.3-codex-spark",
        "-c",
        "model_reasoning_effort=\"low\"",
        "-c",
        "model_reasoning_summary=\"none\"",
        "thread-1",
        "-"
      ],
      cwd: "/repo/worktree"
    });
    expect(String(processes[0].stdin.read())).toBe("Implement the task");
  });
});

function createTestAdapters(): {
  adapters: ReturnType<typeof createProviderAdapters>;
  ptys: FakePty[];
  processes: FakeProcess[];
  spawnCalls: Array<{ file: string; args: string[]; cwd: string | undefined; cols: number | undefined; rows: number | undefined }>;
  processSpawnCalls: Array<{ file: string; args: string[]; cwd: string | undefined }>;
} {
  const runner: ProviderDiscoveryRunner = {
    resolveBinary: (binaryName) => Promise.resolve(`/usr/local/bin/${binaryName}`),
    readVersion: () => Promise.resolve("1.2.3")
  };
  const ptys: FakePty[] = [];
  const processes: FakeProcess[] = [];
  const spawnCalls: Array<{ file: string; args: string[]; cwd: string | undefined; cols: number | undefined; rows: number | undefined }> = [];
  const processSpawnCalls: Array<{ file: string; args: string[]; cwd: string | undefined }> = [];
  const spawnPty: PtySpawner = (file: string, args: string[], options: IPtyForkOptions) => {
    spawnCalls.push({ file, args, cwd: options.cwd, cols: options.cols, rows: options.rows });
    const pty = new FakePty(options.cols ?? 80, options.rows ?? 24);
    ptys.push(pty);
    return pty;
  };
  const spawnStructuredProcess: ProcessSpawner = (file, args, options) => {
    processSpawnCalls.push({ file, args, cwd: options.cwd?.toString() });
    const childProcess = new FakeProcess();
    processes.push(childProcess);
    return childProcess as unknown as ChildProcessWithoutNullStreams;
  };

  return {
    adapters: createProviderAdapters(runner, spawnPty, spawnStructuredProcess),
    ptys,
    processes,
    spawnCalls,
    processSpawnCalls
  };
}

function launchInput(provider: "claude" | "codex" | "cursor"): ProviderLaunchInput {
  const modelLabel =
    provider === "claude"
      ? "Claude Haiku"
      : provider === "cursor"
        ? "Cursor Composer 2"
        : "GPT-5.3 Codex Spark Low";
  const modelId =
    provider === "claude" ? "haiku" : provider === "cursor" ? "composer-2" : "gpt-5.3-codex-spark";
  return {
    sessionId: "session-1",
    workspacePath: "/repo/worktree",
    prompt: "Implement the task",
    modelLabel,
    modelId,
    reasoningEffort: provider === "codex" ? "low" : undefined,
    mode: provider === "cursor" ? "structured-json" : "interactive-pty",
    permissionMode: "auto-approve",
    agentMode: "edit",
    cols: 100,
    rows: 30
  };
}
