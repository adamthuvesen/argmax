// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_HISTORY_KEY,
  completeBrowserAddress,
  initializeBrowserHistory,
  mergeBrowserHistory,
  recordBrowserVisit,
  setBrowserHistoryStorageForTests,
  suggestBrowserHistory,
  type BrowserHistoryEntry
} from "./browserHistory.js";
import type { BrowserHistoryStorage } from "./browserHistoryStorage.js";

let saved: BrowserHistoryEntry[] | undefined;
let failLoad = false;
let failSave = false;
let loadHistory: () => Promise<unknown>;

const storage: BrowserHistoryStorage = {
  load: vi.fn(() => {
    if (failLoad) return Promise.reject(new Error("database unavailable"));
    return loadHistory();
  }),
  save: vi.fn((entries: BrowserHistoryEntry[]) => {
    if (failSave) return Promise.reject(new Error("disk full"));
    saved = structuredClone(entries);
    return Promise.resolve();
  })
};

beforeEach(() => {
  saved = undefined;
  failLoad = false;
  failSave = false;
  loadHistory = () => Promise.resolve(saved);
  window.localStorage.removeItem(BROWSER_HISTORY_KEY);
  setBrowserHistoryStorageForTests(storage);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.removeItem(BROWSER_HISTORY_KEY);
});

