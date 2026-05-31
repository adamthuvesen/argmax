use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;

use super::prepared::prepared;
use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq)]
pub struct PersistApprovalInput {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub provider: String,
    pub risk_level: String,
    pub status: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FindPendingApprovalInput {
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub provider: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub provider: String,
    pub risk_level: String,
    pub status: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

pub fn list_approvals(connection: &Connection, limit: usize) -> ArgmaxResult<Vec<ApprovalRequest>> {
    let mut statement = prepared(
        connection,
        "SELECT * FROM approvals ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map([limit as i64], approval_row_to_request)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn persist_approval(
    connection: &Connection,
    input: &PersistApprovalInput,
) -> ArgmaxResult<ApprovalRequest> {
    let created_at = input.created_at.clone().unwrap_or_else(now_iso);
    let mut statement = prepared(
        connection,
        r#"
        INSERT INTO approvals (id, session_id, command, cwd, provider, risk_level, status, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            input.id.as_str(),
            input.session_id.as_str(),
            input.command.as_str(),
            input.cwd.as_str(),
            input.provider.as_str(),
            input.risk_level.as_str(),
            input.status.as_str(),
            created_at.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_approval_by_id(connection, &input.id)
}

pub fn find_pending_approval(
    connection: &Connection,
    input: &FindPendingApprovalInput,
) -> ArgmaxResult<Option<ApprovalRequest>> {
    let mut statement = prepared(
        connection,
        r#"
        SELECT * FROM approvals
        WHERE session_id = ? AND command = ? AND cwd = ? AND provider = ? AND status = 'pending'
        LIMIT 1
        "#,
    )
    .map_err(sqlite_error)?;
    match statement.query_row(
        (
            input.session_id.as_str(),
            input.command.as_str(),
            input.cwd.as_str(),
            input.provider.as_str(),
        ),
        approval_row_to_request,
    ) {
        Ok(approval) => Ok(Some(approval)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn resolve_approval(
    connection: &Connection,
    approval_id: &str,
    status: &str,
) -> ArgmaxResult<ApprovalRequest> {
    let mut statement = prepared(
        connection,
        "UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    statement
        .execute((status, now_iso(), approval_id))
        .map_err(sqlite_error)?;
    find_approval_by_id(connection, approval_id)
}

pub fn list_pending_approvals(
    connection: &Connection,
    limit: usize,
) -> ArgmaxResult<Vec<ApprovalRequest>> {
    let mut statement = prepared(
        connection,
        "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map([limit as i64], approval_row_to_request)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

fn approval_row_to_request(row: &Row<'_>) -> rusqlite::Result<ApprovalRequest> {
    Ok(ApprovalRequest {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        command: row.get("command")?,
        cwd: row.get("cwd")?,
        provider: row.get("provider")?,
        risk_level: row.get("risk_level")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        resolved_at: row.get("resolved_at")?,
    })
}

fn find_approval_by_id(
    connection: &Connection,
    approval_id: &str,
) -> ArgmaxResult<ApprovalRequest> {
    let mut statement =
        prepared(connection, "SELECT * FROM approvals WHERE id = ?").map_err(sqlite_error)?;
    match statement.query_row([approval_id], approval_row_to_request) {
        Ok(approval) => Ok(approval),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("approval", approval_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}
