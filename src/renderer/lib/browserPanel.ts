/**
 * Open-in-browser request store and browser-surface ownership. Deeply nested
 * chat content (markdown links) asks for the browser without threading a
 * callback through every layer; every review panel subscribes and the one
 * taking requests (the focused pane) switches itself to Browser mode.
 *
 * There is one native browser surface, so exactly one review panel shows it at
 * a time. The owner is whichever panel most recently entered Browser mode, not
 * the focused one: clicking into another pane's chat must not yank the page
 * away, while that pane switching to Browser takes it over deliberately.
 */

import type { BrowserTabInfo } from "../../shared/types.js";

/** Start page when the browser (or a fresh tab) is opened without a target. */
export const DEFAULT_BROWSER_URL = "https://www.google.com";

// Where the browser last was, surviving a close: the native webview is hidden
// rather than destroyed, so reopening at the same URL matches what the
// restored webview actually shows.
let lastUrl: string | null = null;

export interface BrowserOpenRequest {
  url: string;
  /** Bumped on every request: asking again for the URL the page is already on
   *  has to stay a change, or the panel never navigates back to it. */
  seq: number;
  /** Show this existing tab instead of navigating the active one. Set when a
   *  session's tab is what the pane was asked to show. */
  tabId?: string;
}

let openRequest: BrowserOpenRequest | null = null;
const requestListeners = new Set<() => void>();

export function openInBrowserPanel(url: string): void {
  lastUrl = url;
  openRequest = { url, seq: (openRequest?.seq ?? 0) + 1 };
  for (const listener of requestListeners) listener();
}

/** Open the browser without a target: where it last was, or the start page. */
export function openBrowserPanel(): void {
  openInBrowserPanel(lastBrowsedUrl());
}

/** The URL a reopen should land on: what the active webview still shows. */
export function lastBrowsedUrl(): string {
  return lastUrl ?? DEFAULT_BROWSER_URL;
}

export function subscribeBrowserRequest(listener: () => void): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore: replaced, never mutated. */
export function getBrowserRequest(): BrowserOpenRequest | null {
  return openRequest;
}

/** Called on in-page navigation so a reopen lands where the user browsed to. */
export function rememberBrowserUrl(url: string): void {
  if (url.length > 0) lastUrl = url;
}

// --- Surface ownership ------------------------------------------------------

let ownerId: string | null = null;
const ownerListeners = new Set<() => void>();

export function subscribeBrowserOwner(listener: () => void): () => void {
  ownerListeners.add(listener);
  return () => {
    ownerListeners.delete(listener);
  };
}

export function getBrowserOwnerId(): string | null {
  return ownerId;
}

/** Entering Browser mode takes the surface, demoting whoever held it. */
export function claimBrowserSurface(id: string): void {
  if (ownerId === id) return;
  ownerId = id;
  for (const listener of ownerListeners) listener();
}

/** No-op from a panel that no longer owns the surface: a demoted panel
 *  leaving Browser mode must not release the claim that displaced it. */
export function releaseBrowserSurface(id: string): void {
  if (ownerId !== id) return;
  ownerId = null;
  for (const listener of ownerListeners) listener();
}

/** Test-only: forgets the pending request, the owner, and the last URL. */
export function resetBrowserSurfaceForTests(): void {
  openRequest = null;
  ownerId = null;
  lastUrl = null;
  for (const listener of requestListeners) listener();
  for (const listener of ownerListeners) listener();
}

// --- Tab store --------------------------------------------------------------
// Module-level so tabs survive the panel unmounting: the native webviews stay
// alive (hidden) when the pane closes, and this list is what maps them back to
// a tab strip on reopen. Ids are never reused within an app run — they become
// native webview labels, and a destroyed label must not come back.
//
// The app, not this module, is the source of truth for which tabs exist: a
// session can open one with no pane on screen to ask. `applyBrowserTabs`
// folds in the `browser:tabs` push, and localStorage now only remembers URLs
// across a restart — the webviews themselves die with the process and are
// recreated lazily on activation.

export interface BrowserTab {
  id: string;
  url: string;
  title: string | null;
  /** True while the tab's page is loading. Not persisted. */
  loading: boolean;
  /** Session that opened the tab; null for tabs the user opened. */
  ownerSessionId: string | null;
  /** Label a session gave a set of related tabs. Not persisted: grouping
   *  belongs to the run that did the research. */
  group: string | null;
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
    loading: false,
    ownerSessionId: null,
    group: null
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
  const tab: BrowserTab = {
    id: `tab-${nextTabSeq}`,
    url,
    title: null,
    loading: false,
    ownerSessionId: null,
    group: null
  };
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
  registrySeen.clear();
  recentlyClosedUrls.length = 0;
  agentOpenRequest = null;
  tabSyncStarted = false;
  if (typeof window !== "undefined") window.localStorage.removeItem(TABS_KEY);
  for (const listener of tabListeners) listener();
  for (const listener of agentOpenListeners) listener();
}

