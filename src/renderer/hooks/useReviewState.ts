import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  ChangedFileSummary,
  ProjectSummary,
  ReviewComparison,
  WorkspaceDiff,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceSummary
} from "../../shared/types.js";
import {
  claimBrowserSurface,
  ensureBrowserTabSync,
  getAgentBrowserOpen,
  consumeBrowserRequest,
  getBrowserOwnerId,
  getBrowserRequest,
  lastBrowsedUrl,
  LAUNCHER_BROWSER_SCOPE_ID,
  releaseBrowserSurface,
  subscribeAgentBrowserOpen,
  subscribeBrowserOwner,
  subscribeBrowserRequest,
  getBrowserTabs,
  subscribeBrowserTabs,
  isBrowserTabRegistryReady,
  isBrowserTabMaterialized,
  subscribeBrowserTabOpened,
  createBrowserTab,
  activateBrowserTab,
  requestBrowserTabFocus,
  getActiveBrowserTabId,
  removeBrowserTab,
  DEFAULT_BROWSER_URL,
  type BrowserOpenRequest
} from "../lib/browserPanel.js";
import {
  consumeTerminalRequest,
  ensureAgentTerminalSync,
  getTerminalRequest,
  getWorkspaceTerminalState,
  setTerminalShowing,
  subscribeTerminalRequest,
  subscribeTerminalTabs,
  addTerminalTab,
  closeTerminalTab,
  setActiveTerminalTab
} from "../lib/terminalTabs.js";
import { reviewIpcDispatch } from "../lib/reviewIpc.js";
import type { ReviewLayout, ReviewPanelMode, ReviewSplitPosition } from "../lib/reviewLayout.js";
import { isReviewPanelMode, parseReviewLayout, normalizeReviewLayout } from "../lib/reviewLayout.js";
import {
  addReviewTab, createReviewTabs, migrateReviewTabs, moveReviewTab, projectReviewLayout,
  removeReviewTab, openReviewTab, reviewTabMode, reviewToolTab, selectReviewTab, setReviewTabsRatio, splitReviewTab,
  type ReviewTab, type ReviewTabsController, type ReviewTabsState
} from "../lib/reviewTabs.js";
import { uuidV4 } from "../lib/uuid.js";
import { showErrorToast } from "../state/toast.js";
import { errorMessage } from "../../shared/error.js";
import { usePersistedSetting } from "./usePersistedSetting.js";
import { useFilePreview } from "./useFilePreview.js";
import { multitaskTabId } from "../lib/agentTabs.js";
import { hostsBrowserSurface } from "../lib/tauriBridge.js";
import { isSecondaryWindow } from "../lib/windowRole.js";
import { useAgentTabs, type AgentTabsState } from "./useAgentTabs.js";
import { useReviewDiff } from "./useReviewDiff.js";
import { useProjectFolderChanges, type ProjectFolderChangesState } from "./useProjectFolderChanges.js";
import { useWorkspaceFileList } from "./useWorkspaceFileList.js";

export type AsyncState = "idle" | "loading" | "ready" | "error";
export type { ReviewLayout, ReviewPanelMode, ReviewSplitPosition } from "../lib/reviewLayout.js";

/**
 * Which slice of the work the Changes view shows.
 *
 * - `branch`: everything different from the base branch: committed,
 *   uncommitted, and untracked. The default, because it answers "what did this
 *   task change" without the reader having to know what was committed when.
 * - `committed`: only what has landed as commits on the branch.
 * - `uncommitted`: only the working tree, vs `HEAD`.
 * - `lastTurn`: `branch`, filtered to the files the agent wrote in the newest
 *   turn (see lastTurnFiles.ts). Only offered where a session transcript
 *   exists, so it is absent on the launcher.
 */
export type ReviewChangesScope = "branch" | "committed" | "uncommitted" | "lastTurn";

export const REVIEW_SCOPE_LABELS: Record<ReviewChangesScope, string> = {
  branch: "All on branch",
  committed: "Committed",
  uncommitted: "Uncommitted",
  lastTurn: "Last turn"
};

export type WorkspaceFileSaveState = "idle" | "saving" | "error";

const SCOPE_KEY = "argmax.reviewPanel.changesScope";

function isReviewChangesScope(value: unknown): value is ReviewChangesScope {
  return value === "branch" || value === "committed" || value === "uncommitted" || value === "lastTurn";
}

function readStoredScope(): ReviewChangesScope {
  if (typeof window === "undefined") return "branch";
  const stored = window.localStorage.getItem(SCOPE_KEY);
  return isReviewChangesScope(stored) ? stored : "branch";
}

const ALL_SCOPES: ReviewChangesScope[] = ["branch", "committed", "uncommitted", "lastTurn"];

const SCOPE_COMPARISONS: Record<ReviewChangesScope, ReviewComparison> = {
  branch: "branch",
  committed: "committed",
  uncommitted: "workingTree",
  // Last turn narrows the branch list client-side; the git query is the same.
  lastTurn: "branch"
};

/**
 * Either a workspace (worktree-backed) or the project's main checkout
 * (surfaced on the LaunchSurface before a session exists). Both render the
 * same Changes + Files panel and use the same read/write editor flow.
 */
export type ReviewSource =
  | { kind: "workspace"; workspace: WorkspaceSummary }
  | { kind: "project"; project: ProjectSummary; projectFolderId?: string };

export interface WorkspaceFileTab {
  path: string;
  isDirty: boolean;
  saveState: WorkspaceFileSaveState;
  externalChange: boolean;
}

export interface WorkspaceFileDirtyClosePrompt {
  path: string;
  /** Set when the prompt's own Save attempt failed; keeps the prompt honest. */
  saveError: string | null;
}

export interface WorkspaceFilesState {
  entries: WorkspaceFileEntry[];
  listState: AsyncState;
  listError: string | null;
  /** Re-list the source's files on demand (the tree toolbar's refresh). */
  refreshList: () => void;
  tabs: WorkspaceFileTab[];
  activeTabPath: string | null;
  selectedPath: string | null;
  /** Absolute filesystem root for the current source (workspace.path or
   *  project.repoPath). Threaded through so the markdown preview can resolve
   *  relative image URLs against the on-disk file location. Null when no
   *  source is active. */
  rootPath: string | null;
  preview: WorkspaceFilePreview | null;
  previewState: AsyncState;
  previewError: string | null;
  openFile: (filePath: string) => void;
  selectTab: (filePath: string) => void;
  closeTab: (filePath: string) => void;
  dirtyClosePrompt: WorkspaceFileDirtyClosePrompt | null;
  saveDirtyTabAndClose: () => Promise<void>;
  discardDirtyTabAndClose: () => void;
  cancelDirtyTabClose: () => void;
  /** Current editor buffer for the selected file (null if not text/editable). */
  buffer: string | null;
  /** Buffer differs from the last-loaded original. */
  isDirty: boolean;
  /** Disk mtime the renderer last observed for the selected file. */
  diskMtimeMs: number | null;
  /** True when a poll detected the file changed on disk since `diskMtimeMs`. */
  externalChange: boolean;
  /** Save lifecycle (writeFile in flight / errored). */
  saveState: WorkspaceFileSaveState;
  saveError: string | null;
  /** True when the panel is backed by a project or workspace file source. */
  canEdit: boolean;
  editFile: (content: string) => void;
  saveFile: () => Promise<void>;
  reloadFile: () => void;
  dismissExternalChange: () => void;
}

