use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;

use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GhPrRecord {
    pub session_id: String,
    pub pr_number: i64,
    pub head_sha: String,
    pub last_seen_check_state: String,
    pub updated_at: String,
    pub pr_state: Option<String>,
    pub notified_at: Option<String>,
}

pub fn upsert_gh_pr(connection: &Connection, input: &GhPrRecord) -> ArgmaxResult<GhPrRecord> {
    // Reset notified_at when head_sha rotates so a new commit is treated
    // as a fresh notification target; preserve it on a same-sha update so
    // unrelated metadata changes don't replay the notification.
    let mut statement = connection.prepare_cached(r#"
        INSERT INTO gh_pr (session_id, pr_number, head_sha, last_seen_check_state, updated_at, pr_state)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, pr_number) DO UPDATE SET
          head_sha = excluded.head_sha,
          last_seen_check_state = excluded.last_seen_check_state,
          updated_at = excluded.updated_at,
          pr_state = excluded.pr_state,
          notified_at = CASE
            WHEN excluded.head_sha = gh_pr.head_sha THEN gh_pr.notified_at
            ELSE NULL
          END
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            input.session_id.as_str(),
            input.pr_number,
            input.head_sha.as_str(),
            input.last_seen_check_state.as_str(),
            input.updated_at.as_str(),
            input.pr_state.as_deref(),
        ))
        .map_err(sqlite_error)?;

    find_gh_pr(connection, &input.session_id, input.pr_number)
        .map(|row| row.unwrap_or(input.clone()))
}

pub fn list_gh_pr_for_session(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<GhPrRecord>> {
    let mut statement = connection
        .prepare_cached("SELECT * FROM gh_pr WHERE session_id = ? ORDER BY pr_number ASC")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([session_id], row_to_gh_pr)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn list_open_gh_pr_session_ids(connection: &Connection) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection.prepare_cached("SELECT DISTINCT session_id AS id FROM gh_pr WHERE pr_state IS NULL OR pr_state = 'OPEN'",
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>("id"))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// The most-recent PR for a single workspace: the `gh_pr` row with the latest
/// `updated_at` across every session belonging to the workspace. Returns the
/// `(pr_state, pr_number)` pair, or `None` when the workspace has no PR.
pub fn latest_pr_for_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> ArgmaxResult<Option<(Option<String>, i64)>> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT gh_pr.pr_state AS pr_state, gh_pr.pr_number AS pr_number
        FROM gh_pr
        JOIN sessions ON sessions.id = gh_pr.session_id
        WHERE sessions.workspace_id = ?
        ORDER BY gh_pr.updated_at DESC, gh_pr.pr_number DESC
        LIMIT 1
        "#,
        )
        .map_err(sqlite_error)?;
    match statement.query_row([workspace_id], |row| {
        Ok((
            row.get::<_, Option<String>>("pr_state")?,
            row.get::<_, i64>("pr_number")?,
        ))
    }) {
        Ok(pair) => Ok(Some(pair)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn mark_gh_pr_notified(
    connection: &Connection,
    session_id: &str,
    pr_number: i64,
    head_sha: &str,
    notified_at: &str,
) -> ArgmaxResult<()> {
    let mut statement = connection
        .prepare_cached(
            r#"
        UPDATE gh_pr
        SET notified_at = ?
        WHERE session_id = ? AND pr_number = ? AND head_sha = ?
        "#,
        )
        .map_err(sqlite_error)?;
    let changes = statement
        .execute((notified_at, session_id, pr_number, head_sha))
        .map_err(sqlite_error)?;
    if changes == 0 {
        // The head_sha rotated between read and mark — the notification
        // belongs to a stale commit. Surface it so the caller can decide
        // whether to retry against the new sha or drop the notification.
        return Err(ArgmaxError::service(
            "GH_PR_STALE_HEAD_SHA",
            format!(
                "gh_pr row for session {session_id} pr {pr_number} no longer at head_sha {head_sha}",
            ),
        ));
    }
    Ok(())
}

fn find_gh_pr(
    connection: &Connection,
    session_id: &str,
    pr_number: i64,
) -> ArgmaxResult<Option<GhPrRecord>> {
    let mut statement = connection
        .prepare_cached("SELECT * FROM gh_pr WHERE session_id = ? AND pr_number = ?")
        .map_err(sqlite_error)?;
    match statement.query_row((session_id, pr_number), row_to_gh_pr) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

fn row_to_gh_pr(row: &Row<'_>) -> rusqlite::Result<GhPrRecord> {
    Ok(GhPrRecord {
        session_id: row.get("session_id")?,
        pr_number: row.get("pr_number")?,
        head_sha: row.get("head_sha")?,
        last_seen_check_state: row.get("last_seen_check_state")?,
        updated_at: row.get("updated_at")?,
        pr_state: row.get("pr_state")?,
        notified_at: row.get("notified_at")?,
    })
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}
