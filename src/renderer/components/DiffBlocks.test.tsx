import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const highlightLineMock = vi.hoisted(() =>
  vi.fn((content: string, lang: string | null) => {
    if (!lang) return [{ content }];
    // Deterministic stub: tag whitespace runs with no color and non-whitespace
    // runs with a color so the test can assert on a colored token without
    // pulling in a real grammar.
    const tokens: Array<{ content: string; color?: string }> = [];
    const pattern = /\s+|\S+/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      const piece = match[0];
      if (/^\s+$/.test(piece)) {
        tokens.push({ content: piece });
      } else {
        tokens.push({ content: piece, color: "#005cc5" });
      }
    }
    return tokens.length > 0 ? tokens : [{ content }];
  })
);
const useHighlighterReadyMock = vi.hoisted(() => vi.fn<() => boolean>(() => true));
const langFromPathMock = vi.hoisted(() =>
  vi.fn((filePath: string | null | undefined): string | null => {
    if (!filePath) return null;
    if (filePath.endsWith(".ts")) return "typescript";
    return null;
  })
);

vi.mock("../lib/highlighter.js", () => ({
  highlightLine: highlightLineMock,
  useHighlighterReady: useHighlighterReadyMock,
  langFromPath: langFromPathMock
}));

import type { ParsedDiffBlock } from "../lib/diff.js";
import { DiffBlocks } from "./DiffBlocks.js";

const TS_HUNK: ParsedDiffBlock = {
  id: "hunk-1",
  kind: "hunk",
  header: "@@ -1,2 +1,2 @@",
  lines: [
    { kind: "addition", content: "const x = 42;", oldLineNumber: null, newLineNumber: 1 }
  ]
};

const UNKNOWN_HUNK: ParsedDiffBlock = {
  id: "hunk-2",
  kind: "hunk",
  header: "@@ -1 +1 @@",
  lines: [
    { kind: "addition", content: "weird format", oldLineNumber: null, newLineNumber: 1 }
  ]
};

const OMITTED: Extract<ParsedDiffBlock, { kind: "omitted" }> = {
  id: "omitted-1",
  kind: "omitted",
  count: 16
};

const TRUNCATED: ParsedDiffBlock = {
  id: "truncated",
  kind: "truncated",
  droppedBytes: 4096
};

const RANGE_HUNK: Extract<ParsedDiffBlock, { kind: "hunk" }> = {
  id: "range-hunk",
  kind: "hunk",
  header: "@@ -10,3 +20,4 @@",
  lines: [
    { kind: "context", content: "before", oldLineNumber: 10, newLineNumber: 20 },
    { kind: "deletion", content: "old", oldLineNumber: 11, newLineNumber: null },
    { kind: "addition", content: "first", oldLineNumber: null, newLineNumber: 21 },
    { kind: "addition", content: "second", oldLineNumber: null, newLineNumber: 22 },
    { kind: "context", content: "after", oldLineNumber: 12, newLineNumber: 23 }
  ]
};

function lineCommentButton(line: number): HTMLElement {
  return screen.getByRole("button", { name: `Comment on line ${line} of src/x.ts` });
}

