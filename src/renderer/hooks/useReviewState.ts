import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangedFileSummary,
  ProjectSummary,
  WorkspaceDiff,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceSummary
} from "../../shared/types.js";
import { reviewIpcDispatch, type ReviewIpcDispatch } from "../lib/reviewIpc.js";
import { errorMessage } from "../../shared/error.js";

export type AsyncState = "idle" | "loading" | "ready" | "error";
export type ReviewPanelMode = "changes" | "files";
export type WorkspaceFileSaveState = "idle" | "saving" | "error";

/**
 * Either a workspace (worktree-backed, full read/write) or the project's
 * main checkout (read-only, surfaced on the LaunchSurface before a session
 * exists). Both render the same Changes + Files panel; the project variant
 * disables write/stat polling because the main repo shouldn't be edited from
 * the landing page.
 */
export type ReviewSource =
  | { kind: "workspace"; workspace: WorkspaceSummary }
  | { kind: "project"; project: ProjectSummary };

type SourceKind = ReviewSource["kind"];

export interface WorkspaceFileTab {
  path: string;
  isDirty: boolean;
  saveState: WorkspaceFileSaveState;
  externalChange: boolean;
}

export interface WorkspaceFileDirtyClosePrompt {
  path: string;
}

interface WorkspaceFileTabState {
  path: string;
  preview: WorkspaceFilePreview | null;
  previewState: AsyncState;
  previewError: string | null;
  buffer: string | null;
  original: string | null;
  diskMtimeMs: number | null;
  externalChange: boolean;
  saveState: WorkspaceFileSaveState;
  saveError: string | null;
}

function createWorkspaceFileTab(path: string): WorkspaceFileTabState {
  return {
    path,
    preview: null,
    previewState: "idle",
    previewError: null,
    buffer: null,
    original: null,
    diskMtimeMs: null,
    externalChange: false,
    saveState: "idle",
    saveError: null
  };
}

function isWorkspaceFileTabDirty(tab: WorkspaceFileTabState | null, canEdit: boolean): boolean {
  if (!canEdit || !tab || tab.buffer === null) return false;
  return tab.buffer !== tab.original;
}

export interface WorkspaceFilesState {
  entries: WorkspaceFileEntry[];
  listState: AsyncState;
  listError: string | null;
  tabs: WorkspaceFileTab[];
  activeTabPath: string | null;
  selectedPath: string | null;
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
  /** False when the panel is rendered for a project (main checkout, read-only). */
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
  isSummaryCollapsed: boolean;
  mode: ReviewPanelMode;
  setMode: (mode: ReviewPanelMode) => void;
  workspaceFiles: WorkspaceFilesState;
  openFile: (filePath: string) => void;
  openPanelInFilesMode: () => void;
  openInFilesView: (filePath: string) => void;
  closePanel: () => void;
  togglePanel: () => void;
  toggleSummary: () => void;
}

