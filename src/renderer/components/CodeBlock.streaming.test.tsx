import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mark the shiki output so a test can tell a real highlight pass from the plain
// fallback used while a fence is still streaming.
const highlightCodeMock = vi.hoisted(() =>
  vi.fn<(code: string, lang: string | null, appearance?: "light" | "dark") => Array<Array<{ content: string; color: string }>>>(
    (code) => code.split("\n").map((line) => [{ content: `HL:${line}`, color: "#005cc5" }])
  )
);
const plainCodeLinesMock = vi.hoisted(() =>
  vi.fn((code: string) => code.split("\n").map((line) => [{ content: line }]))
);
const useHighlightThemeAppearanceMock = vi.hoisted(() => vi.fn<() => "light" | "dark">(() => "light"));

vi.mock("../lib/highlighter.js", () => ({
  highlightCode: highlightCodeMock,
  // Nothing is cached, and queued highlights run on the next timer tick.
  peekHighlightedCode: () => null,
  queueHighlight: (job: () => void) => {
    const timer = setTimeout(job, 0);
    return () => clearTimeout(timer);
  },
  plainCodeLines: plainCodeLinesMock,
  resolveFenceLang: (tag: string | null | undefined) => (tag ? "typescript" : null),
  useHighlighterReady: () => true,
  useHighlightThemeAppearance: useHighlightThemeAppearanceMock
}));

import { CodeBlock } from "./CodeBlock.js";
import { StreamingCodeContext } from "./streamingCodeContext.js";

describe("CodeBlock streaming highlight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
    useHighlightThemeAppearanceMock.mockReturnValue("light");
  });

  it("paints a settled fence plain, then colors it a slice later", () => {
    render(<CodeBlock className="language-ts">const x = 1;</CodeBlock>);
    // Highlighting never runs inside the render that mounts the fence.
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    expect(highlightCodeMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByText("HL:const x = 1;")).toBeInTheDocument();
    expect(highlightCodeMock).toHaveBeenCalledTimes(1);
  });

  it("renders plain while streaming, then highlights once the fence settles", () => {
    render(
      <StreamingCodeContext.Provider value={true}>
        <CodeBlock className="language-ts">const x = 1;</CodeBlock>
      </StreamingCodeContext.Provider>
    );
    // Immediately: plain text, shiki has not run on the live fence.
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    expect(highlightCodeMock).not.toHaveBeenCalled();

    // After the debounce settles: the real highlight lands, exactly once.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("HL:const x = 1;")).toBeInTheDocument();
    expect(highlightCodeMock).toHaveBeenCalledTimes(1);
  });

  it("re-highlights completed code when the appearance changes", () => {
    const { rerender } = render(<CodeBlock className="language-ts">const x = 1;</CodeBlock>);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(highlightCodeMock).toHaveBeenCalledTimes(1);

    highlightCodeMock.mockClear();
    useHighlightThemeAppearanceMock.mockReturnValue("dark");
    rerender(<CodeBlock className="language-ts">const x = 1;</CodeBlock>);
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(highlightCodeMock).toHaveBeenCalledTimes(1);
    expect(highlightCodeMock.mock.calls[0]?.[2]).toBe("dark");
  });
});
