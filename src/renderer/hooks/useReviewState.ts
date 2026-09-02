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
  getBrowserOwnerId,
  getBrowserRequest,
  lastBrowsedUrl,
  releaseBrowserSurface,
  subscribeBrowserOwner,
  subscribeBrowserRequest,
  type BrowserOpenRequest
} from "../lib/browserPanel.js";
import { filterToLastTurn } from "../lib/lastTurnFiles.js";
import {
  consumeTerminalRequest,
  getTerminalRequest,
  getWorkspaceTerminalState,
  setTerminalShowing,
  subscribeTerminalRequest
} from "../lib/terminalTabs.js";
import { reviewIpcDispatch } from "../lib/reviewIpc.js";
import { usePersistedSetting } from "./usePersistedSetting.js";
import { useFilePreview } from "./useFilePreview.js";
import { useSubagentTabs, type SubagentTabsState } from "./useSubagentTabs.js";
import { useReviewDiff } from "./useReviewDiff.js";
import { useWorkspaceFileList } from "./useWorkspaceFileList.js";

export type AsyncState = "idle" | "loading" | "ready" | "error";
export type ReviewPanelMode = "changes" | "files" | "agents" | "browser" | "terminal";

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
  | { kind: "project"; project: ProjectSummary };

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
  files: ChangedFileSummary[];
  filesState: AsyncState;
  filesError: string | null;
  selectedFilePath: string | null;
  diff: WorkspaceDiff | null;
  diffState: AsyncState;
  diffError: string | null;
  isPanelOpen: boolean;
  mode: ReviewPanelMode;
  setMode: (mode: ReviewPanelMode) => void;
  /** Which slice of the work the Changes view shows. */
  changesScope: ReviewChangesScope;
  setChangesScope: (scope: ReviewChangesScope) => void;
  /** Scopes this source can offer. "lastTurn" needs a session transcript. */
  availableScopes: ReviewChangesScope[];
  /** Base branch label for the scope picker (e.g. "main"); null when no source
   *  is active. */
  comparisonBaseLabel: string | null;
  workspaceFiles: WorkspaceFilesState;
  /** Subagents open in the Agents view. Empty until one is opened from the
   *  transcript, which is also the only way one gets here. */
  subagents: SubagentTabsState;
  /** Open the panel on a subagent, adding its tab if it is not open yet. */
  openAgent: (parentToolUseId: string) => void;
  /** Open the panel on the Browser view, taking the one native surface. */
  openBrowser: () => void;
  /** Workspace whose integrated terminal this panel hosts. Null on a
   *  project-backed panel (the launcher), which has no workspace to run in —
   *  and so has no Terminal tab. */
  terminalWorkspaceId: string | null;
  /** Open the panel on the Terminal view. */
  openTerminal: () => void;
  /** ⌘J and the workspace card's Terminal row: show the terminal, or hide the
   *  panel when it is already the one showing. */
  toggleTerminal: () => void;
  /** True when this panel holds the browser surface. Only the owner mounts the
   *  browser chrome; every other panel in Browser mode shows a placeholder. */
  browserOwner: boolean;
  /** Where the Browser view should be, and a sequence number that re-navigates
   *  even when the URL is the one the page is already on. Null until this
   *  panel has been asked for the browser at least once. */
  browserRequest: BrowserOpenRequest | null;
  openFile: (filePath: string) => void;
  /** Reload the open file's diff with more unchanged context around its hunks. */
  expandDiffContext: () => void;
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
    /** Full-screen surfaces where the panel IS the screen start open, so the
     *  data hooks load on the first render instead of after a mount effect —
     *  an effect-driven open races useReviewDiff's auto-select of the first
     *  changed file. Defaults to closed. */
    initiallyOpen?: boolean;
    /** Whether open-in-browser requests (chat links, the actions menu) land in
     *  this panel. True for the focused pane, and for a launcher that is the
     *  only surface on screen. Defaults to false. */
    claimsBrowserRequests?: boolean;
  }
): ReviewState {
  const sourceKind = source?.kind ?? null;
  const sourceId: string | null = source
    ? source.kind === "workspace"
      ? source.workspace.id
      : source.project.id
    : null;
  const changedFilesKey: string | null =
    source?.kind === "workspace" ? `${source.workspace.changedFiles}:${source.workspace.state}` : null;
  const canEdit = sourceKind !== null && (options?.editable ?? true);

  const dispatch = useMemo(
    () => (sourceKind && sourceId ? reviewIpcDispatch({ kind: sourceKind, id: sourceId }) : null),
    [sourceKind, sourceId]
  );

  const terminalWorkspaceId = source?.kind === "workspace" ? source.workspace.id : null;
  // A pane dies on every session switch, so the panel's mode cannot remember
  // that the reader had the terminal up. The workspace-keyed store can, and
  // seeding from it here is what brings them back to the shell they left
  // running rather than to the Changes default.
  const [isPanelOpen, setIsPanelOpen] = useState(
    () => options?.initiallyOpen ?? getWorkspaceTerminalState(terminalWorkspaceId).showing
  );
  const [mode, setMode] = useState<ReviewPanelMode>(() =>
    getWorkspaceTerminalState(terminalWorkspaceId).showing ? "terminal" : "changes"
  );
  const [storedScope, setChangesScope] = useState<ReviewChangesScope>(readStoredScope);
  usePersistedSetting(SCOPE_KEY, storedScope);
  const previousSourceId = useRef<string | null>(null);

  // --- Browser mode -------------------------------------------------------
  // One native browser surface exists, so one panel shows it at a time. This
  // id identifies the panel to the surface-ownership store.
  const panelId = useId();
  const [browserRequest, setBrowserRequest] = useState<BrowserOpenRequest | null>(null);
  const browserOwner = useSyncExternalStore(subscribeBrowserOwner, getBrowserOwnerId) === panelId;

  const openBrowserAt = useCallback(
    (url: string): void => {
      // Claim here, not only in the effect below: a demoted panel is already
      // in Browser mode with the panel open, so neither of the effect's deps
      // changes and "Show here" would be a no-op.
      claimBrowserSurface(panelId);
      setBrowserRequest((current) => ({ url, seq: (current?.seq ?? 0) + 1 }));
      setMode("browser");
      setIsPanelOpen(true);
    },
    [panelId]
  );

  const openBrowser = useCallback((): void => openBrowserAt(lastBrowsedUrl()), [openBrowserAt]);

  // Entering Browser mode by any path takes the surface; leaving it — another
  // mode, a closed panel, an unmounted pane — hands it back, unless another
  // panel has already claimed it in the meantime.
  useEffect(() => {
    if (mode !== "browser" || !isPanelOpen) return undefined;
    claimBrowserSurface(panelId);
    return () => releaseBrowserSurface(panelId);
  }, [isPanelOpen, mode, panelId]);

  // Open-in-browser requests (chat links, the actions menu). Every panel
  // tracks the sequence, so one that was unfocused when a request landed does
  // not act on it later when focus arrives; only the panel taking requests
  // right now switches itself to Browser mode.
  const pendingBrowserRequest = useSyncExternalStore(subscribeBrowserRequest, getBrowserRequest);
  const claimsBrowserRequests = useRef(options?.claimsBrowserRequests ?? false);
  claimsBrowserRequests.current = options?.claimsBrowserRequests ?? false;
  const handledBrowserSeq = useRef(pendingBrowserRequest?.seq ?? 0);
  useEffect(() => {
    if (!pendingBrowserRequest || pendingBrowserRequest.seq === handledBrowserSeq.current) return;
    handledBrowserSeq.current = pendingBrowserRequest.seq;
    if (!claimsBrowserRequests.current) return;
    openBrowserAt(pendingBrowserRequest.url);
  }, [openBrowserAt, pendingBrowserRequest]);

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
  }, []);

  const reviewDiff = useReviewDiff({
    sourceId,
    sourceKind,
    changedFilesKey,
    comparison,
    dispatch,
    onOpenChanges: openChangesMode
  });

  const fileList = useWorkspaceFileList({
    sourceId,
    sourceKind,
    changedFilesKey,
    dispatch,
    mode,
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
    mode,
    isPanelOpen,
    rootPath: sourceRootPath
  });

  const { resetForSourceChange: resetDiff, ...diffState } = reviewDiff;
  const { resetForSourceChange: resetFileList, ...fileListState } = fileList;
  const { resetForSourceChange: resetFilePreview, openFile: openWorkspaceFile, ...previewState } = filePreview;

  const {
    openTab: openSubagentTab,
    resetForSourceChange: resetSubagents,
    ...subagents
  } = useSubagentTabs();

  useEffect(() => {
    if (previousSourceId.current !== sourceId) {
      previousSourceId.current = sourceId;
      resetDiff();
      resetFileList();
      resetFilePreview();
      resetSubagents();
      // An open panel survives a source switch (picking another project from
      // the palette while browsing its files re-targets the view in place);
      // the resets above already swap the content. A closed panel drops back
      // to the "changes" default for its next open.
      if (!panelRef.current.isPanelOpen) setMode("changes");
    }

    // Browser mode has no source to lose, so it survives the project
    // selection going away; every other mode has nothing left to show.
    if (!window.argmax || ((!sourceId || !sourceKind) && panelRef.current.mode !== "browser")) {
      setIsPanelOpen(false);
    }
  }, [sourceId, sourceKind, resetDiff, resetFileList, resetFilePreview, resetSubagents]);

  const openInFilesView = useCallback(
    (filePath: string): void => {
      setMode("files");
      setIsPanelOpen(true);
      openWorkspaceFile(filePath);
    },
    [openWorkspaceFile]
  );

  const openAgent = useCallback(
    (parentToolUseId: string): void => {
      setMode("agents");
      setIsPanelOpen(true);
      openSubagentTab(parentToolUseId);
    },
    [openSubagentTab]
  );

  const openPanelInFilesMode = useCallback((): void => {
    setMode("files");
    setIsPanelOpen(true);
  }, []);

  const closePanel = useCallback((): void => {
    setIsPanelOpen(false);
  }, []);

  // "Last turn" reuses the branch query and narrows it here, so switching
  // scopes costs no git work and the diff already loaded for a file stays valid.
  const visibleFiles =
    changesScope === "lastTurn" && lastTurnPaths !== null
      ? filterToLastTurn(diffState.files, lastTurnPaths)
      : diffState.files;

  const panelRef = useRef({ isPanelOpen, filesCount: 0, files: visibleFiles, mode });
  panelRef.current = { isPanelOpen, filesCount: visibleFiles.length, files: visibleFiles, mode };

  // Opening the panel never expands a diff: the changed files start collapsed
  // and stay that way until the reader picks one.
  const togglePanel = useCallback((): void => {
    if (!panelRef.current.isPanelOpen && panelRef.current.filesCount === 0) {
      setMode("files");
    }
    setIsPanelOpen((open) => !open);
  }, []);

  const openChangesPanel = useCallback((): void => {
    setMode("changes");
    setIsPanelOpen(true);
  }, []);

  const toggleChangesPanel = useCallback((): void => {
    if (panelRef.current.isPanelOpen && panelRef.current.mode === "changes") {
      setIsPanelOpen(false);
      return;
    }
    setMode("changes");
    setIsPanelOpen(true);
  }, []);

  const openTerminal = useCallback((): void => {
    setMode("terminal");
    setIsPanelOpen(true);
  }, []);

  const toggleTerminal = useCallback((): void => {
    if (panelRef.current.isPanelOpen && panelRef.current.mode === "terminal") {
      setIsPanelOpen(false);
      return;
    }
    openTerminal();
  }, [openTerminal]);

  // ⌘J is pressed on the window, not on this panel, and the pane it is meant
  // for may be mounting in the same tick (⌘J from Settings opens the chat
  // first). So it arrives as a workspace-addressed request that the matching
  // panel consumes here — once, whenever it gets there.
  const terminalRequest = useSyncExternalStore(subscribeTerminalRequest, getTerminalRequest);
  useEffect(() => {
    if (!terminalRequest || terminalRequest.workspaceId !== terminalWorkspaceId) return;
    consumeTerminalRequest(terminalRequest.seq);
    if (terminalRequest.visible) openTerminal();
    else if (panelRef.current.mode === "terminal") setIsPanelOpen(false);
  }, [openTerminal, terminalRequest, terminalWorkspaceId]);

  // Report what this panel shows back to the store, for the next panel that
  // mounts on this workspace. One direction only: nothing here reads it after
  // the initial state above.
  const showsTerminal = isPanelOpen && mode === "terminal";
  useEffect(() => {
    if (!terminalWorkspaceId) return;
    setTerminalShowing(terminalWorkspaceId, showsTerminal);
  }, [showsTerminal, terminalWorkspaceId]);

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
    openFile: openWorkspaceFile,
    selectTab: previewState.selectTab,
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
    files: visibleFiles,
    filesState: diffState.filesState,
    filesError: diffState.filesError,
    selectedFilePath: diffState.selectedFilePath,
    diff: diffState.diff,
    diffState: diffState.diffState,
    diffError: diffState.diffError,
    isPanelOpen,
    mode,
    setMode,
    changesScope,
    setChangesScope,
    availableScopes,
    comparisonBaseLabel,
    workspaceFiles,
    subagents,
    openAgent,
    openBrowser,
    browserOwner,
    browserRequest,
    terminalWorkspaceId,
    openTerminal,
    toggleTerminal,
    openFile: diffState.openFile,
    expandDiffContext: diffState.expandDiffContext,
    openPanelInFilesMode,
    openInFilesView,
    openChangesPanel,
    closePanel,
    togglePanel,
    toggleChangesPanel
  };
}
