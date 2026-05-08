import Database from "better-sqlite3";
import { getDatabasePath } from "../paths.js";
import { runMigrations } from "./migrations.js";
import { seedDemoData } from "./seed.js";
import type {
  ApprovalRequest,
  Checkpoint,
  CheckRun,
  DashboardSnapshot,
  ProjectSettings,
  ProjectSummary,
  RawProviderOutput,
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

export interface PersistSessionInput {
  id: string;
  workspaceId: string;
  provider: SessionSummary["provider"];
  modelLabel: string;
  prompt: string;
  state: SessionSummary["state"];
  attention: SessionSummary["attention"];
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

interface RawOutputRow {
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
  persistApproval: (input: PersistApprovalInput) => ApprovalRequest;
  resolveApproval: (approvalId: string, status: Extract<ApprovalRequest["status"], "approved" | "rejected">) => ApprovalRequest;
  persistCheck: (input: PersistCheckInput) => CheckRun;
  updateCheck: (checkId: string, input: UpdateCheckInput) => CheckRun;
  persistCheckpoint: (input: PersistCheckpointInput) => Checkpoint;
  selectPreferredAttempt: (sessionId: string) => SessionSummary;
  persistSession: (input: PersistSessionInput) => SessionSummary;
  updateSessionState: (sessionId: string, input: SessionStateInput) => SessionSummary;
  persistTimelineEvent: (input: PersistTimelineEventInput) => TimelineEvent;
  persistRawOutput: (input: PersistRawOutputInput) => void;
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
    updateWorkspaceStatus: (workspaceId, status) => updateWorkspaceStatus(connection, workspaceId, status),
    persistApproval: (input) => persistApproval(connection, input),
    resolveApproval: (approvalId, status) => resolveApproval(connection, approvalId, status),
    persistCheck: (input) => persistCheck(connection, input),
    updateCheck: (checkId, input) => updateCheck(connection, checkId, input),
    persistCheckpoint: (input) => persistCheckpoint(connection, input),
    selectPreferredAttempt: (sessionId) => selectPreferredAttempt(connection, sessionId),
    persistSession: (input) => persistSession(connection, input),
    updateSessionState: (sessionId, input) => updateSessionState(connection, sessionId, input),
    persistTimelineEvent: (input) => persistTimelineEvent(connection, input),
    persistRawOutput: (input) => persistRawOutput(connection, input)
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

function persistSession(connection: Database.Database, input: PersistSessionInput): SessionSummary {
  const timestamp = new Date().toISOString();
  connection
    .prepare(
      `
        INSERT INTO sessions (
          id, workspace_id, provider, model_label, prompt, state, attention,
          started_at, completed_at, last_activity_at
        ) VALUES (
          @id, @workspaceId, @provider, @modelLabel, @prompt, @state, @attention,
          @startedAt, NULL, @lastActivityAt
        )
      `
    )
    .run({
      id: input.id,
      workspaceId: input.workspaceId,
      provider: input.provider,
      modelLabel: input.modelLabel,
      prompt: input.prompt,
      state: input.state,
      attention: input.attention,
      startedAt: timestamp,
      lastActivityAt: timestamp
    });

  return findSessionById(connection, input.id);
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

  return findSessionById(connection, sessionId);
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

function findCheckpointById(connection: Database.Database, checkpointId: string): Checkpoint {
  const row = connection.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as CheckpointRow | undefined;
  if (!row) {
    throw new Error(`Checkpoint not found: ${checkpointId}`);
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
    throw new Error(`Check not found: ${checkId}`);
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
    throw new Error(`Approval not found: ${approvalId}`);
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
    throw new Error(`Session not found: ${sessionId}`);
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    modelLabel: row.model_label,
    prompt: row.prompt,
    state: row.state,
    attention: row.attention,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastActivityAt: row.last_activity_at,
    preferred: isPreferredSession(connection, row.id)
  };
}

function loadDashboard(connection: Database.Database): DashboardSnapshot {
  const projects = listProjects(connection);
  const preferredSessionIds = loadPreferredSessionIds(connection);
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
      lastActivityAt: row.last_activity_at,
      preferred: preferredSessionIds.has(row.id)
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

  const rawOutputs = (
    connection.prepare("SELECT * FROM raw_outputs ORDER BY created_at DESC LIMIT 100").all() as RawOutputRow[]
  ).map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    stream: row.stream,
    content: row.content,
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
    rawOutputs,
    approvals,
    checks,
    checkpoints
  };
}

function selectPreferredAttempt(connection: Database.Database, sessionId: string): SessionSummary {
  const session = findSessionById(connection, sessionId);
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

  return { ...session, preferred: true };
}

function loadPreferredSessionIds(connection: Database.Database): Set<string> {
  const rows = connection
    .prepare("SELECT value_json FROM ui_state WHERE key LIKE 'preferred-attempt:%'")
    .all() as Array<{ value_json: string }>;

  return new Set(
    rows
      .map((row) => parseJsonRecord(row.value_json).sessionId)
      .filter((value): value is string => typeof value === "string")
  );
}

function isPreferredSession(connection: Database.Database, sessionId: string): boolean {
  return loadPreferredSessionIds(connection).has(sessionId);
}

function preferredAttemptKey(projectId: string, taskLabel: string): string {
  return `preferred-attempt:${projectId}:${taskLabel}`;
}
