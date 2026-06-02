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
import { reviewIpcDispatch } from "../lib/reviewIpc.js";
import { usePersistedSetting } from "./usePersistedSetting.js";
import { useFilePreview } from "./useFilePreview.js";
import { useReviewDiff } from "./useReviewDiff.js";
import { useWorkspaceFileList } from "./useWorkspaceFileList.js";

export type AsyncState = "idle" | "loading" | "ready" | "error";
export type ReviewPanelMode = "changes" | "files";
/** Which baseline the Changes view diffs against. "local" → working tree vs
 *  HEAD; "branch" → everything different from the base branch. */
export type ReviewChangesComparison = "local" | "branch";
export type WorkspaceFileSaveState = "idle" | "saving" | "error";

const COMPARISON_KEY = "argmax.reviewPanel.changesComparison";

function readStoredComparison(): ReviewChangesComparison {
  if (typeof window === "undefined") return "local";
  return window.localStorage.getItem(COMPARISON_KEY) === "branch" ? "branch" : "local";
}

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
  /** Changes-view baseline: working tree ("local") vs base branch ("branch"). */
  changesComparison: ReviewChangesComparison;
  setChangesComparison: (comparison: ReviewChangesComparison) => void;
  /** Base branch label for the Branch toggle title (e.g. "main"); null when no
   *  source is active. */
  comparisonBaseLabel: string | null;
  workspaceFiles: WorkspaceFilesState;
  openFile: (filePath: string) => void;
  openPanelInFilesMode: () => void;
  openInFilesView: (filePath: string) => void;
  closePanel: () => void;
  togglePanel: () => void;
  toggleChangesPanel: () => void;
}

export function useReviewState(source: ReviewSource | null): ReviewState {
  const sourceKind = source?.kind ?? null;
  const sourceId: string | null = source
    ? source.kind === "workspace"
      ? source.workspace.id
      : source.project.id
    : null;
  const changedFilesKey: string | null =
    source?.kind === "workspace" ? `${source.workspace.changedFiles}:${source.workspace.state}` : null;
  const canEdit = sourceKind !== null;

  const dispatch = useMemo(
    () => (sourceKind && sourceId ? reviewIpcDispatch({ kind: sourceKind, id: sourceId }) : null),
    [sourceKind, sourceId]
  );

  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [mode, setMode] = useState<ReviewPanelMode>("changes");
  const [changesComparison, setChangesComparison] = useState<ReviewChangesComparison>(readStoredComparison);
  usePersistedSetting(COMPARISON_KEY, changesComparison);
  const previousSourceId = useRef<string | null>(null);

  const comparison: ReviewComparison = changesComparison === "branch" ? "branch" : "workingTree";
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
      setIsPanelOpen(false);
      setMode("changes");
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

  const panelRef = useRef({ isPanelOpen, filesCount: 0, files: diffState.files, mode });
  panelRef.current = { isPanelOpen, filesCount: diffState.files.length, files: diffState.files, mode };

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
    files: diffState.files,
    filesState: diffState.filesState,
    filesError: diffState.filesError,
    selectedFilePath: diffState.selectedFilePath,
    diff: diffState.diff,
    diffState: diffState.diffState,
    diffError: diffState.diffError,
    isPanelOpen,
    mode,
    setMode,
    changesComparison,
    setChangesComparison,
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
