use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;

use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq)]
pub struct PersistApprovalInput {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub provider: String,
    pub provider_invocation_id: Option<String>,
    pub provider_request_id: Option<String>,
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
    pub provider_invocation_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub risk_level: String,
    pub status: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

pub fn persist_approval(
    connection: &Connection,
    input: &PersistApprovalInput,
) -> ArgmaxResult<ApprovalRequest> {
    let created_at = input.created_at.clone().unwrap_or_else(now_iso);
    let mut statement = connection.prepare_cached(r#"
        INSERT INTO approvals (id, session_id, command, cwd, provider, provider_invocation_id, provider_request_id, risk_level, status, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
            input.provider_invocation_id.as_deref(),
            input.provider_request_id.as_deref(),
            input.risk_level.as_str(),
            input.status.as_str(),
            created_at.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_approval_by_id(connection, &input.id)
}

/// Find a provider-originated request regardless of its terminal status. A
/// provider correlation id is the only identity strong enough to make replay
/// idempotent after an approval has already been resolved or cancelled.
pub fn find_approval_by_provider_request(
    connection: &Connection,
    session_id: &str,
    provider: &str,
    provider_invocation_id: &str,
    provider_request_id: &str,
) -> ArgmaxResult<Option<ApprovalRequest>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT * FROM approvals WHERE session_id = ? AND provider = ? AND provider_invocation_id = ? AND provider_request_id = ? LIMIT 1",
        )
        .map_err(sqlite_error)?;
    match statement.query_row(
        (
            session_id,
            provider,
            provider_invocation_id,
            provider_request_id,
        ),
        approval_row_to_request,
    ) {
        Ok(approval) => Ok(Some(approval)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn find_pending_approval(
    connection: &Connection,
    input: &FindPendingApprovalInput,
) -> ArgmaxResult<Option<ApprovalRequest>> {
    let mut statement = connection
        .prepare_cached(
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
    let existing = find_approval_by_id(connection, approval_id)?;
    if existing.status == "pending"
        && existing.provider_request_id.is_some()
        && existing.provider_invocation_id.is_none()
    {
        return Err(ArgmaxError::service(
            "APPROVAL_LEGACY_UNSUPPORTED",
            format!(
                "Approval {} belongs to a provider invocation that cannot be resumed safely.",
                existing.id
            ),
        ));
    }
    let mut statement = connection
        .prepare_cached(
            "UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
        )
        .map_err(sqlite_error)?;
    let changed = statement
        .execute((status, now_iso(), approval_id))
        .map_err(sqlite_error)?;
    if changed == 0 {
        let approval = find_approval_by_id(connection, approval_id)?;
        return Err(ArgmaxError::service(
            "APPROVAL_NOT_PENDING",
            format!(
                "Approval {} is already {} and cannot be resolved again.",
                approval.id, approval.status
            ),
        ));
    }
    find_approval_by_id(connection, approval_id)
}

pub fn list_pending_approvals(
    connection: &Connection,
    limit: usize,
) -> ArgmaxResult<Vec<ApprovalRequest>> {
    let mut statement = connection.prepare_cached("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map([limit as i64], approval_row_to_request)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn list_approvals_for_workspace(
    connection: &Connection,
    workspace_id: &str,
    status: &str,
) -> ArgmaxResult<Vec<ApprovalRequest>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT a.* FROM approvals a JOIN sessions s ON s.id = a.session_id WHERE s.workspace_id = ? AND a.status = ? ORDER BY a.created_at DESC, a.id DESC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map((workspace_id, status), approval_row_to_request)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn list_approvals_for_session(
    connection: &Connection,
    session_id: &str,
    status: &str,
) -> ArgmaxResult<Vec<ApprovalRequest>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT * FROM approvals WHERE session_id = ? AND status = ? ORDER BY created_at DESC, id DESC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map((session_id, status), approval_row_to_request)
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
        provider_invocation_id: row.get("provider_invocation_id")?,
        provider_request_id: row.get("provider_request_id")?,
        risk_level: row.get("risk_level")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        resolved_at: row.get("resolved_at")?,
    })
}

pub fn find_approval_by_id(
    connection: &Connection,
    approval_id: &str,
) -> ArgmaxResult<ApprovalRequest> {
    let mut statement = connection
        .prepare_cached("SELECT * FROM approvals WHERE id = ?")
        .map_err(sqlite_error)?;
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
