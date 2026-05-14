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

export interface WorkspaceFilesState {
  entries: WorkspaceFileEntry[];
  listState: AsyncState;
  listError: string | null;
  selectedPath: string | null;
  preview: WorkspaceFilePreview | null;
  previewState: AsyncState;
  previewError: string | null;
  openFile: (filePath: string) => void;
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
  // Project sources have no live activity counter — workspace mode reuses the
  // workspace.changedFiles dep to refetch when an agent edits files; project
  // mode refetches only on source id change (manual reload otherwise).
  const changedFilesKey: number | null =
    source?.kind === "workspace" ? source.workspace.changedFiles : null;
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
  const dispatchRef = useRef<ReviewIpcDispatch | null>(null);
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

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
  const [workspaceFileSelected, setWorkspaceFileSelected] = useState<string | null>(null);
  const [workspaceFilePreview, setWorkspaceFilePreview] = useState<WorkspaceFilePreview | null>(null);
  const [workspaceFilePreviewState, setWorkspaceFilePreviewState] = useState<AsyncState>("idle");
  const [workspaceFilePreviewError, setWorkspaceFilePreviewError] = useState<string | null>(null);
  const [workspaceFileBuffer, setWorkspaceFileBuffer] = useState<string | null>(null);
  const [workspaceFileOriginal, setWorkspaceFileOriginal] = useState<string | null>(null);
  const [workspaceFileDiskMtimeMs, setWorkspaceFileDiskMtimeMs] = useState<number | null>(null);
  const [workspaceFileExternalChange, setWorkspaceFileExternalChange] = useState(false);
  const [workspaceFileSaveState, setWorkspaceFileSaveState] = useState<WorkspaceFileSaveState>("idle");
  const [workspaceFileSaveError, setWorkspaceFileSaveError] = useState<string | null>(null);
  const fileLoadToken = useRef(0);
  const diffLoadToken = useRef(0);
  const workspaceListToken = useRef(0);
  const workspaceReadToken = useRef(0);
  const workspaceSaveToken = useRef(0);
  const previousSourceId = useRef<string | null>(null);
  const isPanelOpenRef = useRef(false);
  const filesCountRef = useRef(0);
  // Refs mirror the latest values for use inside event listeners (focus,
  // dashboard:delta) so we don't need to re-bind the listener on every keystroke.
  const sourceIdRef = useRef<string | null>(null);
  const sourceKindRef = useRef<SourceKind | null>(null);
  const canEditRef = useRef(false);
  const workspaceFileSelectedRef = useRef<string | null>(null);
  const workspaceFileDiskMtimeMsRef = useRef<number | null>(null);

  useEffect(() => {
    sourceIdRef.current = sourceId;
    sourceKindRef.current = sourceKind;
    canEditRef.current = canEdit;
  }, [sourceId, sourceKind, canEdit]);
  useEffect(() => {
    workspaceFileSelectedRef.current = workspaceFileSelected;
  }, [workspaceFileSelected]);
  useEffect(() => {
    workspaceFileDiskMtimeMsRef.current = workspaceFileDiskMtimeMs;
  }, [workspaceFileDiskMtimeMs]);

  useEffect(() => {
    isPanelOpenRef.current = isPanelOpen;
  }, [isPanelOpen]);

