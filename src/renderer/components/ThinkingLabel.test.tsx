import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __liveTimerTickForTest } from "../lib/liveTimer.js";
import { THINKING_WORDS, ThinkingLabel } from "./ThinkingLabel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<ThinkingLabel />", () => {
  it("exposes the Thinking aria-label so existing selectors keep working", () => {
    render(<ThinkingLabel />);
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("chooses one curated word and keeps it stable", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0)
      .mockReturnValue(0.99);

    const { rerender } = render(<ThinkingLabel />);
    expect(screen.getByTestId("thinking-label")).toHaveTextContent("Brainstorming");

    rerender(<ThinkingLabel />);
    expect(screen.getByTestId("thinking-label")).toHaveTextContent("Brainstorming");
  });

  it("occasionally uses Argmaxing as its signature word", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.01);
    render(<ThinkingLabel />);
    expect(screen.getByTestId("thinking-label")).toHaveTextContent("Argmaxing");
  });

  it("uses the curated vocabulary", () => {
    expect(THINKING_WORDS).toEqual([
      "Brainstorming",
      "Disentangling",
      "Sanity-checking",
      "Theorizing",
      "Deciphering",
      "Synthesizing",
      "Deconstructing",
      "Distilling",
      "Reconciling",
      "Refining",
      "Argmaxing"
    ]);
  });

  it("shows the shared live-work mark", () => {
    render(<ThinkingLabel />);
    expect(screen.getByTestId("thinking-label").querySelector('[data-working="true"]')).not.toBeNull();
  });

  it("stays quiet for a short gap and then counts the wait", () => {
    // A ten-to-thirty second relaunch is the case this exists for: a static word
    // reads as a frozen pane, and the count is what says the app is still on it.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const { container } = render(<ThinkingLabel />);
    const elapsed = container.querySelector(".thinking-elapsed");
    expect(elapsed?.textContent).toBe("");

    now = 2_900;
    __liveTimerTickForTest();
    expect(elapsed?.textContent).toBe("");

    now = 14_000;
    __liveTimerTickForTest();
    expect(elapsed?.textContent).toBe("14s");
  });

  it("counts each silent gap from zero rather than from the start of the turn", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const first = render(<ThinkingLabel />);
    now = 20_000;
    __liveTimerTickForTest();
    expect(first.container.querySelector(".thinking-elapsed")?.textContent).toBe("20s");
    first.unmount();

    const second = render(<ThinkingLabel />);
    now = 24_000;
    __liveTimerTickForTest();
    expect(second.container.querySelector(".thinking-elapsed")?.textContent).toBe("4s");
  });
});
