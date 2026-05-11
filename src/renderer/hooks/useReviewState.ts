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

export interface WorkspaceFilesState {
  entries: WorkspaceFileEntry[];
  listState: AsyncState;
  listError: string | null;
  selectedPath: string | null;
  preview: WorkspaceFilePreview | null;
  previewState: AsyncState;
  previewError: string | null;
  openFile: (filePath: string) => void;
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
  const fileLoadToken = useRef(0);
  const diffLoadToken = useRef(0);
  const workspaceListToken = useRef(0);
  const workspaceReadToken = useRef(0);
  const previousWorkspaceId = useRef<string | null>(null);
  const isPanelOpenRef = useRef(false);

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
  }, [workspace?.id, workspace?.changedFiles, workspace?.lastActivityAt]);

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
  }, [mode, isPanelOpen, workspace?.id, workspace?.lastActivityAt]);

  useEffect(() => {
    const token = ++workspaceReadToken.current;
    if (!workspace?.id || !workspaceFileSelected || !window.argmax || mode !== "files") {
      setWorkspaceFilePreview(null);
      setWorkspaceFilePreviewState("idle");
      setWorkspaceFilePreviewError(null);
      return;
    }
    setWorkspaceFilePreviewState("loading");
    setWorkspaceFilePreviewError(null);
    void window.argmax.workspace
      .readFile(workspace.id, workspaceFileSelected)
      .then((preview) => {
        if (token !== workspaceReadToken.current) return;
        setWorkspaceFilePreview(preview);
        setWorkspaceFilePreviewState("ready");
      })
      .catch((error) => {
        if (token !== workspaceReadToken.current) return;
        setWorkspaceFilePreview(null);
        setWorkspaceFilePreviewState("error");
        setWorkspaceFilePreviewError(error instanceof Error ? error.message : "Could not read file.");
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

  const openPanelInFilesMode = useCallback((): void => {
    setMode("files");
    setIsPanelOpen(true);
  }, []);

  const closePanel = useCallback((): void => {
    setIsPanelOpen(false);
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
    openFile: openWorkspaceFile
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
    toggleSummary
  };
}
