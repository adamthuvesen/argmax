import type { AttentionState, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { workspacesWithRunningMultitask } from "./multitask.js";

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

export interface PriorityReason {
  kind: PriorityReasonKind;
  /**
   * When this reason became current. A "Done" is spent once a reason newer
   * than it appears, so every reason has to say when it started — a dismissal
   * measured against the session alone could not see a PR go red.
   */
  since: string;
  /**
   * Epoch ms when this reason lapses on its own, or null when only the thing
   * it names can clear it. An unanswered question does not expire; an
   * unread reply does.
   */
  idleAt: number | null;
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

export interface PriorityEntry {
  workspace: WorkspaceSummary;
  /** Live, undismissed reasons, strongest first. Empty for a working or manually-added row. */
  reasons: PriorityReason[];
  /** The strongest reason, which is what the row says about itself. */
  reason: PriorityReasonKind | null;
  /** `reason` when it is one a session row can wear; null for the PR-shaped ones. */
  attention: PriorityAttention | null;
  /** True while a session on the workspace is mid-turn. */
  working: boolean;
  /**
   * Epoch ms when this row goes quiet long enough to leave the section on its
   * own. Null while it is working, when nothing ages it out (a manual add), or
   * when every reason it holds waits on an event rather than a clock.
   */
  idleAt: number | null;
}

/**
 * A reply nobody has read yet is history after this long — it stays in the
 * normal groups but no longer floats into Priority. The clock runs from the
 * last message, so reading a row does not demote it early. A workspace that is
 * still working never goes idle, however long the turn runs.
 *
 * Only the reasons a clock can resolve use it. An approval, an unanswered
 * question, a red check and an open pull request are all still true half an
 * hour later, so they wait for the event that ends them (or a "Done").
 */
export const PRIORITY_IDLE_MS = 30 * 60 * 1000;

/** When a quiet reason ages out; null when its last message is unreadable. */
function idleDeadline(lastActivityAt: string): number | null {
  const lastActivityMs = Date.parse(lastActivityAt);
  return Number.isFinite(lastActivityMs) ? lastActivityMs + PRIORITY_IDLE_MS : null;
}

function rank(kind: PriorityReasonKind): number {
  return REASON_RANK[kind] ?? 0;
}

function attentionReason(attention: string): PriorityReasonKind | null {
  return ATTENTION_REASONS.has(attention as PriorityReasonKind)
    ? (attention as PriorityReasonKind)
    : null;
}

export interface WorkspaceAttention {
  attention: PriorityAttention;
  /** When `attention` became current. */
  changedAt: string;
  /** The attention session's last message, the clock behind `PRIORITY_IDLE_MS`. */
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

export interface WorkspaceReasonsInput {
  workspaces: WorkspaceSummary[];
  sessions: SessionSummary[];
  nowMs: number;
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
export function computeWorkspaceReasons(
  input: WorkspaceReasonsInput
): Map<string, PriorityReason[]> {
  const { workspaces, sessions, nowMs, unreadWorkspaceIds } = input;
  const bySession = loudestSession(sessions);
  const working = workingWorkspaceIds(sessions);
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
      // weakest session reason drops on sight rather than waiting out a clock.
      const stillUnread = unreadWorkspaceIds?.has(workspace.id) ?? true;
      const wanted = found.kind !== "review-ready" || stillUnread;
      // Only the reasons a clock resolves carry a deadline. The rest hold
      // their place until the thing they name is dealt with.
      const clocked = found.kind !== "approval-needed" && found.kind !== "question-asked";
      const idleAt = clocked && !working.has(workspace.id)
        ? idleDeadline(found.lastActivityAt)
        : null;
      const lapsed = clocked && !working.has(workspace.id) && (idleAt === null || nowMs > idleAt);
      if (wanted && !lapsed) {
        reasons.push({ kind: found.kind, since: found.changedAt, idleAt });
      }
    }

    // A pull request is the workspace's business, not any one session's, and
    // it outlives the turn that opened it. `prActivityAt` is the poller's last
    // observation, which is both what a dismissal is measured against and the
    // proof this PR state is something it actually saw.
    if (workspace.prState === "OPEN" && workspace.prActivityAt) {
      if (workspace.prCheckState === "failure") {
        reasons.push({ kind: "ci-red", since: workspace.prActivityAt, idleAt: null });
      }
      reasons.push({ kind: "pr-open", since: workspace.prActivityAt, idleAt: null });
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
  nowMs: number,
  unreadWorkspaceIds?: ReadonlySet<string>
): Map<string, WorkspaceAttention> {
  const bySession = loudestSession(sessions);
  const reasons = computeWorkspaceReasons({ workspaces, sessions, nowMs, unreadWorkspaceIds });
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
 * A row holds its place while it is working, and after that for as long as its
 * strongest reason lasts: an unread reply for `PRIORITY_IDLE_MS`, an approval
 * or a question until it is answered, a red check until it goes green, an open
 * pull request until it closes. Right-click → "Done" clears everything true at
 * that moment and nothing that happens afterwards.
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
  nowMs: number,
  unreadWorkspaceIds?: ReadonlySet<string>
): PriorityEntry[] {
  const reasonsByWorkspace = computeWorkspaceReasons({
    workspaces,
    sessions,
    nowMs,
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
      working,
      idleAt: working ? null : earliestIdle(reasons)
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

/**
 * When a row next changes on its own. A row leaves only once *every* reason
 * holding it has lapsed, so one reason that waits on an event (an open pull
 * request) means the row has no deadline at all.
 */
function earliestIdle(reasons: readonly PriorityReason[]): number | null {
  let latest: number | null = null;
  for (const reason of reasons) {
    if (reason.idleAt === null) return null;
    if (latest === null || reason.idleAt > latest) latest = reason.idleAt;
  }
  return latest;
}

/**
 * When the section next changes on its own: the earliest moment a listed row
 * crosses the idle line. Null when nothing on screen is aging, so the caller
 * can arm one timer instead of polling a clock.
 */
export function nextPriorityIdleAt(entries: PriorityEntry[]): number | null {
  let earliest: number | null = null;
  for (const entry of entries) {
    if (entry.idleAt === null) continue;
    if (earliest === null || entry.idleAt < earliest) earliest = entry.idleAt;
  }
  return earliest;
}
