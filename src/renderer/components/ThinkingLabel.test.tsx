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

  it("keeps counting the real wait when an anchored label remounts mid-gap", () => {
    // Navigation unmounts the chat and remounts it on return. The anchor is the
    // moment silence began, so the count survives the round trip instead of
    // presenting a five-minute wait as a fresh one.
    const startedAtMs = Date.parse("2026-09-06T07:00:00.000Z");
    let now = startedAtMs + 20_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const first = render(<ThinkingLabel startedAtMs={startedAtMs} />);
    expect(first.container.querySelector(".thinking-elapsed")?.textContent).toBe("20s");
    first.unmount();

    now = startedAtMs + 24_000;
    const second = render(<ThinkingLabel startedAtMs={startedAtMs} />);
    expect(second.container.querySelector(".thinking-elapsed")?.textContent).toBe("24s");
  });

  it("keeps the word stable across remounts of the same silent gap", () => {
    const startedAtMs = Date.parse("2026-09-06T07:00:00.000Z");
    const first = render(<ThinkingLabel phaseKey="session-1" startedAtMs={startedAtMs} />);
    const word = first.container.querySelector(".thinking-label")?.textContent;
    expect(THINKING_WORDS).toContain(word);
    first.unmount();

    const second = render(<ThinkingLabel phaseKey="session-1" startedAtMs={startedAtMs} />);
    expect(second.container.querySelector(".thinking-label")?.textContent).toBe(word);
  });

  it("draws a fresh word for a new silent stretch", () => {
    // Two different gap anchors on one session must not always land on the same
    // word, or every beat of a long session would read the same.
    const words = new Set(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((minute) => {
        const { container, unmount } = render(
          <ThinkingLabel
            phaseKey="session-1"
            startedAtMs={Date.parse("2026-09-06T07:00:00.000Z") + minute * 60_000}
          />
        );
        const word = container.querySelector(".thinking-label")?.textContent;
        unmount();
        return word;
      })
    );
    expect(words.size).toBeGreaterThan(1);
  });
});