export interface ReviewState {
  tabs?: ReviewTabsController;
  projectFolderChanges?: ProjectFolderChangesState;
  projectChanges?: {
    projectId: string;
    workingFolderId: string | null;
    workingRootPath: string;
    refreshKey: string | null;
  };
  files: ChangedFileSummary[];
  filesState: AsyncState;
  filesError: string | null;
  selectedFilePath: string | null;
  diff: WorkspaceDiff | null;
  diffState: AsyncState;
  diffError: string | null;
  isPanelOpen: boolean;
  layout: ReviewLayout;
  mode: ReviewPanelMode;
  setMode: (mode: ReviewPanelMode) => void;
  setPaneMode: (index: 0 | 1, mode: ReviewPanelMode) => void;
  focusPane: (index: 0 | 1) => void;
  splitMode: (mode: ReviewPanelMode, position: ReviewSplitPosition) => void;
  closePane: (index: 0 | 1) => void;
  setSplitRatio: (ratio: number) => void;
  /** Which slice of the work the Changes view shows. */
  changesScope: ReviewChangesScope;
  setChangesScope: (scope: ReviewChangesScope) => void;
  /** Scopes this source can offer. "lastTurn" needs a session transcript. */
  availableScopes: ReviewChangesScope[];
  /** Base branch label for the scope picker (e.g. "main"); null when no source
   *  is active. */
  comparisonBaseLabel: string | null;
  workspaceFiles: WorkspaceFilesState;
  /** Subagents and multitasks open in the Agents view, discovered when the
   *  dock opens or selected explicitly from the transcript. */
  agentTabs: AgentTabsState;
  /** Open the panel on a subagent, adding its tab if it is not open yet. */
  openAgent: (parentToolUseId: string) => void;
  /** Open the panel on the Agents view without selecting a specific tab. */
  openAgents: () => void;
  /** Open the panel on a multitask's chat, adding its tab if it is not open
   *  yet. Same dock as the subagents: both are work running alongside. */
  openMultitask: (sessionId: string) => void;
  /** Open the panel on the Browser view, showing this scope's native surface. */
  openBrowser: (url?: string) => void;
  /** Workspace whose integrated terminal this panel hosts. Null on a
   *  project-backed panel (the launcher), which has no workspace to run in —
   *  and so has no Terminal tab. */
  terminalWorkspaceId: string | null;
  /** Open the panel on the Terminal view. */
  openTerminal: () => void;
  /** ⌘J and the workspace card's Terminal row: show the terminal, or hide the
   *  panel when it is already the one showing. */
  toggleTerminal: () => void;
  /** True when this panel holds the browser surface. Other scopes can show their
   *  own browsers at the same time. */
  browserOwner: boolean;
  /** Chat, launcher, or Browser-page strip this panel shows. */
  browserScopeId: string;
  /** Where the Browser view should be, and a sequence number that re-navigates
   *  even when the URL is the one the page is already on. Null until this
   *  panel has been asked for the browser at least once. */
  browserRequest: BrowserOpenRequest | null;
  handleBrowserRequest: (seq: number) => void;
  openFile: (filePath: string) => void;
  /** Reload the changed-file list and the selected file's diff. */
  refreshChanges: () => void;
  /** Reload the open file's diff with more unchanged context around its hunks. */
  expandDiffContext: () => void;
  updateFileIndex: (filePath: string, revision: string, stage: boolean) => Promise<void>;
  revertFile: (filePath: string, revision: string) => Promise<void>;
  revertHunk: (filePath: string, revision: string, hunkIndex: number) => Promise<void>;
  updateHunkIndex: (filePath: string, revision: string, hunkIndex: number, stage: boolean) => Promise<void>;
  openPanelInFilesMode: () => void;
  openInFilesView: (filePath: string) => void;
  /** Open the panel on the Changes view. Unlike `toggleChangesPanel`, an
   *  already-open panel stays open — a "Review" affordance in the chat is a
   *  request to see the changes, never to hide them. */
  openChangesPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  toggleChangesPanel: () => void;
}

function addReviewTerminal(workspaceId: string): string {
  const labels = new Set(getWorkspaceTerminalState(workspaceId).tabs.map((tab) => tab.label));
  let number = 1;
  while (labels.has(number === 1 ? "Terminal" : `Terminal ${number}`)) number += 1;
  return addTerminalTab(workspaceId, number === 1 ? "Terminal" : `Terminal ${number}`);
}

