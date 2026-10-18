import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangedFileSummary, ProjectFolder, WorkspaceDiff } from "../../shared/types.js";
import { errorMessage } from "../../shared/error.js";
import { nextDiffContext } from "../lib/diff.js";
import type { ReviewState } from "./useReviewState.js";

export interface ProjectFolderChanges {
  folder: ProjectFolder;
  files: ChangedFileSummary[];
  error: string | null;
}

export function useProjectFolderChanges(source: ReviewState["projectChanges"], enabled: boolean) {
  const projectId = source?.projectId;
  const workingFolderId = source?.workingFolderId;
  const workingRootPath = source?.workingRootPath;
  const refreshKey = source?.refreshKey;
  const [revision, setRevision] = useState(0);
  const [groups, setGroups] = useState<ProjectFolderChanges[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ folderId: string; path: string } | null>(null);
  const [contextLines, setContextLines] = useState<number | undefined>();
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const sourceKey = `${projectId}:${workingFolderId}:${workingRootPath}`;

  useEffect(() => {
    setGroups([]);
    setSelection(null);
    setError(null);
  }, [sourceKey]);

  useEffect(() => {
    const bridge = window.argmax;
    if (!enabled || !projectId || !bridge?.projects?.getFolders) return;
    let cancelled = false;
    void bridge.projects.getFolders({ projectId }).then(async (folders) => {
      const others = folders.filter((folder) => folder.enabled &&
        (workingFolderId ? folder.id !== workingFolderId : folder.rootPath !== workingRootPath));
      const result = await Promise.all(others.map(async (folder): Promise<ProjectFolderChanges> => {
        try {
          const files = await bridge.review.listChangedFiles(
            { kind: "projectFolder", id: folder.id }, "workingTree"
          );
          return { folder, files: [...files].sort((a, b) => a.path.localeCompare(b.path)), error: null };
        } catch (failure) {
          return { folder, files: [], error: errorMessage(failure) };
        }
      }));
      if (cancelled) return;
      setGroups(result);
      setError(null);
      setSelection((current) => current && result.some((group) => group.folder.id === current.folderId &&
        group.files.some((file) => file.path === current.path)) ? current : null);
    }).catch((failure: unknown) => {
      if (!cancelled) setError(errorMessage(failure));
    });
    return () => { cancelled = true; };
  }, [enabled, projectId, workingFolderId, workingRootPath, refreshKey, revision]);

  useEffect(() => {
    if (!enabled || !selection || !window.argmax) return;
    let cancelled = false;
    setDiff(null);
    setDiffError(null);
    setLoadingDiff(true);
    void window.argmax.review.loadDiff(
      { kind: "projectFolder", id: selection.folderId }, selection.path, "workingTree", contextLines
    ).then((result) => {
      if (!cancelled) setDiff(result);
    }).catch((failure: unknown) => {
      if (!cancelled) setDiffError(errorMessage(failure));
    }).finally(() => {
      if (!cancelled) setLoadingDiff(false);
    });
    return () => { cancelled = true; };
  }, [enabled, selection, contextLines, refreshKey, revision, sourceKey]);

  const selectFile = useCallback((folderId: string, path: string): void => {
    setContextLines(undefined);
    setSelection({ folderId, path });
  }, []);
  const clearSelection = useCallback(() => setSelection(null), []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const expandContext = useCallback(() => setContextLines((current) => nextDiffContext(current ?? null) ?? current), []);
  const selectedFolder = useMemo(
    () => groups.find((group) => group.folder.id === selection?.folderId)?.folder ?? null,
    [groups, selection]
  );
  return { groups, error, selection, selectedFolder, diff, diffError, loadingDiff, selectFile, clearSelection, refresh, expandContext };
}

export type ProjectFolderChangesState = ReturnType<typeof useProjectFolderChanges>;
