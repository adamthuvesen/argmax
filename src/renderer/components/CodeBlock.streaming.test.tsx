import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mark the shiki output so a test can tell a real highlight pass from the plain
// fallback used while a fence is still streaming.
const highlightCodeMock = vi.hoisted(() =>
  vi.fn((code: string) => code.split("\n").map((line) => [{ content: `HL:${line}`, color: "#005cc5" }]))
);
const plainCodeLinesMock = vi.hoisted(() =>
  vi.fn((code: string) => code.split("\n").map((line) => [{ content: line }]))
);

vi.mock("../lib/highlighter.js", () => ({
  highlightCode: highlightCodeMock,
  plainCodeLines: plainCodeLinesMock,
  resolveFenceLang: (tag: string | null | undefined) => (tag ? "typescript" : null),
  useHighlighterReady: () => true
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
  });

  it("highlights synchronously when not streaming", () => {
    render(<CodeBlock className="language-ts">const x = 1;</CodeBlock>);
    expect(screen.getByText("HL:const x = 1;")).toBeInTheDocument();
    expect(highlightCodeMock).toHaveBeenCalled();
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
});
