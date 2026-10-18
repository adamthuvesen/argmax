import { parseReviewLayout, type ReviewLayout, type ReviewPanelMode, type ReviewSplitPosition } from "./reviewLayout.js";

export type ReviewToolMode = "changes" | "files" | "agents" | "new" | "side-chat";
export type ReviewTab =
  | { id: string; kind: "tool"; mode: ReviewToolMode }
  | { id: string; kind: "browser"; browserTabId: string }
  | { id: string; kind: "side-chat"; sessionId: string; workspaceId: string }
  | { id: string; kind: "file"; path: string; sourceKey: string }
  | { id: string; kind: "terminal"; terminalTabId: string; workspaceId: string };

export interface ReviewTabsState {
  version: 2;
  tabs: ReviewTab[];
  paneTabIds: [string] | [string, string];
  activeIndex: 0 | 1;
  ratio: number;
}

export interface ReviewTabsController {
  items: ReviewTab[];
  paneTabIds: ReviewTabsState["paneTabIds"];
  activeIndex: 0 | 1;
  select: (id: string, index?: 0 | 1) => void;
  close: (id: string) => void;
  move: (id: string, toIndex: number) => void;
  split: (id: string, position: ReviewSplitPosition) => void;
  reopenClosed: () => void;
  canReopen: boolean;
  openTool: (mode: ReviewToolMode) => void;
  openBrowser: (url?: string) => void;
  openTerminal: () => void;
  openSideChat: (sessionId: string, workspaceId: string, sourceTabId?: string) => void;
  selectBrowserTab: (tabId: string) => void;
  selectTerminalTab: (tabId: string) => void;
}

export function reviewTabMode(tab: ReviewTab): ReviewPanelMode {
  return tab.kind === "tool" ? tab.mode : tab.kind === "file" ? "files" : tab.kind;
}

export function reviewToolTab(mode: ReviewToolMode): ReviewTab {
  return { id: `tool:${mode}`, kind: "tool", mode };
}

export function createReviewTabs(): ReviewTabsState {
  const tab = reviewToolTab("changes");
  return { version: 2, tabs: [tab], paneTabIds: [tab.id], activeIndex: 0, ratio: 0.5 };
}

function isTab(value: unknown): value is ReviewTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  if (typeof tab.id !== "string" || !tab.id) return false;
  if (tab.kind === "tool") return tab.mode === "changes" || tab.mode === "files" || tab.mode === "agents" || tab.mode === "new" || tab.mode === "side-chat";
  if (tab.kind === "browser") return typeof tab.browserTabId === "string" && Boolean(tab.browserTabId);
  if (tab.kind === "side-chat") return typeof tab.sessionId === "string" && Boolean(tab.sessionId) && typeof tab.workspaceId === "string" && Boolean(tab.workspaceId);
  if (tab.kind === "file") return typeof tab.path === "string" && Boolean(tab.path) && typeof tab.sourceKey === "string";
  return tab.kind === "terminal" && typeof tab.terminalTabId === "string" && Boolean(tab.terminalTabId) && typeof tab.workspaceId === "string";
}

function ratio(value: number): number {
  return Number.isFinite(value) ? Math.max(0.2, Math.min(0.8, value)) : 0.5;
}

export function parseReviewTabs(stored: string | null): ReviewTabsState | null {
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object") return null;
    const state = value as Record<string, unknown>;
    if (state.version !== 2 || !Array.isArray(state.tabs) || !state.tabs.every(isTab)) return null;
    const tabs = state.tabs;
    if (!tabs.length || new Set(tabs.map((tab) => tab.id)).size !== tabs.length) return null;
    if (!Array.isArray(state.paneTabIds) || state.paneTabIds.length < 1 || state.paneTabIds.length > 2) return null;
    if (!state.paneTabIds.every((id) => typeof id === "string" && tabs.some((tab: ReviewTab) => tab.id === id))) return null;
    if (new Set(state.paneTabIds).size !== state.paneTabIds.length) return null;
    if (state.activeIndex !== 0 && state.activeIndex !== 1) return null;
    if (state.activeIndex >= state.paneTabIds.length || typeof state.ratio !== "number") return null;
    const panes = state.paneTabIds.map((id) => tabs.find((tab: ReviewTab) => tab.id === id) as ReviewTab);
    if (panes.filter((tab) => reviewTabMode(tab) === "files").length > 1) return null;
    return { version: 2, tabs, paneTabIds: state.paneTabIds as ReviewTabsState["paneTabIds"], activeIndex: state.activeIndex, ratio: ratio(state.ratio) };
  } catch {
    return null;
  }
}

