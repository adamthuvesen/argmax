import type Database from "better-sqlite3";
import { RecordNotFoundError } from "./errors.js";
import { safeJsonParseArray } from "../../shared/safeJson.js";
import type { ProjectSettings, ProjectSummary } from "../../shared/types.js";

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

function parseJsonArray(value: string): string[] {
  return safeJsonParseArray(value, (item): item is string => typeof item === "string", "projects.parseJsonArray");
}

export function listProjects(connection: Database.Database): ProjectSummary[] {
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

export function persistProject(connection: Database.Database, input: PersistProjectInput): ProjectSummary {
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

export function updateProjectSettings(
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

export function updateProjectBranch(
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
export function findProjectByRepoPath(
  connection: Database.Database,
  repoPath: string
): ProjectSummary | null {
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
export function findProjectById(
  connection: Database.Database,
  projectId: string
): ProjectSummary | null {
  const row = connection
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as BareProjectRow | undefined;
  return row ? bareProjectRowToSummary(row) : null;
}

export function requireProject(connection: Database.Database, projectId: string): ProjectSummary {
  const project = findProjectById(connection, projectId);
  if (!project) {
    throw new RecordNotFoundError("project", projectId);
  }
  return project;
}

/**
 * Delete a project row. Child rows in `workspaces`, `sessions`, `events`,
 * `raw_outputs`, `approvals`, `checks`, `checkpoints`, `learnings`,
 * `tournaments`, `gh_pr`, and `scoring_policies` cascade via the FK
 * `ON DELETE CASCADE` clauses declared in the migrations.
 *
 * No-op (returns silently) if the project row doesn't exist — keeps the
 * call idempotent for the IPC layer.
 */
export function deleteProject(connection: Database.Database, projectId: string): void {
  connection.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
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

export function updateProjectRemote(
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

export function getProjectRemote(
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
