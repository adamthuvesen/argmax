import { randomUUID } from "node:crypto";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { DashboardDelta } from "../../shared/types.js";
import { RecordNotFoundError } from "../persistence/errors.js";
import { computeSessionAttention } from "../sessions/sessionAttention.js";

/**
 * Reconcile sessions that the database still marks `running` but for which no
 * live handle exists. Intended to run exactly once at app boot — any row in
 * this state at startup was abandoned by a previous process (crash, kill,
 * power loss). Each surviving row transitions to `cancelled` with a synthetic
 * `session.recovered-from-crash` timeline event so users see why a session
 * they expected to be live is no longer running.
 *
 * Publishes one consolidated `DashboardDelta` covering every recovered row
 * (or none, if there was nothing to recover). A row that has been deleted
 * mid-recovery (workspace archived CASCADE) is skipped silently rather than
 * crashing the boot path.
 */
export function recoverOrphanedSessions(
  database: ArgmaxDatabase,
  publishDashboardDelta: (delta: DashboardDelta) => void
): { recoveredCount: number } {
  const ids = database.listRunningSessionIds();
  if (ids.length === 0) {
    return { recoveredCount: 0 };
  }
  const completedAt = new Date().toISOString();
  const recoveredSessions = [];
  const recoveredWorkspaces = [];
  const recoveryEvents = [];
  for (const sessionId of ids) {
    try {
      const session = database.updateSessionState(sessionId, {
        state: "cancelled",
        attention: computeSessionAttention({ state: "cancelled" }),
        completedAt,
        lastActivityAt: completedAt
      });
      recoveredSessions.push(session);
      const workspace = database.updateWorkspaceState(session.workspaceId, "cancelled");
      recoveredWorkspaces.push(workspace);
      const event = database.persistTimelineEvent({
        id: randomUUID(),
        sessionId,
        type: "session.recovered-from-crash",
        message: "Argmax restarted while this session was still running; marking as cancelled.",
        payload: {},
        createdAt: completedAt
      });
      recoveryEvents.push(event);
    } catch (error) {
      if (error instanceof RecordNotFoundError) continue;
      throw error;
    }
  }
  if (recoveredSessions.length > 0) {
    publishDashboardDelta({
      projects: database.listProjects(),
      workspaces: recoveredWorkspaces,
      sessions: recoveredSessions,
      events: recoveryEvents
    });
  }
  return { recoveredCount: recoveredSessions.length };
}
