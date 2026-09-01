import type { AttentionState, SessionSummary, WorkspaceSummary } from "../../shared/types.js";

/** Attention values that earn a workspace a spot in the Priority section. */
export type PriorityAttention = Exclude<AttentionState, "normal">;

/** True when any session on the workspace is mid-turn. */
export function isWorkspaceWorking(sessions: SessionSummary[], workspaceId: string): boolean {
  return sessions.some((session) => session.workspaceId === workspaceId && session.state === "running");
}

// Triage order: stalled-on-you beats needs-your-judgment.
const ATTENTION_SEVERITY: Record<PriorityAttention, number> = {
  "approval-needed": 4,
  blocked: 3,
  failed: 2,
  "review-ready": 1
};

export interface PriorityEntry {
  workspace: WorkspaceSummary;
  /** Null for working or manually-added entries with no attention of their own. */
  attention: PriorityAttention | null;
  /** When `attention` became current; null on sessions predating the column. */
  attentionChangedAt: string | null;
  /** True while a session on the workspace is mid-turn. */
  working: boolean;
  /**
   * Epoch ms when this row goes quiet long enough to leave the section on its
   * own. Null while it is working or when nothing ages it out (a manual add).
   */
  idleAt: number | null;
}

/**
 * A session that has said nothing for this long is history, not triage — it
 * stays in the normal groups but no longer floats into Priority. The clock
 * runs from the last message, so reading a row no longer demotes it: it holds
 * its place until the conversation actually goes quiet. A workspace that is
 * still working never goes idle, however long the turn runs.
 */
export const PRIORITY_IDLE_MS = 30 * 60 * 1000;

/** When a quiet session ages out; null when its last message is unreadable. */
function idleDeadline(lastActivityAt: string): number | null {
  const lastActivityMs = Date.parse(lastActivityAt);
  return Number.isFinite(lastActivityMs) ? lastActivityMs + PRIORITY_IDLE_MS : null;
}

function severity(attention: string): number {
  return ATTENTION_SEVERITY[attention as PriorityAttention] ?? 0;
}

/**
 * A dismissal ("mark as done") only counts while it is newer than the last
 * attention change — a fresh attention event re-promotes the workspace. A
 * null `attentionChangedAt` (pre-migration row) is treated as older than any
 * dismissal so stale review-ready workspaces stay dismissible.
 */
function isDismissed(workspace: WorkspaceSummary, attentionChangedAt: string | null): boolean {
  const dismissedAt = workspace.priorityDismissedAt;
  if (!dismissedAt) return false;
  return attentionChangedAt === null || dismissedAt >= attentionChangedAt;
}

export interface WorkspaceAttention {
  attention: PriorityAttention;
  /** When `attention` became current. */
  changedAt: string;
  /** The attention session's last message, the clock behind `PRIORITY_IDLE_MS`. */
  lastActivityAt: string;
}

/**
 * Fresh, undismissed attention per workspace — the signal behind both the
 * Priority section's placement and the attention chip on a row. Highest
 * severity wins; ties go to the most recently active session since that is the
 * one whose attention is being renewed.
 *
 * `archived` and `kept` workspaces are excluded (keeping is an explicit "I'm
 * done here"), and so is a session quiet for longer than `PRIORITY_IDLE_MS`
 * or of unknown age (pre-migration rows have no `attention_changed_at`, which
 * keeps the first launch after that migration from flooding the section with
 * every failed session ever). Pinned workspaces are *not* excluded: a pin
 * changes where a row sits, not whether it needs you. Placement rules live in
 * `computePriorityEntries`.
 */
