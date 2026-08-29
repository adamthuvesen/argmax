import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangedFileSummary,
  ProjectSummary,
  ReviewComparison,
  WorkspaceDiff,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceSummary
} from "../../shared/types.js";
import { filterToLastTurn } from "../lib/lastTurnFiles.js";
import { reviewIpcDispatch } from "../lib/reviewIpc.js";
import { usePersistedSetting } from "./usePersistedSetting.js";
import { useFilePreview } from "./useFilePreview.js";
import { useReviewDiff } from "./useReviewDiff.js";
import { useWorkspaceFileList } from "./useWorkspaceFileList.js";

export type AsyncState = "idle" | "loading" | "ready" | "error";
export type ReviewPanelMode = "changes" | "files";

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
  openFile: (filePath: string) => void;
  openPanelInFilesMode: () => void;
  openInFilesView: (filePath: string) => void;
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

  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [mode, setMode] = useState<ReviewPanelMode>("changes");
  const [storedScope, setChangesScope] = useState<ReviewChangesScope>(readStoredScope);
  usePersistedSetting(SCOPE_KEY, storedScope);
  const previousSourceId = useRef<string | null>(null);

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
    isPanelOpen,
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

  const {
    resetForSourceChange: resetDiff,
    setSelectedFilePath,
    ...diffState
  } = reviewDiff;
  const { resetForSourceChange: resetFileList, ...fileListState } = fileList;
  const { resetForSourceChange: resetFilePreview, openFile: openWorkspaceFile, ...previewState } = filePreview;

  useEffect(() => {
    if (previousSourceId.current !== sourceId) {
      previousSourceId.current = sourceId;
      resetDiff();
      resetFileList();
      resetFilePreview();
      // An open panel survives a source switch (picking another project from
      // the palette while browsing its files re-targets the view in place);
      // the resets above already swap the content. A closed panel drops back
      // to the "changes" default for its next open.
      if (!panelRef.current.isPanelOpen) setMode("changes");
    }

    if (!sourceId || !sourceKind || !window.argmax) {
      setIsPanelOpen(false);
    }
  }, [sourceId, sourceKind, resetDiff, resetFileList, resetFilePreview]);

  const openInFilesView = useCallback(
    (filePath: string): void => {
      setMode("files");
      setIsPanelOpen(true);
      openWorkspaceFile(filePath);
    },
    [openWorkspaceFile]
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

  const togglePanel = useCallback((): void => {
    const opening = !panelRef.current.isPanelOpen;
    if (opening && panelRef.current.filesCount === 0) {
      setMode("files");
    } else if (opening && panelRef.current.mode === "changes") {
      // Warm the first file's diff the instant the panel opens (the list is
      // already prefetched on focus), so there's no dead beat before content.
      setSelectedFilePath((current) => current ?? panelRef.current.files[0]?.path ?? null);
    }
    setIsPanelOpen((open) => !open);
  }, [setSelectedFilePath]);

  const toggleChangesPanel = useCallback((): void => {
    if (panelRef.current.isPanelOpen && panelRef.current.mode === "changes") {
      setIsPanelOpen(false);
      return;
    }
    setMode("changes");
    setIsPanelOpen(true);
    setSelectedFilePath((current) => current ?? panelRef.current.files[0]?.path ?? null);
  }, [setSelectedFilePath]);

  const workspaceFiles: WorkspaceFilesState = {
    entries: fileListState.entries,
    listState: fileListState.listState,
    listError: fileListState.listError,
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
    openFile: diffState.openFile,
    openPanelInFilesMode,
    openInFilesView,
    closePanel,
    togglePanel,
    toggleChangesPanel
  };
}
