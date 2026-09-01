import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "../../shared/types.js";
import type { ReviewIpcDispatch } from "../lib/reviewIpc.js";
import type { ReviewSourceKind } from "../lib/reviewIpc.js";
import { errorMessage } from "../../shared/error.js";
import type { AsyncState, ReviewPanelMode } from "./useReviewState.js";

export interface UseWorkspaceFileListResult {
  entries: WorkspaceFileEntry[];
  listState: AsyncState;
  listError: string | null;
  /** Re-list the source on demand. The automatic re-fetch keys off the
   *  changed-files signature, which misses files an agent never touched
   *  through git — a manual `mkdir`, an untracked scratch file. */
  refresh: () => void;
  resetForSourceChange: () => void;
}

export function useWorkspaceFileList(args: {
  sourceId: string | null;
  sourceKind: ReviewSourceKind | null;
  changedFilesKey: string | null;
  dispatch: ReviewIpcDispatch | null;
  mode: ReviewPanelMode;
  isPanelOpen: boolean;
}): UseWorkspaceFileListResult {
  const { sourceId, sourceKind, changedFilesKey, dispatch, mode, isPanelOpen } = args;

  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [listState, setListState] = useState<AsyncState>("idle");
  const [listError, setListError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const workspaceListToken = useRef(0);
  // Identifies which source the current list belongs to. A re-fetch within the
  // same source — the workspace's changed-files signature moving as the agent
  // edits mid-turn — keeps the tree on screen instead of unmounting it behind
  // "Loading files…". Only a new source (or the first load) shows loading.
  const listContextRef = useRef<string | null>(null);

  const refresh = useCallback((): void => {
    setRefreshCount((count) => count + 1);
  }, []);

  const resetForSourceChange = useCallback((): void => {
    setEntries([]);
    setListState("idle");
    setListError(null);
  }, []);

  useEffect(() => {
    if (mode !== "files" || !isPanelOpen) return;
    const token = ++workspaceListToken.current;
    if (!sourceId || !sourceKind || !dispatch || !window.argmax) {
      listContextRef.current = null;
      setEntries([]);
      setListState("idle");
      setListError(null);
      return;
    }
    // The context deliberately omits the comparison: listFiles() returns the
    // whole worktree, not a comparison-scoped set.
    const context = `${sourceKind}:${sourceId}`;
    const isNewContext = listContextRef.current !== context;
    listContextRef.current = context;
    if (isNewContext) {
      setListState("loading");
    } else {
      setListState((prev) => (prev === "ready" ? prev : "loading"));
    }
    setListError(null);
    void dispatch.listFiles()
      .then((loaded) => {
        if (token !== workspaceListToken.current) return;
        setEntries(loaded);
        setListState("ready");
      })
      .catch((error) => {
        if (token !== workspaceListToken.current) return;
        setEntries([]);
        setListState("error");
        setListError(errorMessage(error) || "Could not load files.");
      });
  }, [mode, isPanelOpen, sourceId, sourceKind, changedFilesKey, dispatch, refreshCount]);

  return {
    entries,
    listState,
    listError,
    refresh,
    resetForSourceChange
  };
}
