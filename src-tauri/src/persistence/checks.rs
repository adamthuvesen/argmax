use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;

use super::prepared::prepared;
use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq)]
pub struct PersistCheckInput {
    pub id: String,
    pub workspace_id: String,
    pub command: String,
    pub status: String,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UpdateCheckInput {
    pub status: String,
    pub exit_code: Option<i64>,
    pub summary: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PersistCheckpointInput {
    pub id: String,
    pub workspace_id: String,
    pub label: String,
    pub branch: String,
    pub git_ref: Option<String>,
    pub patch_path: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
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

pub fn find_check_by_id(connection: &Connection, check_id: &str) -> ArgmaxResult<CheckRun> {
    let mut statement =
        prepared(connection, "SELECT * FROM checks WHERE id = ?").map_err(sqlite_error)?;
    match statement.query_row([check_id], check_row_to_run) {
        Ok(check) => Ok(check),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("check", check_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn find_checkpoint_by_id(
    connection: &Connection,
    checkpoint_id: &str,
) -> ArgmaxResult<Checkpoint> {
    let mut statement =
        prepared(connection, "SELECT * FROM checkpoints WHERE id = ?").map_err(sqlite_error)?;
    match statement.query_row([checkpoint_id], checkpoint_row_to_summary) {
        Ok(checkpoint) => Ok(checkpoint),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("checkpoint", checkpoint_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn persist_check(connection: &Connection, input: &PersistCheckInput) -> ArgmaxResult<CheckRun> {
    let started_at = input.started_at.clone().unwrap_or_else(now_iso);
    let mut statement = prepared(
        connection,
        r#"
        INSERT INTO checks (id, workspace_id, command, status, exit_code, summary, started_at, completed_at)
        VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            input.id.as_str(),
            input.workspace_id.as_str(),
            input.command.as_str(),
            input.status.as_str(),
            started_at.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_check_by_id(connection, &input.id)
}

pub fn update_check(
    connection: &Connection,
    check_id: &str,
    input: &UpdateCheckInput,
) -> ArgmaxResult<CheckRun> {
    // completed_at stays NULL while a check is in-flight. Defaulting to
    // now_iso() here would mark every mid-run status/summary update as
    // "completed", silently corrupting the row's lifecycle.
    let mut statement = prepared(
        connection,
        r#"
        UPDATE checks
        SET status = ?, exit_code = ?, summary = ?, completed_at = ?
        WHERE id = ?
        "#,
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((
            input.status.as_str(),
            input.exit_code,
            input.summary.as_deref(),
            input.completed_at.as_deref(),
            check_id,
        ))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("check", check_id));
    }
    find_check_by_id(connection, check_id)
}

pub fn persist_checkpoint(
    connection: &Connection,
    input: &PersistCheckpointInput,
) -> ArgmaxResult<Checkpoint> {
    let created_at = input.created_at.clone().unwrap_or_else(now_iso);
    let mut statement = prepared(
        connection,
        r#"
        INSERT INTO checkpoints (id, workspace_id, label, branch, git_ref, patch_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            input.id.as_str(),
            input.workspace_id.as_str(),
            input.label.as_str(),
            input.branch.as_str(),
            input.git_ref.as_deref(),
            input.patch_path.as_deref(),
            created_at.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_checkpoint_by_id(connection, &input.id)
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