export function useReviewState(
  source: ReviewSource | null,
  /** Repo-relative paths the newest turn wrote. `null` where no transcript
   *  exists (the launcher), which also hides the "Last turn" scope. */
  lastTurnPaths: readonly string[] | null = null,
  options?: {
    /** Read-only surfaces (mobile) keep the file preview but drop editing —
     *  and with it the external-change polling that only matters for a live
     *  editor buffer. Defaults to editable. */
    editable?: boolean;
    /** Warm the focused pane while closed. Background panes load when opened. */
    preloadChanges?: boolean;
    /** Full-screen surfaces where the panel IS the screen start open, so the
     *  data hooks load on the first render instead of after a mount effect —
     *  an effect-driven open races useReviewDiff's auto-select of the first
     *  changed file. Defaults to closed. */
    initiallyOpen?: boolean;
    /** Whether open-in-browser requests (chat links, the actions menu) land in
     *  this panel. True for the focused pane, and for a launcher that is the
     *  only surface on screen. Defaults to false. */
    claimsBrowserRequests?: boolean;
    /** Session this panel belongs to. A tab that session's agent opens is
     *  shown here, so the user watches it browse. Null on the launcher. */
    sessionId?: string | null;
    /** Shared checkout workspace for a project-backed panel's terminal. PTYs
     *  are still scoped to a workspace row; project sources have none of their
     *  own. */
    terminalWorkspaceId?: string | null;
  }
): ReviewState {
  const sourceKind = source?.kind === "project" && source.projectFolderId ? "projectFolder" : source?.kind ?? null;
  const sourceId: string | null = source
    ? source.kind === "workspace"
      ? source.workspace.id
      : source.projectFolderId ?? source.project.id
    : null;
  const changedFilesKey: string | null =
    source?.kind === "workspace" ? `${source.workspace.changedFiles}:${source.workspace.state}` : null;
  const canEdit = sourceKind !== null && (options?.editable ?? true);

  const dispatch = useMemo(
    () => (sourceKind && sourceId ? reviewIpcDispatch({ kind: sourceKind, id: sourceId }) : null),
    [sourceKind, sourceId]
  );

  const terminalWorkspaceId =
    source?.kind === "workspace"
      ? source.workspace.id
      : options?.terminalWorkspaceId ?? null;
  const browserScopeId = options?.sessionId ?? LAUNCHER_BROWSER_SCOPE_ID;
  const sourceKey = `${sourceKind ?? "none"}:${sourceId ?? "none"}`;
  const tabOwnerKey = `${sourceKey}\u0000${browserScopeId}`;
  const tabOwnerKeyRef = useRef(tabOwnerKey);
  tabOwnerKeyRef.current = tabOwnerKey;
  const availablePanelModes = useMemo<ReviewPanelMode[]>(() => {
    const modes: ReviewPanelMode[] = ["changes", "files", "new"];
    if (options?.sessionId) modes.push("agents", "side-chat");
    if (hostsBrowserSurface()) modes.push("browser");
    if (terminalWorkspaceId) modes.push("terminal");
    return modes;
  }, [options?.sessionId, terminalWorkspaceId]);
  const panelOpenKey = options?.sessionId && options.initiallyOpen === undefined
    ? `argmax.reviewPanel.open.${options.sessionId}`
    : null;
  const legacyPanelModeKey = panelOpenKey ? `argmax.reviewPanel.mode.${options?.sessionId}` : null;
  const panelLayoutKey = options?.initiallyOpen === undefined
    ? options?.sessionId
      ? `argmax.reviewPanel.layout.${options.sessionId}`
      : source?.kind === "project"
        ? "argmax.reviewPanel.layout.launcher"
        : null
    : null;
  // A new launcher must not inherit visibility from a chat in its checkout.
  const restoreTerminalShowing = sourceKind === "workspace" && getWorkspaceTerminalState(terminalWorkspaceId).showing;
  // Session panes remount on navigation. Restore both visibility and mode,
  // falling back to the workspace terminal state for sessions without a preference.
  const [isPanelOpen, setIsPanelOpen] = useState(() => {
    if (panelOpenKey) {
      try {
        const stored = window.localStorage.getItem(panelOpenKey);
        if (stored !== null) return stored === "true";
      } catch {
        // Appearance preferences are optional when storage is unavailable.
      }
    }
    return options?.initiallyOpen ?? restoreTerminalShowing;
  });
  useEffect(() => {
    if (!panelOpenKey) return;
    try {
      window.localStorage.setItem(panelOpenKey, String(isPanelOpen));
    } catch {
      // Quota or private-mode failures are non-fatal for appearance prefs.
    }
  }, [panelOpenKey, isPanelOpen]);
  const restoredLayoutPreference = useRef(false);
  const tabStateRef = useRef<ReviewTabsState>(createReviewTabs());
  const resolveModeTab = useCallback((nextMode: ReviewPanelMode): ReviewTab | null => {
    if (!availablePanelModes.includes(nextMode)) return null;
    if (nextMode === "side-chat") {
      return tabStateRef.current.tabs.find((tab) => tab.kind === "tool" && tab.mode === "side-chat") ?? {
        id: `tool:side-chat:${uuidV4()}`, kind: "tool", mode: "side-chat"
      };
    }
    if (nextMode === "browser") {
      const browserTabId = getActiveBrowserTabId(browserScopeId) ?? createBrowserTab(browserScopeId, lastBrowsedUrl(browserScopeId)).id;
      return { id: `browser:${browserTabId}`, kind: "browser", browserTabId };
    }
    if (nextMode === "terminal") {
      if (!terminalWorkspaceId) return null;
      const terminalTabId = getWorkspaceTerminalState(terminalWorkspaceId).activeTabId ?? addReviewTerminal(terminalWorkspaceId);
      return { id: `terminal:${terminalWorkspaceId}:${terminalTabId}`, kind: "terminal", terminalTabId, workspaceId: terminalWorkspaceId };
    }
    return reviewToolTab(nextMode);
  }, [availablePanelModes, browserScopeId, terminalWorkspaceId]);
  const [tabState, setTabState] = useState<ReviewTabsState>(() => {
    if (panelLayoutKey) {
      try {
        const raw = window.localStorage.getItem(panelLayoutKey);
        const legacy = parseReviewLayout(raw);
        const stored = migrateReviewTabs(legacy ? JSON.stringify(normalizeReviewLayout(legacy, availablePanelModes)) : raw, resolveModeTab);
        if (stored) {
          restoredLayoutPreference.current = true;
          let next = stored;
          const restoredTerminalIds = new Set(stored.tabs.filter((tab) => tab.kind === "terminal" && getWorkspaceTerminalState(tab.workspaceId).tabs.some((item) => item.id === tab.terminalTabId)).map((tab) => tab.kind === "terminal" ? tab.terminalTabId : ""));
          for (const tab of stored.tabs) {
            if (!availablePanelModes.includes(reviewTabMode(tab)) || (tab.kind === "file" && tab.sourceKey !== sourceKey)) next = removeReviewTab(next, tab.id);
            else if (tab.kind === "terminal" && !getWorkspaceTerminalState(tab.workspaceId).tabs.some((item) => item.id === tab.terminalTabId)) {
              const freshId = getWorkspaceTerminalState(tab.workspaceId).tabs.find((item) => !restoredTerminalIds.has(item.id))?.id ?? addReviewTerminal(tab.workspaceId);
              restoredTerminalIds.add(freshId);
              const replacement: ReviewTab = { id: `terminal:${tab.workspaceId}:${freshId}`, kind: "terminal", terminalTabId: freshId, workspaceId: tab.workspaceId };
              if (replacement) {
                next = { ...next, tabs: next.tabs.map((item) => item.id === tab.id ? replacement : item), paneTabIds: next.paneTabIds.map((id) => id === tab.id ? replacement.id : id) as ReviewTabsState["paneTabIds"] };
              }
            }
          }
          return next;
        }
      } catch {
        // Layout persistence is optional when storage is unavailable.
      }
    }
    if (legacyPanelModeKey) {
      const stored = window.localStorage.getItem(legacyPanelModeKey);
      if (isReviewPanelMode(stored)) {
        const tab = resolveModeTab(stored);
        if (tab) {
          restoredLayoutPreference.current = true;
          return selectReviewTab(addReviewTab(createReviewTabs(), tab), tab.id);
        }
      }
    }
    const initial = options?.initiallyOpen === undefined && restoreTerminalShowing ? resolveModeTab("terminal") : null;
    return initial ? selectReviewTab(addReviewTab(createReviewTabs(), initial), initial.id) : createReviewTabs();
  });
  tabStateRef.current = tabState;
  const layout = useMemo(() => projectReviewLayout(tabState), [tabState]);
  useEffect(() => {
    if (!panelLayoutKey || isSecondaryWindow()) return;
    try { window.localStorage.setItem(panelLayoutKey, JSON.stringify(tabState)); } catch {
      // Layout persistence is optional when storage is unavailable.
    }
  }, [tabState, panelLayoutKey]);
  useEffect(() => {
    setTabState((current) => {
      let next = current;
      for (const tab of current.tabs) {
        if (tab.kind === "file" && tab.sourceKey !== sourceKey) {
          const replacement = reviewToolTab("files");
          next = addReviewTab(next, replacement);
          next = { ...next, paneTabIds: next.paneTabIds.map((id) => id === tab.id ? replacement.id : id) as ReviewTabsState["paneTabIds"] };
          next = removeReviewTab(next, tab.id);
        } else if (!availablePanelModes.includes(reviewTabMode(tab)) || (tab.kind === "terminal" && tab.workspaceId !== terminalWorkspaceId)) next = removeReviewTab(next, tab.id);
      }
      return next;
    });
  }, [availablePanelModes, sourceKey, terminalWorkspaceId]);
  const mode = layout.modes[layout.activeIndex] ?? layout.modes[0];
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const setMode = useCallback((nextMode: ReviewPanelMode): void => {
    const tab = resolveModeTab(nextMode);
    if (!tab) return;
    restoredLayoutPreference.current = true;
    setTabState((current) => openReviewTab(current, tab));
  }, [resolveModeTab]);
  const setPaneMode = useCallback((index: 0 | 1, nextMode: ReviewPanelMode): void => {
    const tab = resolveModeTab(nextMode);
    if (!tab) return;
    restoredLayoutPreference.current = true;
    setTabState((current) => {
      const next = addReviewTab(current, tab);
      const existing = next.paneTabIds.indexOf(tab.id);
      if (existing >= 0 && existing !== index && next.paneTabIds.length === 2) return { ...next, paneTabIds: [next.paneTabIds[1], next.paneTabIds[0]], activeIndex: index };
      return openReviewTab(next, tab, index);
    });
  }, [resolveModeTab]);
  const focusPane = useCallback((index: 0 | 1): void => {
    restoredLayoutPreference.current = true;
    setTabState((current) => index < current.paneTabIds.length && current.activeIndex !== index ? { ...current, activeIndex: index } : current);
  }, []);
  const splitMode = useCallback((nextMode: ReviewPanelMode, position: ReviewSplitPosition): void => {
    let tab = resolveModeTab(nextMode);
    if (!tab) return;
    const current = tabStateRef.current;
    if (current.paneTabIds.length === 1 && current.paneTabIds[0] === tab.id) tab = reviewToolTab(nextMode === "changes" ? "files" : "changes");
    const inserted = tab;
    restoredLayoutPreference.current = true;
    setTabState((state) => splitReviewTab(addReviewTab(state, inserted), inserted.id, position));
    setIsPanelOpen(true);
  }, [resolveModeTab]);
  const closePane = useCallback((index: 0 | 1): void => {
    restoredLayoutPreference.current = true;
    if (layoutRef.current.modes.length === 1) { setIsPanelOpen(false); return; }
    setTabState((current) => ({ ...current, paneTabIds: [current.paneTabIds[index === 0 ? 1 : 0]!], activeIndex: 0 }));
  }, []);
  const setSplitRatio = useCallback((value: number): void => {
    restoredLayoutPreference.current = true;
    setTabState((current) => setReviewTabsRatio(current, value));
  }, []);
  const [storedScope, setChangesScope] = useState<ReviewChangesScope>(readStoredScope);
  usePersistedSetting(SCOPE_KEY, storedScope);
  const previousSourceId = useRef<string | null>(sourceId);
  const sourceChanged = previousSourceId.current !== sourceId;

  // --- Browser mode -------------------------------------------------------
  // Each scope has its own surface. The panel id prevents two views of the
  // same scope from positioning the same native webview.
  const panelId = useId();
  const [browserRequest, setBrowserRequest] = useState<BrowserOpenRequest | null>(() =>
    layout.modes.includes("browser") ? { url: lastBrowsedUrl(browserScopeId), seq: 0 } : null
  );
  const browserOwner = useSyncExternalStore(subscribeBrowserOwner, () => getBrowserOwnerId(browserScopeId)) === panelId;

  const handleBrowserRequest = useCallback((seq: number): void => {
    setBrowserRequest((current) =>
      current?.seq === seq ? { url: "", seq } : current
    );
  }, []);

  const openBrowserAt = useCallback(
    (url: string, tabId?: string, newTab?: boolean): void => {
      // Claim here, not only in the effect below: a demoted panel is already
      // in Browser mode with the panel open, so neither of the effect's deps
      // changes and "Show here" would be a no-op.
      claimBrowserSurface(panelId, browserScopeId);
      const existing = tabId ? getBrowserTabs(browserScopeId).find((tab) => tab.id === tabId) : undefined;
      const browserTabId = tabId ?? (newTab ? null : getActiveBrowserTabId(browserScopeId)) ?? createBrowserTab(browserScopeId, url || DEFAULT_BROWSER_URL).id;
      const tab: ReviewTab = { id: `browser:${browserTabId}`, kind: "browser", browserTabId };
      if (existing || getBrowserTabs(browserScopeId).some((item) => item.id === browserTabId)) activateBrowserTab(browserTabId);
      setBrowserRequest((current) => ({ url, tabId: browserTabId, newTab, seq: (current?.seq ?? 0) + 1 }));
      setTabState((current) => openReviewTab(current, tab));
      setIsPanelOpen(true);
    },
    [browserScopeId, panelId]
  );

  const openBrowser = useCallback(
    (url?: string): void => {
      if (url) {
        const existing = getBrowserTabs(browserScopeId).find((tab) => tab.url === url);
        openBrowserAt(url, existing?.id, !existing);
        return;
      }
      openBrowserAt(
        browserRequest?.tabId ? browserRequest.url : lastBrowsedUrl(browserScopeId),
        browserRequest?.tabId
      );
    },
    [browserRequest, browserScopeId, openBrowserAt]
  );

  const showsBrowser = isPanelOpen && layout.modes.includes("browser");
  // Entering Browser mode by any path takes the surface; leaving it, closing
  // the panel, or unmounting the pane hands it back unless another panel has
  // already claimed it in the meantime.
  useEffect(() => {
    if (!showsBrowser) return undefined;
    claimBrowserSurface(panelId, browserScopeId);
    return () => releaseBrowserSurface(panelId, browserScopeId);
  }, [browserScopeId, panelId, showsBrowser]);

  // Handle chat links in the click's batch, without rendering the closed
  // panel first and opening it in a later effect. Only the panel taking
  // requests right now responds; later focus changes never replay a request.
  // The tab list is pushed by the app, and a session can open a tab with no
  // browser chrome on screen — so the subscription has to exist wherever a
  // review panel does, not only where one is showing the browser.
  useEffect(() => ensureBrowserTabSync(), []);
  useEffect(() => ensureAgentTerminalSync(), []);

  useEffect(() => subscribeBrowserTabOpened((event) => {
    if (event.scopeId !== browserScopeId) return;
    const state = tabStateRef.current;
    const sourceIndex = state.paneTabIds.indexOf(`browser:${event.sourceTabId}`);
    if (!panelRef.current.isPanelOpen || sourceIndex < 0) return;
    const tab: ReviewTab = { id: `browser:${event.tabId}`, kind: "browser", browserTabId: event.tabId };
    const browserTab = getBrowserTabs(browserScopeId).find((item) => item.id === event.tabId);
    activateBrowserTab(event.tabId);
    setBrowserRequest((current) => ({ url: browserTab?.url ?? "", tabId: event.tabId, newTab: sourceIndex === state.activeIndex, seq: (current?.seq ?? 0) + 1 }));
    setTabState((current) => {
      const next = addReviewTab(current, tab);
      const panes: ReviewTabsState["paneTabIds"] = [...next.paneTabIds];
      const index = panes.indexOf(`browser:${event.sourceTabId}`);
      if (index < 0) return next;
      panes[index as 0 | 1] = tab.id;
      return { ...next, paneTabIds: panes };
    });
  }), [browserScopeId]);

  const claimsBrowserRequests = useRef(options?.claimsBrowserRequests ?? false);
  claimsBrowserRequests.current = options?.claimsBrowserRequests ?? false;
  useEffect(() => subscribeBrowserRequest(() => {
    const request = getBrowserRequest();
    if (!request || !claimsBrowserRequests.current) return;
    openBrowserAt(
      request.url || lastBrowsedUrl(browserScopeId),
      request.tabId,
      request.newTab
    );
    consumeBrowserRequest(request.seq);
  }), [browserScopeId, openBrowserAt]);

  // Reveal the first agent tab once per session. Later requests update the
  // browser without disturbing the user's panel layout or visibility.
  // Every panel sees the request; only the one whose session
  // matches acts, and a session with no panel mounted simply gets a tab in
  // the strip the next time someone opens the browser.
  const paneSessionId = options?.sessionId ?? null;
  const agentBrowserOpen = useSyncExternalStore(subscribeAgentBrowserOpen, getAgentBrowserOpen);
  const handledAgentSeq = useRef(agentBrowserOpen?.seq ?? 0);
  const revealedBrowserSessions = useRef(new Set<string>());
  useEffect(() => {
    if (!agentBrowserOpen || agentBrowserOpen.seq === handledAgentSeq.current) return;
    handledAgentSeq.current = agentBrowserOpen.seq;
    if (!paneSessionId || agentBrowserOpen.sessionId !== paneSessionId) return;
    if (!hostsBrowserSurface()) return;
    const revealKey = `argmax.browser.agentRevealed.${paneSessionId}`;
    let alreadyRevealed = revealedBrowserSessions.current.has(paneSessionId);
    try {
      alreadyRevealed ||= window.localStorage.getItem(revealKey) === "true";
      window.localStorage.setItem(revealKey, "true");
    } catch {
      // Keep the one-time reveal in memory when appearance storage is unavailable.
    }
    revealedBrowserSessions.current.add(paneSessionId);
    if (!alreadyRevealed) {
      openBrowserAt(agentBrowserOpen.url, agentBrowserOpen.tabId);
    } else {
      setBrowserRequest((current) => ({
        url: agentBrowserOpen.url,
        tabId: agentBrowserOpen.tabId,
        seq: (current?.seq ?? 0) + 1
      }));
    }
  }, [agentBrowserOpen, openBrowserAt, paneSessionId]);

  const hasTranscript = lastTurnPaths !== null;
  const availableScopes: ReviewChangesScope[] = useMemo(
    () => (hasTranscript ? ALL_SCOPES : ALL_SCOPES.filter((scope) => scope !== "lastTurn")),
    [hasTranscript]
  );
  // A stored "lastTurn" would strand the launcher on a scope it cannot offer.
  const changesScope: ReviewChangesScope = availableScopes.includes(storedScope)
    ? storedScope
    : "branch";
  const comparison: ReviewComparison = SCOPE_COMPARISONS[changesScope];
  const comparisonBaseLabel: string | null = source
    ? source.kind === "workspace"
      ? source.workspace.baseRef
      : source.project.defaultBranch ?? source.project.currentBranch
    : null;

  const openChangesMode = useCallback((): void => {
    setMode("changes");
    setIsPanelOpen(true);
  }, [setMode]);

  const projectChanges = source ? {
    projectId: source.kind === "workspace" ? source.workspace.projectId : source.project.id,
    workingFolderId: source.kind === "workspace" ? source.workspace.projectFolderId ?? null : source.projectFolderId ?? null,
    workingRootPath: source.kind === "workspace" ? source.workspace.path : source.project.repoPath,
    refreshKey: changedFilesKey
  } : undefined;
  const projectFolderChanges = useProjectFolderChanges(projectChanges, isPanelOpen || (options?.preloadChanges ?? true));

  const reviewDiff = useReviewDiff({
    sourceId,
    sourceKind,
    changedFilesKey,
    comparison,
    dispatch,
    enabled: isPanelOpen || (options?.preloadChanges ?? true),
    preloadFirstFile: options?.preloadChanges === true,
    autoSelectFirstFile: isPanelOpen && layout.modes.includes("changes"),
    lastTurnPaths: changesScope === "lastTurn" ? lastTurnPaths : null,
    onOpenChanges: openChangesMode
  });

  const fileListState = useWorkspaceFileList({
    sourceId,
    sourceKind,
    changedFilesKey,
    dispatch,
    mode: layout.modes.includes("files") ? "files" : mode,
    isPanelOpen
  });

  const sourceRootPath: string | null = source
    ? source.kind === "workspace"
      ? source.workspace.path
      : source.project.repoPath
    : null;

  const filePreview = useFilePreview({
    sourceId,
    sourceKind,
    dispatch,
    canEdit,
    mode: layout.modes.includes("files") ? "files" : mode,
    isPanelOpen,
    rootPath: sourceRootPath,
    storageKey: panelLayoutKey && options?.sessionId ? `argmax.reviewPanel.files.${options.sessionId}` : null
  });

  const { resetForSourceChange: resetDiff, ...diffState } = reviewDiff;
  const { resetForSourceChange: resetFilePreview, openFile: openWorkspaceFile, ...previewState } = filePreview;

  const {
    openTab: openAgentTab,
    resetForSourceChange: resetAgentTabs,
    ...agentTabs
  } = useAgentTabs();

  useEffect(() => {
    if (previousSourceId.current !== sourceId) {
      previousSourceId.current = sourceId;
      resetDiff();
      resetFilePreview();
      resetAgentTabs();
      // An open panel survives a source switch (picking another project from
      // the palette while browsing its files re-targets the view in place);
      // the resets above already swap the content. A closed panel drops back
      // to the "changes" default for its next open.
      if (!panelRef.current.isPanelOpen) setMode("changes");
    }

    // Browser mode has no source to lose, so it survives the project
    // selection going away; every other mode has nothing left to show.
    if (
      !window.argmax ||
      ((!sourceId || !sourceKind) && !panelRef.current.layout.modes.includes("browser") && !panelRef.current.layout.modes.includes("new") && !panelRef.current.layout.modes.includes("side-chat"))
    ) {
      setIsPanelOpen(false);
    }
  }, [sourceId, sourceKind, resetDiff, resetFilePreview, resetAgentTabs, setMode]);

  const openInFilesView = useCallback(
    (filePath: string): void => {
      const tab: ReviewTab = { id: `file:${sourceKey}:${encodeURIComponent(filePath)}`, kind: "file", path: filePath, sourceKey };
      setTabState((current) => openReviewTab(current, tab));
      setIsPanelOpen(true);
      openWorkspaceFile(filePath);
    },
    [openWorkspaceFile, sourceKey]
  );

  const openAgent = useCallback(
    (parentToolUseId: string): void => {
      setMode("agents");
      setIsPanelOpen(true);
      openAgentTab(parentToolUseId);
    },
    [openAgentTab, setMode]
  );

  const openAgents = useCallback((): void => {
    setMode("agents");
    setIsPanelOpen(true);
  }, [setMode]);

  const openMultitask = useCallback(
    (sessionId: string): void => {
      setMode("agents");
      setIsPanelOpen(true);
      openAgentTab(multitaskTabId(sessionId));
    },
    [openAgentTab, setMode]
  );

  const openPanelInFilesMode = useCallback((): void => {
    setMode("files");
    setIsPanelOpen(true);
  }, [setMode]);

  const closePanel = useCallback((): void => {
    setIsPanelOpen(false);
  }, []);

  const panelRef = useRef({ isPanelOpen, filesCount: 0, files: diffState.files, mode, layout });
  panelRef.current = {
    isPanelOpen,
    filesCount: diffState.files.length,
    files: diffState.files,
    mode,
    layout
  };

  const togglePanel = useCallback((): void => {
    if (
      !panelRef.current.isPanelOpen &&
      panelRef.current.filesCount === 0 &&
      panelRef.current.layout.modes.length === 1 &&
      !restoredLayoutPreference.current
    ) {
      setMode("files");
    }
    setIsPanelOpen((open) => !open);
  }, [setMode]);

  const openChangesPanel = useCallback((): void => {
    setMode("changes");
    setIsPanelOpen(true);
  }, [setMode]);

  const toggleChangesPanel = useCallback((): void => {
    const changesIndex = panelRef.current.layout.modes.indexOf("changes");
    if (panelRef.current.isPanelOpen && changesIndex >= 0) {
      if (panelRef.current.layout.modes.length === 2) {
        closePane(changesIndex as 0 | 1);
      } else {
        setIsPanelOpen(false);
      }
      return;
    }
    setMode("changes");
    setIsPanelOpen(true);
  }, [closePane, setMode]);

  const openTerminal = useCallback((): void => {
    setMode("terminal");
    setIsPanelOpen(true);
  }, [setMode]);

  const toggleTerminal = useCallback((): void => {
    const terminalIndex = panelRef.current.layout.modes.indexOf("terminal");
    if (panelRef.current.isPanelOpen && terminalIndex >= 0) {
      if (panelRef.current.layout.modes.length === 2) {
        closePane(terminalIndex as 0 | 1);
      } else {
        setIsPanelOpen(false);
      }
      return;
    }
    openTerminal();
  }, [closePane, openTerminal]);

  // ⌘J is pressed on the window, not on this panel, and the pane it is meant
  // for may be mounting in the same tick (⌘J from Settings opens the chat
  // first). So it arrives as a workspace-addressed request that the matching
  // panel consumes here — once, whenever it gets there.
  const terminalRequest = useSyncExternalStore(subscribeTerminalRequest, getTerminalRequest);
  useEffect(() => {
    if (!terminalRequest || terminalRequest.workspaceId !== terminalWorkspaceId) return;
    consumeTerminalRequest(terminalRequest.seq);
    if (terminalRequest.visible) openTerminal();
    else {
      const terminalIndex = panelRef.current.layout.modes.indexOf("terminal");
      if (terminalIndex < 0) return;
      if (panelRef.current.layout.modes.length === 2) closePane(terminalIndex as 0 | 1);
      else setIsPanelOpen(false);
    }
  }, [closePane, openTerminal, terminalRequest, terminalWorkspaceId]);

  // Report what this panel shows back to the store, for the next panel that
  // mounts on this workspace. One direction only: nothing here reads it after
  // the initial state above.
  const showsTerminal = isPanelOpen && layout.modes.includes("terminal");
  useEffect(() => {
    if (!terminalWorkspaceId) return;
    setTerminalShowing(terminalWorkspaceId, showsTerminal);
  }, [showsTerminal, terminalWorkspaceId]);

  const browserTabs = useSyncExternalStore(subscribeBrowserTabs, () => getBrowserTabs(browserScopeId));
  const terminalTabs = useSyncExternalStore(subscribeTerminalTabs, () => getWorkspaceTerminalState(terminalWorkspaceId));
  const browserRegistryReady = useSyncExternalStore(subscribeBrowserTabs, isBrowserTabRegistryReady);
  const restoredBrowserIds = useRef(new Set(tabState.tabs.filter((tab) => tab.kind === "browser").map((tab) => tab.kind === "browser" ? tab.browserTabId : "")));
  const knownBrowserIds = useRef(new Set(browserTabs.map((tab) => tab.id)));
  const [closedTabs, setClosedTabs] = useState<Array<{ tab: ReviewTab; url?: string }>>([]);
  const pendingFileClose = useRef<ReviewTab | null>(null);
  const closingBrowserIds = useRef(new Set<string>());
  useEffect(() => {
    setClosedTabs([]);
    pendingFileClose.current = null;
  }, [sourceKey]);
  const knownFilePaths = useRef({ sourceKey, paths: new Set(previewState.tabs.map((tab) => tab.path)) });
  useEffect(() => {
    const live = new Set(browserTabs.map((tab) => tab.id));
    setTabState((current) => {
      let next = current;
      for (const tab of current.tabs) {
        if (tab.kind === "browser" && !closingBrowserIds.current.has(tab.id) && (knownBrowserIds.current.has(tab.browserTabId) || (browserRegistryReady && restoredBrowserIds.current.has(tab.browserTabId))) && !live.has(tab.browserTabId)) next = removeReviewTab(next, tab.id);
      }
      for (const tab of browserTabs) next = addReviewTab(next, { id: `browser:${tab.id}`, kind: "browser", browserTabId: tab.id });
      return next;
    });
    for (const id of live) knownBrowserIds.current.add(id);
  }, [browserTabs, browserRegistryReady]);
  useEffect(() => {
    setTabState((current) => {
      let next = current;
      for (const tab of current.tabs) {
        if (tab.kind === "terminal" && tab.workspaceId === terminalWorkspaceId && !terminalTabs.tabs.some((item) => item.id === tab.terminalTabId)) next = removeReviewTab(next, tab.id);
      }
      if (terminalWorkspaceId) for (const tab of terminalTabs.tabs) next = addReviewTab(next, { id: `terminal:${terminalWorkspaceId}:${tab.id}`, kind: "terminal", terminalTabId: tab.id, workspaceId: terminalWorkspaceId });
      return next;
    });
  }, [terminalTabs.tabs, terminalWorkspaceId]);
  useEffect(() => {
    if (sourceChanged) return;
    const live = new Set(previewState.tabs.map((tab) => tab.path));
    const removed = knownFilePaths.current.sourceKey === sourceKey
      ? new Set([...knownFilePaths.current.paths].filter((path) => !live.has(path)))
      : new Set<string>();
    knownFilePaths.current = { sourceKey, paths: live };
    const closing = pendingFileClose.current;
    if (closing?.kind === "file" && closing.sourceKey === sourceKey && !live.has(closing.path)) {
      setClosedTabs((current) => [...current.slice(-19), { tab: closing }]);
      pendingFileClose.current = null;
    } else if (!previewState.dirtyClosePrompt) pendingFileClose.current = null;
    setTabState((current) => {
      let next = current;
      for (const tab of current.tabs) {
        if (tab.kind === "file" && tab.sourceKey === sourceKey && removed.has(tab.path)) next = removeReviewTab(next, tab.id);
      }
      for (const tab of previewState.tabs) next = addReviewTab(next, { id: `file:${sourceKey}:${encodeURIComponent(tab.path)}`, kind: "file", path: tab.path, sourceKey });
      return next;
    });
  }, [previewState.tabs, previewState.dirtyClosePrompt, sourceChanged, sourceKey]);

  useEffect(() => {
    const visibleFile = tabState.paneTabIds.map((id) => tabState.tabs.find((tab) => tab.id === id)).find((tab) => tab?.kind === "file");
    if (!previewState.dirtyClosePrompt && visibleFile?.kind === "file" && visibleFile.sourceKey === sourceKey && previewState.tabs.some((tab) => tab.path === visibleFile.path) && previewState.activeTabPath !== visibleFile.path) previewState.selectTab(visibleFile.path);
  }, [tabState.paneTabIds, tabState.tabs, sourceKey, previewState]);

  const activateTabResource = useCallback((tab: ReviewTab): void => {
    if (tab.kind === "browser") activateBrowserTab(tab.browserTabId);
    else if (tab.kind === "terminal") setActiveTerminalTab(tab.workspaceId, tab.terminalTabId);
    else if (tab.kind === "file" && tab.sourceKey === sourceKey) previewState.selectTab(tab.path);
  }, [previewState, sourceKey]);
  const selectReviewItem = useCallback((id: string, index?: 0 | 1): void => {
    const tab = tabStateRef.current.tabs.find((item) => item.id === id);
    if (!tab) return;
    activateTabResource(tab);
    if (tab.kind === "browser") requestBrowserTabFocus(tab.browserTabId);
    setTabState((current) => selectReviewTab(current, id, index));
    setIsPanelOpen(true);
  }, [activateTabResource]);
  const closeReviewItem = useCallback((id: string): void => {
    const current = tabStateRef.current;
    const tab = current.tabs.find((item) => item.id === id);
    if (!tab) return;
    if (tab.kind === "file") {
      setTabState((state) => selectReviewTab(state, tab.id));
      pendingFileClose.current = tab;
      previewState.closeTab(tab.path);
      return;
    }
    const closeOwnerKey = tabOwnerKeyRef.current;
    const url = tab.kind === "browser" ? getBrowserTabs(browserScopeId).find((item) => item.id === tab.browserTabId)?.url : undefined;
    const finishClose = (): void => {
      const state = tabStateRef.current;
      const isCurrentSource = tabOwnerKeyRef.current === closeOwnerKey;
      const wasActive = isCurrentSource && state.paneTabIds[state.activeIndex] === id;
      if (tab.kind === "browser") removeBrowserTab(tab.browserTabId);
      else if (tab.kind === "terminal") closeTerminalTab(tab.workspaceId, tab.terminalTabId);
      if (!isCurrentSource) return;
      setClosedTabs((items) => [...items.slice(-19), { tab, url }]);
      const next = removeReviewTab(state, id);
      const active = next.tabs.find((item) => item.id === next.paneTabIds[next.activeIndex]);
      if (active) {
        activateTabResource(active);
        if (wasActive && tab.kind === "browser" && active.kind === "browser") requestBrowserTabFocus(active.browserTabId);
      }
      setTabState((latest) => removeReviewTab(latest, id));
      if (state.tabs.length === 1) setIsPanelOpen(false);
    };
    if (tab.kind === "browser" && isBrowserTabMaterialized(tab.browserTabId) && window.argmax?.browser?.close) {
      if (closingBrowserIds.current.has(id)) return;
      closingBrowserIds.current.add(id);
      void window.argmax.browser.close(tab.browserTabId).then(finishClose).catch((error: unknown) => showErrorToast(`Could not close browser tab: ${errorMessage(error)}`)).finally(() => closingBrowserIds.current.delete(id));
    } else finishClose();
  }, [activateTabResource, browserScopeId, previewState]);
  const openNewTerminal = useCallback((): void => {
    if (!terminalWorkspaceId) return;
    const terminalTabId = addReviewTerminal(terminalWorkspaceId);
    const tab: ReviewTab = { id: `terminal:${terminalWorkspaceId}:${terminalTabId}`, kind: "terminal", terminalTabId, workspaceId: terminalWorkspaceId };
    setTabState((current) => openReviewTab(current, tab));
    setIsPanelOpen(true);
  }, [terminalWorkspaceId]);
  const selectBrowserTab = useCallback((browserTabId: string): void => {
    const tab: ReviewTab = { id: `browser:${browserTabId}`, kind: "browser", browserTabId };
    activateBrowserTab(browserTabId);
    setTabState((current) => openReviewTab(current, tab));
    setIsPanelOpen(true);
  }, []);
  const selectTerminalTab = useCallback((terminalTabId: string): void => {
    if (!terminalWorkspaceId) return;
    const tab: ReviewTab = { id: `terminal:${terminalWorkspaceId}:${terminalTabId}`, kind: "terminal", terminalTabId, workspaceId: terminalWorkspaceId };
    setActiveTerminalTab(terminalWorkspaceId, terminalTabId);
    setTabState((current) => openReviewTab(current, tab));
    setIsPanelOpen(true);
  }, [terminalWorkspaceId]);
  const tabs: ReviewTabsController = {
    items: tabState.tabs,
    paneTabIds: tabState.paneTabIds,
    activeIndex: tabState.activeIndex,
    select: selectReviewItem,
    close: closeReviewItem,
    move: (id, index) => setTabState((current) => moveReviewTab(current, id, index)),
    split: (id, position) => {
      const tab = tabStateRef.current.tabs.find((item) => item.id === id);
      if (tab) {
        activateTabResource(tab);
        if (tab.kind === "browser") requestBrowserTabFocus(tab.browserTabId);
      }
      setTabState((current) => splitReviewTab(current, id, position));
      setIsPanelOpen(true);
    },
    reopenClosed: () => {
      const closed = closedTabs[closedTabs.length - 1];
      if (!closed) return;
      setClosedTabs((items) => items.slice(0, -1));
      if (closed.tab.kind === "browser") openBrowserAt(closed.url ?? DEFAULT_BROWSER_URL, undefined, true);
      else if (closed.tab.kind === "terminal") openNewTerminal();
      else if (closed.tab.kind === "side-chat") {
        const tab = closed.tab;
        setTabState((current) => openReviewTab(current, tab));
        setIsPanelOpen(true);
      } else if (closed.tab.kind === "file") {
        if (closed.tab.sourceKey === sourceKey) openInFilesView(closed.tab.path);
      } else {
        setMode(closed.tab.mode);
        setIsPanelOpen(true);
      }
    },
    canReopen: closedTabs.length > 0,
    openTool: (nextMode) => { setMode(nextMode); setIsPanelOpen(true); },
    openBrowser: (url) => {
      const existing = url ? getBrowserTabs(browserScopeId).find((tab) => tab.url === url) : undefined;
      openBrowserAt(url ?? DEFAULT_BROWSER_URL, existing?.id, !existing);
    },
    openTerminal: openNewTerminal,
    openSideChat: (sessionId, workspaceId, sourceTabId) => {
      if (!options?.sessionId) return;
      const tab: ReviewTab = { id: `side-chat:${sessionId}`, kind: "side-chat", sessionId, workspaceId };
      setTabState((current) => {
        if (!sourceTabId) return openReviewTab(current, tab);
        const form = current.tabs.find((item) => item.id === sourceTabId);
        if (!form || form.kind !== "tool" || (form.mode !== "new" && form.mode !== "side-chat")) return addReviewTab(current, tab);
        if (current.tabs.some((item) => item.id === tab.id)) return removeReviewTab(current, form.id);
        return {
          ...current,
          tabs: current.tabs.map((item) => item.id === form.id ? tab : item),
          paneTabIds: current.paneTabIds.map((id) => id === form.id ? tab.id : id) as ReviewTabsState["paneTabIds"]
        };
      });
      if (!sourceTabId) setIsPanelOpen(true);
    },
    selectBrowserTab,
    selectTerminalTab
  };

  const workspaceFiles: WorkspaceFilesState = {
    entries: fileListState.entries,
    listState: fileListState.listState,
    listError: fileListState.listError,
    refreshList: fileListState.refresh,
    tabs: previewState.tabs,
    activeTabPath: previewState.activeTabPath,
    selectedPath: previewState.selectedPath,
    rootPath: previewState.rootPath,
    preview: previewState.preview,
    previewState: previewState.previewState,
    previewError: previewState.previewError,
    openFile: openInFilesView,
    selectTab: (path) => {
      const tab = tabStateRef.current.tabs.find((item) => item.kind === "file" && item.path === path && item.sourceKey === sourceKey);
      if (tab) selectReviewItem(tab.id);
      else previewState.selectTab(path);
    },
    closeTab: previewState.closeTab,
    dirtyClosePrompt: previewState.dirtyClosePrompt,
    saveDirtyTabAndClose: previewState.saveDirtyTabAndClose,
    discardDirtyTabAndClose: previewState.discardDirtyTabAndClose,
    cancelDirtyTabClose: previewState.cancelDirtyTabClose,
    buffer: previewState.buffer,
    isDirty: previewState.isDirty,
    diskMtimeMs: previewState.diskMtimeMs,
    externalChange: previewState.externalChange,
    saveState: previewState.saveState,
    saveError: previewState.saveError,
    canEdit: previewState.canEdit,
    editFile: previewState.editFile,
    saveFile: previewState.saveFile,
    reloadFile: previewState.reloadFile,
    dismissExternalChange: previewState.dismissExternalChange
  };

  return {
    tabs,
    projectChanges,
    projectFolderChanges,
    files: diffState.files,
    filesState: diffState.filesState,
    filesError: diffState.filesError,
    selectedFilePath: diffState.selectedFilePath,
    diff: diffState.diff,
    diffState: diffState.diffState,
    diffError: diffState.diffError,
    isPanelOpen,
    layout,
    mode,
    setMode,
    setPaneMode,
    focusPane,
    splitMode,
    closePane,
    setSplitRatio,
    changesScope,
    setChangesScope,
    availableScopes,
    comparisonBaseLabel,
    workspaceFiles,
    agentTabs,
    openAgent,
    openAgents,
    openMultitask,
    openBrowser,
    browserOwner,
    browserScopeId,
    browserRequest,
    handleBrowserRequest,
    terminalWorkspaceId,
    openTerminal,
    toggleTerminal,
    openFile: diffState.openFile,
    refreshChanges: diffState.refreshChanges,
    expandDiffContext: diffState.expandDiffContext,
    updateFileIndex: diffState.updateFileIndex,
    revertFile: diffState.revertFile,
    revertHunk: diffState.revertHunk,
    updateHunkIndex: diffState.updateHunkIndex,
    openPanelInFilesMode,
    openInFilesView,
    openChangesPanel,
    closePanel,
    togglePanel,
    toggleChangesPanel
  };
}
