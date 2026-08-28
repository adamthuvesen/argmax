import {
  FileDiff,
  Files,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Github,
  SquareTerminal,
  X
} from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";
import { errorMessage } from "../../shared/error.js";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { ChangeCount } from "./ChangeCount.js";

const PR_STATE_LABELS: Record<string, string> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged"
};

/**
 * Floating summary of the session's worktree, parked in the conversation's
 * right gutter: which branch the work sits on, how much it has changed, and
 * one click into every surface that already exists for it (changes, files,
 * terminal, commit, PR).
 *
 * It owns no state of its own. Every row hands off to the surface that does.
 * The card is an index into the pane, not a second place to read it, which is
 * why it steps aside the moment a right-hand panel is docked (see
 * SessionConversation) rather than repeating what that panel already shows.
 */
export function WorkspaceCard({
  changeSummary,
  isTerminalOpen,
  onBrowseFiles,
  onHide,
  onOpenChanges,
  onOpenCommitDialog,
  onToggleTerminal,
  session,
  setStatus,
  workspace
}: {
  /** Null until the changed-file list has loaded for this workspace. */
  changeSummary: { fileCount: number; additions: number; deletions: number } | null;
  isTerminalOpen: boolean;
  onBrowseFiles: () => void;
  onHide: () => void;
  onOpenChanges: () => void;
  onOpenCommitDialog?: () => void;
  onToggleTerminal: () => void;
  session: SessionSummary | null;
  setStatus: (message: string | null) => void;
  workspace: WorkspaceSummary;
}): JSX.Element {
  const [isPrPending, setIsPrPending] = useState(false);
  const hasPr = typeof workspace.prNumber === "number";
  const prState = workspace.prState ?? null;
  const prLabel = hasPr ? `PR #${workspace.prNumber}` : "Create pull request";

  // Same one-call flow as the git actions menu: an existing PR opens in the
  // browser, and a workspace without one gets a PR created and opened.
  const openOrCreatePr = (): void => {
    if (!session || !window.argmax) return;
    setIsPrPending(true);
    setStatus(null);
    void window.argmax.git
      .viewOrCreatePr({ sessionId: session.id })
      .then((result) => {
        setStatus(
          result.action === "created"
            ? `Created pull request. Opening ${result.url}.`
            : `Opening pull request #${result.prNumber}.`
        );
      })
      .catch((error: unknown) => setStatus(errorMessage(error)))
      .finally(() => setIsPrPending(false));
  };

  return (
    <aside className="workspace-card" aria-label="Workspace">
      <div className="workspace-card-branch" title={`Branch ${workspace.branch} · from ${workspace.baseRef}`}>
        <GitBranch size={13} aria-hidden="true" />
        <div className="workspace-card-branch-text">
          <span className="workspace-card-branch-name">{workspace.branch}</span>
          <span className="workspace-card-base">from {workspace.baseRef}</span>
        </div>
        <button
          type="button"
          className="workspace-card-hide"
          title="Hide workspace card"
          aria-label="Hide workspace card"
          onClick={onHide}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>

      <div className="workspace-card-rows">
        <WorkspaceCardRow
          icon={<FileDiff size={13} aria-hidden="true" />}
          label="Changes"
          // A clean worktree has no diff to open, so the row reports the state
          // instead of leading to an empty panel.
          meta={
            changeSummary && changeSummary.fileCount > 0 ? (
              <ChangeCount additions={changeSummary.additions} deletions={changeSummary.deletions} />
            ) : (
              <span className="workspace-card-quiet">clean</span>
            )
          }
          disabled={!changeSummary || changeSummary.fileCount === 0}
          title={
            changeSummary && changeSummary.fileCount > 0
              ? `Review ${changeSummary.fileCount} changed ${changeSummary.fileCount === 1 ? "file" : "files"} (⌘B)`
              : "No changes to review"
          }
          onClick={onOpenChanges}
        />
        <WorkspaceCardRow
          icon={<Files size={13} aria-hidden="true" />}
          label="Files"
          title="Browse workspace files (⌘G)"
          onClick={onBrowseFiles}
        />
        <WorkspaceCardRow
          icon={<SquareTerminal size={13} aria-hidden="true" />}
          label="Terminal"
          pressed={isTerminalOpen}
          title="Toggle the integrated terminal (⌘J)"
          onClick={onToggleTerminal}
        />
      </div>

      <div className="workspace-card-rows">
        <WorkspaceCardRow
          icon={<GitCommitHorizontal size={13} aria-hidden="true" />}
          label="Commit"
          disabled={!onOpenCommitDialog}
          title={workspace.dirty ? "Select files and commit" : "Select files and commit (worktree is clean)"}
          onClick={() => onOpenCommitDialog?.()}
        />
        <WorkspaceCardRow
          icon={
            hasPr ? <Github size={13} aria-hidden="true" /> : <GitPullRequestArrow size={13} aria-hidden="true" />
          }
          label={prLabel}
          meta={
            prState ? (
              <span className="workspace-card-pr-state" data-pr-state={prState}>
                {PR_STATE_LABELS[prState] ?? prState.toLowerCase()}
              </span>
            ) : null
          }
          disabled={!session || isPrPending}
          title={hasPr ? `Open pull request #${workspace.prNumber} on GitHub` : "Create a pull request for this branch"}
          onClick={openOrCreatePr}
        />
      </div>
    </aside>
  );
}

function WorkspaceCardRow({
  disabled = false,
  icon,
  label,
  meta = null,
  onClick,
  pressed,
  title
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  meta?: ReactNode;
  onClick: () => void;
  pressed?: boolean;
  title: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="workspace-card-row"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="workspace-card-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="workspace-card-row-label">{label}</span>
      {meta ? <span className="workspace-card-row-meta">{meta}</span> : null}
    </button>
  );
}
