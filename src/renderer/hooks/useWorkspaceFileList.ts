import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "../../shared/types.js";
import type { ReviewIpcDispatch } from "../lib/reviewIpc.js";
import type { ReviewSourceKind } from "../lib/reviewIpc.js";
import { errorMessage } from "../../shared/error.js";
import type { AsyncState } from "./useReviewState.js";

export interface UseWorkspaceFileListResult {
  entries: WorkspaceFileEntry[];
  listState: AsyncState;
  listError: string | null;
  resetForSourceChange: () => void;
}

export function useWorkspaceFileList(args: {
  sourceId: string | null;
  sourceKind: ReviewSourceKind | null;
  changedFilesKey: string | null;
  dispatch: ReviewIpcDispatch | null;
  mode: "changes" | "files";
  isPanelOpen: boolean;
}): UseWorkspaceFileListResult {
  const { sourceId, sourceKind, changedFilesKey, dispatch, mode, isPanelOpen } = args;

  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [listState, setListState] = useState<AsyncState>("idle");
  const [listError, setListError] = useState<string | null>(null);
  const workspaceListToken = useRef(0);

  const resetForSourceChange = useCallback((): void => {
    setEntries([]);
    setListState("idle");
    setListError(null);
  }, []);

  useEffect(() => {
    if (mode !== "files" || !isPanelOpen) return;
    const token = ++workspaceListToken.current;
    if (!sourceId || !sourceKind || !dispatch || !window.argmax) {
      setEntries([]);
      setListState("idle");
      setListError(null);
      return;
    }
    setListState("loading");
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
  }, [mode, isPanelOpen, sourceId, sourceKind, changedFilesKey, dispatch]);

  return {
    entries,
    listState,
    listError,
    resetForSourceChange
  };
}
