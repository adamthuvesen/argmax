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
 *
 * Tab strips are per scope: each chat, the launcher, and the rail's Browser
 * page keep their own tabs, order, and active tab. Native webviews stay in one
 * process-wide pool; a demoted surface hides them rather than destroying them.
 */

import type { BrowserTabInfo } from "../../shared/types.js";

/** Start page when the browser (or a fresh tab) is opened without a target. */
export const DEFAULT_BROWSER_URL = "https://www.google.com";

/** Stable owner id for the full-workspace Browser page (not a review panel). */
export const BROWSER_PAGE_OWNER_ID = "browser-page";

/** Tab strip for the launcher's review panel, which has no session. */
export const LAUNCHER_BROWSER_SCOPE_ID = "launcher";

export interface BrowserOpenRequest {
  url: string;
  /** Bumped on every request: asking again for the URL the page is already on
   *  has to stay a change, or the panel never navigates back to it. */
  seq: number;
  /** Show this existing tab instead of navigating the active one. Set when a
   *  session's tab is what the pane was asked to show. */
  tabId?: string;
  /** Open a fresh tab in the claiming pane's strip instead of navigating. */
  newTab?: boolean;
}

let openRequest: BrowserOpenRequest | null = null;
const requestListeners = new Set<() => void>();

export function openInBrowserPanel(url: string, options?: { newTab?: boolean }): void {
  openRequest = {
    url,
    seq: (openRequest?.seq ?? 0) + 1,
    ...(options?.newTab ? { newTab: true as const } : {})
  };
  for (const listener of requestListeners) listener();
}

/** Open the browser without a target: the claiming pane restores its own strip. */
export function openBrowserPanel(): void {
  openRequest = { url: "", seq: (openRequest?.seq ?? 0) + 1 };
  for (const listener of requestListeners) listener();
}

/** The URL a reopen should land on: what that scope's active tab is showing. */
export function lastBrowsedUrl(scopeId: string): string {
  const state = scopes.get(scopeId);
  const active = state?.tabs.find((tab) => tab.id === state.activeTabId);
  return active?.url ?? state?.lastUrl ?? DEFAULT_BROWSER_URL;
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
export function rememberBrowserUrl(url: string, scopeId: string): void {
  if (url.length === 0) return;
  const state = ensureScope(scopeId);
  if (state.lastUrl === url) return;
  state.lastUrl = url;
  persistTabs();
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
  /** Chat, launcher, or Browser-page strip this tab belongs to. */
  scopeId: string;
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

interface ScopeState {
  tabs: BrowserTab[];
  activeTabId: string | null;
  lastUrl: string | null;
  recentlyClosed: string[];
}

const TABS_KEY = "argmax.browser.tabs";
const EMPTY_TABS: BrowserTab[] = [];
const MAX_RECENTLY_CLOSED = 20;

const scopes = new Map<string, ScopeState>();
let nextTabSeq = 1;
/** Tabs whose native webview exists in THIS app run. A restored tab is not
 *  materialized until its first activation recreates the webview. */
const materializedTabs = new Set<string>();
const tabListeners = new Set<() => void>();

function emptyScope(): ScopeState {
  return { tabs: [], activeTabId: null, lastUrl: null, recentlyClosed: [] };
}

function ensureScope(scopeId: string): ScopeState {
  const existing = scopes.get(scopeId);
  if (existing) return existing;
  const created = emptyScope();
  scopes.set(scopeId, created);
  return created;
}

function persistTabs(): void {
  if (typeof window === "undefined") return;
  try {
    const snapshot: Record<
      string,
      { activeTabId: string | null; lastUrl: string | null; tabs: Array<{ id: string; url: string; title: string | null }> }
    > = {};
    for (const [scopeId, state] of scopes) {
      if (state.tabs.length === 0 && state.lastUrl === null) continue;
      snapshot[scopeId] = {
        activeTabId: state.activeTabId,
        lastUrl: state.lastUrl,
        tabs: state.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title }))
      };
    }
    window.localStorage.setItem(
      TABS_KEY,
      JSON.stringify({
        nextTabSeq,
        scopes: snapshot
      })
    );
  } catch {
    // Tab restoration is a convenience, never an error.
  }
}

function isPersistedTab(tab: unknown): tab is { id: string; url: string; title: string | null } {
  return (
    typeof tab === "object" &&
    tab !== null &&
    typeof (tab as { id: unknown }).id === "string" &&
    // Ids become native webview labels; a corrupted one would make the
    // tab permanently un-openable (Rust rejects non-slug labels).
    /^[a-z0-9-]{1,32}$/.test((tab as { id: string }).id) &&
    typeof (tab as { url: unknown }).url === "string"
  );
}

