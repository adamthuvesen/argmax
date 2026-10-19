import {
  AppWindow,
  Bug,
  Cloud,
  CornerUpLeft,
  Folder,
  Globe,
  MoreHorizontal,
  PanelRightDashed,
  SquareArrowOutUpRight,
  SquarePen,
  Workflow
} from "lucide-react";
import { useCallback, useContext, useEffect, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { DetectedIde, IdeId, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { cloudProviderName, isHostedCloudProvider } from "../../shared/cloudProviders.js";
import { openBrowserPanel } from "../lib/browserPanel.js";
import { isSecondaryWindow } from "../lib/windowRole.js";
import { DeveloperToolsContext } from "../lib/uiPreferences.js";
import { refreshSessionPrs } from "../lib/sessionPrs.js";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { CloudTaskDialog } from "./CloudTaskDialog.js";
import { MenuSections } from "./MenuSections.js";
import { showErrorToast } from "../state/toast.js";

export function SessionActionsMenu({
  defaultIde = null,
  detectedIdes = [],
  isLogOpen,
  isWorkspaceCardEnabled = true,
  onBrowseFiles,
  onNewSession,
  onOpenLaunchingChat,
  onOpenInIde,
  onStartArc,
  onToggleLog,
  onToggleWorkspaceCard,
  session,
  workspace
}: {
  defaultIde?: IdeId | null;
  detectedIdes?: DetectedIde[];
  /** Opens the workspace in the given IDE. Absent where the host surface has
      no IDE handoff (the phone companion), which hides the action. */
  onOpenInIde?: (ide: IdeId) => void;
  isLogOpen: boolean;
  /** Preference state for the floating workspace card, so the checkbox reads
      the user's choice rather than whether the card happens to be on screen. */
  isWorkspaceCardEnabled?: boolean;
  onToggleWorkspaceCard?: () => void;
  onBrowseFiles: () => void;
  /** Opens a launcher pane beside this one. Absent where the grid isn't the
      host surface (the single-pane preview), which hides the action. */
  onNewSession?: () => void;
  /** Opens the chat whose agent launched this one. Absent when that chat has
      left the snapshot, which hides the action — a session names a launcher
      that may since have been archived. */
  onOpenLaunchingChat?: () => void;
  /** Starts an arc with this chat as its coordinator. Absent when the chat is
      already in an arc or cannot take a turn, which hides the action. */
  onStartArc?: { run: () => void; disabledReason: string | null };
  onToggleLog: () => void;
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false);
  const cloudProvider = session && isHostedCloudProvider(session.provider) ? session.provider : null;
  const developerToolsEnabled = useContext(DeveloperToolsContext);
  const closeActions = useCallback(() => {
    setActionsOpen(false);
  }, []);

  // Right-aligned under the trigger, flipping above it near the bottom of the
  // screen, with a height cap for shorter windows.
  const menu = useAnchoredPopover({ open: actionsOpen, placement: "bottom-end", capHeight: true });

  useDismissOnOutsideOrEscape(menu.anchorRef, actionsOpen, closeActions, menu.popoverRef);

  useEffect(() => {
    if (!session?.id || !window.argmax?.prs) return;
    let cancelled = false;
    void window.argmax.prs
      .listForSession({ sessionId: session.id })
      .catch((error) => {
        if (cancelled) return;
        showErrorToast(error instanceof Error ? error.message : "Could not load pull requests.");
      });
    void refreshSessionPrs(session.id)?.catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session?.id]);

  // One item for the pinned default when detected. Without one, listing every
  // GUI IDE *is* the "Ask each time" setting — guessing a favorite here would
  // silently override an explicit choice.
  const guiIdes = detectedIdes.filter((entry) => entry.id !== "terminal" && entry.id !== "iterm");
  const pinnedIde =
    defaultIde && detectedIdes.some((entry) => entry.id === defaultIde) ? defaultIde : null;
  const ideChoices = pinnedIde ? detectedIdes.filter((entry) => entry.id === pinnedIde) : guiIdes;
  // Tearing off is a desktop gesture from the main window: the phone has no
  // windows, and a window already torn off would only focus itself.
  const canOpenInWindow =
    typeof window !== "undefined" && window.argmax?.windows !== undefined && !isSecondaryWindow();

  return (
    <>
      <div className="session-actions-anchor" ref={menu.setAnchor}>
      <button
        className="small-icon"
        type="button"
        title="Chat actions"
        aria-label="Chat actions"
        aria-haspopup="menu"
        aria-expanded={actionsOpen}
        onClick={() => setActionsOpen((open) => !open)}
      >
        <MoreHorizontal size={16} />
      </button>
      {actionsOpen && createPortal(
        <div
          ref={menu.setPopover}
          className="project-picker-popover session-actions-popover"
          role="menu"
          aria-label="Chat actions"
          style={menu.floatingStyles}
        >
          <ul className="session-actions-list">
            <MenuSections
              sections={[
                [
                  onNewSession ? (
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item"
                        title="Compose a task for any repository beside this chat (⌘N)"
                        onClick={() => {
                          closeActions();
                          onNewSession();
                        }}
                      >
                        <SquarePen size={14} aria-hidden="true" />
                        New Chat Here
                      </button>
                    </li>
                  ) : null,
                  onStartArc ? (
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item"
                        disabled={onStartArc.disabledReason !== null}
                        title={onStartArc.disabledReason ?? "This chat becomes the coordinator of a new arc"}
                        onClick={() => {
                          closeActions();
                          onStartArc.run();
                        }}
                      >
                        <Workflow size={14} aria-hidden="true" />
                        Start an Arc from This Chat…
                      </button>
                    </li>
                  ) : null,
                  session && cloudProvider && workspace?.kind === "git" ? (
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item"
                        title={`Continue this chat as a ${cloudProviderName(cloudProvider)} task, from the pushed branch`}
                        onClick={() => {
                          closeActions();
                          setCloudDialogOpen(true);
                        }}
                      >
                        <Cloud size={14} aria-hidden="true" />
                        Send Task to {cloudProviderName(cloudProvider)}…
                      </button>
                    </li>
                  ) : null
                ],
                [
                  session?.launchedBySessionId && onOpenLaunchingChat ? (
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item"
                        title="Open the chat whose agent started this one"
                        onClick={() => {
                          closeActions();
                          onOpenLaunchingChat();
                        }}
                      >
                        <CornerUpLeft size={14} aria-hidden="true" />
                        Open Launching Chat
                      </button>
                    </li>
                  ) : null,
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="project-picker-item"
                      disabled={!workspace}
                      onClick={() => {
                        closeActions();
                        onBrowseFiles();
                      }}
                    >
                      <Folder size={14} aria-hidden="true" />
                      Browse Files
                    </button>
                  </li>,
                  !isSecondaryWindow() ? (
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item"
                        title="Open the browser in the review panel"
                        onClick={() => {
                          closeActions();
                          openBrowserPanel();
                        }}
                      >
                        <Globe size={14} aria-hidden="true" />
                        Open Browser
                      </button>
                    </li>
                  ) : null,
                  session && canOpenInWindow ? (
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item"
                        title="Show this chat in a desktop window of its own"
                        onClick={() => {
                          closeActions();
                          void window.argmax?.windows.openSession({ sessionId: session.id }).catch((error: unknown) => {
                            showErrorToast(error instanceof Error ? error.message : "Couldn't open a new window.");
                          });
                        }}
                      >
                        <AppWindow size={14} aria-hidden="true" />
                        Open in New Window
                      </button>
                    </li>
                  ) : null,
                  onOpenInIde
                    ? ideChoices.map((entry) => (
                        <li role="none" key={entry.id}>
                          <button
                            type="button"
                            role="menuitem"
                            className="project-picker-item"
                            disabled={!workspace}
                            title={
                              pinnedIde
                                ? "Open this workspace in your default IDE (set in Settings → Handoff)"
                                : "Open this workspace in this IDE (pin a default in Settings → Handoff)"
                            }
                            onClick={() => {
                              closeActions();
                              onOpenInIde(entry.id);
                            }}
                          >
                            <SquareArrowOutUpRight size={14} aria-hidden="true" />
                            {`Open in ${entry.label}`}
                          </button>
                        </li>
                      ))
                    : null
                ],
                [
                  <li role="none">
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      className="project-picker-item"
                      aria-checked={isWorkspaceCardEnabled}
                      disabled={!onToggleWorkspaceCard}
                      title="Float a worktree summary beside the chat. Appears once the pane is wide enough to hold it."
                      onClick={() => {
                        closeActions();
                        onToggleWorkspaceCard?.();
                      }}
                    >
                      <PanelRightDashed size={14} aria-hidden="true" />
                      Workspace Card
                    </button>
                  </li>,
                  developerToolsEnabled ? (
                    <li role="none">
                      <button
                        type="button"
                        role="menuitemcheckbox"
                        className="project-picker-item"
                        aria-checked={isLogOpen}
                        onClick={() => {
                          closeActions();
                          onToggleLog();
                        }}
                      >
                        <Bug size={14} aria-hidden="true" />
                        Debug Log
                      </button>
                    </li>
                  ) : null
                ]
              ]}
            />
          </ul>
        </div>,
        document.body
      )}
      </div>
      {session && cloudProvider ? (
        <CloudTaskDialog
          open={cloudDialogOpen}
          sessionId={session.id}
          provider={cloudProvider}
          onClose={() => setCloudDialogOpen(false)}
        />
      ) : null}
    </>
  );
}
