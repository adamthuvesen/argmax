import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef } from "react";
import { useAutoGrowTextArea } from "./useAutoGrowTextArea.js";

function ComposerTextarea({
  maxHeight = 140,
  minHeight,
  value = "",
  selection
}: {
  maxHeight?: number;
  minHeight: number;
  value?: string;
  selection?: [number, number];
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    if (selection) ref.current?.setSelectionRange(...selection);
  }, [value, selection]);
  useAutoGrowTextArea(ref, value, maxHeight);
  return (
    <div>
      <textarea
        aria-label="Prompt"
        ref={ref}
        readOnly
        style={{ minHeight: `${minHeight}px` }}
        value={value}
      />
    </div>
  );
}

function setScrollHeight(height: number): void {
  vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(height);
}

describe("useAutoGrowTextArea", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps empty compact textareas at their CSS minimum height", () => {
    setScrollHeight(24);

    render(<ComposerTextarea minHeight={56} />);

    expect(screen.getByLabelText("Prompt")).toHaveStyle({ height: "56px", overflowY: "hidden" });
  });

  it("uses content height when it is larger than the CSS minimum", () => {
    setScrollHeight(88);

    render(<ComposerTextarea minHeight={56} value={"one\ntwo\nthree"} />);

    expect(screen.getByLabelText("Prompt")).toHaveStyle({ height: "88px", overflowY: "hidden" });
  });

  it("reveals the end of a capped draft after a newline, then allows scrolling back", () => {
    setScrollHeight(200);
    const { rerender } = render(<ComposerTextarea minHeight={56} value="draft" />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Prompt" });
    textarea.focus();

    setScrollHeight(220);
    rerender(<ComposerTextarea minHeight={56} value={"draft\n"} />);

    expect(textarea).toHaveStyle({ height: "140px", overflowY: "auto" });
    // jsdom does not clamp scrollTop. Real-browser checks verify the line box.
    expect(textarea.scrollTop).toBe(220);

    textarea.scrollTop = 12;
    rerender(<ComposerTextarea minHeight={56} value={"draft\n"} />);
    expect(textarea.scrollTop).toBe(12);
  });

  it.each([
    { name: "an earlier caret", selection: [2, 2] as [number, number], focused: true },
    { name: "a selection through the end", selection: [2, 6] as [number, number], focused: true },
    { name: "an unfocused draft", selection: [6, 6] as [number, number], focused: false }
  ])("preserves the scroll position for $name", ({ selection, focused }) => {
    setScrollHeight(220);
    const { rerender } = render(<ComposerTextarea minHeight={56} value="draft" />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Prompt" });
    if (focused) textarea.focus();
    textarea.scrollTop = 12;

    rerender(<ComposerTextarea minHeight={56} value={"draft\n"} selection={selection} />);

    expect(textarea.scrollTop).toBe(12);
  });

  it("recalculates when the composer width changes", () => {
    setScrollHeight(24);
    let triggerResize = (): void => {
      throw new Error("ResizeObserver was not installed.");
    };
    class StubResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        triggerResize = (): void => callback([], this);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);

    render(<ComposerTextarea minHeight={56} />);
    const textarea = screen.getByLabelText("Prompt");
    expect(textarea).toHaveStyle({ height: "56px" });

    textarea.style.minHeight = "72px";
    triggerResize();

    expect(textarea).toHaveStyle({ height: "72px" });
  });
});
