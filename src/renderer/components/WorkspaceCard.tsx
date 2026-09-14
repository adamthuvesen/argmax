import {
  AlertCircle,
  ChevronDown,
  FileDiff,
  Files,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  Github,
  MoreHorizontal,
  SquareTerminal,
  X
} from "lucide-react";
import { Fragment, useEffect, useRef, useState, type JSX, type MouseEvent, type ReactNode } from "react";
import { errorMessage } from "../../shared/error.js";
import type { AsyncState } from "../hooks/useReviewState.js";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { agentStatusLabel } from "../lib/agentLaunch.js";
import { openWebUrl } from "../lib/openWebUrl.js";
import type { SubagentCluster } from "../lib/subagentSummary.js";
import {
  primaryWorkspacePr,
  refreshSessionPrs,
  workspaceSessionPrs,
  type WorkspaceSessionPr
} from "../lib/sessionPrs.js";
import { AgentEmblem } from "./AgentEmblem.js";
import { WorkingNest } from "./WorkingNest.js";
import { ChangeCount } from "./ChangeCount.js";
import type { ComposerStatus } from "./SessionComposer.js";

/** Avatars shown before the stack folds into a +N chip. Matches the reference
 *  density: four or five colored marks read as a team, more read as noise. */
const SUBAGENT_AVATAR_LIMIT = 5;
const VISIBLE_PR_LIMIT = 3;

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
  onOpenAgents,
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
  onOpenAgents?: () => void;
  onOpenCommitDialog?: () => void;
  onToggleTerminal: () => void;
  session: SessionSummary | null;
  setStatus: (status: ComposerStatus | null) => void;
  /** Subagents the session has launched; null hides the section. */
  subagents?: SubagentCluster | null;
  workspace: WorkspaceSummary;
}): JSX.Element {
  const [isPrPending, setIsPrPending] = useState(false);
  const [isPrHistoryOpen, setIsPrHistoryOpen] = useState(false);
  const [branchCopyFlash, copyBranch] = useCopyToClipboard();
  const hasChanges = changeSummary !== null && changeSummary.fileCount > 0;
  const changesLabel = changesState === "error" ? "unavailable" : changesState === "ready" ? null : "…";
  const prs = workspaceSessionPrs(workspace);
  const primaryPr = primaryWorkspacePr(workspace);
  const visiblePrs = visibleWorkspacePrs(prs, primaryPr);
  const visiblePrNumbers = new Set(visiblePrs.map((pr) => pr.prNumber));
  const hiddenPrs = prs.filter((pr) => !visiblePrNumbers.has(pr.prNumber));
  const branchCopyTitle =
    branchCopyFlash === "copied"
      ? "Copied branch name"
      : branchCopyFlash === "failed"
        ? "Couldn't copy branch name"
        : `Copy branch name ${workspace.branch}`;

  useEffect(() => {
    if (!session?.id || workspace.kind !== "git" || !window.argmax?.prs?.refresh) return;
    // The rows land on the actions menu; the card is here for the workspace
    // publish `prs:refresh` performs on its way out, which is why it shares
    // that call rather than making a second one.
    void refreshSessionPrs(session.id)?.catch(() => undefined);
  }, [session?.id, workspace.kind, workspace.branch]);

  const createPr = (event: MouseEvent<HTMLButtonElement>): void => {
    if (!session || !window.argmax) return;
    const flip = event.metaKey || event.ctrlKey;
    setIsPrPending(true);
    setStatus(null);
    void window.argmax.git
      .viewOrCreatePr({ sessionId: session.id, expectedBranch: workspace.branch })
      .then((result) => {
        openWebUrl(result.url, { flip });
      })
      .catch((error: unknown) => setStatus({ kind: "error", message: errorMessage(error) }))
      .finally(() => setIsPrPending(false));
  };

  const setPrimaryPr = (prNumber: number | null): void => {
    if (!session || !window.argmax?.prs?.setPrimary) return;
    setIsPrPending(true);
    setStatus(null);
    void window.argmax.prs
      .setPrimary({ sessionId: session.id, prNumber })
      .catch((error: unknown) => setStatus({ kind: "error", message: errorMessage(error) }))
      .finally(() => setIsPrPending(false));
  };

  const dismissPr = (prNumber: number): void => {
    if (!session || !window.argmax?.prs?.dismiss) return;
    setIsPrPending(true);
    setStatus(null);
    void window.argmax.prs
      .dismiss({ sessionId: session.id, prNumber })
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
      <div
        className="workspace-card-branch"
        title={`${workspace.sharedWorkspace ? "Checkout branch" : "Branch"} ${workspace.branch} · from ${workspace.baseRef}`}
      >
        <span className="workspace-card-row-icon" aria-hidden="true">
          <GitBranch size={13} />
        </span>
        <div className="workspace-card-branch-text">
          <button
            type="button"
            className="workspace-card-branch-name"
            aria-label={branchCopyTitle}
            title={branchCopyTitle}
            onClick={() => void copyBranch(workspace.branch)}
          >
            {branchWithBreakOpportunities(workspace.branch)}
          </button>
          <div className="workspace-card-branch-base">
            <span className="workspace-card-base">from {workspace.baseRef}</span>
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
        </div>
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
          icon={<GitPullRequestArrow size={13} aria-hidden="true" />}
          ariaLabel="Create PR for checkout branch"
          label="Create pull request"
          disabled={!session || isPrPending}
          title={`Create a pull request for ${workspace.branch}`}
          onClick={createPr}
        />
      </div>

      {prs.length > 0 ? (
        <section className="workspace-card-section workspace-card-prs" aria-label="Pull requests">
          {prs.length > 1 ? (
            <div className="workspace-card-section-label workspace-card-prs-label">
              <span>Pull requests</span>
              <span>{prs.length}</span>
            </div>
          ) : null}
          {visiblePrs.map((pr) => (
            <WorkspacePrRow
              key={pr.prNumber}
              pr={pr}
              busy={isPrPending}
              onDismiss={() => dismissPr(pr.prNumber)}
              onSetPrimary={() => setPrimaryPr(pr.prNumber)}
              onUseAutomatic={() => setPrimaryPr(null)}
            />
          ))}
          {hiddenPrs.length > 0 ? (
            <div className="workspace-card-pr-more">
              <button
                type="button"
                aria-expanded={isPrHistoryOpen}
                title={`${isPrHistoryOpen ? "Hide" : "Show"} ${hiddenPrs.length} more pull ${hiddenPrs.length === 1 ? "request" : "requests"}`}
                onClick={() => setIsPrHistoryOpen((open) => !open)}
              >
                <ChevronDown size={12} aria-hidden="true" />
                {hiddenPrs.length} more
              </button>
              {isPrHistoryOpen ? <div className="workspace-card-pr-more-list">
                {hiddenPrs.map((pr) => (
                  <WorkspacePrRow
                    key={pr.prNumber}
                    pr={pr}
                    busy={isPrPending}
                    onDismiss={() => dismissPr(pr.prNumber)}
                    onSetPrimary={() => setPrimaryPr(pr.prNumber)}
                    onUseAutomatic={() => setPrimaryPr(null)}
                  />
                ))}
              </div> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {subagents ? <SubagentsSection cluster={subagents} onOpenAgents={onOpenAgents} /> : null}
    </aside>
  );
}

function visibleWorkspacePrs(
  prs: readonly WorkspaceSessionPr[],
  primary: WorkspaceSessionPr | null
): readonly WorkspaceSessionPr[] {
  const visible: WorkspaceSessionPr[] = [];
  if (primary) visible.push(primary);
  for (const pr of prs) {
    if (visible.length >= VISIBLE_PR_LIMIT) break;
    if (pr.prNumber === primary?.prNumber || pr.prState !== "OPEN") continue;
    visible.push(pr);
  }
  if (visible.length === 0 && prs[0]) visible.push(prs[0]);
  return visible;
}

function WorkspacePrRow({
  busy,
  onDismiss,
  onSetPrimary,
  onUseAutomatic,
  pr
}: {
  busy: boolean;
  onDismiss: () => void;
  onSetPrimary: () => void;
  onUseAutomatic: () => void;
  pr: WorkspaceSessionPr;
}): JSX.Element {
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsideOrEscape(actionsRef, actionsOpen, () => setActionsOpen(false));
  const state = pr.prState?.toLowerCase() ?? "unknown";
  const stateLabel = `${state.charAt(0).toUpperCase()}${state.slice(1)}`;
  const details = [pr.relationship === "referenced" ? "Referenced" : null, pr.headRefName]
    .filter(Boolean).join(" · ");
  const rowTitle = pr.url
    ? `Open pull request #${pr.prNumber} on GitHub (${state})`
    : `Pull request #${pr.prNumber} (${state}) has no URL. Refresh its GitHub state to open it.`;

  return (
    <div className="workspace-card-pr-row">
      <button
        type="button"
        className="workspace-card-row workspace-card-pr-link"
        aria-label={`PR #${pr.prNumber}${pr.title ? ` ${pr.title}` : ""}`}
        disabled={!pr.url}
        title={rowTitle}
        onClick={(event) => {
          if (!pr.url) return;
          openWebUrl(pr.url, { flip: event.metaKey || event.ctrlKey });
        }}
      >
        <span className="workspace-card-row-icon" aria-hidden="true">
          <PrStateIcon state={pr.prState} />
        </span>
        <span className="workspace-card-pr-copy">
          <span className="workspace-card-row-label" title={pr.title ?? undefined}>
            #{pr.prNumber}
          </span>
          {details ? (
            <span
              className="workspace-card-pr-relationship"
              data-relationship={pr.relationship}
              title={`${stateLabel} · ${details}`}
            >
              {details}
            </span>
          ) : null}
        </span>
        {pr.refreshError ? (
          <span className="workspace-card-pr-warning" title={`Refresh failed: ${pr.refreshError}`}>
            <AlertCircle size={12} aria-label="PR refresh failed" />
          </span>
        ) : null}
      </button>
      <div ref={actionsRef} className="workspace-card-pr-actions">
        <button
          type="button"
          aria-label={`Actions for PR #${pr.prNumber}`}
          aria-expanded={actionsOpen}
          title={`Actions for PR #${pr.prNumber}`}
          onClick={() => setActionsOpen((open) => !open)}
        >
          <MoreHorizontal size={13} aria-hidden="true" />
        </button>
        {actionsOpen ? <div className="workspace-card-pr-actions-menu" role="menu" aria-label={`PR #${pr.prNumber} actions`}>
          {!pr.isPinned ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setActionsOpen(false);
                onSetPrimary();
              }}
            >
              {pr.relationship === "unverified" ? "Confirm and make primary" : "Make primary"}
            </button>
          ) : null}
          {pr.isPinned ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setActionsOpen(false);
                onUseAutomatic();
              }}
            >
              Automatic selection
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setActionsOpen(false);
              onDismiss();
            }}
          >
            Remove from this chat
          </button>
        </div> : null}
      </div>
    </div>
  );
}

