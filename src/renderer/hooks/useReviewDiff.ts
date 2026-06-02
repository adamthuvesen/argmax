import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ChangedFileSummary, ReviewComparison, WorkspaceDiff } from "../../shared/types.js";
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
  comparison: ReviewComparison;
  dispatch: ReviewIpcDispatch | null;
  isPanelOpen: boolean;
  onOpenChanges: () => void;
}): UseReviewDiffResult {
  const { sourceId, sourceKind, changedFilesKey, comparison, dispatch, isPanelOpen, onOpenChanges } = args;

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

  // Identifies which (source, comparison) the current list belongs to. A
  // re-fetch within the same context — the workspace's changed-files signature
  // moving as the agent edits mid-turn — keeps the list on screen rather than
  // flashing "loading", so the changed-files card doesn't flicker on every
  // refresh. Only a new source/comparison (or the first load) shows loading.
  const filesContextRef = useRef<string | null>(null);

  // Cache loaded diffs by file path so re-selecting a file you've already
  // viewed is instant. Busted whenever the source changes, the workspace's
  // changed-files signature moves (a new key means the diffs may have changed),
  // or the comparison baseline flips (local ↔ branch produce different diffs
  // for the same path), so a cache hit always reflects the current state.
  const diffCache = useRef(new Map<string, WorkspaceDiff>());
  useEffect(() => {
    diffCache.current.clear();
  }, [sourceId, changedFilesKey, comparison]);

  // Identifies which (source, comparison, file) the loaded diff belongs to. A
  // re-fetch within the same context — the changed-files signature moved as the
  // agent edited the open file mid-turn — keeps the current diff on screen
  // instead of flashing the skeleton. Only a new file/source/comparison loads.
  const diffContextRef = useRef<string | null>(null);

  const resetForSourceChange = useCallback((): void => {
    setSelectedFilePath(null);
    setDiff(null);
    setDiffState("idle");
    setDiffError(null);
  }, []);

  useEffect(() => {
    const token = ++fileLoadToken.current;

    if (!sourceId || !sourceKind || !dispatch || !window.argmax) {
      filesContextRef.current = null;
      setFiles([]);
      setFilesState("idle");
      setFilesError(null);
      return;
    }

    // Show "loading" only for a genuinely new source/comparison (or the first
    // load). A re-fetch within the same context keeps the current list on
    // screen (stale-while-revalidate) so the changed-files card doesn't flicker
    // through a loading state every time the agent edits a file mid-turn.
    const context = `${sourceKind}:${sourceId}:${comparison}`;
    const isNewContext = filesContextRef.current !== context;
    filesContextRef.current = context;

    setFilesError(null);
    if (isNewContext) {
      setFilesState("loading");
    } else {
      setFilesState((prev) => (prev === "ready" ? prev : "loading"));
    }
    void dispatch.listChangedFiles(comparison)
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
  }, [sourceId, sourceKind, changedFilesKey, comparison, dispatch]);

  useEffect(() => {
    const token = ++diffLoadToken.current;
    if (!sourceId || !sourceKind || !selectedFilePath || !dispatch || !window.argmax) {
      diffContextRef.current = null;
      setDiff(null);
      setDiffState("idle");
      setDiffError(null);
      return;
    }

    const context = `${sourceKind}:${sourceId}:${comparison}:${selectedFilePath}`;
    const isNewContext = diffContextRef.current !== context;
    diffContextRef.current = context;

    const cached = diffCache.current.get(selectedFilePath);
    if (cached) {
      setDiff(cached);
      setDiffState("ready");
      setDiffError(null);
      return;
    }

    setDiffError(null);
    // New file/source/comparison shows the skeleton. A same-file revalidation
    // (the changed-files signature moved as the agent edited the open file)
    // keeps the current diff on screen until the fresh one lands.
    if (isNewContext) {
      setDiffState("loading");
    } else {
      setDiffState((prev) => (prev === "ready" ? prev : "loading"));
    }
    void dispatch.loadDiff(selectedFilePath, comparison)
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
  }, [sourceId, sourceKind, selectedFilePath, changedFilesKey, comparison, dispatch]);

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
