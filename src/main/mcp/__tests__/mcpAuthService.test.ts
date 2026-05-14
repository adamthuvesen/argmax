// @vitest-environment node
import type { IDisposable, IPty, IPtyForkOptions } from "node-pty";
import { describe, expect, it } from "vitest";
import { McpAuthService, type McpAuthBroadcaster, type McpAuthPtySpawner } from "../mcpAuthService.js";
import type { McpAuthDataEvent, McpAuthExitEvent } from "../../../shared/types.js";

class FakePty implements IPty {
  readonly pid = 9999;
  readonly process = "fake-claude";
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
    return { dispose: () => this.dataListeners.delete(listener) };
  };

  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };

  emitData(data: string): void {
    for (const l of this.dataListeners) l(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const l of this.exitListeners) l({ exitCode, signal });
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

function setup(options: { resolveBinary?: () => Promise<string | null> } = {}) {
  const ptys: FakePty[] = [];
  const spawnCalls: Array<{ file: string; args: string[]; options: IPtyForkOptions }> = [];
  const spawnPty: McpAuthPtySpawner = (file, args, options) => {
    spawnCalls.push({ file, args, options });
    const pty = new FakePty(options.cols ?? 80, options.rows ?? 24);
    ptys.push(pty);
    return pty;
  };

  const dataEvents: McpAuthDataEvent[] = [];
  const exitEvents: McpAuthExitEvent[] = [];
  const broadcaster: McpAuthBroadcaster = {
    emitData: (event) => dataEvents.push(event),
    emitExit: (event) => exitEvents.push(event)
  };

  const service = new McpAuthService(broadcaster, {
    resolveBinary: options.resolveBinary ?? (() => Promise.resolve("/usr/local/bin/claude")),
    spawnPty
  });

  return { service, ptys, spawnCalls, dataEvents, exitEvents };
}

describe("McpAuthService", () => {
  it("spawns claude in the user's home dir and broadcasts data + exit", async () => {
    const { service, ptys, spawnCalls, dataEvents, exitEvents } = setup();

    const { sessionId } = await service.start({ cols: 100, rows: 30 });
    expect(sessionId).toBeTruthy();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].file).toBe("/usr/local/bin/claude");
    expect(spawnCalls[0].args).toEqual([]);
    expect(spawnCalls[0].options.cols).toBe(100);
    expect(spawnCalls[0].options.rows).toBe(30);
    expect(spawnCalls[0].options.name).toBe("xterm-256color");
    // cwd must be the user's home so Claude reads the global ~/.claude.json
    expect(spawnCalls[0].options.cwd).toBeTruthy();

    const pty = ptys[0];
    pty.emitData("hello\n");
    expect(dataEvents).toEqual([{ sessionId, data: "hello\n" }]);

    pty.emitExit(0);
    expect(exitEvents).toEqual([{ sessionId, exitCode: 0, signal: null }]);
    expect(service.liveCount()).toBe(0);
  });

  it("auto-types `/mcp\\r` exactly once after the first onData chunk", async () => {
    const { service, ptys } = setup();
    await service.start({ cols: 80, rows: 24 });
    const pty = ptys[0];

    expect(pty.writes).toEqual([]);
    pty.emitData("Welcome to Claude.\n");
    expect(pty.writes).toEqual(["/mcp\r"]);

    // Subsequent data chunks must not re-prime.
    pty.emitData("more output\n");
    pty.emitData("even more\n");
    expect(pty.writes).toEqual(["/mcp\r"]);
  });

  it("throws a clear error when the claude binary is not installed", async () => {
    const { service } = setup({ resolveBinary: () => Promise.resolve(null) });

    await expect(service.start({ cols: 80, rows: 24 })).rejects.toThrow(/Claude Code is not installed/);
    expect(service.liveCount()).toBe(0);
  });

  it("delegates write/resize/terminate to the right pty", async () => {
    const { service, ptys } = setup();
    const a = (await service.start({ cols: 80, rows: 24 })).sessionId;
    const b = (await service.start({ cols: 80, rows: 24 })).sessionId;

    service.write({ sessionId: a, data: "hello" });
    service.resize({ sessionId: b, cols: 120, rows: 40 });

    expect(ptys[0].writes).toContain("hello");
    expect(ptys[1].resizeCalls).toEqual([{ cols: 120, rows: 40 }]);

    service.terminate(a);
    expect(ptys[0].killed).toBe(true);
  });

  it("ignores write/resize/terminate for unknown ids without throwing", () => {
    const { service } = setup();
    expect(() => service.write({ sessionId: "ghost", data: "x" })).not.toThrow();
    expect(() => service.resize({ sessionId: "ghost", cols: 80, rows: 24 })).not.toThrow();
    expect(() => service.terminate("ghost")).not.toThrow();
  });

  it("disposeAll kills every live pty and empties the registry", async () => {
    const { service, ptys } = setup();
    await service.start({ cols: 80, rows: 24 });
    await service.start({ cols: 80, rows: 24 });
    expect(service.liveCount()).toBe(2);
    service.disposeAll();
    expect(ptys.every((p) => p.killed)).toBe(true);
    expect(service.liveCount()).toBe(0);
  });

  it("preserves the signal number on exit when available", async () => {
    const { service, ptys, exitEvents } = setup();
    const { sessionId } = await service.start({ cols: 80, rows: 24 });
    ptys[0].emitExit(137, 9);
    expect(exitEvents).toEqual([{ sessionId, exitCode: 137, signal: 9 }]);
  });
});
