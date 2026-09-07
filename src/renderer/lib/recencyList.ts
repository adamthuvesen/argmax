/** Ordered id lists in localStorage: most recently used first. */

const MAX_RECENCY = 32;

export function readIdRecency(key: string): string[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

export function touchIdRecency(key: string, id: string): string[] {
  if (id.length === 0) return readIdRecency(key);
  const next = [id, ...readIdRecency(key).filter((item) => item !== id)].slice(0, MAX_RECENCY);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Quota or private-mode failures are non-fatal for recency prefs.
    }
  }
  return next;
}

export function sortByIdRecency<T>(
  items: readonly T[],
  recency: readonly string[],
  idOf: (item: T) => string
): T[] {
  if (recency.length === 0) return [...items];
  const rank = new Map(recency.map((id, index) => [id, index]));
  return [...items].sort((left, right) => {
    const leftRank = rank.get(idOf(left)) ?? Infinity;
    const rightRank = rank.get(idOf(right)) ?? Infinity;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return 0;
  });
}
