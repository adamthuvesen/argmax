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
import type { AsyncState } from "../hooks/useReviewState.js";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { agentStatusLabel } from "../lib/agentLaunch.js";
import type { SubagentCluster } from "../lib/subagentSummary.js";
import { WorkingNest } from "./WorkingNest.js";
import { ChangeCount } from "./ChangeCount.js";
import type { ComposerStatus } from "./SessionComposer.js";

const PR_STATE_LABELS: Record<string, string> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged"
};

/** Avatars shown before the stack folds into a +N chip. Matches the reference
 *  density: four or five colored marks read as a team, more read as noise. */
const SUBAGENT_AVATAR_LIMIT = 5;

/**
 * Floating summary of the session's worktree, parked in the conversation's
 * right gutter: which branch the work sits on, how much it has changed, and
 * one click into every surface that already exists for it (changes, files,
 * terminal, commit, PR), plus the subagents the session has spawned.
 *
 * It owns no state of its own. Every row hands off to the surface that does.
 * The card is an index into the pane, not a second place to read it, which is
 * why it steps aside the moment a right-hand panel is docked (see
 * SessionConversation) rather than repeating what that panel already shows.
 */
export function WorkspaceCard({
  changeSummary,
  changesState,
  isTerminalOpen,
  onBrowseFiles,
  onHide,
  onOpenChanges,
  onOpenCommitDialog,
  onToggleTerminal,
  session,
  setStatus,
  subagents,
  workspace
}: {
  /** Null until the changed-file list has loaded for this workspace. */
  changeSummary: { fileCount: number; additions: number; deletions: number } | null;
  /** Load state behind that summary — a quiet row only counts as clean once it is ready. */
  changesState: AsyncState;
  isTerminalOpen: boolean;
  onBrowseFiles: () => void;
  onHide: () => void;
  onOpenChanges: () => void;
  onOpenCommitDialog?: () => void;
  onToggleTerminal: () => void;
  session: SessionSummary | null;
  setStatus: (status: ComposerStatus | null) => void;
  /** Subagents the session has launched; null hides the section. */
  subagents?: SubagentCluster | null;
  workspace: WorkspaceSummary;
}): JSX.Element {
  const [isPrPending, setIsPrPending] = useState(false);
  const hasChanges = changeSummary !== null && changeSummary.fileCount > 0;
  const changesLabel = changesState === "error" ? "unavailable" : changesState === "ready" ? null : "…";
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
        setStatus({
          kind: "info",
          message:
            result.action === "created"
              ? `Created pull request. Opening ${result.url}.`
              : `Opening pull request #${result.prNumber}.`
        });
      })
      .catch((error: unknown) => setStatus({ kind: "error", message: errorMessage(error) }))
      .finally(() => setIsPrPending(false));
  };

  return (
    <aside
      className="workspace-card"
      // The agent window's chat scale is about reading the transcript. The
      // workspace card is sidebar-class chrome — branch, repo, PR actions — so
      // it holds the app-chrome scale, matching the left sidebar. See tokens.css.
      data-type-scale="chrome"
      aria-label="Workspace"
    >
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
          // A clean worktree has no diff to open, so the row goes quiet and
          // disabled instead of leading to an empty panel. Only the states that
          // are not yet a verdict — loading, failed — say so in the meta slot.
          meta={
            hasChanges ? (
              <ChangeCount additions={changeSummary.additions} deletions={changeSummary.deletions} />
            ) : changesLabel ? (
              <span className="workspace-card-quiet">{changesLabel}</span>
            ) : null
          }
          disabled={!hasChanges}
          title={
            hasChanges
              ? `Review ${changeSummary.fileCount} changed ${changeSummary.fileCount === 1 ? "file" : "files"} (⌘B)`
              : changesState === "ready"
                ? "No changes to review"
                : changesState === "error"
                  ? "Could not load the changed files"
                  : "Loading changed files…"
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

      {subagents ? <SubagentsSection cluster={subagents} /> : null}
    </aside>
  );
}

/**
 * The Subagents section, Codex-card style: a labeled group with one colored
 * avatar per launch and a quiet count beside it. Not clickable on purpose —
 * the agent tabs and the activity pane own the deep view; this row answers
 * "is anything working, and did the team finish" at a glance.
 */
function SubagentsSection({ cluster }: { cluster: SubagentCluster }): JSX.Element {
  const visible = cluster.entries.slice(0, SUBAGENT_AVATAR_LIMIT);
  const overflow = cluster.entries.length - visible.length;
  const segments: string[] = [];
  if (cluster.running > 0) segments.push(`${cluster.running} running`);
  if (cluster.failed > 0) segments.push(`${cluster.failed} failed`);
  if (cluster.done > 0) segments.push(`${cluster.done} done`);
  const roster = cluster.entries
    .map((entry) => `${entry.codename} — ${agentStatusLabel(entry.status)}`)
    .join(", ");
  const title = `${cluster.entries.length} ${cluster.entries.length === 1 ? "subagent" : "subagents"}: ${roster}`;
  const firstRunningId = cluster.entries.find((entry) => entry.status === "running")?.toolUseId;

  return (
    <section className="workspace-card-section" aria-label="Subagents">
      <div className="workspace-card-section-label">Subagents</div>
      <div className="workspace-card-subagents" title={title}>
        <span className="workspace-card-agent-stack" aria-hidden="true">
          {visible.map((entry) => (
            <span
              key={entry.toolUseId}
              className="workspace-card-agent"
              data-icon-color={entry.iconColor}
              data-status={entry.status}
            >
              {entry.codename.charAt(0)}
            </span>
          ))}
          {overflow > 0 ? <span className="workspace-card-agent workspace-card-agent-more">+{overflow}</span> : null}
        </span>
        {cluster.running > 0 ? (
          <WorkingNest active size={12} phaseKey={firstRunningId} />
        ) : null}
        <span className="workspace-card-agent-count">{segments.join(" · ")}</span>
      </div>
    </section>
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
