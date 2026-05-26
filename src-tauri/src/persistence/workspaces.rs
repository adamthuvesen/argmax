use rusqlite::{Connection, Row};
use serde::Serialize;

use super::prepared::prepared;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq, Serialize)]
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
                "SELECT * FROM workspaces WHERE id IN (SELECT value FROM json_each(?)) ORDER BY last_activity_at DESC LIMIT ?",
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
                "SELECT * FROM workspaces ORDER BY last_activity_at DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map([limit as i64], workspace_row_to_summary)
                .map_err(sqlite_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
        }
    }
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
    })
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn json_error(error: serde_json::Error) -> ArgmaxError {
    ArgmaxError::service("JSON", error.to_string())
}