function restoreScope(
  scopeId: string,
  snapshot: { activeTabId?: unknown; lastUrl?: unknown; tabs?: unknown }
): void {
  if (!Array.isArray(snapshot.tabs)) return;
  const restored = snapshot.tabs.filter(isPersistedTab);
  if (restored.length === 0 && typeof snapshot.lastUrl !== "string") return;
  const state = ensureScope(scopeId);
  state.tabs = restored.map((tab) => ({
    id: tab.id,
    scopeId,
    url: tab.url,
    title: typeof tab.title === "string" ? tab.title : null,
    loading: false,
    ownerSessionId: null,
    group: null
  }));
  state.activeTabId =
    typeof snapshot.activeTabId === "string" && state.tabs.some((tab) => tab.id === snapshot.activeTabId)
      ? snapshot.activeTabId
      : (state.tabs[0]?.id ?? null);
  state.lastUrl = typeof snapshot.lastUrl === "string" ? snapshot.lastUrl : null;
}

function highestRestoredSeq(): number {
  let highest = 0;
  for (const state of scopes.values()) {
    for (const tab of state.tabs) {
      const match = /^tab-(\d+)$/.exec(tab.id);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
  }
  return highest;
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
    scopes?: unknown;
  };
  if (snapshot.scopes && typeof snapshot.scopes === "object") {
    for (const [scopeId, value] of Object.entries(snapshot.scopes)) {
      if (typeof value === "object" && value !== null) {
        restoreScope(scopeId, value as { activeTabId?: unknown; lastUrl?: unknown; tabs?: unknown });
      }
    }
  } else if (Array.isArray(snapshot.tabs)) {
    // Pre-scope snapshots were one app-wide strip. They belong to the rail
    // Browser page so chats do not inherit a shared history.
    restoreScope(BROWSER_PAGE_OWNER_ID, snapshot);
  }
  const persistedSeq =
    typeof snapshot.nextTabSeq === "number" && Number.isFinite(snapshot.nextTabSeq)
      ? Math.floor(snapshot.nextTabSeq)
      : 0;
  nextTabSeq = Math.max(1, persistedSeq, highestRestoredSeq() + 1);
}

restoreTabs();

function notifyTabListeners(): void {
  persistTabs();
  for (const listener of tabListeners) listener();
}

function findScopeIdForTab(id: string): string | null {
  for (const [scopeId, state] of scopes) {
    if (state.tabs.some((tab) => tab.id === id)) return scopeId;
  }
  return null;
}

export function findBrowserTab(id: string): BrowserTab | null {
  for (const state of scopes.values()) {
    const tab = state.tabs.find((candidate) => candidate.id === id);
    if (tab) return tab;
  }
  return null;
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
  const tab = findBrowserTab(id);
  if (!tab || tab.loading === loading) return;
  const state = ensureScope(tab.scopeId);
  state.tabs = state.tabs.map((candidate) =>
    candidate.id === id ? { ...candidate, loading } : candidate
  );
  notifyTabListeners();
}

export function subscribeBrowserTabs(listener: () => void): () => void {
  tabListeners.add(listener);
  return () => tabListeners.delete(listener);
}

/** Stable snapshot for useSyncExternalStore: `tabs` is replaced, never mutated. */
export function getBrowserTabs(scopeId: string): BrowserTab[] {
  return scopes.get(scopeId)?.tabs ?? EMPTY_TABS;
}

export function getActiveBrowserTabId(scopeId: string): string | null {
  return scopes.get(scopeId)?.activeTabId ?? null;
}

export function createBrowserTab(scopeId: string, url: string, activate = true): BrowserTab {
  const tab: BrowserTab = {
    id: `tab-${nextTabSeq}`,
    scopeId,
    url,
    title: null,
    loading: false,
    ownerSessionId: null,
    group: null
  };
  nextTabSeq += 1;
  const state = ensureScope(scopeId);
  state.tabs = [...state.tabs, tab];
  if (activate) state.activeTabId = tab.id;
  state.lastUrl = url;
  notifyTabListeners();
  return tab;
}

export function activateBrowserTab(id: string): void {
  const scopeId = findScopeIdForTab(id);
  if (!scopeId) return;
  const state = ensureScope(scopeId);
  if (state.activeTabId === id) return;
  state.activeTabId = id;
  notifyTabListeners();
}

/** Moves a tab to another slot. Order is the user's alone — the registry's
 *  pushes never touch it — so a carried tab keeps its new place across a
 *  restart through the persisted list. */
export function moveBrowserTab(id: string, toIndex: number): void {
  const scopeId = findScopeIdForTab(id);
  if (!scopeId) return;
  const state = ensureScope(scopeId);
  const from = state.tabs.findIndex((tab) => tab.id === id);
  const moved = state.tabs[from];
  if (!moved) return;
  const to = Math.max(0, Math.min(toIndex, state.tabs.length - 1));
  if (to === from) return;
  const next = [...state.tabs];
  next.splice(from, 1);
  next.splice(to, 0, moved);
  state.tabs = next;
  notifyTabListeners();
}

