import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useAutoGrowTextArea } from "./useAutoGrowTextArea.js";

function ComposerTextarea({
  maxHeight = 140,
  minHeight,
  value = ""
}: {
  maxHeight?: number;
  minHeight: number;
  value?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
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
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return height;
    }
  });
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
