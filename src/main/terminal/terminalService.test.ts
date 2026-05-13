// @vitest-environment node
import type { IDisposable, IPty, IPtyForkOptions } from "node-pty";
import { describe, expect, it } from "vitest";
import { TerminalService, type TerminalBroadcaster, type TerminalPtySpawner } from "./terminalService.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { TerminalDataEvent, TerminalExitEvent } from "../../shared/types.js";

class FakePty implements IPty {
  readonly pid = 4321;
  readonly process = "fake-shell";
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

function setup() {
  const ptys: FakePty[] = [];
  const spawnCalls: Array<{ file: string; args: string[]; options: IPtyForkOptions }> = [];
  const spawnPty: TerminalPtySpawner = (file, args, options) => {
    spawnCalls.push({ file, args, options });
    const pty = new FakePty(options.cols ?? 80, options.rows ?? 24);
    ptys.push(pty);
    return pty;
  };

  const dataEvents: TerminalDataEvent[] = [];
  const exitEvents: TerminalExitEvent[] = [];
  const broadcaster: TerminalBroadcaster = {
    emitData: (event) => dataEvents.push(event),
    emitExit: (event) => exitEvents.push(event)
  };

  const database = {
    getWorkspace: (workspaceId: string) => ({
      id: workspaceId,
      path: "/repo/worktree",
      projectId: "p1",
      taskLabel: "work",
      branch: "main",
      baseRef: "main",
      state: "running",
      sharedWorkspace: false,
      dirty: false
    })
  } as unknown as ArgmaxDatabase;

  const service = new TerminalService(database, broadcaster, spawnPty);
  return { service, ptys, spawnCalls, dataEvents, exitEvents };
}

describe("TerminalService", () => {
  it("spawns a PTY with the workspace cwd and broadcasts data + exit", () => {
    const { service, ptys, spawnCalls, dataEvents, exitEvents } = setup();

    const { terminalId } = service.spawn({ workspaceId: "w1", cols: 100, rows: 30 });
    expect(terminalId).toBeTruthy();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options).toMatchObject({ cols: 100, rows: 30, cwd: "/repo/worktree" });
    expect(spawnCalls[0].options.name).toBe("xterm-256color");

    const pty = ptys[0];
    pty.emitData("hello\n");
    expect(dataEvents).toEqual([{ terminalId, data: "hello\n" }]);

    pty.emitExit(0);
    expect(exitEvents).toEqual([{ terminalId, exitCode: 0, signal: null }]);
    expect(service.liveCount()).toBe(0);
  });

  it("delegates write and resize to the right pty", () => {
    const { service, ptys } = setup();
    const a = service.spawn({ workspaceId: "w1", cols: 80, rows: 24 }).terminalId;
    const b = service.spawn({ workspaceId: "w2", cols: 80, rows: 24 }).terminalId;

    service.write({ terminalId: a, data: "ls\n" });
    service.resize({ terminalId: b, cols: 120, rows: 40 });

    expect(ptys[0].writes).toEqual(["ls\n"]);
    expect(ptys[1].writes).toEqual([]);
    expect(ptys[0].resizeCalls).toEqual([]);
    expect(ptys[1].resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("ignores write/resize/terminate for unknown ids without throwing", () => {
    const { service } = setup();
    expect(() => service.write({ terminalId: "ghost", data: "x" })).not.toThrow();
    expect(() => service.resize({ terminalId: "ghost", cols: 80, rows: 24 })).not.toThrow();
    expect(() => service.terminate("ghost")).not.toThrow();
  });

  it("terminate kills the pty; onExit cleans up the map", () => {
    const { service, ptys } = setup();
    const { terminalId } = service.spawn({ workspaceId: "w1", cols: 80, rows: 24 });
    service.terminate(terminalId);
    expect(ptys[0].killed).toBe(true);
    // Exit signal arrives async via the real pty; fake the path here.
    ptys[0].emitExit(143, 15);
    expect(service.liveCount()).toBe(0);
  });

  it("disposeAll kills every live pty and empties the registry", () => {
    const { service, ptys } = setup();
    service.spawn({ workspaceId: "w1", cols: 80, rows: 24 });
    service.spawn({ workspaceId: "w2", cols: 80, rows: 24 });
    expect(service.liveCount()).toBe(2);
    service.disposeAll();
    expect(ptys.every((p) => p.killed)).toBe(true);
    expect(service.liveCount()).toBe(0);
  });

  it("preserves the signal number on exit when available", () => {
    const { service, ptys, exitEvents } = setup();
    const { terminalId } = service.spawn({ workspaceId: "w1", cols: 80, rows: 24 });
    ptys[0].emitExit(137, 9);
    expect(exitEvents).toEqual([{ terminalId, exitCode: 137, signal: 9 }]);
  });
});
