/** Address-bar history, persisted independently of native tab navigation. */
import {
  indexedDbBrowserHistoryStorage,
  type BrowserHistoryStorage
} from "./browserHistoryStorage.js";

export interface BrowserHistoryEntry {
  url: string;
  title: string | null;
  /** Epoch ms of the most recent visit. */
  visitedAt: number;
  /** Absent in history saved before Chrome import was introduced. */
  visitCount?: number;
}

export const BROWSER_HISTORY_KEY = "argmax.browser.history";
const MAX_ENTRIES = 10_000;
export const MAX_SUGGESTIONS = 6;

function isHistoryEntry(entry: unknown): entry is BrowserHistoryEntry {
  return typeof entry === "object" && entry !== null &&
    "url" in entry && typeof entry.url === "string" && /^https?:\/\//i.test(entry.url) &&
    "title" in entry && (entry.title === null || typeof entry.title === "string") &&
    "visitedAt" in entry && typeof entry.visitedAt === "number" &&
    Number.isFinite(entry.visitedAt) && entry.visitedAt >= 0 &&
    (!("visitCount" in entry) || (typeof entry.visitCount === "number" &&
      Number.isSafeInteger(entry.visitCount) && entry.visitCount >= 0));
}

let cachedEntries: BrowserHistoryEntry[] = [];
let legacyRaw: string | null | undefined;
let historyStorage: BrowserHistoryStorage = indexedDbBrowserHistoryStorage;
let initializationPromise: Promise<void> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

function readLegacyEntries(): BrowserHistoryEntry[] {
  if (legacyRaw !== undefined || typeof window === "undefined") return cachedEntries;
  try {
    legacyRaw = window.localStorage.getItem(BROWSER_HISTORY_KEY);
  } catch {
    legacyRaw = null;
  }
  if (!legacyRaw) return cachedEntries;
  try {
    const parsed: unknown = JSON.parse(legacyRaw);
    if (Array.isArray(parsed)) cachedEntries = parsed.filter(isHistoryEntry);
  } catch {
    // A corrupt legacy cache must not prevent navigation.
  }
  return cachedEntries;
}

