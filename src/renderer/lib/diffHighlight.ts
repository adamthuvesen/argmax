import type { ParsedDiffLine } from "./diff.js";
import { requestHighlight, type HighlightAppearance, type HighlightToken } from "./highlighter.js";

/**
 * Syntax colors for diff hunks, computed off the render path.
 *
 * Highlighting each line with its own synchronous call froze the window for
 * three quarters of a second on a 2,800-line diff. Each hunk is tokenized as
 * its two sides — the new file (context and additions) and the old one
 * (context and deletions) — so a string or comment that spans lines colors
 * correctly. Lines render plain until their side lands.
 */

type HunkTokens = {
  key: string;
  tokens: (HighlightToken[] | undefined)[];
  version: number;
  listeners: Set<() => void>;
};

const hunks = new WeakMap<readonly ParsedDiffLine[], HunkTokens>();

function entryFor(lines: readonly ParsedDiffLine[]): HunkTokens {
  let entry = hunks.get(lines);
  if (!entry) {
    entry = { key: "", tokens: [], version: 0, listeners: new Set() };
    hunks.set(lines, entry);
  }
  return entry;
}

export function subscribeHunkTokens(
  lines: readonly ParsedDiffLine[],
  listener: () => void,
): () => void {
  const entry = entryFor(lines);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

/** Bumps whenever more of the hunk's lines have colors. */
export function hunkTokensVersion(lines: readonly ParsedDiffLine[]): number {
  return hunks.get(lines)?.version ?? 0;
}

/** The colors for line `index`, if they have been computed for `key`. */
export function hunkLineTokens(
  lines: readonly ParsedDiffLine[],
  key: string,
  index: number,
): HighlightToken[] | undefined {
  const entry = hunks.get(lines);
  return entry && entry.key === key ? entry.tokens[index] : undefined;
}

function highlightHunk(
  lines: readonly ParsedDiffLine[],
  lang: string,
  appearance: HighlightAppearance,
  key: string,
): (() => void)[] {
  const entry = entryFor(lines);
  if (
    entry.key === key &&
    entry.tokens.length === lines.length &&
    !entry.tokens.includes(undefined)
  )
    return [];
  entry.key = key;
  entry.tokens = new Array<HighlightToken[] | undefined>(lines.length);
  // Context lines take their colors from the new side; the old side runs
  // through them only to keep its grammar state honest.
  const sides: { indices: number[]; owns: (line: ParsedDiffLine) => boolean }[] = [
    { indices: [], owns: (line) => line.kind !== "deletion" },
    { indices: [], owns: (line) => line.kind === "deletion" },
  ];
  lines.forEach((line, index) => {
    if (line.kind !== "deletion") sides[0].indices.push(index);
    if (line.kind !== "addition") sides[1].indices.push(index);
  });
  const tokens = entry.tokens;
  return sides
    .filter((side) => side.indices.some((index) => side.owns(lines[index])))
    .map((side) =>
      requestHighlight(
        side.indices.map((index) => lines[index].content).join("\n"),
        lang,
        appearance,
        (result) => {
          if (!result || entry.tokens !== tokens) return;
          side.indices.forEach((index, offset) => {
            if (side.owns(lines[index]))
              tokens[index] = result[offset] ?? [{ content: lines[index].content }];
          });
          entry.version += 1;
          for (const listener of entry.listeners) listener();
        },
        { keep: false },
      ),
    );
}

/**
 * Colors every hunk in `hunkLines`, in document order. Returns a cancel for
 * when the diff or theme changes.
 */
export function highlightHunks(
  hunkLines: readonly (readonly ParsedDiffLine[])[],
  lang: string,
  appearance: HighlightAppearance,
): () => void {
  const key = `${lang}:${appearance}`;
  const cancels = hunkLines.flatMap((lines) => highlightHunk(lines, lang, appearance, key));
  return () => {
    for (const cancel of cancels) cancel();
  };
}
