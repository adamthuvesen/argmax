use rusqlite::{Connection, Row};
use serde::Serialize;

use super::prepared::prepared;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq, Serialize)]
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
        "SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?",
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map([limit as i64], approval_row_to_request)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn list_pending_approvals(
    connection: &Connection,
    limit: usize,
) -> ArgmaxResult<Vec<ApprovalRequest>> {
    let mut statement = prepared(
        connection,
        "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?",
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

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}