/**
 * The work-alongside section, Codex-card style: a labeled group with one
 * colored avatar per launch, each wearing its own status. When the pane owns
 * the Agents view, the summary opens that dock; the avatars and the nest
 * answer "is anything still working" without a tally to read.
 *
 * It counts what the dock's tab strip counts: this session's subagents, plus
 * the multitasks dispatched from it. The label follows — "Alongside" once a
 * multitask is in there, since they are not subagents.
 */
function SubagentsSection({ cluster, onOpenAgents }: { cluster: SubagentCluster; onOpenAgents?: () => void }): JSX.Element {
  const visible = cluster.entries.slice(0, SUBAGENT_AVATAR_LIMIT);
  const overflow = cluster.entries.length - visible.length;
  const roster = cluster.entries
    .map((entry) => `${entry.codename} — ${agentStatusLabel(entry.status)}`)
    .join(", ");
  const noun = cluster.hasMultitask ? "running alongside" : cluster.entries.length === 1 ? "subagent" : "subagents";
  const title = `${cluster.entries.length} ${noun}: ${roster}`;
  const firstRunning = cluster.entries.find((entry) => entry.status === "running");
  const label = cluster.hasMultitask ? "Alongside" : "Agents";

  const content = (
    <>
      <span className="workspace-card-agent-stack" aria-hidden="true">
        {visible.map((entry) => (
          <span
            key={entry.toolUseId}
            className="workspace-card-agent"
            data-icon-color={entry.iconColor}
            data-status={entry.status}
          >
            <AgentEmblem
              shape={entry.emblem.shape}
              hue={entry.emblem.hue}
              size={18}
              status={entry.status === "error" ? "error" : "done"}
            />
          </span>
        ))}
        {overflow > 0 ? <span className="workspace-card-agent workspace-card-agent-more">+{overflow}</span> : null}
      </span>
      {cluster.running > 0 ? <WorkingNest active size={12} phaseKey={firstRunning?.toolUseId} /> : null}
    </>
  );

  return (
    <section className="workspace-card-section" aria-label={label}>
      <div className="workspace-card-section-label">{label}</div>
      {onOpenAgents ? (
        <button
          type="button"
          className="workspace-card-subagents agent-emblem-tint"
          data-hue={firstRunning?.emblem?.hue}
          aria-label={`Open ${label}`}
          title={`Open ${label} in the Agents view`}
          onClick={onOpenAgents}
        >
          {content}
        </button>
      ) : (
        <div
          className="workspace-card-subagents agent-emblem-tint"
          data-hue={firstRunning?.emblem?.hue}
          title={title}
        >
          {content}
        </div>
      )}
    </section>
  );
}