// --- Mirroring the app's tab registry ---------------------------------------

/** Tabs the app has reported at least once. A tab that was in a push and then
 *  is not has been closed; one that has never appeared is either a restored
 *  URL with no webview yet or a local tab whose `browser:open` is still in
 *  flight, and dropping either would be a race. */
const registrySeen = new Set<string>();

/** Folds a `browser:tabs` push into the strip. */
export function applyBrowserTabs(incoming: readonly BrowserTabInfo[]): void {
  const byId = new Map(incoming.map((tab) => [tab.tabId, tab]));
  const next: BrowserTab[] = [];
  for (const tab of tabs) {
    const live = byId.get(tab.id);
    if (live) {
      next.push({
        id: tab.id,
        url: live.url,
        // The registry learns a title on load-finish; until then keep the one
        // the strip already showed rather than blanking the label.
        title: live.title ?? tab.title,
        loading: live.loading,
        ownerSessionId: live.ownerSessionId,
        group: live.group
      });
      byId.delete(tab.id);
    } else if (!registrySeen.has(tab.id)) {
      next.push(tab);
    }
  }
  // Whatever is left is new to this renderer — a tab a session just opened.
  for (const tab of incoming) {
    if (!byId.has(tab.tabId)) continue;
    next.push({
      id: tab.tabId,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      ownerSessionId: tab.ownerSessionId,
      group: tab.group
    });
    // The app created the webview, so it exists in this run already.
    materializedTabs.add(tab.tabId);
  }
  for (const tab of incoming) registrySeen.add(tab.tabId);

  const unchanged =
    next.length === tabs.length &&
    next.every((tab, index) => {
      const current = tabs[index];
      return (
        current !== undefined &&
        current.id === tab.id &&
        current.url === tab.url &&
        current.title === tab.title &&
        current.loading === tab.loading &&
        current.ownerSessionId === tab.ownerSessionId &&
        current.group === tab.group
      );
    });
  if (unchanged) return;
  tabs = next;
  if (activeTabId !== null && !tabs.some((tab) => tab.id === activeTabId)) {
    activeTabId = tabs[0]?.id ?? null;
  }
  notifyTabListeners();
}

// --- Agent-opened tabs ------------------------------------------------------

/**
 * A session opened a page. Addressed to the session rather than to a
 * component, because the pane showing it may not be mounted — same shape as
 * the ⌘J terminal request in `terminalTabs.ts`. The pane for that session
 * consumes it on its next render; nobody consuming it is a valid outcome.
 */
export interface AgentBrowserOpenRequest {
  sessionId: string;
  tabId: string;
  url: string;
  seq: number;
}

let agentOpenRequest: AgentBrowserOpenRequest | null = null;
const agentOpenListeners = new Set<() => void>();

export function subscribeAgentBrowserOpen(listener: () => void): () => void {
  agentOpenListeners.add(listener);
  return () => {
    agentOpenListeners.delete(listener);
  };
}

export function getAgentBrowserOpen(): AgentBrowserOpenRequest | null {
  return agentOpenRequest;
}

export function requestAgentBrowserOpen(sessionId: string, tabId: string, url: string): void {
  agentOpenRequest = { sessionId, tabId, url, seq: (agentOpenRequest?.seq ?? 0) + 1 };
  for (const listener of agentOpenListeners) listener();
}

let tabSyncStarted = false;

/**
 * Subscribes the tab store to the app's registry. Idempotent, and called from
 * every review panel's mount: the pushes have to arrive even when no browser
 * chrome is on screen, since that is exactly when a session opens a tab.
 */
export function ensureBrowserTabSync(): void {
  if (tabSyncStarted) return;
  const browser = typeof window === "undefined" ? null : (window.argmax?.browser ?? null);
  if (!browser?.onTabs) return;
  tabSyncStarted = true;
  browser.onTabs((event) => applyBrowserTabs(event.tabs));
  browser.onAgentOpen((event) => {
    lastUrl = event.url;
    requestAgentBrowserOpen(event.sessionId, event.tabId, event.url);
  });
  void browser
    .listTabs({})
    .then((result) => applyBrowserTabs(result.tabs))
    .catch(() => undefined);
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

const closeActiveTabListeners = new Set<() => void>();

/** Menu ⌘W lands here first: close the browser's active tab. False when no
 *  browser is mounted, so the command falls through to the review file tabs
 *  and then to the focused pane. A listener set because App owns the menu
 *  wiring and BrowserPanel owns the tab-close flow (webview teardown,
 *  neighbor activation, last-tab close). */
export function requestCloseActiveBrowserTab(): boolean {
  if (closeActiveTabListeners.size === 0) return false;
  for (const listener of closeActiveTabListeners) listener();
  return true;
}

export function onBrowserCloseActiveTabRequest(listener: () => void): () => void {
  closeActiveTabListeners.add(listener);
  return () => {
    closeActiveTabListeners.delete(listener);
  };
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
