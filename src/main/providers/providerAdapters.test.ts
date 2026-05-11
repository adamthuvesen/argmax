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

function launchInput(provider: "claude" | "codex"): ProviderLaunchInput {
  return {
    sessionId: "session-1",
    workspacePath: "/repo/worktree",
    prompt: "Implement the task",
    modelLabel: provider === "claude" ? "Claude Haiku" : "GPT-5.3 Codex Spark Low",
    modelId: provider === "claude" ? "haiku" : "gpt-5.3-codex-spark",
    reasoningEffort: provider === "codex" ? "low" : undefined,
    mode: "interactive-pty",
    cols: 100,
    rows: 30
  };
}
