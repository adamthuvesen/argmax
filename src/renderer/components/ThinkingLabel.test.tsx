import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