describe("DiffBlocks", () => {
  beforeEach(() => {
    highlightLineMock.mockClear();
    useHighlighterReadyMock.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders syntax-highlighted token spans for a recognized language", () => {
    render(<DiffBlocks blocks={[TS_HUNK]} filePath="src/x.ts" />);

    const tokens = document.querySelectorAll("span.hl-token");
    expect(tokens.length).toBeGreaterThan(0);

    // At least one token carries a non-empty color style.
    const colored = Array.from(tokens).filter((node) => (node as HTMLElement).style.color !== "");
    expect(colored.length).toBeGreaterThan(0);

    expect(highlightLineMock).toHaveBeenCalled();
    expect(highlightLineMock.mock.calls[0]?.[1]).toBe("typescript");
  });

  it("falls back to plain text for an unknown language without throwing", () => {
    render(<DiffBlocks blocks={[UNKNOWN_HUNK]} filePath="weird.xyz" />);

    // No `.hl-token` spans because lang === null short-circuits before the
    // highlighter is consulted.
    expect(document.querySelector("span.hl-token")).toBeNull();
    expect(screen.getByText("weird format")).toBeInTheDocument();
    expect(highlightLineMock).not.toHaveBeenCalled();
  });

  it("renders plain text while the highlighter is still loading", () => {
    useHighlighterReadyMock.mockReturnValue(false);
    render(<DiffBlocks blocks={[TS_HUNK]} filePath="src/x.ts" />);

    expect(document.querySelector("span.hl-token")).toBeNull();
    expect(screen.getByText("const x = 42;")).toBeInTheDocument();
    expect(highlightLineMock).not.toHaveBeenCalled();
  });

  it("refreshes memoized highlighting when the theme changes", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    render(<DiffBlocks blocks={[TS_HUNK]} filePath="src/x.ts" />);
    highlightLineMock.mockClear();
    document.documentElement.setAttribute("data-theme", "dark");
    await waitFor(() => expect(highlightLineMock).toHaveBeenCalled());
  });

  it("offers no comment affordance without an onAddComment handler", () => {
    render(<DiffBlocks blocks={[TS_HUNK]} filePath="src/x.ts" />);
    expect(screen.queryByRole("button", { name: /Comment on line/ })).toBeNull();
  });

  it("submits a line comment through the inline form", () => {
    const onAddComment = vi.fn();
    render(<DiffBlocks blocks={[TS_HUNK]} filePath="src/x.ts" onAddComment={onAddComment} />);

    fireEvent.click(screen.getByRole("button", { name: "Comment on line 1 of src/x.ts" }));
    const form = screen.getByRole("form", { name: "Comment on src/x.ts:1" });
    expect(form).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Comment text"), {
      target: { value: "use a named constant" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(onAddComment).toHaveBeenCalledWith({
      filePath: "src/x.ts",
      line: 1,
      side: "addition",
      lineText: "const x = 42;",
      comment: "use a named constant"
    });
    expect(screen.queryByRole("form", { name: "Comment on src/x.ts:1" })).toBeNull();
  });

  it("cancels the comment form with Escape without submitting", () => {
    const onAddComment = vi.fn();
    render(<DiffBlocks blocks={[TS_HUNK]} filePath="src/x.ts" onAddComment={onAddComment} />);

    fireEvent.click(screen.getByRole("button", { name: "Comment on line 1 of src/x.ts" }));
    fireEvent.keyDown(screen.getByLabelText("Comment text"), { key: "Escape" });

    expect(screen.queryByRole("form", { name: "Comment on src/x.ts:1" })).toBeNull();
    expect(onAddComment).not.toHaveBeenCalled();
  });

  it.each([[21, 23], [23, 21]])("submits a range dragged from %i to %i", (from, to) => {
    const onAddComment = vi.fn();
    render(<DiffBlocks blocks={[RANGE_HUNK]} filePath="src/x.ts" onAddComment={onAddComment} />);
    highlightLineMock.mockClear();
    fireEvent.mouseDown(lineCommentButton(from), { button: 0, buttons: 1 });
    fireEvent.mouseEnter(lineCommentButton(to), { buttons: 1 });
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(3);
    fireEvent.mouseUp(window, { button: 0 });
    fireEvent.click(lineCommentButton(from), { detail: 1 });
    expect(screen.getByRole("form", { name: "Comment on src/x.ts:21-23" })).toBeInTheDocument();
    expect(screen.getByLabelText("Comment text")).toHaveFocus();
    expect(highlightLineMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Comment text"), { target: { value: "range note" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onAddComment).toHaveBeenCalledWith({
      filePath: "src/x.ts", line: 21, endLine: 23, side: "addition", endSide: "context",
      lineText: "+first\n+second\n after", comment: "range note"
    });
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  });

  it("preserves removed and added code in a mixed range", () => {
    const onAddComment = vi.fn();
    render(<DiffBlocks blocks={[RANGE_HUNK]} filePath="src/x.ts" onAddComment={onAddComment} />);
    fireEvent.mouseDown(lineCommentButton(11), { button: 0, buttons: 1 });
    fireEvent.mouseEnter(lineCommentButton(22), { buttons: 1 });
    fireEvent.mouseUp(window);
    expect(screen.getByRole("form", { name: "Comment on src/x.ts:11 (removed)-22 (added)" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Comment text"), { target: { value: "mixed range" } });
    fireEvent.keyDown(screen.getByLabelText("Comment text"), { key: "Enter" });
    expect(onAddComment).toHaveBeenCalledWith({
      filePath: "src/x.ts", line: 11, endLine: 22, side: "deletion", endSide: "addition",
      lineText: "-old\n+first\n+second", comment: "mixed range"
    });
  });

  it.each(["Escape", "blur"])("cancels an unfinished drag on %s", (action) => {
    render(<DiffBlocks blocks={[RANGE_HUNK]} filePath="src/x.ts" onAddComment={vi.fn()} />);
    fireEvent.mouseDown(lineCommentButton(21), { button: 0, buttons: 1 });
    fireEvent.mouseEnter(lineCommentButton(23), { buttons: 1 });
    if (action === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else fireEvent.blur(window);
    fireEvent.mouseUp(window);
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  });

  it.each([
    [11, 23, "11 (removed)-23 (unchanged)"],
    [20, 11, "20 (unchanged)-11 (removed)"]
  ] as const)("labels unchanged endpoints for %i to %i", (from, to, location) => {
    render(<DiffBlocks blocks={[RANGE_HUNK]} filePath="src/x.ts" onAddComment={vi.fn()} />);
    fireEvent.mouseDown(lineCommentButton(from), { button: 0, buttons: 1 });
    fireEvent.mouseEnter(lineCommentButton(to), { buttons: 1 });
    fireEvent.mouseUp(window);
    expect(screen.getByRole("form", { name: `Comment on src/x.ts:${location}` })).toBeInTheDocument();
  });

  it.each(["file", "diff"])("clears a comment when the %s changes", (change) => {
    const onAddComment = vi.fn();
    const { rerender } = render(<DiffBlocks blocks={[RANGE_HUNK]} filePath="src/x.ts" onAddComment={onAddComment} />);
    fireEvent.click(lineCommentButton(21));
    expect(screen.getByRole("form")).toBeInTheDocument();
    rerender(<DiffBlocks
      blocks={change === "diff" ? [{ ...RANGE_HUNK, lines: [] }] : [RANGE_HUNK]}
      filePath={change === "file" ? "src/y.ts" : "src/x.ts"}
      onAddComment={onAddComment}
    />);
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  });

  it("leaves code text selection and right clicks alone", () => {
    render(<DiffBlocks blocks={[RANGE_HUNK]} filePath="src/x.ts" onAddComment={vi.fn()} />);
    fireEvent.mouseDown(screen.getByText("first"), { button: 0, buttons: 1 });
    fireEvent.mouseEnter(lineCommentButton(23), { buttons: 1 });
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(lineCommentButton(21), { button: 2, buttons: 2 });
    fireEvent.mouseUp(window);
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  });

  it("turns a between-hunk gap into an expand control", () => {
    const onExpandContext = vi.fn();
    render(
      <DiffBlocks
        blocks={[TS_HUNK, OMITTED, UNKNOWN_HUNK]}
        filePath="src/x.ts"
        onExpandContext={onExpandContext}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand 16 unmodified lines" }));
    expect(onExpandContext).toHaveBeenCalledTimes(1);
  });

  it("renders a gap as a static label where expansion is unavailable", () => {
    render(<DiffBlocks blocks={[TS_HUNK, OMITTED]} filePath="src/x.ts" />);

    expect(screen.queryByRole("button", { name: /unmodified/ })).toBeNull();
    expect(screen.getByText("16 unmodified lines")).toBeInTheDocument();
  });

  it("singularizes a one-line gap", () => {
    render(<DiffBlocks blocks={[TS_HUNK, { ...OMITTED, count: 1 }]} filePath="src/x.ts" />);

    expect(screen.getByText("1 unmodified line")).toBeInTheDocument();
  });

  it("announces a truncated diff and stops advertising expansion", () => {
    const onExpandContext = vi.fn();
    render(
      <DiffBlocks
        blocks={[TS_HUNK, OMITTED, TRUNCATED]}
        filePath="src/x.ts"
        onExpandContext={onExpandContext}
      />
    );

    // Asking git for more context would only drop more content.
    expect(screen.queryByRole("button", { name: /unmodified/ })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("4 KB of changes were dropped");
  });
});
