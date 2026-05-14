import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChangedFileSummary,
  WorkspaceDiff,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceSummary
} from "../../shared/types.js";

export type AsyncState = "idle" | "loading" | "ready" | "error";
export type ReviewPanelMode = "changes" | "files";
export type WorkspaceFileSaveState = "idle" | "saving" | "error";

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
  closePanel: () => void;
  togglePanel: () => void;
  toggleSummary: () => void;
}

export function useReviewState(workspace: WorkspaceSummary | null): ReviewState {
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
  const previousWorkspaceId = useRef<string | null>(null);
  const isPanelOpenRef = useRef(false);
  // Refs mirror the latest values for use inside event listeners (focus,
  // dashboard:delta) so we don't need to re-bind the listener on every keystroke.
  const workspaceIdRef = useRef<string | null>(null);
  const workspaceFileSelectedRef = useRef<string | null>(null);
  const workspaceFileDiskMtimeMsRef = useRef<number | null>(null);

  useEffect(() => {
    workspaceIdRef.current = workspace?.id ?? null;
  }, [workspace?.id]);
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
    const token = ++fileLoadToken.current;
    const workspaceId = workspace?.id ?? null;
    if (previousWorkspaceId.current !== workspaceId) {
      previousWorkspaceId.current = workspaceId;
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

    if (!workspace?.id || !window.argmax) {
      setFiles([]);
      setFilesState("idle");
      setFilesError(null);
      setIsPanelOpen(false);
      setIsSummaryCollapsed(true);
      return;
    }

    setFilesState("loading");
    setFilesError(null);
    void window.argmax.review
      .listChangedFiles(workspace.id)
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
    // Depend on the changed-file count, not on lastActivityAt — the activity
    // timestamp bumps for every event delta, which would re-fetch the changed
    // files list ~once per streamed token.
  }, [workspace?.id, workspace?.changedFiles]);

  useEffect(() => {
    const token = ++diffLoadToken.current;
    if (!workspace?.id || !selectedFilePath || !window.argmax) {
      setDiff(null);
      setDiffState("idle");
      setDiffError(null);
      return;
    }

    setDiffState("loading");
    setDiffError(null);
    void window.argmax.review
      .loadDiff(workspace.id, selectedFilePath)
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
  }, [workspace?.id, selectedFilePath]);

  useEffect(() => {
    if (mode !== "files" || !isPanelOpen) return;
    const token = ++workspaceListToken.current;
    if (!workspace?.id || !window.argmax) {
      setWorkspaceFileEntries([]);
      setWorkspaceFilesListState("idle");
      setWorkspaceFilesListError(null);
      return;
    }
    setWorkspaceFilesListState("loading");
    setWorkspaceFilesListError(null);
    void window.argmax.workspace
      .listFiles(workspace.id)
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
    // Same reason as the changed-files effect above: depend on the workspace
    // identity + the (stable) `changedFiles` count, not on `lastActivityAt`.
    // The activity timestamp bumps once per streamed token, which would
    // re-list the entire workspace file tree on every chat tick.
  }, [mode, isPanelOpen, workspace?.id, workspace?.changedFiles]);

  useEffect(() => {
    const token = ++workspaceReadToken.current;
    if (!workspace?.id || !workspaceFileSelected || !window.argmax || mode !== "files") {
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
    void window.argmax.workspace
      .readFile(workspace.id, workspaceFileSelected)
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
  }, [workspace?.id, workspaceFileSelected, mode]);

  const openFile = useCallback((filePath: string): void => {
    setSelectedFilePath(filePath);
    setMode("changes");
    setIsPanelOpen(true);
  }, []);

  const openWorkspaceFile = useCallback((filePath: string): void => {
    setWorkspaceFileSelected(filePath);
  }, []);

  const editWorkspaceFile = useCallback((content: string): void => {
    setWorkspaceFileBuffer(content);
    // Clear a stale save-error as soon as the user keeps typing — the next
    // save attempt will produce a fresh error if it still applies.
    setWorkspaceFileSaveError(null);
    setWorkspaceFileSaveState("idle");
  }, []);

  const reloadWorkspaceFile = useCallback((): void => {
    const workspaceId = workspaceIdRef.current;
    const filePath = workspaceFileSelectedRef.current;
    if (!workspaceId || !filePath || !window.argmax) return;
    const token = ++workspaceReadToken.current;
    setWorkspaceFilePreviewState("loading");
    setWorkspaceFileExternalChange(false);
    void window.argmax.workspace
      .readFile(workspaceId, filePath)
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
    if (!workspaceIdRef.current || !workspaceFileSelectedRef.current || !window.argmax) {
      setWorkspaceFileExternalChange(false);
      return;
    }
    void window.argmax.workspace
      .statFile(workspaceIdRef.current, workspaceFileSelectedRef.current)
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
    const workspaceId = workspaceIdRef.current;
    const filePath = workspaceFileSelectedRef.current;
    if (!workspaceId || !filePath || !window.argmax) return;
    if (workspaceFileBuffer === null) return;
    if (workspaceFileBuffer === workspaceFileOriginal) return;
    const token = ++workspaceSaveToken.current;
    setWorkspaceFileSaveState("saving");
    setWorkspaceFileSaveError(null);
    try {
      const result = await window.argmax.workspace.writeFile(
        workspaceId,
        filePath,
        workspaceFileBuffer,
        workspaceFileDiskMtimeMsRef.current
      );
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
   */
  useEffect(() => {
    if (mode !== "files") return;
    const checkExternalChange = (): void => {
      const workspaceId = workspaceIdRef.current;
      const filePath = workspaceFileSelectedRef.current;
      const baseline = workspaceFileDiskMtimeMsRef.current;
      if (!workspaceId || !filePath || baseline === null || !window.argmax) return;
      void window.argmax.workspace
        .statFile(workspaceId, filePath)
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
  }, [mode]);

  const openPanelInFilesMode = useCallback((): void => {
    setMode("files");
    setIsPanelOpen(true);
  }, []);

  const closePanel = useCallback((): void => {
    setIsPanelOpen(false);
  }, []);

  const togglePanel = useCallback((): void => {
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
    isDirty: workspaceFileBuffer !== null && workspaceFileBuffer !== workspaceFileOriginal,
    diskMtimeMs: workspaceFileDiskMtimeMs,
    externalChange: workspaceFileExternalChange,
    saveState: workspaceFileSaveState,
    saveError: workspaceFileSaveError,
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
    closePanel,
    togglePanel,
    toggleSummary
  };
}
