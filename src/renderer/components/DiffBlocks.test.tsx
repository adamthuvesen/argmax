import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("DiffBlocks", () => {
  beforeEach(() => {
    highlightLineMock.mockClear();
    useHighlighterReadyMock.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
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
