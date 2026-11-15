import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mark the shiki output so a test can tell a real highlight pass from the plain
// fallback used while a fence is still streaming.
type TokenLines = Array<Array<{ content: string; color: string }>>;
const requestHighlightMock = vi.hoisted(() =>
  vi.fn<
    (
      code: string,
      lang: string,
      appearance: "light" | "dark",
      done: (lines: TokenLines | null) => void,
    ) => () => void
  >((code, _lang, _appearance, done) => {
    // oxlint-disable-next-line no-restricted-globals -- fake timer: this file installs vi.useFakeTimers() and the tests drive it with advanceTimersByTime
    const timer = setTimeout(
      () => done(code.split("\n").map((line) => [{ content: `HL:${line}`, color: "#005cc5" }])),
      0,
    );
    return () => clearTimeout(timer);
  }),
);
const plainCodeLinesMock = vi.hoisted(() =>
  vi.fn((code: string) => code.split("\n").map((line) => [{ content: line }])),
);
const useHighlightThemeAppearanceMock = vi.hoisted(() =>
  vi.fn<() => "light" | "dark">(() => "light"),
);

vi.mock("../lib/highlighter.js", () => ({
  // Nothing is cached, and tokens land on the next timer tick.
  peekHighlightedCode: () => null,
  requestHighlight: requestHighlightMock,
  plainCodeLines: plainCodeLinesMock,
  resolveFenceLang: (tag: string | null | undefined) => (tag ? "typescript" : null),
  useHighlightThemeAppearance: useHighlightThemeAppearanceMock,
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
    // Colors never land inside the render that mounts the fence.
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    expect(screen.queryByText("HL:const x = 1;")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByText("HL:const x = 1;")).toBeInTheDocument();
    expect(requestHighlightMock).toHaveBeenCalledTimes(1);
  });

  it("renders plain while streaming, then highlights once the fence settles", () => {
    render(
      <StreamingCodeContext.Provider value={true}>
        <CodeBlock className="language-ts">const x = 1;</CodeBlock>
      </StreamingCodeContext.Provider>,
    );
    // Immediately: plain text, shiki has not run on the live fence.
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    expect(requestHighlightMock).not.toHaveBeenCalled();

    // After the throttle tick the request goes out, and its tokens land once.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(screen.getByText("HL:const x = 1;")).toBeInTheDocument();
    expect(requestHighlightMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a fence's request when it unmounts", () => {
    const cancel = vi.fn();
    requestHighlightMock.mockReturnValueOnce(cancel);
    const { unmount } = render(<CodeBlock className="language-ts">const x = 1;</CodeBlock>);
    expect(requestHighlightMock).toHaveBeenCalledTimes(1);
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("re-highlights completed code when the appearance changes", () => {
    const { rerender } = render(<CodeBlock className="language-ts">const x = 1;</CodeBlock>);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(requestHighlightMock).toHaveBeenCalledTimes(1);

    requestHighlightMock.mockClear();
    useHighlightThemeAppearanceMock.mockReturnValue("dark");
    rerender(<CodeBlock className="language-ts">const x = 1;</CodeBlock>);
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(requestHighlightMock).toHaveBeenCalledTimes(1);
    expect(requestHighlightMock.mock.calls[0]?.[2]).toBe("dark");
  });
});