function combineEntries(
  existing: BrowserHistoryEntry[],
  additions: BrowserHistoryEntry[]
): BrowserHistoryEntry[] {
  const merged = new Map(existing.map((entry) => [entry.url, entry]));
  for (const entry of additions) {
    const previous = merged.get(entry.url);
    const latest = previous && previous.visitedAt > entry.visitedAt ? previous : entry;
    merged.set(entry.url, {
      ...latest,
      title: latest.title ?? previous?.title ?? entry.title,
      visitedAt: Math.max(previous?.visitedAt ?? 0, entry.visitedAt),
      visitCount: Math.max(previous ? (previous.visitCount ?? 1) : 0, entry.visitCount ?? 1)
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, MAX_ENTRIES);
}

function enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(mutation, mutation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Load IndexedDB once and migrate the former localStorage value atomically. */
export function initializeBrowserHistory(): Promise<void> {
  if (initializationPromise) return initializationPromise;
  const legacyEntries = readLegacyEntries();
  initializationPromise = (async () => {
    const stored = await historyStorage.load();
    if (stored !== undefined && (!Array.isArray(stored) || !stored.every(isHistoryEntry))) {
      throw new Error("Browser history storage contains invalid data.");
    }
    cachedEntries = combineEntries(stored ?? [], legacyEntries);
    if (legacyRaw !== null && legacyRaw !== undefined) {
      await historyStorage.save(cachedEntries);
      try {
        window.localStorage.removeItem(BROWSER_HISTORY_KEY);
      } catch {
        // The durable copy succeeded. Leaving the legacy value retries cleanup next launch.
      }
    }
  })().catch((error: unknown) => {
    initializationPromise = null;
    throw error;
  });
  return initializationPromise;
}

/** Import is idempotent: another import refreshes counts instead of adding them. */
export async function mergeBrowserHistory(imported: BrowserHistoryEntry[]): Promise<number> {
  if (!imported.every(isHistoryEntry)) throw new Error("Chrome returned invalid browser history.");
  await initializeBrowserHistory();
  return enqueueMutation(async () => {
    const previousUrls = new Set(cachedEntries.map((entry) => entry.url));
    const entries = combineEntries(cachedEntries, imported);
    try {
      await historyStorage.save(entries);
    } catch {
      throw new Error("Could not save imported history. Browser storage may be unavailable.");
    }
    cachedEntries = entries;
    return entries.filter((entry) => !previousUrls.has(entry.url)).length;
  });
}

/** Record a completed navigation, retaining a previously learned page title. */
export async function recordBrowserVisit(url: string, title: string | null): Promise<void> {
  if (typeof window === "undefined" || !/^https?:\/\//i.test(url)) return;
  await initializeBrowserHistory();
  await enqueueMutation(async () => {
    const existing = cachedEntries.find((entry) => entry.url === url);
    const entry: BrowserHistoryEntry = {
      url,
      title: title ?? existing?.title ?? null,
      visitedAt: Date.now(),
      visitCount: (existing?.visitCount ?? (existing ? 1 : 0)) + 1
    };
    const entries = [entry, ...cachedEntries.filter((candidate) => candidate.url !== url)]
      .slice(0, MAX_ENTRIES);
    cachedEntries = entries;
    await historyStorage.save(entries);
  });
}

const ADDRESS_PREFIX = /^https?:\/\/(www\.)?/;

/** Address-bar form of a URL: no scheme, no leading "www.". */
function addressForm(url: string): string {
  return url.replace(ADDRESS_PREFIX, "");
}

/**
 * Inline completion for what the user typed: the first suggestion whose address
 * *extends* it. A substring match can score well enough to lead
 * `suggestBrowserHistory`, but completing one would rewrite the characters the
 * user typed, so only a prefix qualifies. The entry comes back with it, because
 * the completed text drops the scheme and `www.` and resolving it again would
 * visit a different host than the one that was visited before.
 */
export function completeBrowserAddress(
  typed: string,
  suggestions: readonly BrowserHistoryEntry[]
): { entry: BrowserHistoryEntry; completed: string } | null {
  if (typed.length === 0 || /\s/.test(typed)) return null;
  const needle = typed.toLowerCase();
  for (const entry of suggestions) {
    // A root URL completes to the bare host, the way an address bar shows it.
    const address = addressForm(entry.url).replace(/^([^/]+)\/$/, "$1");
    for (const candidate of [address, entry.url]) {
      if (candidate.length > typed.length && candidate.toLowerCase().startsWith(needle)) {
        return { entry, completed: typed + candidate.slice(typed.length) };
      }
    }
  }
  return null;
}

/** Match URL and title, preferring address prefixes and frequent, recent pages. */
export function suggestBrowserHistory(query: string): BrowserHistoryEntry[] {
  const needle = query.trim().toLowerCase();
  const entries = readLegacyEntries();
  if (!needle) return entries.slice(0, MAX_SUGGESTIONS);
  const words = needle.split(/\s+/);
  const now = Date.now();
  return entries.flatMap((entry) => {
    const url = entry.url.toLowerCase();
    const text = `${url} ${(entry.title ?? "").toLowerCase()}`;
    if (!words.every((word) => text.includes(word))) return [];
    const address = addressForm(url);
    const ageDays = Math.max(0, now - entry.visitedAt) / 86_400_000;
    const score = (address.startsWith(needle) || url.startsWith(needle) ? 20 : 0) +
      Math.log2(1 + (entry.visitCount ?? 1)) + 10 / (1 + ageDays / 7);
    return [{ entry, score }];
  }).sort((a, b) => b.score - a.score || b.entry.visitedAt - a.entry.visitedAt)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ entry }) => entry);
}

/** Replace the persistence boundary and reset module state between unit tests. */
export function setBrowserHistoryStorageForTests(storage: BrowserHistoryStorage): void {
  historyStorage = storage;
  cachedEntries = [];
  legacyRaw = undefined;
  initializationPromise = null;
  mutationQueue = Promise.resolve();
}