export function useReviewState(source: ReviewSource | null): ReviewState {
  const sourceKind: SourceKind | null = source?.kind ?? null;
  const sourceId: string | null = source
    ? source.kind === "workspace"
      ? source.workspace.id
      : source.project.id
    : null;
  // Project sources have no live activity counter. Workspace mode refetches on
  // the changed-file count and lifecycle state: provider completion can publish
  // `running -> complete` before the cached count has caught up, so the state
  // edge is the signal to ask git for the authoritative file list.
  const changedFilesKey: string | null =
    source?.kind === "workspace" ? `${source.workspace.changedFiles}:${source.workspace.state}` : null;
  const canEdit = sourceKind === "workspace" || sourceKind === "project";

  // Single dispatch object bound to the active source. Cached per (kind, id)
  // so the six closures keep stable identities until the user navigates to
  // a different workspace/project. The ref mirrors the latest dispatch for
  // callbacks that intentionally do not re-bind on source change — they read
  // the current ref value at call time instead of capturing a stale closure.
  const dispatch: ReviewIpcDispatch | null = useMemo(
    () => (sourceKind && sourceId ? reviewIpcDispatch({ kind: sourceKind, id: sourceId }) : null),
    [sourceKind, sourceId]
  );
  // Mirror dispatch into a ref so the stable callbacks below (`reloadWorkspaceFile`,
  // `dismissExternalChange`, `saveWorkspaceFile`) read the current value at call
  // time instead of capturing a closure. Initialized synchronously (not via
  // useEffect) so the very first call lands against the right dispatch, not
  // null — the effect-based mirror was the M4 finding from /review.
  const dispatchRef = useRef<ReviewIpcDispatch | null>(dispatch);
  dispatchRef.current = dispatch;

  const [files, setFiles] = useState<ChangedFileSummary[]>([]);
  const [filesState, setFilesState] = useState<AsyncState>("idle");
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffState, setDiffState] = useState<AsyncState>("idle");
  const [diffError, setDiffError] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isSummaryCollapsed, setIsSummaryCollapsed] = useState(true);
  const [mode, setMode] = useState<ReviewPanelMode>("changes");
  const [workspaceFileEntries, setWorkspaceFileEntries] = useState<WorkspaceFileEntry[]>([]);
  const [workspaceFilesListState, setWorkspaceFilesListState] = useState<AsyncState>("idle");
  const [workspaceFilesListError, setWorkspaceFilesListError] = useState<string | null>(null);
  const [workspaceFileTabs, setWorkspaceFileTabs] = useState<WorkspaceFileTabState[]>([]);
  const [workspaceActiveFilePath, setWorkspaceActiveFilePath] = useState<string | null>(null);
  const [workspaceDirtyClosePath, setWorkspaceDirtyClosePath] = useState<string | null>(null);
  const fileLoadToken = useRef(0);
  const diffLoadToken = useRef(0);
  const workspaceListToken = useRef(0);
  const workspaceReadSeq = useRef(0);
  const workspaceReadTokens = useRef(new Map<string, number>());
  const workspaceSaveSeq = useRef(0);
  const workspaceSaveTokens = useRef(new Map<string, number>());
  const previousSourceId = useRef<string | null>(null);
  const isPanelOpenRef = useRef(false);
  const filesCountRef = useRef(0);
  // Refs mirror the latest values for use inside event listeners (focus,
  // dashboard:delta) so we don't need to re-bind the listener on every keystroke.
  const sourceIdRef = useRef<string | null>(null);
  const sourceKindRef = useRef<SourceKind | null>(null);
  const canEditRef = useRef(false);
  const workspaceFileTabsRef = useRef<WorkspaceFileTabState[]>([]);
  const workspaceActiveFilePathRef = useRef<string | null>(null);
  const workspaceActiveDiskMtimeMsRef = useRef<number | null>(null);

  const activeWorkspaceFileTab =
    workspaceFileTabs.find((tab) => tab.path === workspaceActiveFilePath) ?? null;
  workspaceFileTabsRef.current = workspaceFileTabs;
  workspaceActiveFilePathRef.current = workspaceActiveFilePath;
  workspaceActiveDiskMtimeMsRef.current = activeWorkspaceFileTab?.diskMtimeMs ?? null;

  useEffect(() => {
    sourceIdRef.current = sourceId;
    sourceKindRef.current = sourceKind;
    canEditRef.current = canEdit;
  }, [sourceId, sourceKind, canEdit]);

  useEffect(() => {
    isPanelOpenRef.current = isPanelOpen;
  }, [isPanelOpen]);

  useEffect(() => {
    filesCountRef.current = files.length;
  }, [files]);

  const updateWorkspaceFileTab = useCallback(
    (filePath: string, update: (tab: WorkspaceFileTabState) => WorkspaceFileTabState): void => {
      setWorkspaceFileTabs((current) =>
        current.map((tab) => (tab.path === filePath ? update(tab) : tab))
      );
    },
    []
  );

  const loadWorkspaceFile = useCallback(
    (filePath: string): void => {
      const id = sourceIdRef.current;
      const kind = sourceKindRef.current;
      if (!id || !kind || !window.argmax) return;
      const ipc = dispatchRef.current;
      if (!ipc) return;
      const token = ++workspaceReadSeq.current;
      workspaceReadTokens.current.set(filePath, token);
      updateWorkspaceFileTab(filePath, (tab) => ({
        ...tab,
        previewState: "loading",
        previewError: null,
        externalChange: false
      }));
      void ipc.readFile(filePath)
        .then((preview) => {
          if (workspaceReadTokens.current.get(filePath) !== token) return;
          updateWorkspaceFileTab(filePath, (tab) => ({
            ...tab,
            preview,
            previewState: "ready",
            previewError: null,
            buffer: preview.kind === "text" ? preview.content : null,
            original: preview.kind === "text" ? preview.content : null,
            diskMtimeMs: preview.kind === "text" ? preview.mtimeMs : null,
            externalChange: false,
            saveState: "idle",
            saveError: null
          }));
        })
        .catch((error) => {
          if (workspaceReadTokens.current.get(filePath) !== token) return;
          updateWorkspaceFileTab(filePath, (tab) => ({
            ...tab,
            preview: null,
            previewState: "error",
            previewError: errorMessage(error) || "Could not read file.",
            buffer: null,
            original: null,
            diskMtimeMs: null
          }));
        });
    },
    [updateWorkspaceFileTab]
  );

  useEffect(() => {
    const token = ++fileLoadToken.current;
    if (previousSourceId.current !== sourceId) {
      previousSourceId.current = sourceId;
      setSelectedFilePath(null);
      setDiff(null);
      setDiffState("idle");
      setDiffError(null);
      setIsPanelOpen(false);
      setIsSummaryCollapsed(true);
      setMode("changes");
      setWorkspaceFileEntries([]);
      setWorkspaceFilesListState("idle");
      setWorkspaceFilesListError(null);
      setWorkspaceFileTabs([]);
      setWorkspaceActiveFilePath(null);
      setWorkspaceDirtyClosePath(null);
      workspaceReadTokens.current.clear();
      workspaceSaveTokens.current.clear();
    }

    if (!sourceId || !sourceKind || !window.argmax) {
      setFiles([]);
      setFilesState("idle");
      setFilesError(null);
      setIsPanelOpen(false);
      setIsSummaryCollapsed(true);
      return;
    }

    setFilesState("loading");
    setFilesError(null);
    void dispatch!.listChangedFiles()
      .then((result) => {
        if (token !== fileLoadToken.current) {
          return;
        }
        const sorted = [...result].sort((left, right) => left.path.localeCompare(right.path));
        setFiles(sorted);
        setFilesState("ready");
        setSelectedFilePath((currentPath) => {
          if (currentPath && sorted.some((file) => file.path === currentPath)) {
            return currentPath;
          }
          return isPanelOpenRef.current ? sorted[0]?.path ?? null : null;
        });
        if (sorted.length === 0) {
          setIsPanelOpen(false);
        }
      })
      .catch((error) => {
        if (token !== fileLoadToken.current) {
          return;
        }
        setFiles([]);
        setFilesState("error");
        setFilesError(errorMessage(error) || "Could not load changed files.");
      });
    // Depend on the changed-file count (workspace mode only), not on
    // lastActivityAt — the activity timestamp bumps for every event delta,
    // which would re-fetch the changed files list ~once per streamed token.
    // Project mode has no live counter; we refetch only on source id change.
  }, [sourceId, sourceKind, changedFilesKey, dispatch]);

  useEffect(() => {
    const token = ++diffLoadToken.current;
    if (!sourceId || !sourceKind || !selectedFilePath || !window.argmax) {
      setDiff(null);
      setDiffState("idle");
      setDiffError(null);
      return;
    }

    setDiffState("loading");
    setDiffError(null);
    void dispatch!.loadDiff(selectedFilePath)
      .then((result) => {
        if (token !== diffLoadToken.current) {
          return;
        }
        setDiff(result);
        setDiffState("ready");
      })
      .catch((error) => {
        if (token !== diffLoadToken.current) {
          return;
        }
        setDiff(null);
        setDiffState("error");
        setDiffError(errorMessage(error) || "Could not load diff.");
      });
  }, [sourceId, sourceKind, selectedFilePath, dispatch]);

  useEffect(() => {
    if (mode !== "files" || !isPanelOpen) return;
    const token = ++workspaceListToken.current;
    if (!sourceId || !sourceKind || !window.argmax) {
      setWorkspaceFileEntries([]);
      setWorkspaceFilesListState("idle");
      setWorkspaceFilesListError(null);
      return;
    }
    setWorkspaceFilesListState("loading");
    setWorkspaceFilesListError(null);
    void dispatch!.listFiles()
      .then((entries) => {
        if (token !== workspaceListToken.current) return;
        setWorkspaceFileEntries(entries);
        setWorkspaceFilesListState("ready");
      })
      .catch((error) => {
        if (token !== workspaceListToken.current) return;
        setWorkspaceFileEntries([]);
        setWorkspaceFilesListState("error");
        setWorkspaceFilesListError(errorMessage(error) || "Could not load files.");
      });
    // Same reason as the changed-files effect above.
  }, [mode, isPanelOpen, sourceId, sourceKind, changedFilesKey, dispatch]);

  useEffect(() => {
    if (mode !== "files" || !isPanelOpen) return;
    if (!sourceId || !sourceKind || !window.argmax) return;
    if (!activeWorkspaceFileTab || activeWorkspaceFileTab.previewState !== "idle") return;
    loadWorkspaceFile(activeWorkspaceFileTab.path);
  }, [
    mode,
    isPanelOpen,
    sourceId,
    sourceKind,
    activeWorkspaceFileTab?.path,
    activeWorkspaceFileTab?.previewState,
    loadWorkspaceFile
  ]);

  const openFile = useCallback((filePath: string): void => {
    setSelectedFilePath(filePath);
    setMode("changes");
    setIsPanelOpen(true);
  }, []);

  const openWorkspaceFile = useCallback((filePath: string): void => {
    setWorkspaceFileTabs((current) =>
      current.some((tab) => tab.path === filePath) ? current : [...current, createWorkspaceFileTab(filePath)]
    );
    setWorkspaceActiveFilePath(filePath);
    setWorkspaceDirtyClosePath(null);
  }, []);

  const selectWorkspaceFileTab = useCallback((filePath: string): void => {
    if (!workspaceFileTabsRef.current.some((tab) => tab.path === filePath)) return;
    setWorkspaceActiveFilePath(filePath);
    setWorkspaceDirtyClosePath(null);
  }, []);

  const forceCloseWorkspaceFile = useCallback((filePath: string): void => {
    const current = workspaceFileTabsRef.current;
    const index = current.findIndex((tab) => tab.path === filePath);
    if (index < 0) return;
    const remaining = current.filter((tab) => tab.path !== filePath);
    const fallbackPath = remaining[index]?.path ?? remaining[index - 1]?.path ?? null;
    setWorkspaceFileTabs(remaining);
    setWorkspaceActiveFilePath((activePath) => {
      if (activePath && activePath !== filePath && remaining.some((tab) => tab.path === activePath)) {
        return activePath;
      }
      return fallbackPath;
    });
    setWorkspaceDirtyClosePath((promptPath) => (promptPath === filePath ? null : promptPath));
    workspaceReadTokens.current.delete(filePath);
    workspaceSaveTokens.current.delete(filePath);
  }, []);

  const closeWorkspaceFile = useCallback((filePath: string): void => {
    const tab = workspaceFileTabsRef.current.find((candidate) => candidate.path === filePath) ?? null;
    if (!tab) return;
    if (isWorkspaceFileTabDirty(tab, canEditRef.current)) {
      setWorkspaceActiveFilePath(filePath);
      setWorkspaceDirtyClosePath(filePath);
      return;
    }
    forceCloseWorkspaceFile(filePath);
  }, [forceCloseWorkspaceFile]);

  const openInFilesView = useCallback((filePath: string): void => {
    setMode("files");
    setIsPanelOpen(true);
    openWorkspaceFile(filePath);
  }, [openWorkspaceFile]);

  const editWorkspaceFile = useCallback((content: string): void => {
    if (!canEditRef.current) return;
    const filePath = workspaceActiveFilePathRef.current;
    if (!filePath) return;
    updateWorkspaceFileTab(filePath, (tab) => ({
      ...tab,
      buffer: content,
      saveError: null,
      saveState: "idle"
    }));
  }, [updateWorkspaceFileTab]);

  const reloadWorkspaceFile = useCallback((): void => {
    const filePath = workspaceActiveFilePathRef.current;
    if (!filePath) return;
    loadWorkspaceFile(filePath);
  }, [loadWorkspaceFile]);

  const dismissExternalChange = useCallback((): void => {
    const id = sourceIdRef.current;
    const kind = sourceKindRef.current;
    const filePath = workspaceActiveFilePathRef.current;
    if (!id || !kind || !filePath) return;
    const ipc = dispatchRef.current;
    const statPromise = ipc?.statFile(filePath);
    if (!statPromise) {
      updateWorkspaceFileTab(filePath, (tab) => ({ ...tab, externalChange: false }));
      return;
    }
    void statPromise
      .then((latest) => {
        updateWorkspaceFileTab(filePath, (tab) => ({
          ...tab,
          diskMtimeMs: latest.mtimeMs,
          externalChange: false
        }));
      })
      .catch(() => {
        updateWorkspaceFileTab(filePath, (tab) => ({ ...tab, externalChange: false }));
      });
  }, [updateWorkspaceFileTab]);

  const saveWorkspaceFilePath = useCallback(async (filePath: string): Promise<boolean> => {
    const id = sourceIdRef.current;
    const kind = sourceKindRef.current;
    const tab = workspaceFileTabsRef.current.find((candidate) => candidate.path === filePath) ?? null;
    if (!id || !kind || !tab || !canEditRef.current) return false;
    if (tab.buffer === null || tab.buffer === tab.original) return true;
    const contentToSave = tab.buffer;
    const token = ++workspaceSaveSeq.current;
    workspaceSaveTokens.current.set(filePath, token);
    updateWorkspaceFileTab(filePath, (current) => ({
      ...current,
      saveState: "saving",
      saveError: null
    }));
    try {
      const ipc = dispatchRef.current;
      const writePromise = ipc?.writeFile(filePath, contentToSave, tab.diskMtimeMs);
      if (!writePromise) {
        updateWorkspaceFileTab(filePath, (current) => ({ ...current, saveState: "idle" }));
        return true;
      }
      const result = await writePromise;
      if (workspaceSaveTokens.current.get(filePath) !== token) return false;
      if (!result.ok) {
        updateWorkspaceFileTab(filePath, (current) => ({
          ...current,
          saveState: "idle",
          externalChange: true
        }));
        return false;
      }
      updateWorkspaceFileTab(filePath, (current) => ({
        ...current,
        original: contentToSave,
        diskMtimeMs: result.mtimeMs,
        saveState: "idle",
        saveError: null,
        externalChange: false
      }));
      return true;
    } catch (error) {
      if (workspaceSaveTokens.current.get(filePath) !== token) return false;
      updateWorkspaceFileTab(filePath, (current) => ({
        ...current,
        saveState: "error",
        saveError: errorMessage(error) || "Could not save file."
      }));
      return false;
    }
  }, [updateWorkspaceFileTab]);

  const saveWorkspaceFile = useCallback(async (): Promise<void> => {
    const filePath = workspaceActiveFilePathRef.current;
    if (!filePath) return;
    await saveWorkspaceFilePath(filePath);
  }, [saveWorkspaceFilePath]);

  const saveDirtyTabAndClose = useCallback(async (): Promise<void> => {
    const filePath = workspaceDirtyClosePath;
    if (!filePath) return;
    setWorkspaceActiveFilePath(filePath);
    const saved = await saveWorkspaceFilePath(filePath);
    if (!saved) {
      setWorkspaceDirtyClosePath(null);
      return;
    }
    forceCloseWorkspaceFile(filePath);
  }, [forceCloseWorkspaceFile, saveWorkspaceFilePath, workspaceDirtyClosePath]);

  const discardDirtyTabAndClose = useCallback((): void => {
    const filePath = workspaceDirtyClosePath;
    if (!filePath) return;
    forceCloseWorkspaceFile(filePath);
  }, [forceCloseWorkspaceFile, workspaceDirtyClosePath]);

  const cancelDirtyTabClose = useCallback((): void => {
    setWorkspaceDirtyClosePath(null);
  }, []);

  const checkActiveWorkspaceFileExternalChange = useCallback((): void => {
    const id = sourceIdRef.current;
    const kind = sourceKindRef.current;
    const filePath = workspaceActiveFilePathRef.current;
    const baseline = workspaceActiveDiskMtimeMsRef.current;
    if (!id || !kind || !filePath || baseline === null) return;
    const ipc = dispatchRef.current;
    const statPromise = ipc?.statFile(filePath);
    if (!statPromise) return;
    void statPromise
      .then((latest) => {
        if (latest.mtimeMs > baseline) {
          updateWorkspaceFileTab(filePath, (tab) => ({ ...tab, externalChange: true }));
        }
      })
      .catch(() => {
        // Stat failures during polling are non-fatal — the next save will
        // surface a real error if the file is genuinely gone.
      });
  }, [updateWorkspaceFileTab]);

  /**
   * Stale-buffer detection. Polls `stat-file` for the active tab on tab
   * activation, window focus, and every `dashboard:delta` (the likely signal
   * for out-of-band provider edits). Inactive tabs keep their last observed
   * mtime and still hit the write guard when saved.
   */
  useEffect(() => {
    if (mode !== "files") return;
    if (!canEdit) return;
    const handleFocus = (): void => checkActiveWorkspaceFileExternalChange();
    window.addEventListener("focus", handleFocus);
    // dashboard.onDelta is optional in test stubs that pass a Partial<ArgmaxApi>;
    // guard the lookup so unrelated tests don't trip when they don't supply it.
    const offDelta = window.argmax?.dashboard?.onDelta?.(() => checkActiveWorkspaceFileExternalChange());
    return () => {
      window.removeEventListener("focus", handleFocus);
      offDelta?.();
    };
  }, [mode, canEdit, checkActiveWorkspaceFileExternalChange]);

  useEffect(() => {
    if (mode !== "files" || !canEdit) return;
    checkActiveWorkspaceFileExternalChange();
  }, [mode, canEdit, workspaceActiveFilePath, checkActiveWorkspaceFileExternalChange]);

  const openPanelInFilesMode = useCallback((): void => {
    setMode("files");
    setIsPanelOpen(true);
  }, []);

  const closePanel = useCallback((): void => {
    setIsPanelOpen(false);
  }, []);

  const togglePanel = useCallback((): void => {
    // Opening with nothing in Changes? Land on the file tree instead of an
    // empty Changes view — the user almost certainly wants to browse files.
    if (!isPanelOpenRef.current && filesCountRef.current === 0) {
      setMode("files");
    }
    setIsPanelOpen((open) => !open);
  }, []);

  const toggleSummary = useCallback((): void => {
    setIsSummaryCollapsed((current) => !current);
  }, []);

  const workspaceFileTabSummaries: WorkspaceFileTab[] = workspaceFileTabs.map((tab) => ({
    path: tab.path,
    isDirty: isWorkspaceFileTabDirty(tab, canEdit),
    saveState: tab.saveState,
    externalChange: tab.externalChange
  }));
  const dirtyCloseTab =
    workspaceDirtyClosePath !== null
      ? workspaceFileTabs.find((tab) => tab.path === workspaceDirtyClosePath) ?? null
      : null;
  const dirtyClosePrompt =
    dirtyCloseTab && isWorkspaceFileTabDirty(dirtyCloseTab, canEdit)
      ? { path: dirtyCloseTab.path }
      : null;

  const workspaceFiles: WorkspaceFilesState = {
    entries: workspaceFileEntries,
    listState: workspaceFilesListState,
    listError: workspaceFilesListError,
    tabs: workspaceFileTabSummaries,
    activeTabPath: activeWorkspaceFileTab?.path ?? null,
    selectedPath: activeWorkspaceFileTab?.path ?? null,
    preview: activeWorkspaceFileTab?.preview ?? null,
    previewState: activeWorkspaceFileTab?.previewState ?? "idle",
    previewError: activeWorkspaceFileTab?.previewError ?? null,
    openFile: openWorkspaceFile,
    selectTab: selectWorkspaceFileTab,
    closeTab: closeWorkspaceFile,
    dirtyClosePrompt,
    saveDirtyTabAndClose,
    discardDirtyTabAndClose,
    cancelDirtyTabClose,
    buffer: activeWorkspaceFileTab?.buffer ?? null,
    isDirty: isWorkspaceFileTabDirty(activeWorkspaceFileTab, canEdit),
    diskMtimeMs: activeWorkspaceFileTab?.diskMtimeMs ?? null,
    externalChange: activeWorkspaceFileTab?.externalChange ?? false,
    saveState: activeWorkspaceFileTab?.saveState ?? "idle",
    saveError: activeWorkspaceFileTab?.saveError ?? null,
    canEdit,
    editFile: editWorkspaceFile,
    saveFile: saveWorkspaceFile,
    reloadFile: reloadWorkspaceFile,
    dismissExternalChange
  };

  return {
    files,
    filesState,
    filesError,
    selectedFilePath,
    diff,
    diffState,
    diffError,
    isPanelOpen,
    isSummaryCollapsed,
    mode,
    setMode,
    workspaceFiles,
    openFile,
    openPanelInFilesMode,
    openInFilesView,
    closePanel,
    togglePanel,
    toggleSummary
  };
}
