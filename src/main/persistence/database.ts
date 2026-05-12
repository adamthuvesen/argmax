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
import { getDatabasePath } from "../paths.js";
import { runMigrations } from "./migrations.js";
import { seedDemoData } from "./seed.js";
import { safeJsonParseArray, safeJsonParseRecord } from "../../shared/safeJson.js";
import type {
  ApprovalRequest,
  Checkpoint,
  CheckRun,
  DashboardSnapshot,
  ProjectSettings,
  ProjectSummary,
  RawProviderOutput,
  SessionCostSummary,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import type { ReasoningEffort, UsageCounts } from "../../shared/providerModels.js";

/**
 * Thrown when a row lookup fails because the row no longer exists. Callers
 * that race against deletion (e.g. async event handlers writing to a session
 * that was just cancelled) can catch this specifically; everything else is
 * a real fault and should propagate.
 */
export class RecordNotFoundError extends Error {
  constructor(
    readonly kind: "session" | "workspace" | "project" | "checkpoint" | "check" | "approval",
    readonly id: string
  ) {
    super(`${kind} not found: ${id}`);
    this.name = "RecordNotFoundError";
  }
}

export interface PersistProjectInput {
  id: string;
  name: string;
  repoPath: string;
  currentBranch: string;
  defaultBranch: string | null;
  settings: ProjectSettings;
}

export interface PersistWorkspaceInput {
  id: string;
  projectId: string;
  taskLabel: string;
  branch: string;
  baseRef: string;
  path: string;
  state: WorkspaceSummary["state"];
  sharedWorkspace: boolean;
  dirty: boolean;
  changedFiles: number;
}

export interface WorkspaceStatusInput {
  branch: string;
  dirty: boolean;
  changedFiles: number;
  lastActivityAt?: string;
}

export interface PersistSessionInput {
  id: string;
  workspaceId: string;
  provider: SessionSummary["provider"];
  modelLabel: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  prompt: string;
  state: SessionSummary["state"];
  attention: SessionSummary["attention"];
}

export interface SessionModelInput {
  modelLabel: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export interface SessionStateInput {
  state: SessionSummary["state"];
  attention: SessionSummary["attention"];
  completedAt?: string | null;
  lastActivityAt?: string;
}

export interface PersistTimelineEventInput {
  id: string;
  sessionId: string;
  type: TimelineEvent["type"];
  message: string;
  payload: Record<string, unknown>;
  createdAt?: string;
  /**
   * Optional usage sidecar. Not persisted to the events row; consumed by
   * the provider session service to drive `insertUsageEvent`.
   */
  usage?: {
    modelId: string;
    tokens: UsageCounts;
    costUsd: number;
    eventId?: string;
  };
}

export interface PersistRawOutputInput {
  id: string;
  sessionId: string;
  stream: "stdout" | "stderr" | "pty" | "system";
  content: string;
  createdAt?: string;
}

export interface PersistApprovalInput {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  provider: ApprovalRequest["provider"];
  riskLevel: ApprovalRequest["riskLevel"];
  status: ApprovalRequest["status"];
  createdAt?: string;
}

export interface PersistCheckInput {
  id: string;
  workspaceId: string;
  command: string;
  status: CheckRun["status"];
  startedAt?: string;
}

export interface UpdateCheckInput {
  status: CheckRun["status"];
  exitCode: number | null;
  summary: string | null;
  completedAt?: string | null;
}

export interface PersistCheckpointInput {
  id: string;
  workspaceId: string;
  label: string;
  branch: string;
  gitRef: string | null;
  patchPath: string | null;
  createdAt?: string;
}

export interface InsertUsageEventInput {
  sessionId: string;
  eventId?: string;
  modelId: string;
  tokens: UsageCounts;
  costUsd: number;
  createdAt?: number;
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

interface WorkspaceRow {
  id: string;
  project_id: string;
  task_label: string;
  branch: string;
  base_ref: string;
  path: string;
  state: WorkspaceSummary["state"];
  shared_workspace: number;
  dirty: number;
  changed_files: number;
  last_activity_at: string;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  provider: SessionSummary["provider"];
  model_label: string;
  model_id: string | null;
  reasoning_effort: ReasoningEffort | null;
  provider_conversation_id: string | null;
  prompt: string;
  state: SessionSummary["state"];
  attention: SessionSummary["attention"];
  started_at: string;
  completed_at: string | null;
  last_activity_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

interface EventRow {
  row_cursor?: number;
  id: string;
  session_id: string;
  type: TimelineEvent["type"];
  message: string;
  payload_json: string;
  created_at: string;
}

interface RawOutputRow {
  row_cursor?: number;
  id: string;
  session_id: string;
  stream: RawProviderOutput["stream"];
  content: string;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  session_id: string;
  command: string;
  cwd: string;
  provider: ApprovalRequest["provider"];
  risk_level: ApprovalRequest["riskLevel"];
  status: ApprovalRequest["status"];
  created_at: string;
  resolved_at: string | null;
}

interface CheckRow {
  id: string;
  workspace_id: string;
  command: string;
  status: CheckRun["status"];
  exit_code: number | null;
  summary: string | null;
  started_at: string;
  completed_at: string | null;
}

interface CheckpointRow {
  id: string;
  workspace_id: string;
  label: string;
  branch: string;
  git_ref: string | null;
  patch_path: string | null;
  created_at: string;
}

export interface FindPendingApprovalInput {
  sessionId: string;
  command: string;
  cwd: string;
  provider: ApprovalRequest["provider"];
}

export interface SessionEventsSinceInput {
  sessionId: string;
  eventCursor?: number;
  rawOutputCursor?: number;
}

export interface SessionEventsSinceResult {
  events: TimelineEvent[];
  rawOutputs: RawProviderOutput[];
  eventCursor: number;
  rawOutputCursor: number;
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
  getSessionCostSummary: (sessionId: string) => SessionCostSummary;
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
      console.warn("database.pruneRawOutputs.failed", {
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
    listSessionEventsSince: (input) => listSessionEventsSince(connection, input),
    listWorkspaceStatus: (input) => listWorkspaceStatus(connection, input),
    listPendingApprovals: () => listPendingApprovals(connection),
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
    getSessionCostSummary: (sessionId) => getSessionCostSummary(connection, sessionId),
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

function parseJsonRecord(value: string, context = "database.parseJsonRecord"): Record<string, unknown> {
  return safeJsonParseRecord(value, context);
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

function persistWorkspace(connection: Database.Database, input: PersistWorkspaceInput): WorkspaceSummary {
  const timestamp = new Date().toISOString();
  connection
    .prepare(
      `
        INSERT INTO workspaces (
          id, project_id, task_label, branch, base_ref, path, state, shared_workspace,
          dirty, changed_files, last_activity_at, created_at, updated_at
        ) VALUES (
          @id, @projectId, @taskLabel, @branch, @baseRef, @path, @state, @sharedWorkspace,
          @dirty, @changedFiles, @lastActivityAt, @createdAt, @updatedAt
        )
      `
    )
    .run({
      id: input.id,
      projectId: input.projectId,
      taskLabel: input.taskLabel,
      branch: input.branch,
      baseRef: input.baseRef,
      path: input.path,
      state: input.state,
      sharedWorkspace: input.sharedWorkspace ? 1 : 0,
      dirty: input.dirty ? 1 : 0,
      changedFiles: input.changedFiles,
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    });

  return findWorkspaceById(connection, input.id);
}

function updateWorkspaceState(
  connection: Database.Database,
  workspaceId: string,
  state: WorkspaceSummary["state"]
): WorkspaceSummary {
  const timestamp = new Date().toISOString();
  connection
    .prepare("UPDATE workspaces SET state = ?, last_activity_at = ?, updated_at = ? WHERE id = ?")
    .run(state, timestamp, timestamp, workspaceId);

  return findWorkspaceById(connection, workspaceId);
}

function updateWorkspaceStatus(
  connection: Database.Database,
  workspaceId: string,
  status: WorkspaceStatusInput
): WorkspaceSummary {
  const timestamp = status.lastActivityAt ?? new Date().toISOString();
  connection
    .prepare(
      `
        UPDATE workspaces
        SET branch = ?, dirty = ?, changed_files = ?, last_activity_at = ?, updated_at = ?
        WHERE id = ?
      `
    )
    .run(status.branch, status.dirty ? 1 : 0, status.changedFiles, timestamp, timestamp, workspaceId);

  return findWorkspaceById(connection, workspaceId);
}

function persistSession(connection: Database.Database, input: PersistSessionInput): SessionSummary {
  const timestamp = new Date().toISOString();
  connection
    .prepare(
      `
        INSERT INTO sessions (
          id, workspace_id, provider, model_label, model_id, reasoning_effort, provider_conversation_id, prompt, state, attention,
          started_at, completed_at, last_activity_at
        ) VALUES (
          @id, @workspaceId, @provider, @modelLabel, @modelId, @reasoningEffort, NULL, @prompt, @state, @attention,
          @startedAt, NULL, @lastActivityAt
        )
      `
    )
    .run({
      id: input.id,
      workspaceId: input.workspaceId,
      provider: input.provider,
      modelLabel: input.modelLabel,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort ?? null,
      prompt: input.prompt,
      state: input.state,
      attention: input.attention,
      startedAt: timestamp,
      lastActivityAt: timestamp
    });

  // Just-persisted row: no need to scan ui_state for the preferred bit.
  // The row is brand new, so `preferred` is necessarily `false` here.
  // (selectPreferredAttempt is the only writer to ui_state and it has
  // its own re-read path.)
  return findSessionByIdNoPreferred(connection, input.id);
}

function updateSessionModel(
  connection: Database.Database,
  sessionId: string,
  input: SessionModelInput
): SessionSummary {
  const timestamp = new Date().toISOString();
  connection
    .prepare(
      `
        UPDATE sessions
        SET model_label = ?, model_id = ?, reasoning_effort = ?, last_activity_at = ?
        WHERE id = ?
      `
    )
    .run(input.modelLabel, input.modelId, input.reasoningEffort ?? null, timestamp, sessionId);

  return findSessionByIdNoPreferred(connection, sessionId);
}

function updateSessionState(
  connection: Database.Database,
  sessionId: string,
  input: SessionStateInput
): SessionSummary {
  const timestamp = input.lastActivityAt ?? new Date().toISOString();
  connection
    .prepare(
      `
        UPDATE sessions
        SET state = ?, attention = ?, completed_at = ?, last_activity_at = ?
        WHERE id = ?
      `
    )
    .run(input.state, input.attention, input.completedAt ?? null, timestamp, sessionId);

  // The preferred bit is decoupled from session state; reuse the
  // NoPreferred fast path. If a caller specifically needs the preferred
  // flag after a state update they should call findSessionById/getSession.
  return findSessionByIdNoPreferred(connection, sessionId);
}

function updateSessionProviderConversationId(
  connection: Database.Database,
  sessionId: string,
  providerConversationId: string
): SessionSummary {
  const timestamp = new Date().toISOString();
  connection
    .prepare("UPDATE sessions SET provider_conversation_id = ?, last_activity_at = ? WHERE id = ?")
    .run(providerConversationId, timestamp, sessionId);

  return findSessionByIdNoPreferred(connection, sessionId);
}

function persistTimelineEvent(connection: Database.Database, input: PersistTimelineEventInput): TimelineEvent {
  const createdAt = input.createdAt ?? new Date().toISOString();
  connection
    .prepare(
      `
        INSERT INTO events (id, session_id, type, message, payload_json, created_at)
        VALUES (@id, @sessionId, @type, @message, @payloadJson, @createdAt)
      `
    )
    .run({
      id: input.id,
      sessionId: input.sessionId,
      type: input.type,
      message: input.message,
      payloadJson: JSON.stringify(input.payload),
      createdAt
    });

  return {
    id: input.id,
    sessionId: input.sessionId,
    type: input.type,
    message: input.message,
    payload: input.payload,
    createdAt
  };
}

function persistRawOutput(connection: Database.Database, input: PersistRawOutputInput): void {
  connection
    .prepare(
      `
        INSERT INTO raw_outputs (id, session_id, stream, content, created_at)
        VALUES (@id, @sessionId, @stream, @content, @createdAt)
      `
    )
    .run({
      id: input.id,
      sessionId: input.sessionId,
      stream: input.stream,
      content: input.content,
      createdAt: input.createdAt ?? new Date().toISOString()
    });
}

function persistApproval(connection: Database.Database, input: PersistApprovalInput): ApprovalRequest {
  const createdAt = input.createdAt ?? new Date().toISOString();
  connection
    .prepare(
      `
        INSERT INTO approvals (id, session_id, command, cwd, provider, risk_level, status, created_at, resolved_at)
        VALUES (@id, @sessionId, @command, @cwd, @provider, @riskLevel, @status, @createdAt, NULL)
      `
    )
    .run({
      id: input.id,
      sessionId: input.sessionId,
      command: input.command,
      cwd: input.cwd,
      provider: input.provider,
      riskLevel: input.riskLevel,
      status: input.status,
      createdAt
    });

  return findApprovalById(connection, input.id);
}

function findPendingApproval(
  connection: Database.Database,
  input: FindPendingApprovalInput
): ApprovalRequest | null {
  const row = connection
    .prepare(
      `
        SELECT * FROM approvals
        WHERE session_id = ? AND command = ? AND cwd = ? AND provider = ? AND status = 'pending'
        LIMIT 1
      `
    )
    .get(input.sessionId, input.command, input.cwd, input.provider) as ApprovalRow | undefined;
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    command: row.command,
    cwd: row.cwd,
    provider: row.provider,
    riskLevel: row.risk_level,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}

function resolveApproval(
  connection: Database.Database,
  approvalId: string,
  status: Extract<ApprovalRequest["status"], "approved" | "rejected">
): ApprovalRequest {
  connection
    .prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), approvalId);

  return findApprovalById(connection, approvalId);
}

function persistCheck(connection: Database.Database, input: PersistCheckInput): CheckRun {
  const startedAt = input.startedAt ?? new Date().toISOString();
  connection
    .prepare(
      `
        INSERT INTO checks (id, workspace_id, command, status, exit_code, summary, started_at, completed_at)
        VALUES (@id, @workspaceId, @command, @status, NULL, NULL, @startedAt, NULL)
      `
    )
    .run({
      id: input.id,
      workspaceId: input.workspaceId,
      command: input.command,
      status: input.status,
      startedAt
    });

  return findCheckById(connection, input.id);
}

function updateCheck(connection: Database.Database, checkId: string, input: UpdateCheckInput): CheckRun {
  connection
    .prepare(
      `
        UPDATE checks
        SET status = ?, exit_code = ?, summary = ?, completed_at = ?
        WHERE id = ?
      `
    )
    .run(input.status, input.exitCode, input.summary, input.completedAt ?? new Date().toISOString(), checkId);

  return findCheckById(connection, checkId);
}

function persistCheckpoint(connection: Database.Database, input: PersistCheckpointInput): Checkpoint {
  const createdAt = input.createdAt ?? new Date().toISOString();
  connection
    .prepare(
      `
        INSERT INTO checkpoints (id, workspace_id, label, branch, git_ref, patch_path, created_at)
        VALUES (@id, @workspaceId, @label, @branch, @gitRef, @patchPath, @createdAt)
      `
    )
    .run({
      id: input.id,
      workspaceId: input.workspaceId,
      label: input.label,
      branch: input.branch,
      gitRef: input.gitRef,
      patchPath: input.patchPath,
      createdAt
    });

  return findCheckpointById(connection, input.id);
}

function findWorkspaceById(connection: Database.Database, workspaceId: string): WorkspaceSummary {
  const row = connection.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as WorkspaceRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("workspace", workspaceId);
  }

  return workspaceRowToSummary(row);
}

function workspaceRowToSummary(row: WorkspaceRow): WorkspaceSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskLabel: row.task_label,
    branch: row.branch,
    baseRef: row.base_ref,
    path: row.path,
    state: row.state,
    // Strict equality on the 0/1 tinyint column. The v3 migration adds
    // CHECK (col IN (0,1)) but historic rows might still hold 2 — refuse
    // to coerce a stray value into `true`.
    sharedWorkspace: row.shared_workspace === 1,
    dirty: row.dirty === 1,
    changedFiles: row.changed_files,
    lastActivityAt: row.last_activity_at
  };
}

function findCheckpointById(connection: Database.Database, checkpointId: string): Checkpoint {
  const row = connection.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as CheckpointRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("checkpoint", checkpointId);
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    label: row.label,
    branch: row.branch,
    gitRef: row.git_ref,
    patchPath: row.patch_path,
    createdAt: row.created_at
  };
}

function findCheckById(connection: Database.Database, checkId: string): CheckRun {
  const row = connection.prepare("SELECT * FROM checks WHERE id = ?").get(checkId) as CheckRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("check", checkId);
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    command: row.command,
    status: row.status,
    exitCode: row.exit_code,
    summary: row.summary,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function findApprovalById(connection: Database.Database, approvalId: string): ApprovalRequest {
  const row = connection.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as ApprovalRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("approval", approvalId);
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    command: row.command,
    cwd: row.cwd,
    provider: row.provider,
    riskLevel: row.risk_level,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}

function findSessionById(connection: Database.Database, sessionId: string): SessionSummary {
  const row = connection.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("session", sessionId);
  }

  return sessionRowToSummary(row, isPreferredSession(connection, row.id));
}

/**
 * Single-row session SELECT that does NOT consult `ui_state` for the
 * preferred bit; returns `preferred: false`. Use from hot paths and from
 * post-write callers that just inserted/updated the row (`persistSession`,
 * `updateSessionState`) where the preferred flag has not changed and
 * cannot be true anyway.
 */
function findSessionByIdNoPreferred(
  connection: Database.Database,
  sessionId: string
): SessionSummary {
  const row = connection.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("session", sessionId);
  }
  return sessionRowToSummary(row, false);
}

function sessionRowToSummary(row: SessionRow, preferred: boolean): SessionSummary {
  // model_id is backfilled by migration v5 and required by `persistSession`'s
  // TypeScript input. A null here means a buggy write path or a corrupted
  // database — fail visibly rather than papering over with the human label.
  if (row.model_id == null) {
    throw new Error(`Session row missing model_id (id=${row.id}); database may be corrupted.`);
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    modelLabel: row.model_label,
    modelId: row.model_id,
    ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
    providerConversationId: row.provider_conversation_id,
    prompt: row.prompt,
    state: row.state,
    attention: row.attention,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastActivityAt: row.last_activity_at,
    preferred,
    costUsd: row.cost_usd,
    tokens: {
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens
    }
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

function listSessionEventsSince(
  connection: Database.Database,
  input: SessionEventsSinceInput
): SessionEventsSinceResult {
  const eventRows = input.eventCursor === undefined
    ? (connection
        .prepare(
          `
            SELECT * FROM (
              SELECT rowid AS row_cursor, * FROM events
              WHERE session_id = ?
              ORDER BY rowid DESC
              LIMIT ${SESSION_EVENT_PAGE_LIMIT}
            )
            ORDER BY row_cursor ASC
          `
        )
        .all(input.sessionId) as EventRow[])
    : (connection
        .prepare(
          `
            SELECT rowid AS row_cursor, * FROM events
            WHERE session_id = ? AND rowid > ?
            ORDER BY rowid ASC
            LIMIT ${SESSION_EVENT_PAGE_LIMIT}
          `
        )
        .all(input.sessionId, input.eventCursor) as EventRow[]);

  const rawOutputRows = input.rawOutputCursor === undefined
    ? (connection
        .prepare(
          `
            SELECT * FROM (
              SELECT rowid AS row_cursor, * FROM raw_outputs
              WHERE session_id = ?
              ORDER BY rowid DESC
              LIMIT ${SESSION_RAW_OUTPUT_PAGE_LIMIT}
            )
            ORDER BY row_cursor ASC
          `
        )
        .all(input.sessionId) as RawOutputRow[])
    : (connection
        .prepare(
          `
            SELECT rowid AS row_cursor, * FROM raw_outputs
            WHERE session_id = ? AND rowid > ?
            ORDER BY rowid ASC
            LIMIT ${SESSION_RAW_OUTPUT_PAGE_LIMIT}
          `
        )
        .all(input.sessionId, input.rawOutputCursor) as RawOutputRow[]);

  return {
    events: eventRows.map(eventRowToTimelineEvent),
    rawOutputs: rawOutputRows.map(rawOutputRowToProviderOutput),
    eventCursor: maxRowCursor(eventRows, input.eventCursor ?? 0),
    rawOutputCursor: maxRowCursor(rawOutputRows, input.rawOutputCursor ?? 0)
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
  const approvals = listApprovals(connection);

  return {
    ...dashboard,
    events,
    rawOutputs,
    approvals
  };
}

function listApprovals(connection: Database.Database): ApprovalRequest[] {
  return (
    connection.prepare(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT ${DASHBOARD_ROW_LIMIT}`).all() as ApprovalRow[]
  ).map(approvalRowToRequest);
}

function listPendingApprovals(connection: Database.Database): ApprovalRequest[] {
  return (
    connection
      .prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT ${DASHBOARD_ROW_LIMIT}`)
      .all() as ApprovalRow[]
  ).map(approvalRowToRequest);
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

function eventRowToTimelineEvent(row: EventRow): TimelineEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    message: row.message,
    payload: parseJsonRecord(row.payload_json, "database.eventPayload"),
    createdAt: row.created_at
  };
}

function rawOutputRowToProviderOutput(row: RawOutputRow): RawProviderOutput {
  return {
    id: row.id,
    sessionId: row.session_id,
    stream: row.stream,
    content: row.content,
    createdAt: row.created_at
  };
}

function approvalRowToRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    command: row.command,
    cwd: row.cwd,
    provider: row.provider,
    riskLevel: row.risk_level,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}

function checkRowToRun(row: CheckRow): CheckRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    command: row.command,
    status: row.status,
    exitCode: row.exit_code,
    summary: row.summary,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function checkpointRowToSummary(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    label: row.label,
    branch: row.branch,
    gitRef: row.git_ref,
    patchPath: row.patch_path,
    createdAt: row.created_at
  };
}

function maxRowCursor(rows: Array<{ row_cursor?: number }>, fallback: number): number {
  return rows.reduce((max, row) => Math.max(max, row.row_cursor ?? max), fallback);
}

function selectPreferredAttempt(connection: Database.Database, sessionId: string): SessionSummary {
  return connection.transaction(() => {
    // Read first via the no-preferred fast path so the workspace lookup is
    // available without an extra ui_state scan.
    const session = findSessionByIdNoPreferred(connection, sessionId);
    const workspace = findWorkspaceById(connection, session.workspaceId);
    const key = preferredAttemptKey(workspace.projectId, workspace.taskLabel);
    connection
      .prepare(
        `
          INSERT INTO ui_state (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `
      )
      .run(key, JSON.stringify({ sessionId }), new Date().toISOString());

    // Re-read with preferred recomputed; returned session reflects the
    // just-written preferred state without relying on a `{ ...session,
    // preferred: true }` overlay — concurrent calls would otherwise
    // interleave and produce stale snapshots.
    return findSessionById(connection, sessionId);
  })();
}

function loadPreferredSessionIds(connection: Database.Database): Set<string> {
  // Range scan on the PK index — `LIKE 'preferred-attempt:%'` skips the index
  // unless `case_sensitive_like` is ON. The half-open range below uses the PK
  // regardless of pragma settings. `:` is 0x3A, `;` is 0x3B (next codepoint).
  const rows = connection
    .prepare(
      "SELECT value_json FROM ui_state WHERE key >= 'preferred-attempt:' AND key < 'preferred-attempt;'"
    )
    .all() as Array<{ value_json: string }>;

  return new Set(
    rows
      .map((row) => parseJsonRecord(row.value_json, "database.preferredAttempt").sessionId)
      .filter((value): value is string => typeof value === "string")
  );
}

function isPreferredSession(connection: Database.Database, sessionId: string): boolean {
  return loadPreferredSessionIds(connection).has(sessionId);
}

function preferredAttemptKey(projectId: string, taskLabel: string): string {
  return `preferred-attempt:${projectId}:${taskLabel}`;
}

interface UsageEventRow {
  model_id: string;
}

interface SessionCostRow {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

function insertUsageEvent(connection: Database.Database, input: InsertUsageEventInput): void {
  const insertStmt = connection.prepare(
    `
      INSERT INTO usage_events (
        session_id, event_id, model_id, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd, created_at
      ) VALUES (
        @sessionId, @eventId, @modelId, @inputTokens, @outputTokens,
        @cacheReadTokens, @cacheWriteTokens, @costUsd, @createdAt
      )
    `
  );
  const updateStmt = connection.prepare(
    `
      UPDATE sessions
      SET
        input_tokens = input_tokens + @inputTokens,
        output_tokens = output_tokens + @outputTokens,
        cache_read_tokens = cache_read_tokens + @cacheReadTokens,
        cache_write_tokens = cache_write_tokens + @cacheWriteTokens,
        cost_usd = cost_usd + @costUsd
      WHERE id = @sessionId
    `
  );
  // Atomic so the audit-log row and aggregate totals can't diverge on a
  // session-deleted race. Nested-call safe: better-sqlite3 promotes this to
  // a savepoint when run inside an outer transaction (see flushBatch).
  connection.transaction(() => {
    insertStmt.run({
      sessionId: input.sessionId,
      eventId: input.eventId ?? null,
      modelId: input.modelId,
      inputTokens: input.tokens.input,
      outputTokens: input.tokens.output,
      cacheReadTokens: input.tokens.cacheRead,
      cacheWriteTokens: input.tokens.cacheWrite,
      costUsd: input.costUsd,
      createdAt: input.createdAt ?? Date.now()
    });
    const result = updateStmt.run({
      sessionId: input.sessionId,
      inputTokens: input.tokens.input,
      outputTokens: input.tokens.output,
      cacheReadTokens: input.tokens.cacheRead,
      cacheWriteTokens: input.tokens.cacheWrite,
      costUsd: input.costUsd
    });
    if (result.changes === 0) {
      throw new RecordNotFoundError("session", input.sessionId);
    }
  })();
}

function getSessionCostSummary(connection: Database.Database, sessionId: string): SessionCostSummary {
  const sessionRow = connection
    .prepare(
      "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd FROM sessions WHERE id = ?"
    )
    .get(sessionId) as SessionCostRow | undefined;
  if (!sessionRow) {
    throw new RecordNotFoundError("session", sessionId);
  }
  const latestUsage = connection
    .prepare("SELECT model_id FROM usage_events WHERE session_id = ? ORDER BY id DESC LIMIT 1")
    .get(sessionId) as UsageEventRow | undefined;

  return {
    sessionId,
    modelId: latestUsage?.model_id ?? null,
    tokens: {
      input: sessionRow.input_tokens,
      output: sessionRow.output_tokens,
      cacheRead: sessionRow.cache_read_tokens,
      cacheWrite: sessionRow.cache_write_tokens
    },
    costUsd: sessionRow.cost_usd
  };
}
