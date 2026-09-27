// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { tryFit } from "./xtermFit.js";

function makeTerminal(width: number, height: number): Terminal {
  const host = document.createElement("div");
  const element = document.createElement("div");
  host.appendChild(element);
  Object.defineProperty(host, "clientWidth", { value: width });
  Object.defineProperty(host, "clientHeight", { value: height });
  return { element } as unknown as Terminal;
}

describe("tryFit", () => {
  // A hidden host reports `100%` as 100px to the fit addon, which shrinks the
  // grid (and the PTY) to a few cells; zsh then redraws its prompt wrapped,
  // and the terminal reopens with blank rows above the prompt.
  it("skips the fit while the host has no layout box", () => {
    const fitSpy = vi.fn();
    const fit = { fit: fitSpy } as unknown as FitAddon;

    expect(tryFit(makeTerminal(0, 0), fit)).toBe(false);
    expect(tryFit(makeTerminal(400, 0), fit)).toBe(false);
    expect(fitSpy).not.toHaveBeenCalled();
  });

  it("fits a laid-out host", () => {
    const fitSpy = vi.fn();
    const fit = { fit: fitSpy } as unknown as FitAddon;

    expect(tryFit(makeTerminal(400, 300), fit)).toBe(true);
    expect(fitSpy).toHaveBeenCalledTimes(1);
  });
});
