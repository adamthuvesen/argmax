import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingVerbs } from "./ThinkingVerbs.js";
import { THINKING_VERBS } from "../lib/thinkingVerbs.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<ThinkingVerbs />", () => {
  it("exposes the Thinking aria-label so existing selectors keep working", () => {
    render(<ThinkingVerbs />);
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("does not render the terminal command text", () => {
    render(<ThinkingVerbs />);
    expect(screen.queryByText(/argmax run/i)).toBeNull();
  });

  it("renders a verb from the roster on mount", () => {
    render(<ThinkingVerbs />);
    const bubble = screen.getByLabelText("Thinking");
    const matched = THINKING_VERBS.some((verb) =>
      bubble.textContent?.includes(verb)
    );
    expect(matched).toBe(true);
  });

  it("rotates the verb after the interval elapses", () => {
    vi.useFakeTimers();
    render(<ThinkingVerbs />);
    const bubble = screen.getByLabelText("Thinking");
    const first = bubble.textContent;
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    const second = bubble.textContent;
    expect(second).not.toEqual(first);
    const matched = THINKING_VERBS.some((verb) => second?.includes(verb));
    expect(matched).toBe(true);
  });
});
