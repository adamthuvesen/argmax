import type { GrammarState } from "shiki/core";
import type { ParsedDiffLine } from "./diff.js";
import { tokenizeLines, type HighlightAppearance, type HighlightToken } from "./highlighter.js";

/**
 * Syntax colors for diff hunks, computed off the render path in small slices.
 *
 * Highlighting each line with its own synchronous call froze the window for
 * three quarters of a second on a 2,800-line diff. Each hunk is now tokenized
 * as its two sides — the new file (context and additions) and the old one
 * (context and deletions) — so a string or comment that spans lines colors
 * correctly, in chunks that carry the grammar state forward, a few
 * milliseconds at a time. Lines render plain until their chunk lands.
 */

type HunkTokens = {
  key: string;
  tokens: (HighlightToken[] | undefined)[];
  version: number;
  listeners: Set<() => void>;
};

const hunks = new WeakMap<readonly ParsedDiffLine[], HunkTokens>();
const SLICE_MS = 6;
const CHUNK_LINES = 200;

function entryFor(lines: readonly ParsedDiffLine[]): HunkTokens {
  let entry = hunks.get(lines);
  if (!entry) {
    entry = { key: "", tokens: [], version: 0, listeners: new Set() };
    hunks.set(lines, entry);
  }
  return entry;
}

export function subscribeHunkTokens(lines: readonly ParsedDiffLine[], listener: () => void): () => void {
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
  index: number
): HighlightToken[] | undefined {
  const entry = hunks.get(lines);
  return entry && entry.key === key ? entry.tokens[index] : undefined;
}

function* tokenizeHunk(
  lines: readonly ParsedDiffLine[],
  lang: string,
  appearance: HighlightAppearance,
  key: string
): Generator<void, void, void> {
  const entry = entryFor(lines);
  if (entry.key === key && entry.tokens.length === lines.length && !entry.tokens.includes(undefined)) return;
  entry.key = key;
  entry.tokens = new Array<HighlightToken[] | undefined>(lines.length);
  // Context lines take their colors from the new side; the old side runs
  // through them only to keep its grammar state honest.
  const sides: { indices: number[]; owns: (line: ParsedDiffLine) => boolean }[] = [
    { indices: [], owns: (line) => line.kind !== "deletion" },
    { indices: [], owns: (line) => line.kind === "deletion" }
  ];
  lines.forEach((line, index) => {
    if (line.kind !== "deletion") sides[0].indices.push(index);
    if (line.kind !== "addition") sides[1].indices.push(index);
  });
  for (const side of sides) {
    if (!side.indices.some((index) => side.owns(lines[index]))) continue;
    let state: GrammarState | undefined;
    for (let start = 0; start < side.indices.length; start += CHUNK_LINES) {
      const chunk = side.indices.slice(start, start + CHUNK_LINES);
      const result = tokenizeLines(chunk.map((index) => lines[index].content).join("\n"), lang, appearance, state);
      if (!result || entry.key !== key) return;
      state = result.grammarState;
      chunk.forEach((index, offset) => {
        if (side.owns(lines[index])) entry.tokens[index] = result.lines[offset] ?? [{ content: lines[index].content }];
      });
      entry.version += 1;
      for (const listener of entry.listeners) listener();
      yield;
    }
  }
}

/**
 * Colors every hunk in `blocks`, a slice at a time between frames, in
 * document order. Returns a cancel for when the diff or theme changes.
 */
export function highlightHunksInSlices(
  hunkLines: readonly (readonly ParsedDiffLine[])[],
  lang: string,
  appearance: HighlightAppearance
): () => void {
  const key = `${lang}:${appearance}`;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const work = (function* () {
    for (const lines of hunkLines) yield* tokenizeHunk(lines, lang, appearance, key);
  })();
  const slice = (): void => {
    timer = null;
    const deadline = performance.now() + SLICE_MS;
    while (!cancelled && performance.now() < deadline) {
      if (work.next().done) return;
    }
    if (!cancelled) timer = setTimeout(slice, 0);
  };
  timer = setTimeout(slice, 0);
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };
}
