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
import { errorMessage } from "../../shared/error.js";
import { getDatabasePath } from "../paths.js";
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
  listPendingApprovals,
  persistApproval,
  resolveApproval,
  type FindPendingApprovalInput,
  type PersistApprovalInput
} from "./approvals.js";
import {
  persistCheck,
  persistCheckpoint,
  updateCheck,
  type PersistCheckInput,
  type PersistCheckpointInput,
  type UpdateCheckInput
} from "./checks.js";
import {
  listSessionEventsSince,
  persistRawOutput,
  persistTimelineEvent,
  type PersistRawOutputInput,
  type PersistTimelineEventInput,
  type SessionEventsSinceInput,
  type SessionEventsSinceResult
} from "./events.js";
import {
  findWorkspaceById,
  persistWorkspace,
  setWorkspacePinned,
  updateWorkspaceState,
  updateWorkspaceStatus,
  type PersistWorkspaceInput,
  type WorkspaceStatusInput
} from "./workspaces.js";
import {
  findSessionById,
  persistSession,
  selectPreferredAttempt,
  updateSessionLastModelId,
  updateSessionModel,
  updateSessionProviderConversationId,
  updateSessionState,
  type PersistSessionInput,
  type SessionModelInput,
  type SessionStateInput
} from "./sessions.js";
import {
  findProjectById,
  findProjectByRepoPath,
  getProjectRemote,
  listProjects,
  persistProject,
  requireProject,
  updateProjectBranch,
  updateProjectRemote,
  updateProjectSettings,
  type PersistProjectInput
} from "./projects.js";
import {
  countAttention,
  DASHBOARD_ROW_LIMIT,
  listDashboard,
  listRunningSessionIds,
  listWorkspaceStatus,
  loadDashboard,
  type DashboardListSnapshot,
  type WorkspaceStatusInputFilter,
  type WorkspaceStatusSnapshot
} from "./dashboard.js";
import { runMigrations } from "./migrations.js";
import { seedDemoData } from "./seed.js";
import type {
  ApprovalRequest,
  Checkpoint,
  CheckRun,
  DashboardSnapshot,
  GhPrRecord,
  Learning,
  ProjectSettings,
  ProjectSummary,
  RawProviderOutput,
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
export type { PersistProjectInput } from "./projects.js";
export type {
  DashboardListSnapshot,
  WorkspaceStatusInputFilter,
  WorkspaceStatusSnapshot
} from "./dashboard.js";

const SESSION_EVENT_PAGE_LIMIT = 500;
const SESSION_RAW_OUTPUT_PAGE_LIMIT = 100;
/** How often the prune timer fires (raw_outputs retention sweep). */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** SQLite datetime modifier matching PRUNE_INTERVAL_MS retention. */
const RAW_OUTPUT_RETENTION = "-7 days";

/**
 * Deletes `raw_outputs` rows older than the retention window. Exported so the
 * D4 regression test can exercise the prune SQL against a seeded DB without
 * having to drive the setInterval-based wiring inside `createDatabase`.
 *
 * Swallows + logs errors — the prune is best-effort: a transient lock should
 * not crash the app. Callers in `createDatabase` re-invoke daily anyway.
 */
export function pruneOldRawOutputs(connection: Database.Database): void {
  try {
    connection
      .prepare(`DELETE FROM raw_outputs WHERE created_at < datetime('now', '${RAW_OUTPUT_RETENTION}')`)
      .run();
  } catch (error) {
    logger.warn("database.prune", "pruneRawOutputs failed", {
      error: errorMessage(error)
    });
  }
}

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
  persistRawOutput: (input: PersistRawOutputInput) => RawProviderOutput;
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
    pruneOldRawOutputs(connection);
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
