import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Folder,
  GitBranch,
  MoreHorizontal,
  PanelRightDashed,
  SquareArrowOutUpRight,
  SquarePen
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { DetectedIde, GhPrRecord, IdeId, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { GitActionsMenu } from "./GitActionsMenu.js";
import type { ComposerStatus } from "./SessionComposer.js";

export function SessionActionsMenu({
  defaultIde = null,
  detectedIdes = [],
  isLogOpen,
  isWorkspaceCardEnabled = true,
  onBrowseFiles,
  onNewSession,
  onOpenCommitDialog,
  onOpenInIde,
  onToggleLog,
  onToggleWorkspaceCard,
  session,
  setStatus,
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
  onOpenCommitDialog?: () => void;
  onToggleLog: () => void;
  session: SessionSummary | null;
  setStatus?: (status: ComposerStatus | null) => void;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const [prs, setPrs] = useState<GhPrRecord[]>([]);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionsMode, setActionsMode] = useState<"main" | "git">("main");
  const [actionsPos, setActionsPos] = useState<{ top: number; right: number } | null>(null);
  const actionsAnchorRef = useRef<HTMLDivElement | null>(null);
  const actionsPopoverRef = useRef<HTMLDivElement | null>(null);
  const closeActions = useCallback(() => {
    setActionsOpen(false);
    setActionsMode("main");
  }, []);

  useDismissOnOutsideOrEscape(actionsAnchorRef, actionsOpen, closeActions, actionsPopoverRef);

  useLayoutEffect(() => {
    if (!actionsOpen) {
      setActionsPos(null);
      return;
    }
    const anchor = actionsAnchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setActionsPos({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right)
    });
  }, [actionsOpen]);

  useEffect(() => {
    if (!session?.id || !window.argmax) {
      setPrs([]);
      return;
    }
    let cancelled = false;
    void window.argmax.prs
      .listForSession({ sessionId: session.id })
      .then((rows) => {
        if (!cancelled) setPrs(rows);
      })
      .catch((error) => {
        if (cancelled) return;
        setPrs([]);
        setStatus?.({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not load pull requests."
        });
      });
    return () => {
      cancelled = true;
    };
  }, [session?.id, setStatus]);

  // One item for the pinned default when detected. Without one, listing every
  // GUI IDE *is* the "Ask each time" setting — guessing a favorite here would
  // silently override an explicit choice.
  const guiIdes = detectedIdes.filter((entry) => entry.id !== "terminal" && entry.id !== "iterm");
  const pinnedIde =
    defaultIde && detectedIdes.some((entry) => entry.id === defaultIde) ? defaultIde : null;
  const ideChoices = pinnedIde ? detectedIdes.filter((entry) => entry.id === pinnedIde) : guiIdes;

  const refreshPrs = useCallback((): void => {
    if (!session?.id || !window.argmax) return;
    void window.argmax.prs
      .listForSession({ sessionId: session.id })
      .then(setPrs)
      .catch((error) => {
        setPrs([]);
        setStatus?.({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not refresh pull requests."
        });
      });
  }, [session?.id, setStatus]);

  return (
    <div className="session-actions-anchor" ref={actionsAnchorRef}>
      <button
        className="small-icon"
        type="button"
        title="Session actions"
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={actionsOpen}
        onClick={() => setActionsOpen((open) => !open)}
      >
        <MoreHorizontal size={16} />
      </button>
      {actionsOpen && actionsPos && createPortal(
        <div
          ref={actionsPopoverRef}
          className="project-picker-popover session-actions-popover"
          role="menu"
          aria-label="Session actions"
          style={{
            position: "fixed",
            top: actionsPos.top,
            right: actionsPos.right,
            left: "auto",
            bottom: "auto"
          }}
        >
          {actionsMode === "main" && (
            <ul className="session-actions-list">
              {onNewSession ? (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="project-picker-item"
                    title="Compose a task for any repository beside this session (⌘N)"
                    onClick={() => {
                      closeActions();
                      onNewSession();
                    }}
                  >
                    <SquarePen size={14} aria-hidden="true" />
                    New session here
                  </button>
                </li>
              ) : null}
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
                  Browse files
                </button>
              </li>
              {onOpenInIde && ideChoices.length === 0 ? (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="project-picker-item"
                    disabled
                    title="No supported IDEs found. Install VS Code, Cursor, Windsurf, or Zed."
                  >
                    <SquareArrowOutUpRight size={14} aria-hidden="true" />
                    Open in IDE
                  </button>
                </li>
              ) : null}
              {onOpenInIde
                ? ideChoices.map((entry) => (
                    <li role="none" key={entry.id}>
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item"
                        disabled={!workspace}
                        title={
                          pinnedIde
                            ? "Open this workspace in your default IDE (set in Settings → Integrations)"
                            : "Open this workspace in this IDE (pin a default in Settings → Integrations)"
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
                : null}
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item session-actions-submenu-trigger"
                  aria-haspopup="menu"
                  disabled={!workspace}
                  onClick={() => setActionsMode("git")}
                >
                  <GitBranch size={14} aria-hidden="true" />
                  <span className="session-actions-submenu-label">Git actions</span>
                  <ChevronRight size={14} aria-hidden="true" className="session-actions-submenu-chevron" />
                </button>
              </li>
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
                  Workspace card
                </button>
              </li>
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
                  Toggle debug log
                </button>
              </li>
            </ul>
          )}
          {actionsMode === "git" && (
            <div className="session-actions-submenu">
              <button
                type="button"
                className="session-actions-back"
                aria-label="Back to session actions"
                onClick={() => setActionsMode("main")}
              >
                <ChevronLeft size={12} aria-hidden="true" />
                Back
              </button>
              <GitActionsMenu
                prs={prs}
                session={session}
                workspace={workspace}
                onPrsRefresh={refreshPrs}
                onOpenCommitDialog={onOpenCommitDialog}
                onClose={closeActions}
              />
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
