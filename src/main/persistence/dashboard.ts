import type Database from "better-sqlite3";
import { listApprovals } from "./approvals.js";
import { prepared } from "./preparedStatements.js";
import {
  checkRowToRun,
  checkpointRowToSummary,
  type CheckRow,
  type CheckpointRow
} from "./checks.js";
import {
  eventRowToTimelineEvent,
  rawOutputRowToProviderOutput,
  type EventRow,
  type RawOutputRow
} from "./events.js";
import { listProjects } from "./projects.js";
import { sessionRowToSummary, type SessionRow } from "./sessions.js";
import { workspaceRowToSummary, type WorkspaceRow } from "./workspaces.js";
import type { DashboardSnapshot } from "../../shared/types.js";

/** Cap on dashboard rows per resource (workspaces, sessions, approvals, checks, checkpoints). */
export const DASHBOARD_ROW_LIMIT = 200;
/** Dashboard timeline tail size. */
const DASHBOARD_EVENT_LIMIT = 500;
/** Dashboard raw-output tail size. */
const DASHBOARD_RAW_OUTPUT_LIMIT = 100;

export type DashboardListSnapshot = Pick<
  DashboardSnapshot,
  "projects" | "workspaces" | "sessions" | "checks" | "checkpoints"
>;

export type WorkspaceStatusSnapshot = Pick<
  DashboardSnapshot,
  "workspaces" | "sessions" | "checks" | "checkpoints"
>;

export interface WorkspaceStatusInputFilter {
  workspaceIds?: string[];
}

export function listDashboard(connection: Database.Database): DashboardListSnapshot {
  return {
    projects: listProjects(connection),
    ...listWorkspaceStatus(connection)
  };
}

export function listWorkspaceStatus(
  connection: Database.Database,
  input?: WorkspaceStatusInputFilter
): WorkspaceStatusSnapshot {
  // Batch the five reads in one transaction (ralph D2). sqlite implicitly
  // BEGIN/COMMITs per statement otherwise; a deferred transaction holds the
  // read snapshot consistent and amortizes the journaling overhead across
  // the slice queries.
  return connection.transaction((): WorkspaceStatusSnapshot => {
    const workspaceIds = input?.workspaceIds
      ? [...new Set(input.workspaceIds)].slice(0, DASHBOARD_ROW_LIMIT)
      : undefined;
    const workspaceFilter = buildWorkspaceFilter(workspaceIds, "id");
    const sessionFilter = buildWorkspaceFilter(workspaceIds, "workspace_id");
    const checkFilter = buildWorkspaceFilter(workspaceIds, "workspace_id");
    const checkpointFilter = buildWorkspaceFilter(workspaceIds, "workspace_id");

    // Cap unfiltered dashboard reads at 200 rows each, sorted newest first.
    // Renderer's sidebar truncates further (7 per project) so older rows are
    // unreachable in the UI anyway; without this the read grows linearly with
    // local history. Filtered reads (explicit workspaceIds) still respect the
    // cap because passing > 200 IDs would not render either.
    const workspaces = (
      prepared(
        connection,
        `SELECT * FROM workspaces${workspaceFilter.where} ORDER BY last_activity_at DESC LIMIT ${DASHBOARD_ROW_LIMIT}`
      ).all(...workspaceFilter.params) as WorkspaceRow[]
    ).map((row) => workspaceRowToSummary(row));

    // Sessions are pulled from two overlapping sets so the snapshot can never
    // surface a workspace whose session is missing:
    //   A. Top DASHBOARD_ROW_LIMIT sessions by activity (existing behavior —
    //      preserves multiple sessions per workspace when they're recent).
    //   B. The latest session for each workspace in the top-DASHBOARD_ROW_LIMIT
    //      workspace set (gap-filler — covers the cap-desync where a workspace
    //      stays in the workspace top-N but its session has dropped below the
    //      session top-N).
    // Without B, a click on an older terminal-state workspace in the sidebar
    // can silently fail because the renderer's .find(workspaceId) returns
    // undefined. The NOT EXISTS clause keeps B at one row per workspace
    // (latest by last_activity_at, tiebreak by id). Total row count is bounded
    // by 2 * DASHBOARD_ROW_LIMIT.
    const sessions = (
      prepared(
        connection,
        `
          SELECT outer_s.*
          FROM sessions outer_s
          WHERE outer_s.id IN (
              SELECT id FROM sessions${sessionFilter.where}
              ORDER BY last_activity_at DESC
              LIMIT ${DASHBOARD_ROW_LIMIT}
            )
            OR (
              outer_s.workspace_id IN (
                SELECT id FROM workspaces${workspaceFilter.where}
                ORDER BY last_activity_at DESC
                LIMIT ${DASHBOARD_ROW_LIMIT}
              )
              AND NOT EXISTS (
                SELECT 1 FROM sessions s2
                WHERE s2.workspace_id = outer_s.workspace_id
                  AND (
                    s2.last_activity_at > outer_s.last_activity_at
                    OR (s2.last_activity_at = outer_s.last_activity_at AND s2.id > outer_s.id)
                  )
              )
            )
          ORDER BY outer_s.last_activity_at DESC
        `
      ).all(...sessionFilter.params, ...workspaceFilter.params) as SessionRow[]
    ).map((row) => sessionRowToSummary(row));

    const checks = (
      prepared(
        connection,
        `SELECT * FROM checks${checkFilter.where} ORDER BY started_at DESC LIMIT ${DASHBOARD_ROW_LIMIT}`
      ).all(...checkFilter.params) as CheckRow[]
    ).map(checkRowToRun);

    const checkpoints = (
      prepared(
        connection,
        `SELECT * FROM checkpoints${checkpointFilter.where} ORDER BY created_at DESC LIMIT ${DASHBOARD_ROW_LIMIT}`
      ).all(...checkpointFilter.params) as CheckpointRow[]
    ).map(checkpointRowToSummary);

    return {
      workspaces,
      sessions,
      checks,
      checkpoints
    };
  })();
}