export function popRecentlyClosedBrowserTab(scopeId: string): string | null {
  return ensureScope(scopeId).recentlyClosed.pop() ?? null;
}

/** Drops the tab and returns the neighbor to activate, if the closed tab was
 *  active. The caller owns destroying the native webview. */
export function removeBrowserTab(id: string): BrowserTab | null {
  const scopeId = findScopeIdForTab(id);
  if (!scopeId) return null;
  const state = ensureScope(scopeId);
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return null;
  const closed = state.tabs[index];
  if (closed) {
    state.recentlyClosed.push(closed.url);
    if (state.recentlyClosed.length > MAX_RECENTLY_CLOSED) state.recentlyClosed.shift();
  }
  state.tabs = state.tabs.filter((tab) => tab.id !== id);
  materializedTabs.delete(id);
  let nextActive: BrowserTab | null = null;
  if (state.activeTabId === id) {
    nextActive = state.tabs[Math.min(index, state.tabs.length - 1)] ?? null;
    state.activeTabId = nextActive?.id ?? null;
  }
  notifyTabListeners();
  return nextActive;
}

/** Test-only: clears tabs, the id counter, and persisted state. */
export function resetBrowserTabsForTests(): void {
  scopes.clear();
  nextTabSeq = 1;
  materializedTabs.clear();
  registrySeen.clear();
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

function tabsEqual(next: BrowserTab[], current: BrowserTab[]): boolean {
  return (
    next.length === current.length &&
    next.every((tab, index) => {
      const existing = current[index];
      return (
        existing !== undefined &&
        existing.id === tab.id &&
        existing.scopeId === tab.scopeId &&
        existing.url === tab.url &&
        existing.title === tab.title &&
        existing.loading === tab.loading &&
        existing.ownerSessionId === tab.ownerSessionId &&
        existing.group === tab.group
      );
    })
  );
}

function foldLiveTab(tab: BrowserTab, live: BrowserTabInfo): BrowserTab {
  return {
    ...tab,
    url: live.url,
    title: live.title ?? tab.title,
    loading: live.loading,
    ownerSessionId: live.ownerSessionId,
    group: live.group
  };
}

/** Folds a `browser:tabs` push into the strips. Agent-owned tabs land in that
 *  session's strip; user tabs stay in the scope that already listed them. */
export function applyBrowserTabs(incoming: readonly BrowserTabInfo[]): void {
  const byId = new Map(incoming.map((tab) => [tab.tabId, tab]));
  let changed = false;

  for (const state of scopes.values()) {
    const next: BrowserTab[] = [];
    for (const tab of state.tabs) {
      const live = byId.get(tab.id);
      if (live) {
        next.push(foldLiveTab(tab, live));
        byId.delete(tab.id);
      } else if (!registrySeen.has(tab.id)) {
        next.push(tab);
      }
    }
    if (!tabsEqual(next, state.tabs)) {
      state.tabs = next;
      if (state.activeTabId !== null && !next.some((tab) => tab.id === state.activeTabId)) {
        state.activeTabId = next[0]?.id ?? null;
      }
      changed = true;
    }
  }

  for (const tab of incoming) {
    if (!byId.has(tab.tabId)) continue;
    const scopeId = tab.ownerSessionId ?? BROWSER_PAGE_OWNER_ID;
    const state = ensureScope(scopeId);
    state.tabs = [
      ...state.tabs,
      {
        id: tab.tabId,
        scopeId,
        url: tab.url,
        title: tab.title,
        loading: tab.loading,
        ownerSessionId: tab.ownerSessionId,
        group: tab.group
      }
    ];
    if (state.activeTabId === null) state.activeTabId = tab.tabId;
    materializedTabs.add(tab.tabId);
    changed = true;
  }

  for (const tab of incoming) registrySeen.add(tab.tabId);
  if (changed) notifyTabListeners();
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
    requestAgentBrowserOpen(event.sessionId, event.tabId, event.url);
  });
  void browser
    .listTabs({})
    .then((result) => applyBrowserTabs(result.tabs))
    .catch(() => undefined);
}

export function updateBrowserTabState(id: string, url: string, title: string | null): void {
  const tab = findBrowserTab(id);
  if (!tab) return;
  if (tab.url === url && (title === null || tab.title === title)) return;
  const state = ensureScope(tab.scopeId);
  state.tabs = state.tabs.map((candidate) =>
    candidate.id === id ? { ...candidate, url, title: title ?? candidate.title } : candidate
  );
  state.lastUrl = url;
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
