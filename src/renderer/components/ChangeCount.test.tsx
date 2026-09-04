import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeCount } from "./ChangeCount.js";

function mockMatchMedia(matches: boolean): void {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  });
}

describe("ChangeCount", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("mounts at the live totals with an accessible label", () => {
    render(<ChangeCount additions={110} deletions={15} />);

    expect(screen.getByText("+110")).toBeInTheDocument();
    expect(screen.getByText("-15")).toBeInTheDocument();
    expect(screen.getByLabelText("110 additions, 15 deletions")).toBeInTheDocument();
  });

  it("ticks toward new totals across frames and lands exactly", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // Additions and deletions animate independently, so drain every frame.
    let pending: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      pending.push(cb);
      return pending.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      pending = [];
    });
    const runFrame = (advanceMs: number): void => {
      now += advanceMs;
      act(() => {
        const callbacks = pending;
        pending = [];
        for (const cb of callbacks) cb(now);
      });
    };

    const { rerender } = render(<ChangeCount additions={10} deletions={2} />);
    rerender(<ChangeCount additions={110} deletions={15} />);

    // Mid-flight the digits sit between the old and new totals …
    runFrame(200);
    const midAdditions = Number(screen.getByText(/^\+\d+$/).textContent?.slice(1));
    expect(midAdditions).toBeGreaterThan(10);
    expect(midAdditions).toBeLessThan(110);

    // … and settle exactly on them, while the label never leaves the live values.
    runFrame(500);
    expect(screen.getByText("+110")).toBeInTheDocument();
    expect(screen.getByText("-15")).toBeInTheDocument();
    expect(screen.getByLabelText("110 additions, 15 deletions")).toBeInTheDocument();
  });

  it("jumps straight to new totals for reduced-motion users", () => {
    mockMatchMedia(true);

    const { rerender } = render(<ChangeCount additions={10} deletions={2} />);
    rerender(<ChangeCount additions={110} deletions={15} />);

    expect(screen.getByText("+110")).toBeInTheDocument();
    expect(screen.getByText("-15")).toBeInTheDocument();
  });
});
