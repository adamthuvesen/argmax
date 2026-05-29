import uFuzzy from "@leeoniya/ufuzzy";

export type PaletteGroup = "Actions" | "Sessions" | "Projects" | "Files" | "Messages";

export interface PaletteItem {
  id: string;
  label: string;
  subtitle?: string;
  group: PaletteGroup;
  run: () => void;
}

export interface PaletteHit {
  item: PaletteItem;
  labelRanges: number[] | null;
  subtitleRanges: number[] | null;
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
  if (info && order && order.length > 0) {
    const out: string[] = [];
    for (let i = 0; i < order.length && out.length < limit; i++) {
      out.push(paths[info.idx[order[i]]]);
    }
    return out;
  }
  // Fallback: info-pass produced no ranked order (uFuzzy can return this even
  // when `idxs` has pre-filter hits — e.g. a prefix that doesn't satisfy the
  // right-boundary rule). Use the pre-filter idxs in haystack order.
  const out: string[] = [];
  for (let i = 0; i < idxs.length && out.length < limit; i++) {
    out.push(paths[idxs[i]]);
  }
  return out;
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
  const remaining = items.filter((item) => item.subtitle && !matched.has(item.id));
  const subtitleHits =
    remaining.length > 0
      ? rankBy(
          remaining,
          remaining.map((item) => item.subtitle ?? ""),
          query,
          "subtitle"
        )
      : [];

  return [...labelHits, ...subtitleHits];
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
    // Pre-filter matched but the result set exceeded infoThresh; return idxs
    // in haystack order without highlight ranges.
    return idxs.map((idx) => ({
      item: items[idx],
      labelRanges: null,
      subtitleRanges: null
    }));
  }
  const hits: PaletteHit[] = [];
  for (let i = 0; i < order.length; i++) {
    const infoIdx = order[i];
    const itemIdx = info.idx[infoIdx];
    const ranges = info.ranges[infoIdx] ?? EMPTY_RANGES;
    hits.push({
      item: items[itemIdx],
      labelRanges: field === "label" ? ranges : null,
      subtitleRanges: field === "subtitle" ? ranges : null
    });
  }
  return hits;
}

export type HighlightSegment = { text: string; matched: boolean };

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
