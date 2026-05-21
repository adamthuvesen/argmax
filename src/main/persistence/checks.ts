import type Database from "better-sqlite3";
import { RecordNotFoundError } from "./errors.js";
import type { Checkpoint, CheckRun } from "../../shared/types.js";

export interface CheckRow {
  id: string;
  workspace_id: string;
  command: string;
  status: CheckRun["status"];
  exit_code: number | null;
  summary: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface CheckpointRow {
  id: string;
  workspace_id: string;
  label: string;
  branch: string;
  git_ref: string | null;
  patch_path: string | null;
  created_at: string;
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

export function checkRowToRun(row: CheckRow): CheckRun {
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

export function checkpointRowToSummary(row: CheckpointRow): Checkpoint {
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

export function findCheckById(connection: Database.Database, checkId: string): CheckRun {
  const row = connection.prepare("SELECT * FROM checks WHERE id = ?").get(checkId) as CheckRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("check", checkId);
  }
  return checkRowToRun(row);
}

export function findCheckpointById(connection: Database.Database, checkpointId: string): Checkpoint {
  const row = connection.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as CheckpointRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("checkpoint", checkpointId);
  }
  return checkpointRowToSummary(row);
}

export function persistCheck(connection: Database.Database, input: PersistCheckInput): CheckRun {
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

export function updateCheck(
  connection: Database.Database,
  checkId: string,
  input: UpdateCheckInput
): CheckRun {
  const result = connection
    .prepare(
      `
        UPDATE checks
        SET status = ?, exit_code = ?, summary = ?, completed_at = ?
        WHERE id = ?
      `
    )
    .run(input.status, input.exitCode, input.summary, input.completedAt ?? new Date().toISOString(), checkId);

  if (result.changes === 0) {
    throw new RecordNotFoundError("check", checkId);
  }
  return findCheckById(connection, checkId);
}

export function persistCheckpoint(connection: Database.Database, input: PersistCheckpointInput): Checkpoint {
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
