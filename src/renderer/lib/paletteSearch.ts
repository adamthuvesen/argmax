import uFuzzy from "@leeoniya/ufuzzy";
import type { LucideIcon } from "lucide-react";

export type PaletteGroup =
  | "Actions"
  | "Sessions"
  | "Projects"
  | "Files"
  | "Messages"
  | "Contents"
  | "Settings";

export interface PaletteItem {
  id: string;
  label: string;
  /** Secondary text shown inline after the label — a file's directory, an action's blurb. */
  subtitle?: string;
  /**
   * Trailing text pinned to the row's right edge — the project a session belongs
   * to. Rows carry either this or a subtitle, never both.
   */
  meta?: string;
  group: PaletteGroup;
  /**
   * Per-item glyph. Actions each carry their own (New Session → Plus, etc.);
   * homogeneous groups (Projects, Sessions, Files) fall back to a group icon
   * so a row's type stays legible once results interleave and headers scroll off.
   */
  icon?: LucideIcon;
  /**
   * Leave the palette open after `run` — for stepwise commands (larger /
   * smaller text) the user repeats while watching the app behind the dialog.
   */
  keepOpen?: boolean;
  run: () => void;
}

export interface PaletteHit {
  item: PaletteItem;
  labelRanges: number[] | null;
  subtitleRanges: number[] | null;
  matchRank?: number;
}

/** Lower is better. Fuzzy order breaks ties, preserving recency for equal hits. */
export function searchMatchRank(text: string, rawQuery: string): number {
  const value = text.toLocaleLowerCase().trim();
  const query = rawQuery.toLocaleLowerCase().trim();
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  const words = value.split(/[\s/\\._-]+/u);
  if (words.some((word) => word === query)) return 2;
  const terms = query.split(/\s+/u);
  if (terms.every((term) => words.some((word) => word.startsWith(term)))) return 3;
  if (value.includes(query)) return 4;
  return 5;
}

// Single-error typo tolerance (one substitution/transposition/insertion/deletion
// per term), strict left boundary so "dash" matches "dashboard" but not the
// "dash" inside "redashed". Inserts allowed on the right so partial prefixes
// keep matching.
const fuzzy = new uFuzzy({
  intraMode: 1,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
  intraDel: 1,
  interLft: 2,
  interRgt: 1
});

// File-path matcher: same left-boundary strictness so "src" matches
// "src-tauri/src" but not the "src" inside "rsrc", *but* `interRgt: 0` so a
// prefix like "AG" still matches "AGENTS.md" — the right edge of a typed
// prefix is almost never at a non-alphanumeric character.
const filePathFuzzy = new uFuzzy({
  intraMode: 1,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
  intraDel: 1,
  interLft: 2,
  interRgt: 0
});

const EMPTY_RANGES: number[] = [];

export function searchFilePaths(paths: string[], rawQuery: string, limit = 50): string[] {
  if (paths.length === 0) return [];
  const query = rawQuery.trim();
  if (!query) {
    return paths.slice(0, limit);
  }
  const [idxs, info, order] = filePathFuzzy.search(paths, query, 1, 1000);
  if (!idxs) return [];
  const ranked = info && order?.length ? order.map((index) => info.idx[index]) : idxs;
  const pathQuery = /[/\\]/u.test(query);
  return ranked.map((index) => {
    const path = paths[index];
    const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
    const nameRank = searchMatchRank(name, query);
    return {
      path,
      rank: pathQuery ? searchMatchRank(path, query)
        : nameRank < 5 ? nameRank : 6 + searchMatchRank(path, query)
    };
  }).sort((left, right) => left.rank - right.rank).slice(0, limit).map(({ path }) => path);
}

