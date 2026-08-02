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
  attention: PriorityAttention;
  /** When `attention` became current; null on sessions predating the column. */
  attentionChangedAt: string | null;
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

/**
 * Workspaces that need the user right now, most urgent first. `archived` and
 * `kept` workspaces are excluded — keeping is an explicit "I'm done here".
 * Ties within a severity sort oldest-waiting first (triage, not a feed).
 */
export function computePriorityEntries(
  workspaces: WorkspaceSummary[],
  sessions: SessionSummary[]
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
    if (workspace.state === "archived" || workspace.state === "kept") continue;
    const found = attentionByWorkspace.get(workspace.id);
    if (!found) continue;
    if (isDismissed(workspace, found.changedAt)) continue;
    entries.push({
      workspace,
      attention: found.attention,
      attentionChangedAt: found.changedAt
    });
  }

  entries.sort((a, b) => {
    const bySeverity = severity(b.attention) - severity(a.attention);
    if (bySeverity !== 0) return bySeverity;
    // Oldest waiting first; a null stamp (unknown age) sorts oldest.
    const aChanged = a.attentionChangedAt ?? "";
    const bChanged = b.attentionChangedAt ?? "";
    if (aChanged !== bChanged) return aChanged < bChanged ? -1 : 1;
    return a.workspace.id < b.workspace.id ? -1 : 1;
  });
  return entries;
}
