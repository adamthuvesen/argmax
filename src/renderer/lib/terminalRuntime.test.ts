// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { syncTerminalSize, type TerminalTabRuntime } from "./terminalRuntime.js";

/** `syncTerminalSize` reads only the grid off the terminal and never touches
 *  the fit addon, so a real xterm instance (and a laid-out DOM) would add
 *  nothing the assertions can see. */
function makeRuntime(cols: number, rows: number, terminalId: string | null): TerminalTabRuntime {
  return {
    term: { cols, rows } as unknown as Terminal,
    fit: {} as unknown as FitAddon,
    terminalId,
    lastSentSize: null
  };
}

function mockResize(): ReturnType<typeof vi.fn> {
  const resize = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { argmax: unknown }).argmax = { terminal: { resize } };
  return resize;
}

describe("syncTerminalSize", () => {
  afterEach(() => {
    delete (window as { argmax?: unknown }).argmax;
    vi.restoreAllMocks();
  });

  // `terminal:resize` is a synchronous Rust command on the macOS main thread,
  // and a ResizeObserver fires per pixel of a drag while a cell is ~8x18px —
  // so the overwhelming majority of ticks would otherwise be pure contention.
  it("sends nothing when the grid did not move", () => {
    const resize = mockResize();
    const runtime = makeRuntime(80, 24, "term-1");

    syncTerminalSize(runtime);
    syncTerminalSize(runtime);
    syncTerminalSize(runtime);

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ terminalId: "term-1", cols: 80, rows: 24 });
  });

  it("sends again once cols or rows actually change", () => {
    const resize = mockResize();
    const runtime = makeRuntime(80, 24, "term-1");

    syncTerminalSize(runtime);
    (runtime.term as unknown as { rows: number }).rows = 25;
    syncTerminalSize(runtime);

    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith({ terminalId: "term-1", cols: 80, rows: 25 });
  });

  // Before the spawn resolves there is no PTY to resize, and recording the
  // size then would make the first real push look like a no-op.
  it("stays quiet, and remembers nothing, until the PTY exists", () => {
    const resize = mockResize();
    const runtime = makeRuntime(80, 24, null);

    syncTerminalSize(runtime);

    expect(resize).not.toHaveBeenCalled();
    expect(runtime.lastSentSize).toBeNull();
  });
});
