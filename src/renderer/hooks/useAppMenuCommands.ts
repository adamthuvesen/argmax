import { useCallback } from "react";
import type { MenuCommand } from "../../shared/types.js";
import { requestCloseActiveBrowserTab } from "../lib/browserPanel.js";
import { requestCloseActiveReviewFileTab } from "../lib/reviewFilePanel.js";
import { jumpToAdjacentChat } from "../lib/chatCycle.js";
import { listVisibleSidebarWorkspaceIds, selectedSidebarWorkspaceId } from "../lib/sidebarOrder.js";
import {
  hideCommandPalette,
  hideStandalonePage,
  showCommandPalette,
  showKeyboardCheatSheet,
  showSettings
} from "../state/overlays.js";
import { hideFullLauncher } from "../state/launcherSurface.js";
import { toggleSidebarCollapsed } from "../state/sidebarChrome.js";

interface MenuCommands {
  isSettingsOpen: boolean;
  closeWorkspacePages: () => void;
  openNewSessionPane: () => void;
  openWorkspaceChat: (workspaceId: string, modifiers: { ctrlOrMeta: boolean; alt: boolean }) => void;
  closeFocusedSurface: () => boolean;
  toggleRightPanel: () => void;
  toggleDebugLog: () => void;
}

/** Native menu commands share the same navigation rules as sidebar gestures. */
export function useAppMenuCommands({
  isSettingsOpen,
  closeWorkspacePages,
  openNewSessionPane,
  openWorkspaceChat,
  closeFocusedSurface,
  toggleRightPanel,
  toggleDebugLog
}: MenuCommands): (command: MenuCommand) => void {
  return useCallback((command: MenuCommand): void => {
    switch (command) {
      case "open-settings":
        if (isSettingsOpen) hideStandalonePage();
        else showSettings();
        return;
      case "new-session":
        hideCommandPalette();
        hideStandalonePage();
        closeWorkspacePages();
        openNewSessionPane();
        return;
      case "next-chat":
      case "previous-chat": {
        const workspaceId = jumpToAdjacentChat(
          command === "next-chat" ? 1 : -1,
          listVisibleSidebarWorkspaceIds(),
          selectedSidebarWorkspaceId()
        );
        if (!workspaceId) return;
        hideStandalonePage();
        hideFullLauncher();
        closeWorkspacePages();
        openWorkspaceChat(workspaceId, { ctrlOrMeta: false, alt: false });
        return;
      }
      case "open-command-palette":
        showCommandPalette("all");
        return;
      case "open-cheat-sheet":
        showKeyboardCheatSheet();
        return;
      case "toggle-sidebar":
        toggleRightPanel();
        return;
      case "toggle-left-sidebar":
        toggleSidebarCollapsed();
        return;
      // The renderer handles ⌘W first. A native tab may receive it instead.
      case "close-surface":
        if (requestCloseActiveBrowserTab()) return;
        if (requestCloseActiveReviewFileTab()) return;
        closeFocusedSurface();
        return;
      case "toggle-debug-log":
        toggleDebugLog();
        return;
      case "check-for-updates":
        return;
    }
  }, [closeFocusedSurface, closeWorkspacePages, isSettingsOpen, openNewSessionPane, openWorkspaceChat, toggleDebugLog, toggleRightPanel]);
}