export function loadDashboard(connection: Database.Database): DashboardSnapshot {
  const dashboard = listDashboard(connection);

  const events = (
    prepared(
      connection,
      `SELECT rowid AS row_cursor, * FROM events ORDER BY rowid DESC LIMIT ${DASHBOARD_EVENT_LIMIT}`
    ).all() as EventRow[]
  ).map(eventRowToTimelineEvent);

  const rawOutputs = (
    prepared(
      connection,
      `SELECT rowid AS row_cursor, * FROM raw_outputs ORDER BY rowid DESC LIMIT ${DASHBOARD_RAW_OUTPUT_LIMIT}`
    ).all() as RawOutputRow[]
  ).map(rawOutputRowToProviderOutput);

  // Cap dashboard reads at 200 rows for approvals/checks/checkpoints.
  // Older rows remain in storage; pagination ships separately via dedicated
  // handlers when needed.
  const approvals = listApprovals(connection, DASHBOARD_ROW_LIMIT);

  return {
    ...dashboard,
    events,
    rawOutputs,
    approvals
  };
}

export function listRunningSessionIds(connection: Database.Database): string[] {
  const rows = prepared(
    connection,
    "SELECT id FROM sessions WHERE state = 'running'"
  ).all() as { id: string }[];
  return rows.map((row) => row.id);
}

export function countAttention(
  connection: Database.Database
): { pendingApprovals: number; waitingSessions: number; total: number } {
  const approvalsRow = prepared(
    connection,
    "SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'"
  ).get() as { count: number };
  const sessionsRow = prepared(
    connection,
    "SELECT COUNT(*) AS count FROM sessions WHERE state = 'waiting'"
  ).get() as { count: number };
  const pendingApprovals = approvalsRow.count;
  const waitingSessions = sessionsRow.count;
  return {
    pendingApprovals,
    waitingSessions,
    total: pendingApprovals + waitingSessions
  };
}

function buildWorkspaceFilter(
  workspaceIds: string[] | undefined,
  columnName: "id" | "workspace_id"
): { where: string; params: string[] } {
  if (!workspaceIds || workspaceIds.length === 0) {
    return { where: "", params: [] };
  }
  // Serialize the IDs through json_each(?) instead of expanding to N
  // placeholders. Without this, every distinct workspaceIds.length produces
  // a different SQL string and therefore a different `prepared()` cache
  // entry — the cache grows unbounded as filter sizes vary across a long-
  // running session. (audit-2026-05-17 M4)
  return {
    where: ` WHERE ${columnName} IN (SELECT value FROM json_each(?))`,
    params: [JSON.stringify(workspaceIds)]
  };
}
