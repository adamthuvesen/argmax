use rusqlite::{Connection, Row};
use serde::Serialize;

use super::prepared::prepared;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub id: String,
    pub workspace_id: String,
    pub command: String,
    pub status: String,
    pub exit_code: Option<i64>,
    pub summary: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub workspace_id: String,
    pub label: String,
    pub branch: String,
    pub git_ref: Option<String>,
    pub patch_path: Option<String>,
    pub created_at: String,
}

pub fn list_checks(
    connection: &Connection,
    workspace_ids: Option<&[String]>,
    limit: usize,
) -> ArgmaxResult<Vec<CheckRun>> {
    match workspace_ids {
        Some(ids) if !ids.is_empty() => {
            let json = serde_json::to_string(ids).map_err(json_error)?;
            let mut statement = prepared(
                connection,
                "SELECT * FROM checks WHERE workspace_id IN (SELECT value FROM json_each(?)) ORDER BY started_at DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map((json, limit as i64), check_row_to_run)
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
        _ => {
            let mut statement = prepared(
                connection,
                "SELECT * FROM checks ORDER BY started_at DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map([limit as i64], check_row_to_run)
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
    }
}

pub fn list_checkpoints(
    connection: &Connection,
    workspace_ids: Option<&[String]>,
    limit: usize,
) -> ArgmaxResult<Vec<Checkpoint>> {
    match workspace_ids {
        Some(ids) if !ids.is_empty() => {
            let json = serde_json::to_string(ids).map_err(json_error)?;
            let mut statement = prepared(
                connection,
                "SELECT * FROM checkpoints WHERE workspace_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map((json, limit as i64), checkpoint_row_to_summary)
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
        _ => {
            let mut statement = prepared(
                connection,
                "SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map([limit as i64], checkpoint_row_to_summary)
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
    }
}

fn check_row_to_run(row: &Row<'_>) -> rusqlite::Result<CheckRun> {
    Ok(CheckRun {
        id: row.get("id")?,
        workspace_id: row.get("workspace_id")?,
        command: row.get("command")?,
        status: row.get("status")?,
        exit_code: row.get("exit_code")?,
        summary: row.get("summary")?,
        started_at: row.get("started_at")?,
        completed_at: row.get("completed_at")?,
    })
}

fn checkpoint_row_to_summary(row: &Row<'_>) -> rusqlite::Result<Checkpoint> {
    Ok(Checkpoint {
        id: row.get("id")?,
        workspace_id: row.get("workspace_id")?,
        label: row.get("label")?,
        branch: row.get("branch")?,
        git_ref: row.get("git_ref")?,
        patch_path: row.get("patch_path")?,
        created_at: row.get("created_at")?,
    })
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn json_error(error: serde_json::Error) -> ArgmaxError {
    ArgmaxError::service("JSON", error.to_string())
}
