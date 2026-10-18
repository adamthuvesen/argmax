import type { AttentionState, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { workspacesWithRunningMultitask } from "./multitask.js";
import { workspacePrSummaryState } from "./sessionPrs.js";

/** Attention values that earn a workspace a spot in the Priority section. */
export type PriorityAttention = Exclude<AttentionState, "normal">;

/**
 * Why a workspace is in the Priority section.
 *
 * The section used to run on one value — the session's attention — and one
 * clock. That made it a recency feed: `review-ready` is what *every* completed
 * turn earns, and thirty minutes of silence cleared everything, including the
 * things silence does not resolve. A reason instead carries its own answer to
 * "what makes this go away", so an open pull request can outlive a read
 * message and a finished-and-read chat can leave immediately.
 */
export type PriorityReasonKind =
  | "approval-needed"
  | "question-asked"
  | "blocked"
  | "failed"
  | "ci-red"
  | "review-ready"
  | "pr-open";

/**
 * Triage order. Stalled-on-you beats asked-you beats broken beats
 * ready-to-look-at, and a pull request merely being open is the weakest claim
 * on the person there is — it is a state, not a request.
 */
const REASON_RANK: Record<PriorityReasonKind, number> = {
  "approval-needed": 7,
  "question-asked": 6,
  blocked: 5,
  failed: 4,
  "ci-red": 3,
  "review-ready": 2,
  "pr-open": 1
};

/** Reasons that are also a session attention value, so a row can wear one. */
const ATTENTION_REASONS = new Set<PriorityReasonKind>([
  "approval-needed",
  "question-asked",
  "blocked",
  "failed",
  "review-ready"
]);

interface PriorityReason {
  kind: PriorityReasonKind;
  /**
   * When this reason became current. A "Done" is spent once a reason newer
   * than it appears, so every reason has to say when it started — a dismissal
   * measured against the session alone could not see a PR go red.
   */
  since: string;
}

/**
 * Workspaces with a turn in flight — their own, or one belonging to a
 * multitask they dispatched. A multitask is work in progress on the chat that
 * started it, which is the only row it has, so it counts here too: it keeps
 * the row marked and holds its place instead of ageing out mid-run.
 *
 * Built once per snapshot rather than asked per workspace, since both callers
 * walk every workspace.
 */
export function workingWorkspaceIds(sessions: readonly SessionSummary[]): Set<string> {
  const working = workspacesWithRunningMultitask(sessions);
  for (const session of sessions) {
    if (session.state === "running") working.add(session.workspaceId);
  }
  return working;
}

interface PriorityEntry {
  workspace: WorkspaceSummary;
  /** Live, undismissed reasons, strongest first. Empty for a working or manually-added row. */
  reasons: PriorityReason[];
  /** The strongest reason, which is what the row says about itself. */
  reason: PriorityReasonKind | null;
  /** `reason` when it is one a session row can wear; null for the PR-shaped ones. */
  attention: PriorityAttention | null;
  /** True while a session on the workspace is mid-turn. */
  working: boolean;
}

function rank(kind: PriorityReasonKind): number {
  return REASON_RANK[kind] ?? 0;
}

function attentionReason(attention: string): PriorityReasonKind | null {
  return ATTENTION_REASONS.has(attention as PriorityReasonKind)
    ? (attention as PriorityReasonKind)
    : null;
}

interface WorkspaceAttention {
  attention: PriorityAttention;
  /** When `attention` became current. */
  changedAt: string;
  /** The attention session's last message. */
  lastActivityAt: string;
}

/** The session whose attention speaks for the workspace, if any does. */
function loudestSession(
  sessions: SessionSummary[]
): Map<string, { kind: PriorityReasonKind; changedAt: string | null; lastActivityAt: string }> {
  const bySession = new Map<
    string,
    { kind: PriorityReasonKind; changedAt: string | null; lastActivityAt: string }
  >();
  for (const session of sessions) {
    const kind = attentionReason(session.attention);
    if (!kind) continue;
    const current = bySession.get(session.workspaceId);
    if (
      current &&
      (rank(current.kind) > rank(kind) ||
        (rank(current.kind) === rank(kind) && current.lastActivityAt >= session.lastActivityAt))
    ) {
      continue;
    }
    bySession.set(session.workspaceId, {
      kind,
      changedAt: session.attentionChangedAt ?? null,
      lastActivityAt: session.lastActivityAt
    });
  }
  return bySession;
}

/**
 * A dismissal ("mark as done") covers every reason that was already true when
 * it was made, and nothing that has happened since. A reason with no timestamp
 * of its own (a pre-migration session row) is treated as older than any
 * dismissal, so stale rows stay dismissible.
 */
function isDismissed(workspace: WorkspaceSummary, since: string | null): boolean {
  const dismissedAt = workspace.priorityDismissedAt;
  if (!dismissedAt) return false;
  return since === null || dismissedAt >= since;
}

function inPlay(workspace: WorkspaceSummary): boolean {
  return workspace.state !== "archived" && workspace.state !== "kept";
}

interface WorkspaceReasonsInput {
  workspaces: WorkspaceSummary[];
  sessions: SessionSummary[];
  /**
   * Workspaces whose latest reply the user has not opened. Reading clears
   * `review-ready` and nothing else: opening a chat means you have seen what
   * the agent said, not that you have approved its request, answered its
   * question, or merged its pull request.
   */
  unreadWorkspaceIds?: ReadonlySet<string>;
}

/**
 * Every live, undismissed reason per workspace, strongest first — the signal
 * behind both the Priority section's placement and the attention chip on a
 * row.
 *
 * `archived` and `kept` workspaces are excluded (keeping is an explicit "I'm
 * done here"). Pinned workspaces are *not*: a pin changes where a row sits,
 * not whether it needs you. Placement rules live in `computePriorityEntries`.
 */
function computeWorkspaceReasons(
  input: WorkspaceReasonsInput
): Map<string, PriorityReason[]> {
  const { workspaces, sessions, unreadWorkspaceIds } = input;
  const bySession = loudestSession(sessions);
  const result = new Map<string, PriorityReason[]>();

  for (const workspace of workspaces) {
    if (!inPlay(workspace)) continue;
    const reasons: PriorityReason[] = [];

    const found = bySession.get(workspace.id);
    // A null `changedAt` is a row from before the column existed. Admitting
    // those would flood the section on first launch with every session that
    // ever failed, so they stay out until their attention next moves.
    if (found && found.changedAt !== null) {
      // Once the reply has been read there is nothing left to review, so the
      // weakest session reason drops on sight.
      const stillUnread = unreadWorkspaceIds?.has(workspace.id) ?? true;
      const wanted = found.kind !== "review-ready" || stillUnread;
      if (wanted) {
        reasons.push({ kind: found.kind, since: found.changedAt });
      }
    }

    // A pull request is the workspace's business, not any one session's, and
    // it outlives the turn that opened it. `prActivityAt` is the poller's last
    // observation, which is both what a dismissal is measured against and the
    // proof this PR state is something it actually saw.
    if (workspacePrSummaryState(workspace) === "OPEN" && workspace.prActivityAt) {
      if (workspace.prCheckState === "failure") {
        reasons.push({ kind: "ci-red", since: workspace.prActivityAt });
      }
      reasons.push({ kind: "pr-open", since: workspace.prActivityAt });
    }

    const live = workspace.priorityAddedAt
      ? reasons
      : reasons.filter((reason) => !isDismissed(workspace, reason.since));
    if (live.length === 0) continue;
    live.sort((a, b) => rank(b.kind) - rank(a.kind));
    result.set(workspace.id, live);
  }
  return result;
}

/**
 * Fresh, undismissed attention per workspace — the strongest reason a session
 * row can wear as its own state. PR-shaped reasons are deliberately absent:
 * the row already draws a pull request on its marker.
 */
export function computeWorkspaceAttention(
  workspaces: WorkspaceSummary[],
  sessions: SessionSummary[],
  unreadWorkspaceIds?: ReadonlySet<string>
): Map<string, WorkspaceAttention> {
  const bySession = loudestSession(sessions);
  const reasons = computeWorkspaceReasons({ workspaces, sessions, unreadWorkspaceIds });
  const result = new Map<string, WorkspaceAttention>();
  for (const [workspaceId, workspaceReasons] of reasons) {
    const top = workspaceReasons.find((reason) => ATTENTION_REASONS.has(reason.kind));
    const session = bySession.get(workspaceId);
    if (!top || !session) continue;
    result.set(workspaceId, {
      attention: top.kind as PriorityAttention,
      changedAt: top.since,
      lastActivityAt: session.lastActivityAt
    });
  }
  return result;
}

/**
 * Workspaces that need the user right now (a live reason, a turn in flight, or
 * a manual add). `archived` and `kept` workspaces are excluded — keeping is an
 * explicit "I'm done here" — as is anything mid-archive.
 *
 * A row holds its place while it is working, and after that until every
 * reason is resolved or dismissed. Reading clears an unread reply. An
 * approval or question waits for an answer, a red check waits for green, and
 * an open pull request waits until it closes. Right-click → "Done" clears
 * everything true at that moment and nothing that happens afterwards.
 *
 * Sorting:
 * 1) Working rows are always at the top (sorted by last message descending).
 * 2) Then by the strength of the strongest reason.
 * 3) Then by last message, descending.
 *
 * A manual add (`priorityAddedAt`) floats the workspace regardless of reason
 * and never ages out; the backend guarantees add/dismiss are mutually
 * exclusive, so a manually-added row skips the dismissal check.
 *
 * Pinned workspaces stay in Pinned. A pin is a standing placement, so it
 * wins over both a reason and a manual add until the row is unpinned.
 */
export function computePriorityEntries(
  workspaces: WorkspaceSummary[],
  sessions: SessionSummary[],
  unreadWorkspaceIds?: ReadonlySet<string>
): PriorityEntry[] {
  const reasonsByWorkspace = computeWorkspaceReasons({
    workspaces,
    sessions,
    unreadWorkspaceIds
  });
  const workingWorkspaces = workingWorkspaceIds(sessions);

  const entries: PriorityEntry[] = [];
  for (const workspace of workspaces) {
    if (
      workspace.pinned ||
      workspace.state === "archived" ||
      workspace.state === "kept" ||
      workspace.state === "archiving" ||
      workspace.state === "archive-failed"
    ) continue;
    const reasons = reasonsByWorkspace.get(workspace.id) ?? [];
    const working = workingWorkspaces.has(workspace.id);
    const manuallyAdded = Boolean(workspace.priorityAddedAt);
    if (reasons.length === 0 && !working && !manuallyAdded) continue;
    const top = reasons[0] ?? null;
    entries.push({
      workspace,
      reasons,
      // A working or manually-added row still says why when it has a reason of
      // its own; otherwise it renders plain.
      reason: top?.kind ?? null,
      attention: top && ATTENTION_REASONS.has(top.kind) ? (top.kind as PriorityAttention) : null,
      working
    });
  }

  entries.sort((a, b) => {
    // 1) Working is always at the top
    if (a.working !== b.working) {
      return a.working ? -1 : 1;
    }
    // 2) Then the row with the stronger claim on the reader
    const byReason = (b.reason ? rank(b.reason) : 0) - (a.reason ? rank(a.reason) : 0);
    if (byReason !== 0) return byReason;
    // 3) Followed by last message in descending order
    if (a.workspace.lastActivityAt !== b.workspace.lastActivityAt) {
      return a.workspace.lastActivityAt < b.workspace.lastActivityAt ? 1 : -1;
    }
    return a.workspace.id < b.workspace.id ? -1 : 1;
  });
  return entries;
}