export function migrateReviewTabs(stored: string | null, resolve: (mode: ReviewPanelMode) => ReviewTab | null): ReviewTabsState | null {
  const current = parseReviewTabs(stored);
  if (current) return current;
  const legacy = parseReviewLayout(stored);
  if (!legacy) return null;
  const tabs = legacy.modes.map(resolve).filter((tab): tab is ReviewTab => tab !== null);
  if (!tabs.length) return createReviewTabs();
  return { version: 2, tabs, paneTabIds: tabs.map((tab) => tab.id) as ReviewTabsState["paneTabIds"], activeIndex: tabs.length === 2 ? legacy.activeIndex : 0, ratio: legacy.ratio };
}

export function projectReviewLayout(state: ReviewTabsState): ReviewLayout {
  return {
    modes: state.paneTabIds.map((id) => reviewTabMode(state.tabs.find((tab) => tab.id === id)!)) as ReviewLayout["modes"],
    activeIndex: state.activeIndex,
    ratio: state.ratio
  };
}

export function addReviewTab(state: ReviewTabsState, tab: ReviewTab): ReviewTabsState {
  return state.tabs.some((item) => item.id === tab.id) ? state : { ...state, tabs: [...state.tabs, tab] };
}

export function selectReviewTab(state: ReviewTabsState, id: string, index = state.activeIndex): ReviewTabsState {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab || index >= state.paneTabIds.length) return state;
  const existing = state.paneTabIds.indexOf(id);
  if (existing >= 0) return existing === state.activeIndex ? state : { ...state, activeIndex: existing as 0 | 1 };
  const filePane = reviewTabMode(tab) === "files" ? state.paneTabIds.findIndex((pane) => reviewTabMode(state.tabs.find((item) => item.id === pane)!) === "files") : -1;
  const target = filePane >= 0 ? filePane as 0 | 1 : index;
  const panes: ReviewTabsState["paneTabIds"] = [...state.paneTabIds];
  panes[target] = id;
  return { ...state, paneTabIds: panes, activeIndex: target };
}

export function openReviewTab(state: ReviewTabsState, tab: ReviewTab, index = state.activeIndex): ReviewTabsState {
  const replacedId = state.paneTabIds[index];
  const replaced = state.tabs.find((item) => item.id === replacedId);
  const next = selectReviewTab(addReviewTab(state, tab), tab.id, index);
  return replaced?.kind === "tool" && (replaced.mode === "new" || replaced.mode === "side-chat") && replaced.id !== tab.id
    ? removeReviewTab(next, replaced.id)
    : next;
}

export function removeReviewTab(state: ReviewTabsState, id: string): ReviewTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (!tabs.length) return createReviewTabs();
  const panes = state.paneTabIds.filter((pane) => pane !== id);
  if (panes.length === 0) panes.push(tabs[Math.min(index, tabs.length - 1)].id);
  const activeId = state.paneTabIds[state.activeIndex];
  return { ...state, tabs, paneTabIds: panes as ReviewTabsState["paneTabIds"], activeIndex: Math.max(0, panes.indexOf(activeId!)) as 0 | 1 };
}

export function splitReviewTab(state: ReviewTabsState, id: string, position: ReviewSplitPosition): ReviewTabsState {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab) return state;
  const target = position === "top" ? 0 : 1;
  const existing = state.paneTabIds.indexOf(id);
  if (state.paneTabIds.length === 1 && existing === 0) {
    const candidates = state.tabs.filter((other) => other.id !== id && !(reviewTabMode(tab) === "files" && reviewTabMode(other) === "files"));
    const other = candidates.find((item) => item.kind === "tool" && item.mode === "changes") ?? candidates[0];
    if (!other) return state;
    return { ...state, paneTabIds: target === 0 ? [id, other.id] : [other.id, id], activeIndex: target };
  }
  if (reviewTabMode(tab) === "files") {
    const otherFiles = state.paneTabIds.find((pane) => pane !== id && reviewTabMode(state.tabs.find((item) => item.id === pane)!) === "files");
    if (otherFiles) return selectReviewTab(state, id);
  }
  if (state.paneTabIds.length === 1) return { ...state, paneTabIds: target === 0 ? [id, state.paneTabIds[0]] : [state.paneTabIds[0], id], activeIndex: target };
  if (existing >= 0) return { ...state, paneTabIds: existing === target ? state.paneTabIds : [state.paneTabIds[1], state.paneTabIds[0]], activeIndex: target };
  const panes: [string, string] = [...state.paneTabIds];
  panes[target] = id;
  return { ...state, paneTabIds: panes, activeIndex: target };
}

export function moveReviewTab(state: ReviewTabsState, id: string, toIndex: number): ReviewTabsState {
  const from = state.tabs.findIndex((tab) => tab.id === id);
  if (from < 0 || !Number.isFinite(toIndex)) return state;
  const to = Math.max(0, Math.min(state.tabs.length - 1, Math.trunc(toIndex)));
  if (from === to) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab);
  return { ...state, tabs };
}

export function setReviewTabsRatio(state: ReviewTabsState, value: number): ReviewTabsState {
  const next = ratio(value);
  return next === state.ratio ? state : { ...state, ratio: next };
}