export function searchPaletteItems(items: PaletteItem[], rawQuery: string): PaletteHit[] {
  const query = rawQuery.trim();
  if (!query) {
    return items.map((item) => ({ item, labelRanges: null, subtitleRanges: null }));
  }
  if (items.length === 0) return [];

  const labels = items.map((item) => item.label);
  const labelHits = rankBy(items, labels, query, "label");

  const matched = new Set(labelHits.map((hit) => hit.item.id));
  const remaining = items.filter((item) => secondaryText(item) && !matched.has(item.id));
  const subtitleHits =
    remaining.length > 0
      ? rankBy(remaining, remaining.map(secondaryText), query, "subtitle")
      : [];

  for (const hit of subtitleHits) matched.add(hit.item.id);
  const combinedItems = items.filter((item) => secondaryText(item) && !matched.has(item.id));
  const combinedHits = rankBy(combinedItems,
    combinedItems.map((item) => `${item.label} ${secondaryText(item)}`), query, "label");
  for (const hit of combinedHits) {
    const offset = hit.item.label.length + 1;
    const ranges = hit.labelRanges ?? [];
    hit.labelRanges = [];
    hit.subtitleRanges = [];
    for (let index = 0; index < ranges.length; index += 2) {
      const start = ranges[index];
      const end = ranges[index + 1];
      if (start < offset - 1) hit.labelRanges.push(start, Math.min(end, offset - 1));
      if (end > offset) hit.subtitleRanges.push(Math.max(0, start - offset), end - offset);
    }
    hit.matchRank = 6 + (hit.matchRank ?? 5);
  }
  return [...labelHits, ...subtitleHits, ...combinedHits]
    .sort((left, right) => (left.matchRank ?? 5) - (right.matchRank ?? 5));
}

/** The row's one piece of secondary text, wherever it renders. */
function secondaryText(item: PaletteItem): string {
  return item.meta ?? item.subtitle ?? "";
}

function rankBy(
  items: PaletteItem[],
  haystack: string[],
  needle: string,
  field: "label" | "subtitle"
): PaletteHit[] {
  // outOfOrder=1 lets "settings open" match "Open Settings". infoThresh=1000
  // keeps the info pass cheap on large haystacks.
  const [idxs, info, order] = fuzzy.search(haystack, needle, 1, 1000);
  if (!idxs) return [];
  if (!info || !order) {
    // Large sets and out-of-order terms can skip uFuzzy's detail pass.
    // Highlight literal terms without guessing the position of a typo match.
    const terms = needle.split(/\s+/u).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const literalTerms = new RegExp(terms.join("|"), "giu");
    return idxs.map((idx) => {
      const ranges = Array.from(haystack[idx].matchAll(literalTerms))
        .flatMap((match) => [match.index, match.index + match[0].length]);
      return {
        item: items[idx],
        labelRanges: field === "label" ? ranges : null,
        subtitleRanges: field === "subtitle" ? ranges : null,
        matchRank: searchMatchRank(haystack[idx], needle) + (field === "subtitle" ? 6 : 0)
      };
    }).sort((left, right) => left.matchRank - right.matchRank);
  }
  const hits: PaletteHit[] = [];
  for (let i = 0; i < order.length; i++) {
    const infoIdx = order[i];
    const itemIdx = info.idx[infoIdx];
    const ranges = info.ranges[infoIdx] ?? EMPTY_RANGES;
    hits.push({
      item: items[itemIdx],
      matchRank: searchMatchRank(haystack[itemIdx], needle) + (field === "subtitle" ? 6 : 0),
      labelRanges: field === "label" ? ranges : null,
      subtitleRanges: field === "subtitle" ? ranges : null
    });
  }
  return hits.sort((left, right) => (left.matchRank ?? 5) - (right.matchRank ?? 5));
}

type HighlightSegment = { text: string; matched: boolean };

/**
 * Parses an FTS5 snippet string that wraps matched tokens in `<b>...</b>` (the
 * marker pair we configure in the snippet() call). Returns React-renderable
 * segments without going through `dangerouslySetInnerHTML` — the bold markers
 * are emitted by SQLite, so we trust them, but any user-content bytes between
 * markers are rendered as plain text.
 */
export function parseFtsSnippet(raw: string): HighlightSegment[] {
  if (!raw) return [];
  const segments: HighlightSegment[] = [];
  const pattern = /<b>(.*?)<\/b>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: raw.slice(cursor, match.index), matched: false });
    }
    if (match[1].length > 0) {
      segments.push({ text: match[1], matched: true });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < raw.length) {
    segments.push({ text: raw.slice(cursor), matched: false });
  }
  return segments;
}

/**
 * Splits a string into matched / unmatched segments using uFuzzy's range
 * output. Returns a list of segments the caller can render — keeps the
 * highlight pipeline free of `dangerouslySetInnerHTML`.
 */
export function highlightSegments(text: string, ranges: number[] | null): HighlightSegment[] {
  if (!ranges || ranges.length === 0) return [{ text, matched: false }];
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    const start = ranges[i];
    const end = ranges[i + 1];
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), matched: false });
    }
    if (end > start) {
      segments.push({ text: text.slice(start, end), matched: true });
    }
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), matched: false });
  }
  return segments;
}