export function computeWorkspaceAttention(
  workspaces: WorkspaceSummary[],
  sessions: SessionSummary[],
  nowMs: number
): Map<string, WorkspaceAttention> {
  const bySession = new Map<string, { attention: PriorityAttention; changedAt: string | null; lastActivityAt: string }>();
  for (const session of sessions) {
    const rank = severity(session.attention);
    if (rank === 0) continue;
    const current = bySession.get(session.workspaceId);
    if (
      current &&
      (severity(current.attention) > rank ||
        (severity(current.attention) === rank && current.lastActivityAt >= session.lastActivityAt))
    ) {
      continue;
    }
    bySession.set(session.workspaceId, {
      attention: session.attention as PriorityAttention,
      changedAt: session.attentionChangedAt ?? null,
      lastActivityAt: session.lastActivityAt
    });
  }

  const result = new Map<string, WorkspaceAttention>();
  for (const workspace of workspaces) {
    if (workspace.state === "archived" || workspace.state === "kept") continue;
    const found = bySession.get(workspace.id);
    if (!found || found.changedAt === null) continue;
    if (!isWorkspaceWorking(sessions, workspace.id)) {
      const idleAtMs = idleDeadline(found.lastActivityAt);
      if (idleAtMs === null || nowMs > idleAtMs) continue;
    }
    if (isDismissed(workspace, found.changedAt)) continue;
    result.set(workspace.id, {
      attention: found.attention,
      changedAt: found.changedAt,
      lastActivityAt: found.lastActivityAt
    });
  }
  return result;
}

/**
 * Workspaces that need the user right now (active attention, live turns, or
 * manual adds). `archived` and `kept` workspaces are excluded — keeping is an
 * explicit "I'm done here" — and so is anything quiet for longer than
 * `PRIORITY_IDLE_MS` (or whose last message is of unknown age). A row holds its
 * place while it is working and for `PRIORITY_IDLE_MS` after the last message;
 * opening it changes nothing, and right-click → "Done" is how the user clears
 * it early.
 *
 * Sorting:
 * 1) Working rows are always at the top (sorted by last message descending).
 * 2) Followed by the remaining priority rows, also sorted by last message in
 *    descending order.
 *
 * A manual add (`priorityAddedAt`) floats the workspace regardless of
 * attention and never ages out; the backend guarantees add/dismiss are
 * mutually exclusive, so a manually-added row skips the dismissal check.
 *
 * Pinned workspaces stay in Pinned. A pin is a standing placement, so it
 * wins over both attention and a manual add until the row is unpinned.
 */
export function computePriorityEntries(
  workspaces: WorkspaceSummary[],
  sessions: SessionSummary[],
  nowMs: number
): PriorityEntry[] {
  const attentionByWorkspace = computeWorkspaceAttention(workspaces, sessions, nowMs);

  const entries: PriorityEntry[] = [];
  for (const workspace of workspaces) {
    if (
      workspace.pinned ||
      workspace.state === "archived" ||
      workspace.state === "kept" ||
      workspace.state === "archiving" ||
      workspace.state === "archive-failed"
    ) continue;
    const found = attentionByWorkspace.get(workspace.id);
    const working = isWorkspaceWorking(sessions, workspace.id);
    const manuallyAdded = Boolean(workspace.priorityAddedAt);
    if (!found && !working && !manuallyAdded) continue;
    entries.push({
      workspace,
      // A working or manually-added row still shows real attention when there
      // is fresh, undismissed attention to show; otherwise it renders plain.
      attention: found?.attention ?? null,
      attentionChangedAt: found?.changedAt ?? null,
      working,
      idleAt: found && !working ? idleDeadline(found.lastActivityAt) : null
    });
  }

  entries.sort((a, b) => {
    // 1) Working is always at the top
    if (a.working !== b.working) {
      return a.working ? -1 : 1;
    }
    // 2) Followed by last message in descending order
    if (a.workspace.lastActivityAt !== b.workspace.lastActivityAt) {
      return a.workspace.lastActivityAt < b.workspace.lastActivityAt ? 1 : -1;
    }
    return a.workspace.id < b.workspace.id ? -1 : 1;
  });
  return entries;
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
