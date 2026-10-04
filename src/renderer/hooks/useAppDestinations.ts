import { useCallback } from "react";
import type { SessionSummary } from "../../shared/types.js";
import { hostsBrowserSurface } from "../lib/tauriBridge.js";
import { persistLaunchProjectId } from "../lib/launchProjectPreference.js";
import { clearPaneGrid } from "../state/paneGrid.js";
import {
  hideArcPage,
  hideCommandPalette,
  hideStandalonePage,
  showArcPage
} from "../state/overlays.js";
import { hideFullLauncher, setLauncherSideChatMode } from "../state/launcherSurface.js";

interface AppDestinations {
  sessions: SessionSummary[];
  closeWorkspacePages: () => void;
  openProjectLauncher: (projectId: string) => void;
  openWorkspaceChat: (workspaceId: string, modifiers: { ctrlOrMeta: boolean; alt: boolean }) => void;
  setBrowserPageOpen: (open: boolean) => void;
}

/** Resolves explicit destinations before the grid or page shell changes. */
export function useAppDestinations({
  sessions,
  closeWorkspacePages,
  openProjectLauncher,
  openWorkspaceChat,
  setBrowserPageOpen
}: AppDestinations) {
  const openRepoProjectLauncher = useCallback((projectId: string): void => {
    persistLaunchProjectId(projectId);
    setLauncherSideChatMode(false);
    openProjectLauncher(projectId);
  }, [openProjectLauncher]);

  const openProject = useCallback((projectId: string): void => {
    hideStandalonePage();
    hideFullLauncher();
    closeWorkspacePages();
    clearPaneGrid();
    openRepoProjectLauncher(projectId);
  }, [closeWorkspacePages, openRepoProjectLauncher]);

  const openWorkspace = useCallback((workspaceId: string, modifiers: { ctrlOrMeta: boolean; alt: boolean }): void => {
    hideStandalonePage();
    hideFullLauncher();
    closeWorkspacePages();
    openWorkspaceChat(workspaceId, modifiers);
  }, [closeWorkspacePages, openWorkspaceChat]);

  const openArc = useCallback((arcId: string): void => {
    hideCommandPalette();
    hideStandalonePage();
    hideFullLauncher();
    closeWorkspacePages();
    showArcPage(arcId);
  }, [closeWorkspacePages]);

  const openBrowser = useCallback((): void => {
    if (!hostsBrowserSurface()) return;
    hideCommandPalette();
    hideStandalonePage();
    hideFullLauncher();
    hideArcPage();
    setBrowserPageOpen(true);
  }, [setBrowserPageOpen]);

  const openSession = useCallback((sessionId: string): void => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    openWorkspace(session.workspaceId, { ctrlOrMeta: false, alt: false });
  }, [openWorkspace, sessions]);

  return { openRepoProjectLauncher, openProject, openWorkspace, openArc, openBrowser, openSession };
}
