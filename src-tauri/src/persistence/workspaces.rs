use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;

use super::prepared::prepared;
use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq)]
pub struct PersistWorkspaceInput {
    pub id: String,
    pub project_id: String,
    pub task_label: String,
    pub branch: String,
    pub base_ref: String,
    pub path: String,
    pub state: String,
    pub shared_workspace: bool,
    pub dirty: bool,
    pub changed_files: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceStatusInput {
    pub branch: String,
    pub dirty: bool,
    pub changed_files: i64,
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub project_id: String,
    pub task_label: String,
    pub branch: String,
    pub base_ref: String,
    pub path: String,
    pub state: String,
    pub shared_workspace: bool,
    pub dirty: bool,
    pub changed_files: i64,
    pub last_activity_at: String,
    pub pinned: bool,
    /// State of the most-recent PR across this workspace's sessions. Populated
    /// only on the dashboard snapshot path; `None` everywhere else.
    pub pr_state: Option<String>,
    /// PR number paired with `pr_state`.
    pub pr_number: Option<i64>,
}

pub fn list_workspaces(
    connection: &Connection,
    workspace_ids: Option<&[String]>,
    limit: usize,
) -> ArgmaxResult<Vec<WorkspaceSummary>> {
    match workspace_ids {
        Some(ids) if !ids.is_empty() => {
            let json = serde_json::to_string(ids).map_err(json_error)?;
            let mut statement = prepared(
                connection,
                "SELECT * FROM workspaces WHERE id IN (SELECT value FROM json_each(?)) ORDER BY last_activity_at DESC, id DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map((json, limit as i64), workspace_row_to_summary)
                .map_err(sqlite_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
        }
        _ => {
            let mut statement = prepared(
                connection,
                "SELECT * FROM workspaces ORDER BY last_activity_at DESC, id DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map([limit as i64], workspace_row_to_summary)
                .map_err(sqlite_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
        }
    }
}

pub fn find_workspace_by_id(
    connection: &Connection,
    workspace_id: &str,
) -> ArgmaxResult<WorkspaceSummary> {
    let mut statement =
        prepared(connection, "SELECT * FROM workspaces WHERE id = ?").map_err(sqlite_error)?;
    match statement.query_row([workspace_id], workspace_row_to_summary) {
        Ok(workspace) => Ok(workspace),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("workspace", workspace_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn persist_workspace(
    connection: &Connection,
    input: &PersistWorkspaceInput,
) -> ArgmaxResult<WorkspaceSummary> {
    let timestamp = now_iso();
    let mut statement = prepared(
        connection,
        r#"
        INSERT INTO workspaces (
          id, project_id, task_label, branch, base_ref, path, state, shared_workspace,
          dirty, changed_files, last_activity_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            input.id.as_str(),
            input.project_id.as_str(),
            input.task_label.as_str(),
            input.branch.as_str(),
            input.base_ref.as_str(),
            input.path.as_str(),
            input.state.as_str(),
            bool_to_i64(input.shared_workspace),
            bool_to_i64(input.dirty),
            input.changed_files,
            timestamp.as_str(),
            timestamp.as_str(),
            timestamp.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_workspace_by_id(connection, &input.id)
}

pub fn update_workspace_state(
    connection: &Connection,
    workspace_id: &str,
    state: &str,
) -> ArgmaxResult<WorkspaceSummary> {
    let timestamp = now_iso();
    let is_user_archive_action = state == "archived" || state == "kept";
    let changes = if is_user_archive_action {
        let mut statement = prepared(
            connection,
            "UPDATE workspaces SET state = ?, updated_at = ? WHERE id = ?",
        )
        .map_err(sqlite_error)?;
        statement
            .execute((state, timestamp.as_str(), workspace_id))
            .map_err(sqlite_error)?
    } else {
        let mut statement = prepared(
            connection,
            "UPDATE workspaces SET state = ?, last_activity_at = ?, updated_at = ? WHERE id = ?",
        )
        .map_err(sqlite_error)?;
        statement
            .execute((state, timestamp.as_str(), timestamp.as_str(), workspace_id))
            .map_err(sqlite_error)?
    };
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("workspace", workspace_id));
    }
    find_workspace_by_id(connection, workspace_id)
}

pub fn update_workspace_status(
    connection: &Connection,
    workspace_id: &str,
    status: &WorkspaceStatusInput,
) -> ArgmaxResult<WorkspaceSummary> {
    let timestamp = status.last_activity_at.clone().unwrap_or_else(now_iso);
    let mut statement = prepared(
        connection,
        r#"
        UPDATE workspaces
        SET branch = ?, dirty = ?, changed_files = ?, last_activity_at = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((
            status.branch.as_str(),
            bool_to_i64(status.dirty),
            status.changed_files,
            timestamp.as_str(),
            timestamp.as_str(),
            workspace_id,
        ))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("workspace", workspace_id));
    }
    find_workspace_by_id(connection, workspace_id)
}

pub fn set_workspace_pinned(
    connection: &Connection,
    workspace_id: &str,
    pinned: bool,
) -> ArgmaxResult<WorkspaceSummary> {
    let mut statement = prepared(
        connection,
        "UPDATE workspaces SET pinned = ?, updated_at = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((bool_to_i64(pinned), now_iso(), workspace_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("workspace", workspace_id));
    }
    find_workspace_by_id(connection, workspace_id)
}

pub fn set_workspace_label(
    connection: &Connection,
    workspace_id: &str,
    task_label: &str,
) -> ArgmaxResult<WorkspaceSummary> {
    // A manual rename marks the label custom (`task_label_auto = 0`) so the
    // session-title generator stops overwriting it.
    let mut statement = prepared(
        connection,
        "UPDATE workspaces SET task_label = ?, task_label_auto = 0, updated_at = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((task_label, now_iso(), workspace_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("workspace", workspace_id));
    }
    find_workspace_by_id(connection, workspace_id)
}

/// Sets an auto-generated title, but only while the label is still auto
/// (`task_label_auto = 1`). Returns `Ok(None)` when the row is missing or the
/// user has already renamed it — the caller treats that as a no-op so a manual
/// rename is never clobbered by a late-arriving generated title.
pub fn set_workspace_label_auto(
    connection: &Connection,
    workspace_id: &str,
    task_label: &str,
) -> ArgmaxResult<Option<WorkspaceSummary>> {
    let mut statement = prepared(
        connection,
        "UPDATE workspaces SET task_label = ?, updated_at = ? WHERE id = ? AND task_label_auto = 1",
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((task_label, now_iso(), workspace_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Ok(None);
    }
    find_workspace_by_id(connection, workspace_id).map(Some)
}

pub fn workspace_row_to_summary(row: &Row<'_>) -> rusqlite::Result<WorkspaceSummary> {
    Ok(WorkspaceSummary {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        task_label: row.get("task_label")?,
        branch: row.get("branch")?,
        base_ref: row.get("base_ref")?,
        path: row.get("path")?,
        state: row.get("state")?,
        shared_workspace: row.get::<_, i64>("shared_workspace")? == 1,
        dirty: row.get::<_, i64>("dirty")? == 1,
        changed_files: row.get("changed_files")?,
        last_activity_at: row.get("last_activity_at")?,
        pinned: row.get::<_, i64>("pinned")? == 1,
        // PR fields are not workspace columns; the dashboard snapshot fills them
        // in from gh_pr after the row maps.
        pr_state: None,
        pr_number: None,
    })
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn json_error(error: serde_json::Error) -> ArgmaxError {
    ArgmaxError::service("JSON", error.to_string())
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}
