import type Database from "better-sqlite3";
import type { GhCheckState, GhPrRecord } from "../../shared/types.js";

/**
 * Upsert the GitHub PR row for a session. The (session_id, pr_number) tuple
 * is the natural key — a single session may have multiple PRs (rebases, etc.)
 * and we want to track the latest head SHA + check state per PR.
 */
export function upsertGhPr(connection: Database.Database, input: GhPrRecord): GhPrRecord {
  connection
    .prepare(
      `INSERT INTO gh_pr (session_id, pr_number, head_sha, last_seen_check_state, updated_at)
       VALUES (@sessionId, @prNumber, @headSha, @lastSeenCheckState, @updatedAt)
       ON CONFLICT(session_id, pr_number) DO UPDATE SET
         head_sha = excluded.head_sha,
         last_seen_check_state = excluded.last_seen_check_state,
         updated_at = excluded.updated_at`
    )
    .run({
      sessionId: input.sessionId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      lastSeenCheckState: input.lastSeenCheckState,
      updatedAt: input.updatedAt
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
              updated_at AS updatedAt
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
  }>;
  return rows;
}
