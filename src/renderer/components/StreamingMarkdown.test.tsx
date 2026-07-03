import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("<StreamingMarkdown />", () => {
  it("reveals large streaming chunks at a steady cadence", () => {
    vi.useFakeTimers();
    const text = "A".repeat(120);

    const { container } = render(<StreamingMarkdown text={text} streaming />);

    const markdown = container.querySelector(".markdown");
    expect(markdown?.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(markdown?.textContent).toBe("A".repeat(5));

    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(markdown?.textContent).toBe("A".repeat(10));

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("keeps completed blocks formatted while a later block is still streaming", () => {
    vi.useFakeTimers();
    // A finished heading, then a paragraph still being typed. The committed
    // prefix ("# Title\n\n") must render as a real heading even before the
    // trailing paragraph finishes.
    const text = "# Title\n\nStreaming the rest of the answer now, one chunk at a time.";

    render(<StreamingMarkdown text={text} streaming />);

    act(() => {
      // Reveal past the heading and into the paragraph, but not to the end.
      vi.advanceTimersByTime(32 * 6);
    });

    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
  });

  it("renders completed text immediately", () => {
    const text = "Completed answers should not be delayed.";

    render(<StreamingMarkdown text={text} streaming={false} />);

    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("does not smooth streaming text for reduced-motion users", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    const text = "B".repeat(120);

    render(<StreamingMarkdown text={text} streaming />);

    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
