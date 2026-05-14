/**
 * Persistence layer for Argmax.
 *
 * `findSessionById` returns a `SessionSummary` whose `preferred` flag is
 * computed by `loadPreferredSessionIds`. That helper reads `ui_state` via
 * a primary-key range scan (`key >= 'preferred-attempt:' AND key <
 * 'preferred-attempt;'`), which uses the PK index regardless of the
 * `case_sensitive_like` pragma.
 *
 * Hot-path callers that don't need the preferred bit (e.g. callers that
 * just persisted the row) should use `findSessionByIdNoPreferred` below.
 * It's a single-row SELECT and never hits `ui_state`.
 */
import Database from "better-sqlite3";
import { logger } from "../../shared/logger.js";
import { getDatabasePath } from "../paths.js";
import { RecordNotFoundError } from "./errors.js";
import {
  deleteLearning,
  insertLearning,
  listLearnings,
  searchEvents,
  updateLearning,
  type InsertLearningInput
} from "./learnings.js";
import {
  getSessionCostSummary,
  insertUsageEvent,
  type InsertUsageEventInput
} from "./usage.js";
import { listGhPrForSession, upsertGhPr } from "./gh.js";
import {
  findPendingApproval,
  listApprovals,
  listPendingApprovals,
  persistApproval,
  resolveApproval,
  type FindPendingApprovalInput,
  type PersistApprovalInput
} from "./approvals.js";
import {
  checkpointRowToSummary,
  checkRowToRun,
  persistCheck,
  persistCheckpoint,
  updateCheck,
  type CheckRow,
  type CheckpointRow,
  type PersistCheckInput,
  type PersistCheckpointInput,
  type UpdateCheckInput
} from "./checks.js";
import {
  eventRowToTimelineEvent,
  listSessionEventsSince,
  persistRawOutput,
  persistTimelineEvent,
  rawOutputRowToProviderOutput,
  type EventRow,
  type PersistRawOutputInput,
  type PersistTimelineEventInput,
  type RawOutputRow,
  type SessionEventsSinceInput,
  type SessionEventsSinceResult
} from "./events.js";
import {
  findWorkspaceById,
  persistWorkspace,
  setWorkspacePinned,
  updateWorkspaceState,
  updateWorkspaceStatus,
  workspaceRowToSummary,
  type PersistWorkspaceInput,
  type WorkspaceRow,
  type WorkspaceStatusInput
} from "./workspaces.js";
import {
  findSessionById,
  loadPreferredSessionIds,
  persistSession,
  selectPreferredAttempt,
  sessionRowToSummary,
  updateSessionLastModelId,
  updateSessionModel,
  updateSessionProviderConversationId,
  updateSessionState,
  type PersistSessionInput,
  type SessionModelInput,
  type SessionRow,
  type SessionStateInput
} from "./sessions.js";
import { runMigrations } from "./migrations.js";
import { seedDemoData } from "./seed.js";
import { safeJsonParseArray } from "../../shared/safeJson.js";
import type {
  ApprovalRequest,
  Checkpoint,
  CheckRun,
  DashboardSnapshot,
  GhPrRecord,
  Learning,
  ProjectSettings,
  ProjectSummary,
  SessionCostSummary,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";

// Re-export from the dedicated submodules so existing consumers
// (`import { RecordNotFoundError, InsertUsageEventInput } from "./database.js"`)
// keep working without churning every callsite.
export { RecordNotFoundError } from "./errors.js";
export type { InsertLearningInput } from "./learnings.js";
export type { InsertUsageEventInput } from "./usage.js";
export type { FindPendingApprovalInput, PersistApprovalInput } from "./approvals.js";
export type { PersistCheckInput, PersistCheckpointInput, UpdateCheckInput } from "./checks.js";
export type {
  PersistRawOutputInput,
  PersistTimelineEventInput,
  SessionEventsSinceInput,
  SessionEventsSinceResult
} from "./events.js";
export type { PersistWorkspaceInput, WorkspaceStatusInput } from "./workspaces.js";
export type { PersistSessionInput, SessionModelInput, SessionStateInput } from "./sessions.js";

export interface PersistProjectInput {
  id: string;
  name: string;
  repoPath: string;
  currentBranch: string;
  defaultBranch: string | null;
  settings: ProjectSettings;
}

interface ProjectAggregateRow {
  id: string;
  name: string;
  repo_path: string;
  current_branch: string;
  default_branch: string | null;
  default_provider: ProjectSettings["defaultProvider"];
  default_model_label: string;
  worktree_location: string;
  setup_command: string;
  check_commands_json: string;
  updated_at: string | null;
  active_count: number | null;
  workspace_blocked: number | null;
  workspace_failed: number | null;
  workspace_complete: number | null;
  session_blocked: number | null;
  session_failed: number | null;
  session_review_ready: number | null;
  workspace_latest: string | null;
  session_latest: string | null;
}

interface BareProjectRow {
  id: string;
  name: string;
  repo_path: string;
  current_branch: string;
  default_branch: string | null;
  default_provider: ProjectSettings["defaultProvider"];
  default_model_label: string;
  worktree_location: string;
  setup_command: string;
  check_commands_json: string;
  updated_at: string;
}

export interface WorkspaceStatusInputFilter {
  workspaceIds?: string[];
}

const SESSION_EVENT_PAGE_LIMIT = 500;
const SESSION_RAW_OUTPUT_PAGE_LIMIT = 100;
/** Cap on dashboard rows per resource (workspaces, sessions, approvals, checks, checkpoints). */
const DASHBOARD_ROW_LIMIT = 200;
/** Dashboard timeline tail size and raw-output tail size. */
const DASHBOARD_EVENT_LIMIT = 500;
const DASHBOARD_RAW_OUTPUT_LIMIT = 100;
/** How often the prune timer fires (raw_outputs retention sweep). */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** SQLite datetime modifier matching PRUNE_INTERVAL_MS retention. */
const RAW_OUTPUT_RETENTION = "-7 days";

export type DashboardListSnapshot = Pick<
  DashboardSnapshot,
  "projects" | "workspaces" | "sessions" | "checks" | "checkpoints"
>;

export type WorkspaceStatusSnapshot = Pick<
  DashboardSnapshot,
  "workspaces" | "sessions" | "checks" | "checkpoints"
>;

export interface ArgmaxDatabase {
  connection: Database.Database;
  listProjects: () => ProjectSummary[];
  listDashboard: () => DashboardListSnapshot;
  listSessionEventsSince: (input: SessionEventsSinceInput) => SessionEventsSinceResult;
  listWorkspaceStatus: (input?: WorkspaceStatusInputFilter) => WorkspaceStatusSnapshot;
  listPendingApprovals: () => ApprovalRequest[];
  countAttention: () => { pendingApprovals: number; waitingSessions: number; total: number };
  listRunningSessionIds: () => string[];
  loadDashboard: () => DashboardSnapshot;
  persistProject: (input: PersistProjectInput) => ProjectSummary;
  updateProjectSettings: (projectId: string, settings: ProjectSettings) => ProjectSummary;
  updateProjectBranch: (projectId: string, branch: string) => ProjectSummary;
  getProject: (projectId: string) => ProjectSummary;
  findProjectById: (projectId: string) => ProjectSummary | null;
  findProjectByRepoPath: (repoPath: string) => ProjectSummary | null;
  getWorkspace: (workspaceId: string) => WorkspaceSummary;
  getSession: (sessionId: string) => SessionSummary;
  persistWorkspace: (input: PersistWorkspaceInput) => WorkspaceSummary;
  updateWorkspaceState: (workspaceId: string, state: WorkspaceSummary["state"]) => WorkspaceSummary;
  updateWorkspaceStatus: (workspaceId: string, status: WorkspaceStatusInput) => WorkspaceSummary;
  persistApproval: (input: PersistApprovalInput) => ApprovalRequest;
  findPendingApproval: (input: FindPendingApprovalInput) => ApprovalRequest | null;
  resolveApproval: (approvalId: string, status: Extract<ApprovalRequest["status"], "approved" | "rejected">) => ApprovalRequest;
  persistCheck: (input: PersistCheckInput) => CheckRun;
  updateCheck: (checkId: string, input: UpdateCheckInput) => CheckRun;
  persistCheckpoint: (input: PersistCheckpointInput) => Checkpoint;
  selectPreferredAttempt: (sessionId: string) => SessionSummary;
  persistSession: (input: PersistSessionInput) => SessionSummary;
  updateSessionModel: (sessionId: string, input: SessionModelInput) => SessionSummary;
  updateSessionProviderConversationId: (sessionId: string, providerConversationId: string) => SessionSummary;
  updateSessionState: (sessionId: string, input: SessionStateInput) => SessionSummary;
  persistTimelineEvent: (input: PersistTimelineEventInput) => TimelineEvent;
  persistRawOutput: (input: PersistRawOutputInput) => void;
  insertUsageEvent: (input: InsertUsageEventInput) => void;
  updateSessionLastModelId: (sessionId: string, modelId: string) => void;
  getSessionCostSummary: (sessionId: string) => SessionCostSummary;
  insertLearning: (input: InsertLearningInput) => Learning;
  listLearnings: (projectId: string, limit?: number) => Learning[];
  updateLearning: (input: { id: string; summary?: string; verified?: boolean }) => Learning;
  deleteLearning: (id: string) => void;
  searchEvents: (input: { query: string; limit?: number }) => Array<{
    sessionId: string;
    eventId: string;
    snippet: string;
    rank: number;
  }>;
  setWorkspacePinned: (workspaceId: string, pinned: boolean) => WorkspaceSummary;
  updateProjectRemote: (projectId: string, remote: { owner: string; name: string } | null) => void;
  getProjectRemote: (projectId: string) => { owner: string; name: string } | null;
  upsertGhPr: (input: GhPrRecord) => GhPrRecord;
  listGhPrForSession: (sessionId: string) => GhPrRecord[];
  /** Cancels the periodic raw_outputs prune timer. Call before close. */
  clearPruneInterval: () => void;
  /** Clears the prune timer and closes the underlying connection. Idempotent. */
  close: () => void;
}

export function createDatabase(databasePath = getDatabasePath(), options: { seed?: boolean } = {}): ArgmaxDatabase {
  const connection = new Database(databasePath);
  // Pragmas must be set before migrations run so the migration writes
  // themselves use the configured journal/durability/locking behavior.
  // - journal_mode = WAL: concurrent reader during writer, durability across
  //   crashes, sticky on the file (sidecar -wal/-shm files appear next to it).
  // - synchronous = NORMAL: balances fsync cost against durability for a
  //   single-user local app; combined with WAL, no data loss outside a power cut.
  // - busy_timeout = 5000: retry briefly when another connection holds the
  //   write lock (dev hot-reload, multi-window) instead of failing immediately.
  // foreign_keys is set per-connection inside runMigrations.
  connection.pragma("journal_mode = WAL");
  connection.pragma("synchronous = NORMAL");
  connection.pragma("busy_timeout = 5000");
  // wal_autocheckpoint = 1000: SQLite checkpoints WAL → main DB whenever the
  // log reaches 1000 pages (default), keeping the WAL file from growing
  // without bound during long-running sessions. Explicit so a future build
  // tweaking the global default doesn't silently change behavior. Diagnostics
  // surfaces this so an unhealthy WAL is visible without shell access.
  connection.pragma("wal_autocheckpoint = 1000");
  runMigrations(connection);
  // Default `seed` to false: the developer's existing local DB at
  // getDatabasePath() must not be repopulated with demo rows on every
  // launch. Test callers that need seeded data pass `{ seed: true }` explicitly.
  if (options.seed ?? false) {
    seedDemoData(connection);
  }

  // One-shot + daily prune of `raw_outputs` rows older than 7 days. The
  // dashboard read path slices the latest 100 rows; older rows are dead
  // weight and grow unboundedly without this.
  const pruneRawOutputs = (): void => {
    if (!connection.open) return;
    try {
      connection
        .prepare(`DELETE FROM raw_outputs WHERE created_at < datetime('now', '${RAW_OUTPUT_RETENTION}')`)
        .run();
    } catch (error) {
      logger.warn("database.prune", "pruneRawOutputs failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
  pruneRawOutputs();
  const pruneTimer: NodeJS.Timeout = setInterval(pruneRawOutputs, PRUNE_INTERVAL_MS);
  // Don't keep the event loop alive solely for the prune timer.
  if (typeof pruneTimer.unref === "function") {
    pruneTimer.unref();
  }

  return {
    connection,
    listProjects: () => listProjects(connection),
    listDashboard: () => listDashboard(connection),
    listSessionEventsSince: (input) => listSessionEventsSince(connection, input, SESSION_EVENT_PAGE_LIMIT, SESSION_RAW_OUTPUT_PAGE_LIMIT),
    listWorkspaceStatus: (input) => listWorkspaceStatus(connection, input),
    listPendingApprovals: () => listPendingApprovals(connection, DASHBOARD_ROW_LIMIT),
    countAttention: () => countAttention(connection),
    listRunningSessionIds: () => listRunningSessionIds(connection),
    loadDashboard: () => loadDashboard(connection),
    persistProject: (input) => persistProject(connection, input),
    updateProjectSettings: (projectId, settings) => updateProjectSettings(connection, projectId, settings),
    updateProjectBranch: (projectId, branch) => updateProjectBranch(connection, projectId, branch),
    getProject: (projectId) => requireProject(connection, projectId),
    findProjectById: (projectId) => findProjectById(connection, projectId),
    findProjectByRepoPath: (repoPath) => findProjectByRepoPath(connection, repoPath),
    getWorkspace: (workspaceId) => findWorkspaceById(connection, workspaceId),
    getSession: (sessionId) => findSessionById(connection, sessionId),
    persistWorkspace: (input) => persistWorkspace(connection, input),
    updateWorkspaceState: (workspaceId, state) => updateWorkspaceState(connection, workspaceId, state),
    updateWorkspaceStatus: (workspaceId, status) => updateWorkspaceStatus(connection, workspaceId, status),
    persistApproval: (input) => persistApproval(connection, input),
    findPendingApproval: (input) => findPendingApproval(connection, input),
    resolveApproval: (approvalId, status) => resolveApproval(connection, approvalId, status),
    persistCheck: (input) => persistCheck(connection, input),
    updateCheck: (checkId, input) => updateCheck(connection, checkId, input),
    persistCheckpoint: (input) => persistCheckpoint(connection, input),
    selectPreferredAttempt: (sessionId) => selectPreferredAttempt(connection, sessionId),
    persistSession: (input) => persistSession(connection, input),
    updateSessionModel: (sessionId, input) => updateSessionModel(connection, sessionId, input),
    updateSessionProviderConversationId: (sessionId, providerConversationId) =>
      updateSessionProviderConversationId(connection, sessionId, providerConversationId),
    updateSessionState: (sessionId, input) => updateSessionState(connection, sessionId, input),
    persistTimelineEvent: (input) => persistTimelineEvent(connection, input),
    persistRawOutput: (input) => persistRawOutput(connection, input),
    insertUsageEvent: (input) => insertUsageEvent(connection, input),
    updateSessionLastModelId: (sessionId, modelId) => updateSessionLastModelId(connection, sessionId, modelId),
    getSessionCostSummary: (sessionId) => getSessionCostSummary(connection, sessionId),
    insertLearning: (input) => insertLearning(connection, input),
    listLearnings: (projectId, limit) => listLearnings(connection, projectId, limit),
    updateLearning: (input) => updateLearning(connection, input),
    deleteLearning: (id) => deleteLearning(connection, id),
    searchEvents: (input) => searchEvents(connection, input.query, input.limit),
    setWorkspacePinned: (workspaceId, pinned) => setWorkspacePinned(connection, workspaceId, pinned),
    updateProjectRemote: (projectId, remote) => updateProjectRemote(connection, projectId, remote),
    getProjectRemote: (projectId) => getProjectRemote(connection, projectId),
    upsertGhPr: (input) => upsertGhPr(connection, input),
    listGhPrForSession: (sessionId) => listGhPrForSession(connection, sessionId),
    clearPruneInterval: () => clearInterval(pruneTimer),
    close: () => {
      clearInterval(pruneTimer);
      if (connection.open) {
        connection.close();
      }
    }
  };
}

function parseJsonArray(value: string, context = "database.parseJsonArray"): string[] {
  return safeJsonParseArray(value, (item): item is string => typeof item === "string", context);
}

function listProjects(connection: Database.Database): ProjectSummary[] {
  // Two LEFT JOIN subqueries — one over `workspaces`, one over `sessions
  // JOIN workspaces` — so workspace counts are not multiplied by the
  // number of sessions per workspace. Each subquery is grouped
  // independently and the planner can pick its own index.
  const rows = connection
    .prepare(
      `
        SELECT
          p.*,
          COALESCE(ws.active_count,         0) AS active_count,
          COALESCE(ws.workspace_blocked,    0) AS workspace_blocked,
          COALESCE(ws.workspace_failed,     0) AS workspace_failed,
          COALESCE(ws.workspace_complete,   0) AS workspace_complete,
          COALESCE(ss.session_blocked,      0) AS session_blocked,
          COALESCE(ss.session_failed,       0) AS session_failed,
          COALESCE(ss.session_review_ready, 0) AS session_review_ready,
          ws.workspace_latest               AS workspace_latest,
          ss.session_latest                 AS session_latest
        FROM projects p
        LEFT JOIN (
          SELECT
            project_id,
            SUM(CASE WHEN state IN ('created', 'running', 'waiting', 'blocked') THEN 1 ELSE 0 END) AS active_count,
            SUM(CASE WHEN state = 'blocked'  THEN 1 ELSE 0 END) AS workspace_blocked,
            SUM(CASE WHEN state = 'failed'   THEN 1 ELSE 0 END) AS workspace_failed,
            SUM(CASE WHEN state = 'complete' THEN 1 ELSE 0 END) AS workspace_complete,
            MAX(last_activity_at) AS workspace_latest
          FROM workspaces
          GROUP BY project_id
        ) ws ON ws.project_id = p.id
        LEFT JOIN (
          SELECT
            w.project_id AS project_id,
            SUM(CASE WHEN s.attention = 'blocked'      THEN 1 ELSE 0 END) AS session_blocked,
            SUM(CASE WHEN s.attention = 'failed'       THEN 1 ELSE 0 END) AS session_failed,
            SUM(CASE WHEN s.attention = 'review-ready' THEN 1 ELSE 0 END) AS session_review_ready,
            MAX(s.last_activity_at) AS session_latest
          FROM sessions s
          JOIN workspaces w ON w.id = s.workspace_id
          GROUP BY w.project_id
        ) ss ON ss.project_id = p.id
        ORDER BY COALESCE(ws.workspace_latest, ss.session_latest, p.updated_at) DESC
      `
    )
    .all() as ProjectAggregateRow[];

  return rows.map((row) => {
    const blocked = (row.workspace_blocked ?? 0) + (row.session_blocked ?? 0);
    const failed = (row.workspace_failed ?? 0) + (row.session_failed ?? 0);
    const reviewReady = (row.workspace_complete ?? 0) + (row.session_review_ready ?? 0);
    const latestActivityAt =
      maxNullableIso(row.workspace_latest, row.session_latest) ?? row.updated_at ?? null;
    return {
      id: row.id,
      name: row.name,
      repoPath: row.repo_path,
      currentBranch: row.current_branch,
      defaultBranch: row.default_branch,
      settings: {
        defaultProvider: row.default_provider,
        defaultModelLabel: row.default_model_label,
        worktreeLocation: row.worktree_location,
        setupCommand: row.setup_command,
        checkCommands: parseJsonArray(row.check_commands_json)
      },
      counts: {
        active: row.active_count ?? 0,
        blocked,
        failed,
        reviewReady
      },
      latestActivityAt
    };
  });
}

function maxNullableIso(...values: Array<string | null | undefined>): string | null {
  let max: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!max || value > max) max = value;
  }
  return max;
}

function persistProject(connection: Database.Database, input: PersistProjectInput): ProjectSummary {
  const timestamp = new Date().toISOString();
  connection
    .prepare(
      `
        INSERT INTO projects (
          id, name, repo_path, current_branch, default_branch, default_provider,
          default_model_label, worktree_location, setup_command, check_commands_json,
          ui_preferences_json, created_at, updated_at
        ) VALUES (
          @id, @name, @repoPath, @currentBranch, @defaultBranch, @defaultProvider,
          @defaultModelLabel, @worktreeLocation, @setupCommand, @checkCommandsJson,
          '{}', @createdAt, @updatedAt
        )
        ON CONFLICT(repo_path) DO UPDATE SET
          name = excluded.name,
          current_branch = excluded.current_branch,
          default_branch = excluded.default_branch,
          updated_at = excluded.updated_at
      `
    )
    .run({
      id: input.id,
      name: input.name,
      repoPath: input.repoPath,
      currentBranch: input.currentBranch,
      defaultBranch: input.defaultBranch,
      defaultProvider: input.settings.defaultProvider,
      defaultModelLabel: input.settings.defaultModelLabel,
      worktreeLocation: input.settings.worktreeLocation,
      setupCommand: input.settings.setupCommand,
      checkCommandsJson: JSON.stringify(input.settings.checkCommands),
      createdAt: timestamp,
      updatedAt: timestamp
    });

  return requireProjectByRepoPath(connection, input.repoPath);
}

function updateProjectSettings(
  connection: Database.Database,
  projectId: string,
  settings: ProjectSettings
): ProjectSummary {
  connection
    .prepare(
      `
        UPDATE projects
        SET
          default_provider = @defaultProvider,
          default_model_label = @defaultModelLabel,
          worktree_location = @worktreeLocation,
          setup_command = @setupCommand,
          check_commands_json = @checkCommandsJson,
          updated_at = @updatedAt
        WHERE id = @projectId
      `
    )
    .run({
      projectId,
      defaultProvider: settings.defaultProvider,
      defaultModelLabel: settings.defaultModelLabel,
      worktreeLocation: settings.worktreeLocation,
      setupCommand: settings.setupCommand,
      checkCommandsJson: JSON.stringify(settings.checkCommands),
      updatedAt: new Date().toISOString()
    });

  return requireProject(connection, projectId);
}

function updateProjectBranch(
  connection: Database.Database,
  projectId: string,
  branch: string
): ProjectSummary {
  connection
    .prepare("UPDATE projects SET current_branch = @branch, updated_at = @updatedAt WHERE id = @projectId")
    .run({ projectId, branch, updatedAt: new Date().toISOString() });
  return requireProject(connection, projectId);
}

/**
 * Lightweight single-row lookup by repoPath. Use this when you only need
 * the project's static fields (id, name, repo path, settings) and not the
 * dashboard aggregation counts. Returns `null` when no row matches —
 * callers that want to throw should use `requireProjectByRepoPath` (only
 * the persistProject post-write reuses that contract).
 */
function findProjectByRepoPath(connection: Database.Database, repoPath: string): ProjectSummary | null {
  const row = connection
    .prepare("SELECT * FROM projects WHERE repo_path = ?")
    .get(repoPath) as BareProjectRow | undefined;
  return row ? bareProjectRowToSummary(row) : null;
}

/**
 * Lightweight single-row lookup by project id. Returns `null` when the row
 * is missing. Counts default to zero on this path — fetch via `listProjects`
 * or `loadDashboard` if you need the aggregate counts.
 */
function findProjectById(connection: Database.Database, projectId: string): ProjectSummary | null {
  const row = connection
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as BareProjectRow | undefined;
  return row ? bareProjectRowToSummary(row) : null;
}

function requireProject(connection: Database.Database, projectId: string): ProjectSummary {
  const project = findProjectById(connection, projectId);
  if (!project) {
    throw new RecordNotFoundError("project", projectId);
  }
  return project;
}

function requireProjectByRepoPath(connection: Database.Database, repoPath: string): ProjectSummary {
  const project = findProjectByRepoPath(connection, repoPath);
  if (!project) {
    throw new Error(`Project was not persisted for repository: ${repoPath}`);
  }
  return project;
}

function bareProjectRowToSummary(row: BareProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    currentBranch: row.current_branch,
    defaultBranch: row.default_branch,
    settings: {
      defaultProvider: row.default_provider,
      defaultModelLabel: row.default_model_label,
      worktreeLocation: row.worktree_location,
      setupCommand: row.setup_command,
      checkCommands: parseJsonArray(row.check_commands_json)
    },
    counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
    latestActivityAt: row.updated_at
  };
}

function listDashboard(connection: Database.Database): DashboardListSnapshot {
  return {
    projects: listProjects(connection),
    ...listWorkspaceStatus(connection)
  };
}

function listWorkspaceStatus(
  connection: Database.Database,
  input?: WorkspaceStatusInputFilter
): WorkspaceStatusSnapshot {
  const preferredSessionIds = loadPreferredSessionIds(connection);
  const workspaceIds = input?.workspaceIds;
  const workspaceFilter = buildWorkspaceFilter(workspaceIds, "id");
  const sessionFilter = buildWorkspaceFilter(workspaceIds, "workspace_id");
  const checkFilter = buildWorkspaceFilter(workspaceIds, "workspace_id");
  const checkpointFilter = buildWorkspaceFilter(workspaceIds, "workspace_id");

  // Cap unfiltered dashboard reads at 200 rows each, sorted newest first. The
  // renderer's sidebar truncates further (7 per project) so older rows are
  // unreachable in the UI anyway; without this the read grows linearly with
  // local history. Filtered reads (explicit workspaceIds) still respect the
  // cap because passing > 200 IDs would not render either.
  const workspaces = (
    connection
      .prepare(`SELECT * FROM workspaces${workspaceFilter.where} ORDER BY last_activity_at DESC LIMIT ${DASHBOARD_ROW_LIMIT}`)
      .all(...workspaceFilter.params) as WorkspaceRow[]
  ).map((row) => workspaceRowToSummary(row));

  const sessions = (
    connection
      .prepare(`SELECT * FROM sessions${sessionFilter.where} ORDER BY last_activity_at DESC LIMIT ${DASHBOARD_ROW_LIMIT}`)
      .all(...sessionFilter.params) as SessionRow[]
  ).map((row) => sessionRowToSummary(row, preferredSessionIds.has(row.id)));

  const checks = (
    connection
      .prepare(`SELECT * FROM checks${checkFilter.where} ORDER BY started_at DESC LIMIT ${DASHBOARD_ROW_LIMIT}`)
      .all(...checkFilter.params) as CheckRow[]
  ).map(checkRowToRun);

  const checkpoints = (
    connection
      .prepare(`SELECT * FROM checkpoints${checkpointFilter.where} ORDER BY created_at DESC LIMIT ${DASHBOARD_ROW_LIMIT}`)
      .all(...checkpointFilter.params) as CheckpointRow[]
  ).map(checkpointRowToSummary);

  return {
    workspaces,
    sessions,
    checks,
    checkpoints
  };
}

function loadDashboard(connection: Database.Database): DashboardSnapshot {
  const dashboard = listDashboard(connection);

  const events = (
    connection.prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT ${DASHBOARD_EVENT_LIMIT}`).all() as EventRow[]
  ).map(eventRowToTimelineEvent);

  const rawOutputs = (
    connection.prepare(`SELECT * FROM raw_outputs ORDER BY created_at DESC LIMIT ${DASHBOARD_RAW_OUTPUT_LIMIT}`).all() as RawOutputRow[]
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

function listRunningSessionIds(connection: Database.Database): string[] {
  const rows = connection
    .prepare("SELECT id FROM sessions WHERE state = 'running'")
    .all() as { id: string }[];
  return rows.map((row) => row.id);
}

function countAttention(
  connection: Database.Database
): { pendingApprovals: number; waitingSessions: number; total: number } {
  const approvalsRow = connection
    .prepare("SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'")
    .get() as { count: number };
  const sessionsRow = connection
    .prepare("SELECT COUNT(*) AS count FROM sessions WHERE state = 'waiting'")
    .get() as { count: number };
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

  return {
    where: ` WHERE ${columnName} IN (${workspaceIds.map(() => "?").join(", ")})`,
    params: workspaceIds
  };
}

function updateProjectRemote(
  connection: Database.Database,
  projectId: string,
  remote: { owner: string; name: string } | null
): void {
  const result = connection
    .prepare(
      "UPDATE projects SET repo_remote_owner = ?, repo_remote_name = ?, updated_at = ? WHERE id = ?"
    )
    .run(remote?.owner ?? null, remote?.name ?? null, new Date().toISOString(), projectId);
  if (result.changes === 0) {
    throw new RecordNotFoundError("project", projectId);
  }
}

function getProjectRemote(
  connection: Database.Database,
  projectId: string
): { owner: string; name: string } | null {
  const row = connection
    .prepare(
      "SELECT repo_remote_owner AS owner, repo_remote_name AS name FROM projects WHERE id = ?"
    )
    .get(projectId) as { owner: string | null; name: string | null } | undefined;
  if (!row) {
    throw new RecordNotFoundError("project", projectId);
  }
  if (!row.owner || !row.name) return null;
  return { owner: row.owner, name: row.name };
}
