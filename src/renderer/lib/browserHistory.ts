/**
 * Visited-page history for the browser pane's address bar. Persisted to
 * localStorage so it survives app restarts (the native webviews and their
 * in-memory history do not). Reads tolerate missing/corrupt values.
 */

export interface BrowserHistoryEntry {
  url: string;
  title: string | null;
  /** Epoch ms of the most recent visit. */
  visitedAt: number;
}

export const BROWSER_HISTORY_KEY = "argmax.browser.history";
const MAX_ENTRIES = 200;
export const MAX_SUGGESTIONS = 6;

function readEntries(): BrowserHistoryEntry[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(BROWSER_HISTORY_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is BrowserHistoryEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as BrowserHistoryEntry).url === "string" &&
      typeof (entry as BrowserHistoryEntry).visitedAt === "number"
  );
}

function writeEntries(entries: BrowserHistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(entries));
  } catch {
    // Quota or private mode: history is a convenience, never an error.
  }
}

/** Record a visit: bumps an existing URL to the top, keeps its title unless a
 *  fresh one arrives, and caps the list at {@link MAX_ENTRIES}. */
export function recordBrowserVisit(url: string, title: string | null): void {
  if (!/^https?:/.test(url)) return;
  const entries = readEntries();
  const existing = entries.find((entry) => entry.url === url);
  const entry: BrowserHistoryEntry = {
    url,
    title: title ?? existing?.title ?? null,
    visitedAt: Date.now()
  };
  const next = [entry, ...entries.filter((candidate) => candidate.url !== url)];
  writeEntries(next.slice(0, MAX_ENTRIES));
}

/** Most recent visits matching the query (case-insensitive substring on URL
 *  and title). An empty query returns the most recent visits. */
export function suggestBrowserHistory(query: string): BrowserHistoryEntry[] {
  const needle = query.trim().toLowerCase();
  const entries = readEntries();
  const matches = needle
    ? entries.filter(
        (entry) =>
          entry.url.toLowerCase().includes(needle) ||
          (entry.title ?? "").toLowerCase().includes(needle)
      )
    : entries;
  return matches.slice(0, MAX_SUGGESTIONS);
}
