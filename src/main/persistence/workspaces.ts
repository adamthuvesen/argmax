import type Database from "better-sqlite3";
import { RecordNotFoundError } from "./errors.js";
import type { WorkspaceSummary } from "../../shared/types.js";

export interface WorkspaceRow {
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
  pinned: number;
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

export function workspaceRowToSummary(row: WorkspaceRow): WorkspaceSummary {
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
    lastActivityAt: row.last_activity_at,
    pinned: row.pinned === 1
  };
}

export function findWorkspaceById(connection: Database.Database, workspaceId: string): WorkspaceSummary {
  const row = connection.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as WorkspaceRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("workspace", workspaceId);
  }
  return workspaceRowToSummary(row);
}

export function persistWorkspace(
  connection: Database.Database,
  input: PersistWorkspaceInput
): WorkspaceSummary {
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

export function updateWorkspaceState(
  connection: Database.Database,
  workspaceId: string,
  state: WorkspaceSummary["state"]
): WorkspaceSummary {
  const timestamp = new Date().toISOString();
  // Archiving/keeping is a user action, not session activity. Bumping
  // last_activity_at here would re-sort the row to the top of the sidebar
  // (visible for "kept", since only "archived" is filtered out). Preserve
  // the existing activity timestamp for these terminal states; other
  // transitions (running/failed/cancelled) are real activity and still bump.
  const isUserArchiveAction = state === "archived" || state === "kept";
  const result = isUserArchiveAction
    ? connection
        .prepare("UPDATE workspaces SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, timestamp, workspaceId)
    : connection
        .prepare("UPDATE workspaces SET state = ?, last_activity_at = ?, updated_at = ? WHERE id = ?")
        .run(state, timestamp, timestamp, workspaceId);
  if (result.changes === 0) {
    throw new RecordNotFoundError("workspace", workspaceId);
  }
  return findWorkspaceById(connection, workspaceId);
}

export function updateWorkspaceStatus(
  connection: Database.Database,
  workspaceId: string,
  status: WorkspaceStatusInput
): WorkspaceSummary {
  const timestamp = status.lastActivityAt ?? new Date().toISOString();
  const result = connection
    .prepare(
      `
        UPDATE workspaces
        SET branch = ?, dirty = ?, changed_files = ?, last_activity_at = ?, updated_at = ?
        WHERE id = ?
      `
    )
    .run(status.branch, status.dirty ? 1 : 0, status.changedFiles, timestamp, timestamp, workspaceId);
  if (result.changes === 0) {
    throw new RecordNotFoundError("workspace", workspaceId);
  }
  return findWorkspaceById(connection, workspaceId);
}

export function setWorkspacePinned(
  connection: Database.Database,
  workspaceId: string,
  pinned: boolean
): WorkspaceSummary {
  const result = connection
    .prepare("UPDATE workspaces SET pinned = ?, updated_at = ? WHERE id = ?")
    .run(pinned ? 1 : 0, new Date().toISOString(), workspaceId);
  if (result.changes === 0) {
    throw new RecordNotFoundError("workspace", workspaceId);
  }
  return findWorkspaceById(connection, workspaceId);
}
