import { act, cleanup, render } from "@testing-library/react";
import { useRef, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setViewportMeasurementPaused, useVisualViewportInsets } from "./useVisualViewportInsets.js";

/**
 * The stuck-viewport repair is invisible once it has run — the shell is hidden
 * and shown again inside one task — so the reflow read is what the test
 * watches: it records the display value the browser would have measured.
 */
const reflowsWhileHidden: string[] = [];

function Harness(): JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null);
  useVisualViewportInsets(shellRef);
  return <div ref={shellRef} className="mobile-shell" />;
}

const viewport = {
  height: 932,
  offsetTop: 0,
  addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
  removeEventListener: () => undefined
};
let listeners: (() => void)[] = [];

function renderShell(): void {
  render(<Harness />);
  const shell = document.querySelector<HTMLElement>(".mobile-shell");
  if (!shell) throw new Error("no shell");
  Object.defineProperty(shell, "offsetHeight", {
    configurable: true,
    get: () => {
      reflowsWhileHidden.push(shell.style.display);
      return 0;
    }
  });
}

/** One frame of the phone reporting a new viewport. */
function reportViewport(innerHeight: number, height: number): void {
  window.innerHeight = innerHeight;
  viewport.height = height;
  act(() => {
    for (const listener of listeners) listener();
    // The hook batches its writes into a frame.
    vi.advanceTimersByTime(20);
  });
}

describe("useVisualViewportInsets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners = [];
    reflowsWhileHidden.length = 0;
    window.innerHeight = 932;
    viewport.height = 932;
    viewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(window.navigator, "standalone", { configurable: true, value: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("publishes the visual viewport as custom properties", () => {
    renderShell();
    reportViewport(932, 596);
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--mobile-viewport-height")).toBe("596px");
    expect(root.getPropertyValue("--mobile-keyboard-inset")).toBe("336px");
  });

  it("re-measures a home-screen viewport left short after the keyboard closes", () => {
    renderShell();
    reportViewport(932, 596);
    // iOS gives back a viewport 59px shorter than the one it started with.
    reportViewport(873, 873);
    expect(reflowsWhileHidden).toEqual(["none"]);
  });

  it("leaves the viewport alone in Safari, where the toolbar owns the height", () => {
    Object.defineProperty(window.navigator, "standalone", { configurable: true, value: false });
    renderShell();
    reportViewport(932, 596);
    reportViewport(873, 873);
    expect(reflowsWhileHidden).toEqual([]);
  });

  it("holds the published viewport while a native picker is open", () => {
    // Tapping attach opens the iOS menu, which dismisses the keyboard and
    // hands back the full height. Publishing that mid-gesture is what dropped
    // the composer and left a blank strip under it.
    renderShell();
    reportViewport(932, 596);
    setViewportMeasurementPaused(true);
    reportViewport(932, 932);
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--mobile-viewport-height")).toBe("596px");
    expect(root.getPropertyValue("--mobile-keyboard-inset")).toBe("336px");

    // Releasing catches up in one write, without waiting for another resize.
    act(() => setViewportMeasurementPaused(false));
    expect(root.getPropertyValue("--mobile-viewport-height")).toBe("932px");
    expect(root.getPropertyValue("--mobile-keyboard-inset")).toBe("0px");
  });

  it("reads a rotation as a new height, not as the bug", () => {
    renderShell();
    reportViewport(430, 430);
    reportViewport(430, 200);
    reportViewport(430, 430);
    expect(reflowsWhileHidden).toEqual([]);
  });
});