/** A branch name may run to two lines in the header. Left to itself the
 *  browser would break it mid-word wherever the line ran out; a `<wbr>` after
 *  each slash and hyphen lets it fold at the seams a branch name already has
 *  (`adam/` then `feat-approvals-and-chat`). `overflow-wrap: anywhere` in the
 *  CSS still catches a single segment longer than the line. */
function branchWithBreakOpportunities(branch: string): ReactNode {
  const segments = branch.split(/(?<=[/-])/);
  if (segments.length === 1) return branch;
  return segments.map((segment, index) => (
    <Fragment key={index}>
      {segment}
      {index < segments.length - 1 ? <wbr /> : null}
    </Fragment>
  ));
}

/** The PR row states itself in the icon GitHub uses for that state — sage open,
 *  purple merged, a struck-through pull request closed — instead of spending row
 *  width on the word. The row icon is `aria-hidden`, so the word still reaches a
 *  screen reader through the row's title. A PR whose state we have not polled
 *  yet keeps the plain GitHub mark rather than guessing at one. */
function PrStateIcon({ state }: { state: string | null }): JSX.Element {
  if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") {
    return <Github size={13} aria-hidden="true" />;
  }
  const Icon = state === "MERGED" ? GitMerge : state === "OPEN" ? GitPullRequest : GitPullRequestClosed;
  return <Icon size={13} aria-hidden="true" className="workspace-card-pr-state" data-pr-state={state} />;
}

function WorkspaceCardRow({
  ariaLabel,
  disabled = false,
  icon,
  label,
  meta = null,
  onClick,
  pressed,
  title
}: {
  ariaLabel?: string;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  meta?: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  pressed?: boolean;
  title: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="workspace-card-row"
      aria-label={ariaLabel ?? label}
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
