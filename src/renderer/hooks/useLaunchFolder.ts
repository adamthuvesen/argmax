import { useCallback, useEffect, useState } from "react";
import type { ProjectFolder, ProjectSummary } from "../../shared/types.js";
import { errorMessage } from "../../shared/error.js";

export function useLaunchFolder(project: ProjectSummary | null) {
  const [foldersState, setFoldersState] = useState<{ projectId: string; folders: ProjectFolder[] } | null>(null);
  const [picked, setPicked] = useState<{ projectId: string; folderId: string } | null>(null);
  const [context, setContext] = useState<{ projectId: string; folderId: string; rootPath: string; project: ProjectSummary; isGit: boolean } | null>(null);
  const [failure, setFailure] = useState<{ projectId: string; source: "folders" | "context"; message: string } | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const projectId = project?.id;
  const updateProject = useCallback((updated: ProjectSummary) => {
    setContext((current) => current ? { ...current, project: updated } : null);
  }, []);

  useEffect(() => {
    if (!projectId || !window.argmax) return;
    let cancelled = false;
    void window.argmax.projects.getFolders({ projectId }).then((folders) => {
      if (!cancelled) {
        setFoldersState({ projectId, folders });
        setFailure((current) => current?.source === "folders" ? null : current);
      }
    }).catch((error: unknown) => {
      if (!cancelled) setFailure({ projectId, source: "folders", message: errorMessage(error) || "Could not load project folders." });
    });
    return () => { cancelled = true; };
  }, [projectId, project, retryCount]);

  const folders = foldersState && foldersState.projectId === projectId ? foldersState.folders : [];
  const selectedByHand = picked && picked.projectId === projectId ? picked : null;
  const folder = selectedByHand ? folders.find((entry) => entry.id === selectedByHand.folderId)
    : folders.find((entry) => entry.isPrimary);
  const removedSelection = foldersState?.projectId === projectId && selectedByHand !== null && folder === undefined;
  const folderId = folder?.id;
  const rootPath = folder?.rootPath;
  const isSecondary = folder !== undefined && !folder.isPrimary;

  useEffect(() => {
    if (!projectId || !folderId || !rootPath || !isSecondary || !window.argmax) return;
    let cancelled = false;
    setFailure(null);
    void window.argmax.projects.getFolderContext({ projectId, projectFolderId: folderId }).then((result) => {
      if (!cancelled) setContext({ projectId, folderId, rootPath, project: result.project, isGit: result.isGit });
    }).catch((error: unknown) => {
      if (!cancelled) setFailure({ projectId, source: "context", message: errorMessage(error) || "Could not open project folder." });
    });
    return () => { cancelled = true; };
  }, [projectId, folderId, rootPath, isSecondary, retryCount]);

  const resolved = context && context.projectId === projectId && context.folderId === folderId && context.rootPath === rootPath ? context : null;
  const error = removedSelection ? "This working folder was removed. Choose another folder to continue."
    : failure && failure.projectId === projectId ? failure.message : null;
  return {
    folders,
    folder,
    projectFolderId: folderId,
    project: removedSelection ? null : isSecondary ? resolved?.project ?? null : project,
    isGit: isSecondary ? resolved?.isGit ?? false : true,
    ready: !error && foldersState?.projectId === projectId && (!isSecondary || resolved !== null),
    error,
    updateProject,
    retry: () => {
      setFailure(null);
      setContext(null);
      setRetryCount((current) => current + 1);
    },
    pickFolder: (entry: ProjectFolder) => {
      if (!projectId) return;
      if (entry.id === folderId && !error) return;
      setFailure(null);
      setContext(null);
      setPicked({ projectId, folderId: entry.id });
      if (entry.id === folderId) setRetryCount((current) => current + 1);
    }
  };
}
