import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Folder,
  GitBranch,
  GitCommit,
  MoreHorizontal
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { GhPrRecord, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { GitActionsMenu } from "./GitActionsMenu.js";

export function SessionActionsMenu({
  isLogOpen,
  onBrowseFiles,
  onCreateCheckpoint,
  onOpenCommitDialog,
  onToggleLog,
  session,
  setStatus,
  workspace
}: {
  isLogOpen: boolean;
  onBrowseFiles: () => void;
  onCreateCheckpoint: (workspaceId: string) => Promise<void>;
  onOpenCommitDialog?: () => void;
  onToggleLog: () => void;
  session: SessionSummary | null;
  setStatus?: (message: string | null) => void;
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
        setStatus?.(error instanceof Error ? error.message : "Could not load pull requests.");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.id, setStatus]);

  const refreshPrs = useCallback((): void => {
    if (!session?.id || !window.argmax) return;
    void window.argmax.prs
      .listForSession({ sessionId: session.id })
      .then(setPrs)
      .catch((error) => {
        setPrs([]);
        setStatus?.(error instanceof Error ? error.message : "Could not refresh pull requests.");
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
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item"
                  title={
                    workspace?.dirty
                      ? "Save checkpoint of the current worktree"
                      : "Worktree is clean — no checkpoint needed"
                  }
                  disabled={!workspace?.dirty}
                  onClick={() => {
                    if (!workspace) return;
                    closeActions();
                    void onCreateCheckpoint(workspace.id);
                  }}
                >
                  <GitCommit size={14} aria-hidden="true" />
                  Save checkpoint
                </button>
              </li>
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
