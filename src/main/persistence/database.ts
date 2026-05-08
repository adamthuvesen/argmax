import Database from "better-sqlite3";
import { getDatabasePath } from "../paths.js";
import { runMigrations } from "./migrations.js";
import { seedDemoData } from "./seed.js";
import type {
  ApprovalRequest,
  CheckRun,
  DashboardSnapshot,
  ProjectSettings,
  ProjectSummary,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";

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

interface ProjectRow {
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
  active_count: number;
  blocked_count: number;
  failed_count: number;
  review_ready_count: number;
  latest_activity_at: string | null;
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
  prompt: string;
  state: SessionSummary["state"];
  attention: SessionSummary["attention"];
  started_at: string;
  completed_at: string | null;
  last_activity_at: string;
}

interface EventRow {
  id: string;
  session_id: string;
  type: TimelineEvent["type"];
  message: string;
  payload_json: string;
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

export interface MaestroDatabase {
  connection: Database.Database;
  listProjects: () => ProjectSummary[];
  loadDashboard: () => DashboardSnapshot;
  persistProject: (input: PersistProjectInput) => ProjectSummary;
  updateProjectSettings: (projectId: string, settings: ProjectSettings) => ProjectSummary;
  getProject: (projectId: string) => ProjectSummary;
  getWorkspace: (workspaceId: string) => WorkspaceSummary;
  persistWorkspace: (input: PersistWorkspaceInput) => WorkspaceSummary;
  updateWorkspaceState: (workspaceId: string, state: WorkspaceSummary["state"]) => WorkspaceSummary;
  updateWorkspaceStatus: (workspaceId: string, status: WorkspaceStatusInput) => WorkspaceSummary;
}

export function createDatabase(databasePath = getDatabasePath(), options: { seed?: boolean } = {}): MaestroDatabase {
  const connection = new Database(databasePath);
  runMigrations(connection);
  if (options.seed ?? true) {
    seedDemoData(connection);
  }

  return {
    connection,
    listProjects: () => listProjects(connection),
    loadDashboard: () => loadDashboard(connection),
    persistProject: (input) => persistProject(connection, input),
    updateProjectSettings: (projectId, settings) => updateProjectSettings(connection, projectId, settings),
    getProject: (projectId) => findProjectById(connection, projectId),
    getWorkspace: (workspaceId) => findWorkspaceById(connection, workspaceId),
    persistWorkspace: (input) => persistWorkspace(connection, input),
    updateWorkspaceState: (workspaceId, state) => updateWorkspaceState(connection, workspaceId, state),
    updateWorkspaceStatus: (workspaceId, status) => updateWorkspaceStatus(connection, workspaceId, status)
  };
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function listProjects(connection: Database.Database): ProjectSummary[] {
  const rows = connection
    .prepare(
      `
        SELECT
          p.*,
          SUM(CASE WHEN w.state IN ('created', 'running', 'waiting', 'blocked') THEN 1 ELSE 0 END) AS active_count,
          SUM(CASE WHEN s.attention = 'blocked' OR w.state = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
          SUM(CASE WHEN s.attention = 'failed' OR w.state = 'failed' THEN 1 ELSE 0 END) AS failed_count,
          SUM(CASE WHEN s.attention = 'review-ready' OR w.state = 'complete' THEN 1 ELSE 0 END) AS review_ready_count,
          MAX(COALESCE(s.last_activity_at, w.last_activity_at, p.updated_at)) AS latest_activity_at
        FROM projects p
        LEFT JOIN workspaces w ON w.project_id = p.id
        LEFT JOIN sessions s ON s.workspace_id = w.id
        GROUP BY p.id
        ORDER BY latest_activity_at DESC
      `
    )
    .all() as ProjectRow[];

  return rows.map((row) => ({
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
      blocked: row.blocked_count ?? 0,
      failed: row.failed_count ?? 0,
      reviewReady: row.review_ready_count ?? 0
    },
    latestActivityAt: row.latest_activity_at
  }));
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
          default_provider = excluded.default_provider,
          default_model_label = excluded.default_model_label,
          worktree_location = excluded.worktree_location,
          setup_command = excluded.setup_command,
          check_commands_json = excluded.check_commands_json,
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

  return findProjectByRepoPath(connection, input.repoPath);
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

  return findProjectById(connection, projectId);
}

function findProjectByRepoPath(connection: Database.Database, repoPath: string): ProjectSummary {
  const project = listProjects(connection).find((item) => item.repoPath === repoPath);
  if (!project) {
    throw new Error(`Project was not persisted for repository: ${repoPath}`);
  }
  return project;
}

function findProjectById(connection: Database.Database, projectId: string): ProjectSummary {
  const project = listProjects(connection).find((item) => item.id === projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  return project;
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

function findWorkspaceById(connection: Database.Database, workspaceId: string): WorkspaceSummary {
  const row = connection.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as WorkspaceRow | undefined;
  if (!row) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  return {
    id: row.id,
    projectId: row.project_id,
    taskLabel: row.task_label,
    branch: row.branch,
    baseRef: row.base_ref,
    path: row.path,
    state: row.state,
    sharedWorkspace: Boolean(row.shared_workspace),
    dirty: Boolean(row.dirty),
    changedFiles: row.changed_files,
    lastActivityAt: row.last_activity_at
  };
}

function loadDashboard(connection: Database.Database): DashboardSnapshot {
  const projects = listProjects(connection);
  const workspaces = (connection.prepare("SELECT * FROM workspaces ORDER BY last_activity_at DESC").all() as WorkspaceRow[]).map(
    (row) => ({
      id: row.id,
      projectId: row.project_id,
      taskLabel: row.task_label,
      branch: row.branch,
      baseRef: row.base_ref,
      path: row.path,
      state: row.state,
      sharedWorkspace: Boolean(row.shared_workspace),
      dirty: Boolean(row.dirty),
      changedFiles: row.changed_files,
      lastActivityAt: row.last_activity_at
    })
  );

  const sessions = (connection.prepare("SELECT * FROM sessions ORDER BY last_activity_at DESC").all() as SessionRow[]).map(
    (row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      provider: row.provider,
      modelLabel: row.model_label,
      prompt: row.prompt,
      state: row.state,
      attention: row.attention,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      lastActivityAt: row.last_activity_at
    })
  );

  const events = (
    connection.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 50").all() as EventRow[]
  ).map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    message: row.message,
    payload: parseJsonRecord(row.payload_json),
    createdAt: row.created_at
  }));

  const approvals = (connection.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all() as ApprovalRow[]).map(
    (row) => ({
      id: row.id,
      sessionId: row.session_id,
      command: row.command,
      cwd: row.cwd,
      provider: row.provider,
      riskLevel: row.risk_level,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at
    })
  );

  const checks = (connection.prepare("SELECT * FROM checks ORDER BY started_at DESC").all() as CheckRow[]).map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    command: row.command,
    status: row.status,
    exitCode: row.exit_code,
    summary: row.summary,
    startedAt: row.started_at,
    completedAt: row.completed_at
  }));

  const checkpoints = (
    connection.prepare("SELECT * FROM checkpoints ORDER BY created_at DESC").all() as CheckpointRow[]
  ).map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    label: row.label,
    branch: row.branch,
    gitRef: row.git_ref,
    patchPath: row.patch_path,
    createdAt: row.created_at
  }));

  return {
    projects,
    workspaces,
    sessions,
    events,
    approvals,
    checks,
    checkpoints
  };
}
