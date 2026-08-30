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
  /** Null for manually-added entries with no attention of their own. */
  attention: PriorityAttention | null;
  /** When `attention` became current; null on sessions predating the column. */
  attentionChangedAt: string | null;
}

/**
 * Attention older than this is history, not triage — it stays in the normal
 * groups but no longer floats into Priority. Also the implicit gate for
 * pre-migration sessions (null stamp = unknown age = stale), which keeps the
 * first launch after the migration from flooding the section with every
 * failed session ever.
 */
export const PRIORITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
}

/**
 * Fresh, undismissed attention per workspace — the signal behind both the
 * Priority section's placement and the attention chip on a row. Highest
 * severity wins; ties go to the most recently active session since that is the
 * one whose attention is being renewed.
 *
 * `archived` and `kept` workspaces are excluded (keeping is an explicit "I'm
 * done here"), and so is attention older than `PRIORITY_MAX_AGE_MS` or of
 * unknown age. Pinned workspaces are *not* excluded: a pin changes where a row
 * sits, not whether it needs you. Placement rules live in
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
    const changedAtMs = Date.parse(found.changedAt);
    if (!Number.isFinite(changedAtMs) || nowMs - changedAtMs > PRIORITY_MAX_AGE_MS) continue;
    if (isDismissed(workspace, found.changedAt)) continue;
    result.set(workspace.id, { attention: found.attention, changedAt: found.changedAt });
  }
  return result;
}

/**
 * Workspaces that need the user right now, most urgent first. `archived` and
 * `kept` workspaces are excluded — keeping is an explicit "I'm done here" —
 * and so is anything whose attention became current more than
 * `PRIORITY_MAX_AGE_MS` before `nowMs` (or whose age is unknown).
 * Ties within a severity sort oldest-waiting first (triage, not a feed).
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
    const manuallyAdded = Boolean(workspace.priorityAddedAt);
    if (!found && !manuallyAdded) continue;
    entries.push({
      workspace,
      // A manual add still shows real attention when there is fresh,
      // undismissed attention to show; otherwise it renders as a plain row.
      attention: found?.attention ?? null,
      attentionChangedAt: found?.changedAt ?? null
    });
  }

  entries.sort((a, b) => {
    const bySeverity =
      (b.attention ? severity(b.attention) : 0) - (a.attention ? severity(a.attention) : 0);
    if (bySeverity !== 0) return bySeverity;
    // Oldest waiting first; manual entries (no stamp) sort by add time.
    const aChanged = a.attentionChangedAt ?? a.workspace.priorityAddedAt ?? "";
    const bChanged = b.attentionChangedAt ?? b.workspace.priorityAddedAt ?? "";
    if (aChanged !== bChanged) return aChanged < bChanged ? -1 : 1;
    return a.workspace.id < b.workspace.id ? -1 : 1;
  });
  return entries;
}

/**
 * Attention-driven rows demote after the user has opened them and then left —
 * attention is an unread marker, and opening the session is reading it.
 * Working sessions stay: a live turn is still a priority reason. Purely
 * manual entries (no attention) stay until explicitly removed. Based on
 * `computeWorkspaceAttention` rather than `computePriorityEntries` so a
 * pinned workspace demotes too: a pin keeps the row out of the Priority
 * section, but its attention chip (the mobile list shows one) still has to
 * clear on read. A later attention change re-promotes the row either way.
 */
export function shouldDemoteOnLeave(
  workspace: WorkspaceSummary,
  sessions: SessionSummary[],
  nowMs: number
): boolean {
  if (isWorkspaceWorking(sessions, workspace.id)) return false;
  // A workspace mid-teardown is not triage. `computeWorkspaceAttention` keeps
  // these states (they still deserve a chip while the row is on screen), so
  // they are excluded here: leaving an archiving session would otherwise stamp
  // a dismissal that races the archive, and a write landing after the row is
  // gone surfaces a spurious "Could not remove the session from priority."
  if (workspace.state === "archiving" || workspace.state === "archive-failed") return false;
  return computeWorkspaceAttention([workspace], sessions, nowMs).has(workspace.id);
}
