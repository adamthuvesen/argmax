import type Database from "better-sqlite3";
import type { GhCheckState, GhPrRecord, GhPrState } from "../../shared/types.js";

/**
 * Upsert the GitHub PR row for a session. The (session_id, pr_number) tuple
 * is the natural key — a single session may have multiple PRs (rebases, etc.)
 * and we want to track the latest head SHA + check state per PR.
 */
export function upsertGhPr(connection: Database.Database, input: GhPrRecord): GhPrRecord {
  connection
    .prepare(
      `INSERT INTO gh_pr (session_id, pr_number, head_sha, last_seen_check_state, updated_at, pr_state)
       VALUES (@sessionId, @prNumber, @headSha, @lastSeenCheckState, @updatedAt, @prState)
       ON CONFLICT(session_id, pr_number) DO UPDATE SET
         head_sha = excluded.head_sha,
         last_seen_check_state = excluded.last_seen_check_state,
         updated_at = excluded.updated_at,
         pr_state = excluded.pr_state`
    )
    .run({
      sessionId: input.sessionId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      lastSeenCheckState: input.lastSeenCheckState,
      updatedAt: input.updatedAt,
      prState: input.prState ?? null
    });
  return input;
}

export function listGhPrForSession(connection: Database.Database, sessionId: string): GhPrRecord[] {
  const rows = connection
    .prepare(
      `SELECT session_id AS sessionId,
              pr_number AS prNumber,
              head_sha AS headSha,
              last_seen_check_state AS lastSeenCheckState,
              updated_at AS updatedAt,
              pr_state AS prState,
              notified_at AS notifiedAt
       FROM gh_pr
       WHERE session_id = ?
       ORDER BY pr_number ASC`
    )
    .all(sessionId) as Array<{
    sessionId: string;
    prNumber: number;
    headSha: string;
    lastSeenCheckState: GhCheckState;
    updatedAt: string;
    prState: GhPrState | null;
    notifiedAt: string | null;
  }>;
  return rows;
}

/**
 * Returns session IDs that have at least one open PR row (or no row at all,
 * which the union with running-sessions handles upstream). Used by the gh
 * poller to skip sessions whose PRs are merged/closed and don't need polling
 * anymore. (audit-2026-05-17 H5)
 */
export function listOpenGhPrSessionIds(connection: Database.Database): string[] {
  const rows = connection
    .prepare(
      `SELECT DISTINCT session_id AS id
       FROM gh_pr
       WHERE pr_state IS NULL OR pr_state = 'OPEN'`
    )
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Stamp the notified_at column when a failure follow-up has fired for this
 * (session_id, pr_number) so a subsequent poll dedups even if the in-memory
 * `queued` set has been cleared (e.g. app restart). (audit-2026-05-17 L9)
 */
export function markGhPrNotified(
  connection: Database.Database,
  sessionId: string,
  prNumber: number,
  headSha: string,
  notifiedAt: string
): void {
  connection
    .prepare(
      `UPDATE gh_pr
       SET notified_at = ?
       WHERE session_id = ? AND pr_number = ? AND head_sha = ?`
    )
    .run(notifiedAt, sessionId, prNumber, headSha);
}
