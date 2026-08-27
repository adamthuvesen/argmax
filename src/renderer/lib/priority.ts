import type { AttentionState, SessionSummary, WorkspaceSummary } from "../../shared/types.js";

/** Attention values that earn a workspace a spot in the Priority section. */
export type PriorityAttention = Exclude<AttentionState, "normal">;

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
  // Highest-severity attention per workspace; ties go to the most recently
  // active session since that is the one whose attention is being renewed.
  const attentionByWorkspace = new Map<string, { attention: PriorityAttention; changedAt: string | null; lastActivityAt: string }>();
  for (const session of sessions) {
    const rank = severity(session.attention);
    if (rank === 0) continue;
    const current = attentionByWorkspace.get(session.workspaceId);
    if (
      current &&
      (severity(current.attention) > rank ||
        (severity(current.attention) === rank && current.lastActivityAt >= session.lastActivityAt))
    ) {
      continue;
    }
    attentionByWorkspace.set(session.workspaceId, {
      attention: session.attention as PriorityAttention,
      changedAt: session.attentionChangedAt ?? null,
      lastActivityAt: session.lastActivityAt
    });
  }

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
    const attentionQualifies = (() => {
      if (!found || found.changedAt === null) return false;
      const changedAtMs = Date.parse(found.changedAt);
      if (!Number.isFinite(changedAtMs) || nowMs - changedAtMs > PRIORITY_MAX_AGE_MS) return false;
      return !isDismissed(workspace, found.changedAt);
    })();
    const manuallyAdded = Boolean(workspace.priorityAddedAt);
    if (!attentionQualifies && !manuallyAdded) continue;
    entries.push({
      workspace,
      // A manual add still shows real attention when there is fresh,
      // undismissed attention to show; otherwise it renders as a plain row.
      attention: attentionQualifies && found ? found.attention : null,
      attentionChangedAt: attentionQualifies && found ? found.changedAt : null
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
