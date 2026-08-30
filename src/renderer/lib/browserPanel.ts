/**
 * Open-in-browser-pane request bus. Deeply nested chat content (markdown
 * links) asks for the pane without threading a callback through every layer;
 * App subscribes once and owns the panel state.
 */

const OPEN_EVENT = "argmax:browser-panel-open";

/** Start page when the pane (or a fresh tab) is opened without a target. */
export const DEFAULT_BROWSER_URL = "https://www.google.com";

// Where the pane last was, surviving a close: the native webview is hidden
// rather than destroyed, so reopening at the same URL matches what the
// restored webview actually shows.
let lastUrl: string | null = null;

export function openInBrowserPanel(url: string): void {
  lastUrl = url;
  window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: url }));
}

/** Open the pane without a target: the last browsed URL, or the start page. */
export function openBrowserPanel(): void {
  openInBrowserPanel(lastUrl ?? DEFAULT_BROWSER_URL);
}

/** Called on in-page navigation so a reopen lands where the user browsed to. */
export function rememberBrowserUrl(url: string): void {
  if (url.length > 0) lastUrl = url;
}

// --- Tab store --------------------------------------------------------------
// Module-level so tabs survive the panel unmounting: the native webviews stay
// alive (hidden) when the pane closes, and this list is what maps them back to
// a tab strip on reopen. Ids are never reused within an app run — they become
// native webview labels, and a destroyed label must not come back. The list
// also persists to localStorage so a restart restores the strip; the webviews
// themselves die with the process and are recreated lazily on activation.

export interface BrowserTab {
  id: string;
  url: string;
  title: string | null;
  /** True while the tab's page is loading. Not persisted. */
  loading: boolean;
}

const TABS_KEY = "argmax.browser.tabs";

let tabs: BrowserTab[] = [];
let activeTabId: string | null = null;
let nextTabSeq = 1;
/** Tabs whose native webview exists in THIS app run. A restored tab is not
 *  materialized until its first activation recreates the webview. */
const materializedTabs = new Set<string>();
const tabListeners = new Set<() => void>();

function persistTabs(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      TABS_KEY,
      JSON.stringify({
        activeTabId,
        nextTabSeq,
        tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title }))
      })
    );
  } catch {
    // Tab restoration is a convenience, never an error.
  }
}

