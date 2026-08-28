// Per-workspace integrated-terminal tab state that outlives pane mounts.
//
// Session panes remount whenever the grid cell or workspace changes; keeping
// the tab list, active tab, and panel-open flag in this module (instead of
// component state) is what lets a session switch come back to the same
// terminals instead of tearing them down. The heavy side — xterm instances
// and PTY wiring — lives in `terminalRuntime.ts`, which stays inside the
// lazy xterm chunk. This module is import-safe from the main bundle.
//
// Memory guardrail: at most `MAX_TERMINAL_WORKSPACES` workspaces keep live
// terminals. Adding a tab for a new workspace evicts the least-recently-used
// workspace that has no mounted panel, disposing its runtimes (which
// terminates their PTYs).

export interface TerminalTabMeta {
  id: string;
  label: string;
}

export interface WorkspaceTerminalState {
  tabs: readonly TerminalTabMeta[];
  activeTabId: string | null;
  panelOpen: boolean;
}

export const MAX_TERMINAL_WORKSPACES = 6;

const EMPTY_STATE: WorkspaceTerminalState = Object.freeze({
  tabs: Object.freeze<TerminalTabMeta[]>([]),
  activeTabId: null,
  panelOpen: false
});

interface WorkspaceEntry {
  state: WorkspaceTerminalState;
  /** Mounted TerminalTabsPanel count. Attached workspaces are never evicted. */
  attachedCount: number;
  /** Monotonic recency stamp for LRU eviction. */
  lastUsedSeq: number;
}

const entries = new Map<string, WorkspaceEntry>();
const listeners = new Set<() => void>();
let useSeq = 0;
let tabSeq = 0;

/**
 * `terminalRuntime.ts` registers its dispose function here so the store can
 * tear down xterm instances + PTYs on tab close and LRU eviction without
 * this module importing the heavy chunk.
 */
type TabDisposer = (tabId: string) => void;
let tabDisposer: TabDisposer | null = null;

export function registerTerminalTabDisposer(disposer: TabDisposer): void {
  tabDisposer = disposer;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeTerminalTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot for `useSyncExternalStore`; referentially stable between mutations. */
export function getWorkspaceTerminalState(workspaceId: string | null): WorkspaceTerminalState {
  if (!workspaceId) return EMPTY_STATE;
  return entries.get(workspaceId)?.state ?? EMPTY_STATE;
}

function entryFor(workspaceId: string): WorkspaceEntry {
  let entry = entries.get(workspaceId);
  if (!entry) {
    entry = { state: { tabs: [], activeTabId: null, panelOpen: false }, attachedCount: 0, lastUsedSeq: ++useSeq };
    entries.set(workspaceId, entry);
  }
  return entry;
}

function touch(entry: WorkspaceEntry): void {
  entry.lastUsedSeq = ++useSeq;
}

function pruneIfEmpty(workspaceId: string, entry: WorkspaceEntry): void {
  if (entry.state.tabs.length === 0 && !entry.state.panelOpen && entry.attachedCount === 0) {
    entries.delete(workspaceId);
  }
}

export function setTerminalPanelOpen(workspaceId: string, open: boolean): void {
  if (open) {
    const entry = entryFor(workspaceId);
    touch(entry);
    if (entry.state.panelOpen) return;
    entry.state = { ...entry.state, panelOpen: true };
    notify();
    return;
  }
  const entry = entries.get(workspaceId);
  if (!entry || !entry.state.panelOpen) return;
  entry.state = { ...entry.state, panelOpen: false };
  pruneIfEmpty(workspaceId, entry);
  notify();
}

export function toggleTerminalPanel(workspaceId: string): void {
  setTerminalPanelOpen(workspaceId, !getWorkspaceTerminalState(workspaceId).panelOpen);
}

export function addTerminalTab(workspaceId: string, label: string): string {
  const entry = entryFor(workspaceId);
  tabSeq += 1;
  const id = `tab-${tabSeq}`;
  entry.state = {
    ...entry.state,
    tabs: [...entry.state.tabs, { id, label }],
    activeTabId: id
  };
  touch(entry);
  evictLeastRecentlyUsed();
  notify();
  return id;
}

export function closeTerminalTab(workspaceId: string, tabId: string): void {
  const entry = entries.get(workspaceId);
  if (!entry || !entry.state.tabs.some((tab) => tab.id === tabId)) return;
  tabDisposer?.(tabId);
  const tabs = entry.state.tabs.filter((tab) => tab.id !== tabId);
  const activeTabId =
    entry.state.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : entry.state.activeTabId;
  entry.state = { ...entry.state, tabs, activeTabId };
  touch(entry);
  notify();
}

export function setActiveTerminalTab(workspaceId: string, tabId: string): void {
  const entry = entries.get(workspaceId);
  if (!entry || entry.state.activeTabId === tabId) return;
  if (!entry.state.tabs.some((tab) => tab.id === tabId)) return;
  entry.state = { ...entry.state, activeTabId: tabId };
  touch(entry);
  notify();
}

/**
 * Marks a mounted TerminalTabsPanel so eviction skips this workspace.
 * Returns the release function for the effect cleanup.
 */
export function markTerminalWorkspaceAttached(workspaceId: string): () => void {
  const entry = entryFor(workspaceId);
  entry.attachedCount += 1;
  touch(entry);
  return () => {
    entry.attachedCount = Math.max(0, entry.attachedCount - 1);
    pruneIfEmpty(workspaceId, entry);
  };
}

function evictLeastRecentlyUsed(): void {
  const withTabs = [...entries.entries()].filter(([, entry]) => entry.state.tabs.length > 0);
  let liveCount = withTabs.length;
  if (liveCount <= MAX_TERMINAL_WORKSPACES) return;
  const evictable = withTabs
    .filter(([, entry]) => entry.attachedCount === 0)
    .sort((a, b) => a[1].lastUsedSeq - b[1].lastUsedSeq);
  for (const [workspaceId, entry] of evictable) {
    if (liveCount <= MAX_TERMINAL_WORKSPACES) break;
    for (const tab of entry.state.tabs) tabDisposer?.(tab.id);
    entries.delete(workspaceId);
    liveCount -= 1;
  }
}

export function resetTerminalTabsForTests(): void {
  // The disposer registration is a module-load side effect of the runtime,
  // so it survives resets deliberately.
  entries.clear();
  listeners.clear();
  useSeq = 0;
  tabSeq = 0;
}
