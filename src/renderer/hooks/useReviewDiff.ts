import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ChangedFileSummary, WorkspaceDiff } from "../../shared/types.js";
import type { ReviewIpcDispatch } from "../lib/reviewIpc.js";
import type { ReviewSourceKind } from "../lib/reviewIpc.js";
import { errorMessage } from "../../shared/error.js";
import type { AsyncState } from "./useReviewState.js";

export interface UseReviewDiffResult {
  files: ChangedFileSummary[];
  filesState: AsyncState;
  filesError: string | null;
  selectedFilePath: string | null;
  setSelectedFilePath: Dispatch<SetStateAction<string | null>>;
  diff: WorkspaceDiff | null;
  diffState: AsyncState;
  diffError: string | null;
  openFile: (filePath: string) => void;
  resetForSourceChange: () => void;
}

export function useReviewDiff(args: {
  sourceId: string | null;
  sourceKind: ReviewSourceKind | null;
  changedFilesKey: string | null;
  dispatch: ReviewIpcDispatch | null;
  isPanelOpen: boolean;
  onOpenChanges: () => void;
}): UseReviewDiffResult {
  const { sourceId, sourceKind, changedFilesKey, dispatch, isPanelOpen, onOpenChanges } = args;

  const [files, setFiles] = useState<ChangedFileSummary[]>([]);
  const [filesState, setFilesState] = useState<AsyncState>("idle");
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffState, setDiffState] = useState<AsyncState>("idle");
  const [diffError, setDiffError] = useState<string | null>(null);

  const fileLoadToken = useRef(0);
  const diffLoadToken = useRef(0);
  const isPanelOpenRef = useRef(isPanelOpen);
  isPanelOpenRef.current = isPanelOpen;

  // Cache loaded diffs by file path so re-selecting a file you've already
  // viewed is instant. Busted whenever the source changes or the workspace's
  // changed-files signature moves (a new key means the diffs may have changed),
  // so a cache hit always reflects the current state.
  const diffCache = useRef(new Map<string, WorkspaceDiff>());
  useEffect(() => {
    diffCache.current.clear();
  }, [sourceId, changedFilesKey]);

  const resetForSourceChange = useCallback((): void => {
    setSelectedFilePath(null);
    setDiff(null);
    setDiffState("idle");
    setDiffError(null);
  }, []);

  useEffect(() => {
    const token = ++fileLoadToken.current;

    if (!sourceId || !sourceKind || !dispatch || !window.argmax) {
      setFiles([]);
      setFilesState("idle");
      setFilesError(null);
      return;
    }

    setFilesState("loading");
    setFilesError(null);
    void dispatch.listChangedFiles()
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
      })
      .catch((error) => {
        if (token !== fileLoadToken.current) {
          return;
        }
        setFiles([]);
        setFilesState("error");
        setFilesError(errorMessage(error) || "Could not load changed files.");
      });
  }, [sourceId, sourceKind, changedFilesKey, dispatch]);

  useEffect(() => {
    const token = ++diffLoadToken.current;
    if (!sourceId || !sourceKind || !selectedFilePath || !dispatch || !window.argmax) {
      setDiff(null);
      setDiffState("idle");
      setDiffError(null);
      return;
    }

    const cached = diffCache.current.get(selectedFilePath);
    if (cached) {
      setDiff(cached);
      setDiffState("ready");
      setDiffError(null);
      return;
    }

    setDiffState("loading");
    setDiffError(null);
    void dispatch.loadDiff(selectedFilePath)
      .then((result) => {
        if (token !== diffLoadToken.current) {
          return;
        }
        diffCache.current.set(selectedFilePath, result);
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

  const openFile = useCallback(
    (filePath: string): void => {
      setSelectedFilePath(filePath);
      onOpenChanges();
    },
    [onOpenChanges]
  );

  return {
    files,
    filesState,
    filesError,
    selectedFilePath,
    setSelectedFilePath,
    diff,
    diffState,
    diffError,
    openFile,
    resetForSourceChange
  };
}