  useEffect(() => {
    filesCountRef.current = files.length;
  }, [files]);

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
      setWorkspaceFileSelected(null);
      setWorkspaceFilePreview(null);
      setWorkspaceFilePreviewState("idle");
      setWorkspaceFilePreviewError(null);
      setWorkspaceFileBuffer(null);
      setWorkspaceFileOriginal(null);
      setWorkspaceFileDiskMtimeMs(null);
      setWorkspaceFileExternalChange(false);
      setWorkspaceFileSaveState("idle");
      setWorkspaceFileSaveError(null);
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
        setFilesError(error instanceof Error ? error.message : "Could not load changed files.");
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
        setDiffError(error instanceof Error ? error.message : "Could not load diff.");
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
        setWorkspaceFilesListError(error instanceof Error ? error.message : "Could not load files.");
      });
    // Same reason as the changed-files effect above.
  }, [mode, isPanelOpen, sourceId, sourceKind, changedFilesKey, dispatch]);

  useEffect(() => {
    const token = ++workspaceReadToken.current;
    if (!sourceId || !sourceKind || !workspaceFileSelected || !window.argmax || mode !== "files") {
      setWorkspaceFilePreview(null);
      setWorkspaceFilePreviewState("idle");
      setWorkspaceFilePreviewError(null);
      setWorkspaceFileBuffer(null);
      setWorkspaceFileOriginal(null);
      setWorkspaceFileDiskMtimeMs(null);
      setWorkspaceFileExternalChange(false);
      return;
    }
    setWorkspaceFilePreviewState("loading");
    setWorkspaceFilePreviewError(null);
    setWorkspaceFileExternalChange(false);
    void dispatch!.readFile(workspaceFileSelected)
      .then((preview) => {
        if (token !== workspaceReadToken.current) return;
        setWorkspaceFilePreview(preview);
        setWorkspaceFilePreviewState("ready");
        if (preview.kind === "text") {
          setWorkspaceFileBuffer(preview.content);
          setWorkspaceFileOriginal(preview.content);
          setWorkspaceFileDiskMtimeMs(preview.mtimeMs);
        } else {
          setWorkspaceFileBuffer(null);
          setWorkspaceFileOriginal(null);
          setWorkspaceFileDiskMtimeMs(null);
        }
      })
      .catch((error) => {
        if (token !== workspaceReadToken.current) return;
        setWorkspaceFilePreview(null);
        setWorkspaceFilePreviewState("error");
        setWorkspaceFilePreviewError(error instanceof Error ? error.message : "Could not read file.");
        setWorkspaceFileBuffer(null);
        setWorkspaceFileOriginal(null);
        setWorkspaceFileDiskMtimeMs(null);
      });
  }, [sourceId, sourceKind, workspaceFileSelected, mode, dispatch]);

  const openFile = useCallback((filePath: string): void => {
    setSelectedFilePath(filePath);
    setMode("changes");
    setIsPanelOpen(true);
  }, []);

  const openWorkspaceFile = useCallback((filePath: string): void => {
    setWorkspaceFileSelected(filePath);
  }, []);

  const openInFilesView = useCallback((filePath: string): void => {
    setMode("files");
    setIsPanelOpen(true);
    setWorkspaceFileSelected(filePath);
  }, []);

  const editWorkspaceFile = useCallback((content: string): void => {
    // Read-only sources (project main checkout) drop edits on the floor so
    // CodeMirror's `onChange` from a stray keystroke can't dirty the buffer.
    if (!canEditRef.current) return;
    setWorkspaceFileBuffer(content);
    // Clear a stale save-error as soon as the user keeps typing — the next
    // save attempt will produce a fresh error if it still applies.
    setWorkspaceFileSaveError(null);
    setWorkspaceFileSaveState("idle");
  }, []);

  const reloadWorkspaceFile = useCallback((): void => {
    const id = sourceIdRef.current;
    const kind = sourceKindRef.current;
    const filePath = workspaceFileSelectedRef.current;
    if (!id || !kind || !filePath || !window.argmax) return;
    const ipc = dispatchRef.current;
    if (!ipc) return;
    const token = ++workspaceReadToken.current;
    setWorkspaceFilePreviewState("loading");
    setWorkspaceFileExternalChange(false);
    void ipc.readFile(filePath)
      .then((preview) => {
        if (token !== workspaceReadToken.current) return;
        setWorkspaceFilePreview(preview);
        setWorkspaceFilePreviewState("ready");
        if (preview.kind === "text") {
          setWorkspaceFileBuffer(preview.content);
          setWorkspaceFileOriginal(preview.content);
          setWorkspaceFileDiskMtimeMs(preview.mtimeMs);
        }
      })
      .catch((error) => {
        if (token !== workspaceReadToken.current) return;
        setWorkspaceFilePreviewState("error");
        setWorkspaceFilePreviewError(error instanceof Error ? error.message : "Could not reload file.");
      });
  }, []);

  const dismissExternalChange = useCallback((): void => {
    // "Keep my edits" — bump our notion of disk mtime to whatever stat last
    // reported so the next save passes the guard and overwrites the file.
    const id = sourceIdRef.current;
    const kind = sourceKindRef.current;
    const filePath = workspaceFileSelectedRef.current;
    if (!id || !kind || !filePath) {
      setWorkspaceFileExternalChange(false);
      return;
    }
    const ipc = dispatchRef.current;
    const statPromise = ipc?.statFile(filePath);
    if (!statPromise) {
      setWorkspaceFileExternalChange(false);
      return;
    }
    void statPromise
      .then((latest) => {
        setWorkspaceFileDiskMtimeMs(latest.mtimeMs);
        setWorkspaceFileExternalChange(false);
      })
      .catch(() => {
        // Stat failed (file deleted, perms, etc.) — clear the banner anyway;
        // the next save will surface a real error if one applies.
        setWorkspaceFileExternalChange(false);
      });
  }, []);

  const saveWorkspaceFile = useCallback(async (): Promise<void> => {
    const id = sourceIdRef.current;
    const kind = sourceKindRef.current;
    const filePath = workspaceFileSelectedRef.current;
    if (!id || !kind || !filePath || !canEditRef.current) return;
    if (workspaceFileBuffer === null) return;
    if (workspaceFileBuffer === workspaceFileOriginal) return;
    const token = ++workspaceSaveToken.current;
    setWorkspaceFileSaveState("saving");
    setWorkspaceFileSaveError(null);
    try {
      const ipc = dispatchRef.current;
      const writePromise = ipc?.writeFile(
        filePath,
        workspaceFileBuffer,
        workspaceFileDiskMtimeMsRef.current
      );
      if (!writePromise) {
        // Read-only source — should never reach here given the canEdit guard
        // above, but if a race lands us here, treat it as a no-op rather than
        // throwing through the save UI.
        setWorkspaceFileSaveState("idle");
        return;
      }
      const result = await writePromise;
      if (token !== workspaceSaveToken.current) return;
      if (!result.ok) {
        setWorkspaceFileSaveState("idle");
        setWorkspaceFileExternalChange(true);
        // Don't bump diskMtimeMs yet — the user picks Reload (which fetches
        // fresh content + mtime) or Keep mine (which calls statFile and
        // bumps mtime so the next save succeeds).
        return;
      }
      setWorkspaceFileOriginal(workspaceFileBuffer);
      setWorkspaceFileDiskMtimeMs(result.mtimeMs);
      setWorkspaceFileSaveState("idle");
      setWorkspaceFileExternalChange(false);
    } catch (error) {
      if (token !== workspaceSaveToken.current) return;
      setWorkspaceFileSaveState("error");
      setWorkspaceFileSaveError(error instanceof Error ? error.message : "Could not save file.");
    }
  }, [workspaceFileBuffer, workspaceFileOriginal]);

  /**
   * Stale-buffer detection. Polls `stat-file` for the currently-open file on
   * window focus and after every `dashboard:delta` (which fires whenever a
   * provider session does anything — the most likely source of out-of-band
   * file edits). If disk mtime moved past our baseline, set the banner flag.
   *
   * Project-source mode also polls (so editing files in the main checkout
   * still catches external edits from another editor); the delta listener is
   * a no-op there since no provider session is mutating the project.
   */
  useEffect(() => {
    if (mode !== "files") return;
    if (!canEdit) return;
    const checkExternalChange = (): void => {
      const id = sourceIdRef.current;
      const kind = sourceKindRef.current;
      const filePath = workspaceFileSelectedRef.current;
      const baseline = workspaceFileDiskMtimeMsRef.current;
      if (!id || !kind || !filePath || baseline === null) return;
      const ipc = dispatchRef.current;
      const statPromise = ipc?.statFile(filePath);
      if (!statPromise) return;
      void statPromise
        .then((latest) => {
          if (latest.mtimeMs > baseline) {
            setWorkspaceFileExternalChange(true);
          }
        })
        .catch(() => {
          // Stat failures during polling are non-fatal — the next save will
          // surface a real error if the file is genuinely gone.
        });
    };
    const handleFocus = (): void => checkExternalChange();
    window.addEventListener("focus", handleFocus);
    // dashboard.onDelta is optional in test stubs that pass a Partial<ArgmaxApi>;
    // guard the lookup so unrelated tests don't trip when they don't supply it.
    const offDelta = window.argmax?.dashboard?.onDelta?.(() => checkExternalChange());
    return () => {
      window.removeEventListener("focus", handleFocus);
      offDelta?.();
    };
  }, [mode, canEdit]);

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

  const workspaceFiles: WorkspaceFilesState = {
    entries: workspaceFileEntries,
    listState: workspaceFilesListState,
    listError: workspaceFilesListError,
    selectedPath: workspaceFileSelected,
    preview: workspaceFilePreview,
    previewState: workspaceFilePreviewState,
    previewError: workspaceFilePreviewError,
    openFile: openWorkspaceFile,
    buffer: workspaceFileBuffer,
    isDirty: canEdit && workspaceFileBuffer !== null && workspaceFileBuffer !== workspaceFileOriginal,
    diskMtimeMs: workspaceFileDiskMtimeMs,
    externalChange: workspaceFileExternalChange,
    saveState: workspaceFileSaveState,
    saveError: workspaceFileSaveError,
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