describe("browser history", () => {
  it("retains imported pages beyond the old cap after browsing and reloading", async () => {
    const imported = Array.from({ length: 250 }, (_, index) => ({
      url: `https://example.com/page-${index}/`, title: `Page ${index}`,
      visitedAt: 1_700_000_000_000 + index, visitCount: 3
    }));
    expect(await mergeBrowserHistory(imported)).toBe(250);
    await recordBrowserVisit("https://new.example.com", "New");
    setBrowserHistoryStorageForTests(storage);
    await initializeBrowserHistory();
    expect(suggestBrowserHistory("page-0/")[0]?.url).toBe(imported[0]?.url);
    expect(await mergeBrowserHistory(imported)).toBe(0);
    expect(suggestBrowserHistory("page-0/")[0]?.visitCount).toBe(3);
  });

  it("migrates legacy localStorage only after IndexedDB saves it", async () => {
    const legacy = [{ url: "https://legacy.example.com", title: "Legacy", visitedAt: 10, visitCount: 2 }];
    window.localStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(legacy));

    expect(suggestBrowserHistory("")).toEqual(legacy);
    await initializeBrowserHistory();

    expect(saved).toEqual(legacy);
    expect(window.localStorage.getItem(BROWSER_HISTORY_KEY)).toBeNull();
  });

  it("keeps legacy history when its IndexedDB migration fails", async () => {
    const legacy = [{ url: "https://legacy.example.com", title: null, visitedAt: 10 }];
    window.localStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(legacy));
    failSave = true;

    await expect(initializeBrowserHistory()).rejects.toThrow("disk full");

    expect(window.localStorage.getItem(BROWSER_HISTORY_KEY)).not.toBeNull();
    expect(suggestBrowserHistory("")).toEqual([{ ...legacy[0], visitCount: 1 }]);
  });

  it("retries initialization after a transient storage error", async () => {
    failLoad = true;
    await expect(initializeBrowserHistory()).rejects.toThrow("database unavailable");
    failLoad = false;

    await expect(initializeBrowserHistory()).resolves.toBeUndefined();
  });

  it("does not lose visits that arrive while IndexedDB is loading", async () => {
    let finishLoad: ((entries: BrowserHistoryEntry[]) => void) | undefined;
    loadHistory = () => new Promise((resolve) => { finishLoad = resolve; });

    const visit = recordBrowserVisit("https://new.example.com", "New");
    finishLoad?.([{ url: "https://stored.example.com", title: "Stored", visitedAt: 1, visitCount: 2 }]);
    await visit;

    expect(saved?.map((entry) => entry.url)).toEqual([
      "https://new.example.com",
      "https://stored.example.com"
    ]);
  });

  it("orders concurrent visit writes so neither update is overwritten", async () => {
    await Promise.all([
      recordBrowserVisit("https://first.example.com", "First"),
      recordBrowserVisit("https://second.example.com", "Second")
    ]);

    expect(saved?.map((entry) => entry.url).sort()).toEqual([
      "https://first.example.com",
      "https://second.example.com"
    ]);
  });

  it("merges counts without losing a newer local visit or inflating repeat imports", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    await recordBrowserVisit("https://example.com", "Local title");
    const imported = [{ url: "https://example.com", title: "Old title", visitedAt: 1_000, visitCount: 12 }];
    expect(await mergeBrowserHistory(imported)).toBe(0);
    expect(await mergeBrowserHistory(imported)).toBe(0);
    expect(suggestBrowserHistory("")[0]).toEqual({
      url: "https://example.com", title: "Local title", visitedAt: 5_000, visitCount: 12
    });
  });

  it("ranks address prefixes first, then rewards frequent and recent visits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const visitedAt = Date.now();
    await mergeBrowserHistory([
      { url: "https://other.com", title: "GitHub", visitedAt, visitCount: 30 },
      { url: "https://github.com/once", title: "Once", visitedAt, visitCount: 1 },
      { url: "https://github.com/often", title: "Often", visitedAt, visitCount: 8 },
      { url: "https://github.com/old", title: "Old", visitedAt: 1_000, visitCount: 8 }
    ]);
    expect(suggestBrowserHistory("github").map((entry) => entry.url)).toEqual([
      "https://github.com/often", "https://github.com/once", "https://github.com/old", "https://other.com"
    ]);
    expect(suggestBrowserHistory("github often")[0]?.url).toBe("https://github.com/often");
  });

  it("completes the first suggestion the typed address is a prefix of", () => {
    const entries: BrowserHistoryEntry[] = [
      // Leads the list on a substring match; completing it would rewrite "you".
      { url: "https://about.youtube.com/press", title: "Press", visitedAt: 2, visitCount: 9 },
      { url: "https://www.youtube.com/", title: "YouTube", visitedAt: 1, visitCount: 3 }
    ];

    expect(completeBrowserAddress("you", entries)).toEqual({ entry: entries[1], completed: "youtube.com" });
    expect(completeBrowserAddress("https://ab", entries)?.completed).toBe("https://about.youtube.com/press");
    expect(completeBrowserAddress("About.YouTube.com/p", entries)?.completed).toBe("About.YouTube.com/press");
  });

  it("leaves the input alone when no suggestion extends it", () => {
    const entries: BrowserHistoryEntry[] = [
      { url: "https://www.youtube.com/", title: "YouTube", visitedAt: 1, visitCount: 3 }
    ];

    for (const typed of ["", "youtube.com", "tube", "you tube"]) {
      expect(completeBrowserAddress(typed, entries)).toBeNull();
    }
  });

  it("reports persistence failure without replacing existing history", async () => {
    await recordBrowserVisit("https://kept.com", "Kept");
    failSave = true;
    await expect(mergeBrowserHistory([
      { url: "https://new.com", title: null, visitedAt: Date.now(), visitCount: 1 }
    ])).rejects.toThrow("Could not save imported history");
    expect(suggestBrowserHistory("").map((entry) => entry.url)).toEqual(["https://kept.com"]);
  });

  it("rejects malformed import data atomically", async () => {
    await recordBrowserVisit("https://kept.com", "Kept");
    await expect(mergeBrowserHistory([
      { url: "https://valid.com", title: null, visitedAt: 1_000 },
      { url: "file:///private", title: null, visitedAt: 1_000 }
    ])).rejects.toThrow("invalid browser history");
    expect(suggestBrowserHistory("").map((entry) => entry.url)).toEqual(["https://kept.com"]);
  });

  it("records visits newest-first and dedupes by URL, keeping the title", async () => {
    await recordBrowserVisit("https://github.com", "GitHub");
    await recordBrowserVisit("https://example.com", "Example");
    await recordBrowserVisit("https://github.com", null);

    const suggestions = suggestBrowserHistory("");
    expect(suggestions.map((entry) => entry.url)).toEqual([
      "https://github.com",
      "https://example.com"
    ]);
    expect(suggestions[0]?.title).toBe("GitHub");
  });

  it("matches on URL and title, case-insensitively", async () => {
    await recordBrowserVisit("https://github.com/argmax", "Argmax repo");
    await recordBrowserVisit("https://example.com", "Example");

    expect(suggestBrowserHistory("ARGMAX").map((entry) => entry.url)).toEqual([
      "https://github.com/argmax"
    ]);
    expect(suggestBrowserHistory("example.com").map((entry) => entry.url)).toEqual([
      "https://example.com"
    ]);
    expect(suggestBrowserHistory("nothing")).toEqual([]);
  });

  it("ignores non-web URLs and survives corrupt legacy storage", async () => {
    await recordBrowserVisit("about:blank", null);
    expect(suggestBrowserHistory("")).toEqual([]);

    setBrowserHistoryStorageForTests(storage);
    window.localStorage.setItem(BROWSER_HISTORY_KEY, "not json");
    expect(suggestBrowserHistory("")).toEqual([]);
    await recordBrowserVisit("https://github.com", "GitHub");
    expect(suggestBrowserHistory("")).toHaveLength(1);
  });
});
