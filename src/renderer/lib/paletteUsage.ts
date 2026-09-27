/**
 * What the user picks from ⌘K, so the palette learns their habits. Two
 * signals, both decaying with a one-week half-life so old habits fade:
 *
 * - per item: how often and how recently it was picked (frecency);
 * - per typed query: which item was picked after typing it, so `us` → Open
 *   usage sticks after a pick or two, the way Alfred and Raycast learn.
 *
 * A per-device convenience in localStorage, like the other recency lists.
 */

export const PALETTE_USAGE_KEY = "argmax.palette.usage";

const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 300;
const MAX_QUERIES = 300;
const MAX_QUERY_LENGTH = 32;

interface UsageEntry {
  /** Pick weight, decayed as of `at`. */
  score: number;
  at: number;
}

export interface PaletteUsage {
  items: Record<string, UsageEntry>;
  /** Normalized query → item id → pick weight. */
  queries: Record<string, Record<string, UsageEntry>>;
}

const EMPTY_USAGE: PaletteUsage = { items: {}, queries: {} };

function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase().slice(0, MAX_QUERY_LENGTH);
}

function decayed(entry: UsageEntry | undefined, now: number): number {
  if (!entry) return 0;
  return entry.score * 2 ** (-Math.max(0, now - entry.at) / HALF_LIFE_MS);
}

function isEntry(value: unknown): value is UsageEntry {
  if (typeof value !== "object" || value === null) return false;
  const { score, at } = value as Record<string, unknown>;
  return typeof score === "number" && Number.isFinite(score) && typeof at === "number" && Number.isFinite(at);
}

function entriesOf(value: unknown): Record<string, UsageEntry> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => isEntry(entry)));
}

export function readPaletteUsage(): PaletteUsage {
  if (typeof window === "undefined") return EMPTY_USAGE;
  try {
    const raw = window.localStorage.getItem(PALETTE_USAGE_KEY);
    if (!raw) return EMPTY_USAGE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_USAGE;
    const { items, queries } = parsed as Record<string, unknown>;
    return {
      items: entriesOf(items),
      queries: typeof queries === "object" && queries !== null
        ? Object.fromEntries(Object.entries(queries).map(([query, picks]) => [query, entriesOf(picks)]))
        : {}
    };
  } catch {
    // Unreadable storage only costs the learned ranking, never the palette.
    return EMPTY_USAGE;
  }
}

/** Keeps the `limit` heaviest keys, so storage stays bounded. */
function prune<T>(record: Record<string, T>, limit: number, weight: (value: T) => number): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= limit) return record;
  return Object.fromEntries(
    keys.sort((left, right) => weight(record[right]) - weight(record[left]))
      .slice(0, limit)
      .map((key) => [key, record[key]])
  );
}

export function recordPaletteUse(itemId: string, query: string, now = Date.now()): PaletteUsage {
  const usage = readPaletteUsage();
  const bump = (entry: UsageEntry | undefined): UsageEntry => ({ score: decayed(entry, now) + 1, at: now });
  const items = prune({ ...usage.items, [itemId]: bump(usage.items[itemId]) }, MAX_ITEMS,
    (entry) => decayed(entry, now));
  const normalized = normalizeQuery(query);
  let queries = usage.queries;
  if (normalized) {
    const picks = queries[normalized] ?? {};
    queries = prune({ ...queries, [normalized]: { ...picks, [itemId]: bump(picks[itemId]) } }, MAX_QUERIES,
      (entries) => Math.max(0, ...Object.values(entries).map((entry) => decayed(entry, now))));
  }
  const next = { items, queries };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(PALETTE_USAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota or private-mode failures only cost the learning.
    }
  }
  return next;
}

/** Decayed pick weight of one item, whatever was typed. */
export function itemFrecency(usage: PaletteUsage, itemId: string, now = Date.now()): number {
  return decayed(usage.items[itemId], now);
}

/**
 * Pick weight per item learned for this query. A pick counts when it was made
 * after typing a prefix of the query or a continuation of it: picking Open
 * usage after `usa` teaches both `us` and `usage`.
 */
export function learnedPicks(usage: PaletteUsage, query: string, now = Date.now()): Map<string, number> {
  const normalized = normalizeQuery(query);
  const learned = new Map<string, number>();
  if (!normalized) return learned;
  for (const [typed, picks] of Object.entries(usage.queries)) {
    if (!typed.startsWith(normalized) && !normalized.startsWith(typed)) continue;
    for (const [itemId, entry] of Object.entries(picks)) {
      learned.set(itemId, (learned.get(itemId) ?? 0) + decayed(entry, now));
    }
  }
  return learned;
}

/**
 * How far usage lifts a hit, in match-rank tiers (lower rank wins). Habit
 * alone is worth up to one and a half tiers, so a clearly better text match
 * still leads; a query-specific habit is worth up to four, enough to pin
 * the item a user keeps choosing for what they typed.
 */
export function usageBoost(frecency: number, learned: number): number {
  return Math.min(1.5, 0.5 * Math.log2(1 + frecency)) + Math.min(4, 2 * learned);
}
