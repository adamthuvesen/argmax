// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import {
  attachTerminalTab,
  resetTerminalRuntimesForTests,
  syncTerminalSize,
  type TerminalTabRuntime
} from "./terminalRuntime.js";

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

/** A key as WebKit delivers it; xterm still reads the legacy `keyCode`. */
function pressKey(target: HTMLElement, key: string, keyCode: number, modifiers: KeyboardEventInit = {}): void {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  Object.defineProperty(event, "keyCode", { value: keyCode });
  target.dispatchEvent(event);
}

// Drives a real xterm, so this pins the bytes the shell receives for each
// editing key, not just the chord table.
describe("terminal editing keys", () => {
  afterEach(() => {
    resetTerminalRuntimesForTests();
    delete (window as { argmax?: unknown }).argmax;
    document.body.innerHTML = "";
  });

  it.each([
    ["Backspace", "Backspace", 8, {}, "\x7f"],
    ["⌥⌫", "Backspace", 8, { altKey: true }, "\x1b\x7f"],
    ["⌘⌫", "Backspace", 8, { metaKey: true }, "\x15"],
    ["Delete", "Delete", 46, {}, "\x1b[3~"],
    ["⌥⌦", "Delete", 46, { altKey: true }, "\x1bd"],
    ["⌥←", "ArrowLeft", 37, { altKey: true }, "\x1bb"],
    ["⌥→", "ArrowRight", 39, { altKey: true }, "\x1bf"],
    ["⌘←", "ArrowLeft", 37, { metaKey: true }, "\x01"],
    ["⌘→", "ArrowRight", 39, { metaKey: true }, "\x05"],
    ["Home", "Home", 36, {}, "\x1b[H"],
    ["End", "End", 35, {}, "\x1b[F"],
    ["Up", "ArrowUp", 38, {}, "\x1b[A"],
    ["Tab", "Tab", 9, {}, "\t"],
    ["Esc", "Escape", 27, {}, "\x1b"],
    ["Ctrl+U", "u", 85, { ctrlKey: true }, "\x15"],
    ["Ctrl+W", "w", 87, { ctrlKey: true }, "\x17"],
    ["Ctrl+C", "c", 67, { ctrlKey: true }, "\x03"]
  ] as const)("%s reaches the PTY as the shell's editing sequence", async (_label, key, keyCode, modifiers, bytes) => {
    const write = vi.fn().mockResolvedValue(undefined);
    const subscription = () => Object.assign(() => undefined, { ready: Promise.resolve() });
    (window as unknown as { argmax: unknown }).argmax = {
      terminal: {
        onData: subscription,
        onExit: subscription,
        spawn: vi.fn().mockResolvedValue({ terminalId: "term-1" }),
        resize: vi.fn().mockResolvedValue(undefined),
        terminate: vi.fn().mockResolvedValue(undefined),
        write
      }
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const runtime = attachTerminalTab("tab-1", "ws-1", container);
    await waitFor(() => expect(runtime.terminalId).toBe("term-1"));

    pressKey(runtime.term.textarea!, key, keyCode, modifiers);

    expect(write.mock.calls).toEqual([[{ terminalId: "term-1", data: bytes }]]);
  });
});
