import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { ProjectFoldersDraft } from "../components/ProjectFoldersForm.js";
import type { DashboardSnapshot } from "../../shared/types.js";
import { persistLaunchProjectId } from "../lib/launchProjectPreference.js";
import { mergeDashboardDelta } from "../lib/snapshot.js";
import { clearPaneGrid } from "../state/paneGrid.js";
import { showErrorToast, showInfoToast } from "../state/toast.js";

interface ProjectActions {
  projects: DashboardSnapshot["projects"];
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  setSelectedWorkspaceId: (id: string | null) => void;
  setSelectedSessionId: (id: string | null) => void;
  setSnapshot: Dispatch<SetStateAction<DashboardSnapshot>>;
}

/** Keeps project catalog mutations and their selection repair together. */
export function useProjectActions({
  projects,
  selectedProjectId,
  setSelectedProjectId,
  setSelectedWorkspaceId,
  setSelectedSessionId,
  setSnapshot
}: ProjectActions) {
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const addProject = useCallback((): void => {
    if (!window.argmax) {
      showErrorToast("Open Argmax on your Mac to create a project.");
      return;
    }
    setNewProjectOpen(true);
  }, []);
  const closeNewProject = useCallback(() => setNewProjectOpen(false), []);
  const createProject = useCallback(async (draft: ProjectFoldersDraft): Promise<void> => {
    const api = window.argmax;
    if (!api) throw new Error("Open Argmax on your Mac to create a project.");
    const project = await api.projects.create(draft);
    setSelectedSessionId(null);
    setSelectedWorkspaceId(null);
    persistLaunchProjectId(project.id);
    setSelectedProjectId(project.id);
    clearPaneGrid();
    setSnapshot((current) => mergeDashboardDelta(current, { projects: [project] }));
    setNewProjectOpen(false);
    showInfoToast(`Created ${project.name}.`);
  }, [setSelectedProjectId, setSelectedSessionId, setSelectedWorkspaceId, setSnapshot]);

  const removeProject = useCallback(async (projectId: string): Promise<void> => {
    const api = window.argmax;
    if (!api) {
      showErrorToast("Open Argmax on your Mac to remove a project.");
      return;
    }
    const projectName = projects.find((project) => project.id === projectId)?.name ?? "project";
    try {
      await api.projects.remove({ projectId });
      setSnapshot((current) => ({
        ...current,
        projects: current.projects.filter((project) => project.id !== projectId),
        workspaces: current.workspaces.filter((workspace) => workspace.projectId !== projectId),
        sessions: current.sessions.filter((session) =>
          current.workspaces.some((workspace) => workspace.id === session.workspaceId && workspace.projectId !== projectId)
        )
      }));
      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
        setSelectedWorkspaceId(null);
        setSelectedSessionId(null);
        clearPaneGrid();
      }
      showInfoToast(`Removed ${projectName}.`);
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : `Could not remove ${projectName}.`);
    }
  }, [projects, selectedProjectId, setSelectedProjectId, setSelectedSessionId, setSelectedWorkspaceId, setSnapshot]);

  return { addProject, removeProject, newProjectOpen, closeNewProject, createProject };
}
