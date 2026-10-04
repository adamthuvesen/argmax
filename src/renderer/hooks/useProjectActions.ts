import { useCallback, type Dispatch, type SetStateAction } from "react";
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
  const addProject = useCallback(async (): Promise<void> => {
    const api = window.argmax;
    if (!api) {
      showErrorToast("Open Argmax on your Mac to add a project.");
      return;
    }
    try {
      const result = await api.projects.pickFolder();
      if (result.cancelled) return;
      // Clear workspace selection before changing the selected project.
      setSelectedSessionId(null);
      setSelectedWorkspaceId(null);
      persistLaunchProjectId(result.project.id);
      setSelectedProjectId(result.project.id);
      clearPaneGrid();
      setSnapshot((current) => mergeDashboardDelta(current, { projects: [result.project] }));
      showInfoToast(`Added ${result.project.name}.`);
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : "Argmax requires a local git repository.");
    }
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

  return { addProject, removeProject };
}
