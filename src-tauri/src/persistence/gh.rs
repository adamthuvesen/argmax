use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;

use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GhPrRecord {
    /// The session that observed this PR. Provenance only — sidebar markers
    /// resolve by `head_ref_name`, not by this id.
    pub session_id: String,
    pub pr_number: i64,
    pub head_sha: String,
    pub last_seen_check_state: String,
    pub updated_at: String,
    pub pr_state: Option<String>,
    pub notified_at: Option<String>,
    /// Branch the PR was opened from, per `gh pr view --json headRefName`.
    /// Null on rows written before the branch was recorded; those still attach
    /// to the observing workspace so a merged PR does not lose its marker.
    pub head_ref_name: Option<String>,
}

pub fn upsert_gh_pr(connection: &Connection, input: &GhPrRecord) -> ArgmaxResult<GhPrRecord> {
    // Reset notified_at when head_sha rotates so a new commit is treated
    // as a fresh notification target; preserve it on a same-sha update so
    // unrelated metadata changes don't replay the notification.
    let mut statement = connection.prepare_cached(r#"
        INSERT INTO gh_pr (session_id, pr_number, head_sha, last_seen_check_state, updated_at, pr_state, head_ref_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, pr_number) DO UPDATE SET
          head_sha = excluded.head_sha,
          last_seen_check_state = excluded.last_seen_check_state,
          updated_at = excluded.updated_at,
          pr_state = excluded.pr_state,
          head_ref_name = excluded.head_ref_name,
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
            input.head_ref_name.as_deref(),
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

/// The most-recent PR opened from `branch` in `project_id`, whichever session
/// happened to observe it. A PR is a property of its head branch, so every
/// workspace sitting on that branch resolves the same PR — including the ones
/// whose own sessions were idle when the poller last looked.
///
/// Scoped by project because branch names are only unique within a repo:
/// `adam/fix-thing` in two different repos are two different branches.
pub fn latest_pr_for_branch(
    connection: &Connection,
    project_id: &str,
    branch: &str,
) -> ArgmaxResult<Option<GhPrRecord>> {
    if branch.is_empty() {
        return Ok(None);
    }
    query_latest_pr(
        connection,
        r#"
        SELECT gh_pr.*
        FROM gh_pr
        JOIN sessions ON sessions.id = gh_pr.session_id
        JOIN workspaces ON workspaces.id = sessions.workspace_id
        WHERE workspaces.project_id = ?
          AND gh_pr.head_ref_name = ?
        ORDER BY gh_pr.updated_at DESC, gh_pr.pr_number DESC
        LIMIT 1
        "#,
        (project_id, branch),
    )
}

/// Sidebar marker for one workspace: the latest PR on this workspace's current
/// branch in the same project, or — for rows recorded before the branch was
/// stored — a PR this workspace's own sessions observed.
pub fn latest_pr_for_workspace(
    connection: &Connection,
    workspace_id: &str,
    project_id: &str,
    branch: &str,
) -> ArgmaxResult<Option<GhPrRecord>> {
    query_latest_pr(
        connection,
        r#"
        SELECT gh_pr.*
        FROM gh_pr
        JOIN sessions ON sessions.id = gh_pr.session_id
        JOIN workspaces ON workspaces.id = sessions.workspace_id
        WHERE workspaces.project_id = ?1
          AND (
            (?2 != '' AND gh_pr.head_ref_name = ?2)
            OR (gh_pr.head_ref_name IS NULL AND sessions.workspace_id = ?3)
          )
        ORDER BY gh_pr.updated_at DESC, gh_pr.pr_number DESC
        LIMIT 1
        "#,
        (project_id, branch, workspace_id),
    )
}

fn query_latest_pr(
    connection: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> ArgmaxResult<Option<GhPrRecord>> {
    let mut statement = connection.prepare_cached(sql).map_err(sqlite_error)?;
    match statement.query_row(params, row_to_gh_pr) {
        Ok(record) => Ok(Some(record)),
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
        head_ref_name: row.get("head_ref_name")?,
    })
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}