function restoreTabs(): void {
  if (typeof window === "undefined") return;
  const raw = window.localStorage.getItem(TABS_KEY);
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const snapshot = parsed as {
    activeTabId?: unknown;
    nextTabSeq?: unknown;
    tabs?: unknown;
  };
  if (!Array.isArray(snapshot.tabs)) return;
  const restored = snapshot.tabs.filter(
    (tab): tab is { id: string; url: string; title: string | null } =>
      typeof tab === "object" &&
      tab !== null &&
      typeof (tab as { id: unknown }).id === "string" &&
      // Ids become native webview labels; a corrupted one would make the
      // tab permanently un-openable (Rust rejects non-slug labels).
      /^[a-z0-9-]{1,32}$/.test((tab as { id: string }).id) &&
      typeof (tab as { url: unknown }).url === "string"
  );
  if (restored.length === 0) return;
  tabs = restored.map((tab) => ({
    id: tab.id,
    url: tab.url,
    title: typeof tab.title === "string" ? tab.title : null,
    loading: false
  }));
  activeTabId =
    typeof snapshot.activeTabId === "string" && tabs.some((tab) => tab.id === snapshot.activeTabId)
      ? snapshot.activeTabId
      : (tabs[0]?.id ?? null);
  // Never below max(restored ids)+1 — a colliding id would map two tabs onto
  // one native webview label.
  const highestRestoredSeq = tabs.reduce((highest, tab) => {
    const match = /^tab-(\d+)$/.exec(tab.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  const persistedSeq =
    typeof snapshot.nextTabSeq === "number" && Number.isFinite(snapshot.nextTabSeq)
      ? Math.floor(snapshot.nextTabSeq)
      : 0;
  nextTabSeq = Math.max(1, persistedSeq, highestRestoredSeq + 1);
  lastUrl = tabs.find((tab) => tab.id === activeTabId)?.url ?? lastUrl;
}

restoreTabs();

function notifyTabListeners(): void {
  persistTabs();
  for (const listener of tabListeners) listener();
}

/** True when the tab's native webview exists in this app run. */
export function isBrowserTabMaterialized(id: string): boolean {
  return materializedTabs.has(id);
}

export function markBrowserTabMaterialized(id: string): void {
  materializedTabs.add(id);
}

/** Failed webview creation: forget the mark so the next activation retries
 *  instead of leaving a zombie tab whose every command hits a dead label. */
export function unmarkBrowserTabMaterialized(id: string): void {
  materializedTabs.delete(id);
}

export function setBrowserTabLoading(id: string, loading: boolean): void {
  const index = tabs.findIndex((tab) => tab.id === id);
  const current = tabs[index];
  if (!current || current.loading === loading) return;
  const next = [...tabs];
  next[index] = { ...current, loading };
  tabs = next;
  notifyTabListeners();
}

export function subscribeBrowserTabs(listener: () => void): () => void {
  tabListeners.add(listener);
  return () => tabListeners.delete(listener);
}

/** Stable snapshot for useSyncExternalStore: `tabs` is replaced, never mutated. */
export function getBrowserTabs(): BrowserTab[] {
  return tabs;
}

export function getActiveBrowserTabId(): string | null {
  return activeTabId;
}

export function createBrowserTab(url: string, activate = true): BrowserTab {
  const tab: BrowserTab = { id: `tab-${nextTabSeq}`, url, title: null, loading: false };
  nextTabSeq += 1;
  tabs = [...tabs, tab];
  if (activate) activeTabId = tab.id;
  notifyTabListeners();
  return tab;
}

export function activateBrowserTab(id: string): void {
  if (activeTabId === id || !tabs.some((tab) => tab.id === id)) return;
  activeTabId = id;
  notifyTabListeners();
}

/** URLs of closed tabs, most recent last — the ⌘⇧T reopen stack. Session
 *  only; a reopened tab gets a fresh id and webview. */
const recentlyClosedUrls: string[] = [];
const MAX_RECENTLY_CLOSED = 20;

export function popRecentlyClosedBrowserTab(): string | null {
  return recentlyClosedUrls.pop() ?? null;
}

/** Drops the tab and returns the neighbor to activate, if the closed tab was
 *  active. The caller owns destroying the native webview. */
export function removeBrowserTab(id: string): BrowserTab | null {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return null;
  const closed = tabs[index];
  if (closed) {
    recentlyClosedUrls.push(closed.url);
    if (recentlyClosedUrls.length > MAX_RECENTLY_CLOSED) recentlyClosedUrls.shift();
  }
  tabs = tabs.filter((tab) => tab.id !== id);
  materializedTabs.delete(id);
  let nextActive: BrowserTab | null = null;
  if (activeTabId === id) {
    nextActive = tabs[Math.min(index, tabs.length - 1)] ?? null;
    activeTabId = nextActive?.id ?? null;
  }
  notifyTabListeners();
  return nextActive;
}

/** Test-only: clears tabs, the id counter, and persisted state. */
export function resetBrowserTabsForTests(): void {
  tabs = [];
  activeTabId = null;
  nextTabSeq = 1;
  materializedTabs.clear();
  recentlyClosedUrls.length = 0;
  if (typeof window !== "undefined") window.localStorage.removeItem(TABS_KEY);
  for (const listener of tabListeners) listener();
}

export function updateBrowserTabState(id: string, url: string, title: string | null): void {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  const current = tabs[index];
  if (!current || (current.url === url && (title === null || current.title === title))) return;
  const next = [...tabs];
  next[index] = { ...current, url, title: title ?? current.title };
  tabs = next;
  notifyTabListeners();
}

const CLOSE_ACTIVE_TAB_EVENT = "argmax:browser-close-active-tab";

/** Menu ⌘W lands here when the browser pane is open: close the active tab.
 *  A bus event because App owns the menu wiring and BrowserPanel owns the
 *  tab-close flow (webview teardown, neighbor activation, last-tab close). */
export function requestCloseActiveBrowserTab(): void {
  window.dispatchEvent(new CustomEvent(CLOSE_ACTIVE_TAB_EVENT));
}

export function onBrowserCloseActiveTabRequest(listener: () => void): () => void {
  window.addEventListener(CLOSE_ACTIVE_TAB_EVENT, listener);
  return () => window.removeEventListener(CLOSE_ACTIVE_TAB_EVENT, listener);
}

export function onBrowserPanelRequest(listener: (url: string) => void): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<string>).detail;
    if (typeof detail === "string" && detail.length > 0) listener(detail);
  };
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}

/**
 * Turn address-bar input into a navigable URL: pass http(s) through, refuse
 * other schemes, and treat everything else ("github.com", "localhost:3000")
 * as an https host. Returns null when the input can't become a web URL.
 */
export function normalizeBrowserUrl(raw: string): string | null {
  const input = raw.trim();
  if (input.length === 0) return null;
  if (/^https?:\/\//i.test(input)) return input;
  // A colon followed by digits is a port ("localhost:5173"), not a scheme.
  if (/^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(input)) return null;
  if (/\s/.test(input)) return null;
  const host = input.split(/[/?#]/, 1)[0] ?? "";
  if (!host.includes(".") && !host.startsWith("localhost")) return null;
  return `https://${input}`;
}

/**
 * Address-bar input → destination: a URL when the input reads as one,
 * otherwise a Google search for it (matching every mainstream browser).
 * Null only for blank input.
 */
export function resolveBrowserInput(raw: string): string | null {
  const normalized = normalizeBrowserUrl(raw);
  if (normalized) return normalized;
  const query = raw.trim();
  if (query.length === 0) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
