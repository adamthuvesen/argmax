use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;

use super::bool_to_i64;
use super::gh::latest_pr_for_workspace;
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
    /// When the user marked this workspace done in the sidebar's Priority
    /// section. The dismissal is spent (ignored by the renderer) once the
    /// workspace's session attention changes again — compare against
    /// `SessionSummary.attention_changed_at`.
    pub priority_dismissed_at: Option<String>,
    /// When the user manually added this workspace to the Priority section.
    /// Manual entries need no attention and never age out; cleared by an
    /// explicit remove or a dismissal.
    pub priority_added_at: Option<String>,
    /// State of the most-recent PR across this workspace's sessions. Filled in
    /// from `gh_pr` on every read path — the renderer merges workspace deltas
    /// by whole-object replacement, so a summary published with `None` here
    /// would erase the sidebar PR marker.
    pub pr_state: Option<String>,
    /// PR number paired with `pr_state`.
    pub pr_number: Option<i64>,
    /// Curated Lucide icon name the user picked for this row's sidebar glyph.
    /// `None` keeps the row on its live status marker.
    pub icon: Option<String>,
    /// Named palette entry paired with `icon`.
    pub icon_color: Option<String>,
}

pub fn list_workspaces(
    connection: &Connection,
    workspace_ids: Option<&[String]>,
    limit: usize,
) -> ArgmaxResult<Vec<WorkspaceSummary>> {
    match workspace_ids {
        Some(ids) if !ids.is_empty() => {
            let json = serde_json::to_string(ids).map_err(json_error)?;
            let mut statement = connection.prepare_cached("SELECT * FROM workspaces WHERE id IN (SELECT value FROM json_each(?)) ORDER BY last_activity_at DESC, id DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map((json, limit as i64), workspace_row_to_summary)
                .map_err(sqlite_error)?;
            let mut workspaces = rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)?;
            for workspace in &mut workspaces {
                attach_latest_pr(connection, workspace)?;
            }
            Ok(workspaces)
        }
        _ => {
            let mut statement = connection
                .prepare_cached(
                    "SELECT * FROM workspaces ORDER BY last_activity_at DESC, id DESC LIMIT ?",
                )
                .map_err(sqlite_error)?;
            let rows = statement
                .query_map([limit as i64], workspace_row_to_summary)
                .map_err(sqlite_error)?;
            let mut workspaces = rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)?;
            for workspace in &mut workspaces {
                attach_latest_pr(connection, workspace)?;
            }
            Ok(workspaces)
        }
    }
}

pub fn find_workspace_by_id(
    connection: &Connection,
    workspace_id: &str,
) -> ArgmaxResult<WorkspaceSummary> {
    let mut statement = connection
        .prepare_cached("SELECT * FROM workspaces WHERE id = ?")
        .map_err(sqlite_error)?;
    match statement.query_row([workspace_id], workspace_row_to_summary) {
        Ok(mut workspace) => {
            attach_latest_pr(connection, &mut workspace)?;
            Ok(workspace)
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("workspace", workspace_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

fn attach_latest_pr(connection: &Connection, workspace: &mut WorkspaceSummary) -> ArgmaxResult<()> {
    if let Some((pr_state, pr_number)) = latest_pr_for_workspace(connection, &workspace.id)? {
        workspace.pr_state = pr_state;
        workspace.pr_number = Some(pr_number);
    }
    Ok(())
}

pub fn persist_workspace(
    connection: &Connection,
    input: &PersistWorkspaceInput,
) -> ArgmaxResult<WorkspaceSummary> {
    let timestamp = now_iso();
    let mut statement = connection
        .prepare_cached(
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
        let mut statement = connection
            .prepare_cached("UPDATE workspaces SET state = ?, updated_at = ? WHERE id = ?")
            .map_err(sqlite_error)?;
        statement
            .execute((state, timestamp.as_str(), workspace_id))
            .map_err(sqlite_error)?
    } else {
        let mut statement = connection.prepare_cached("UPDATE workspaces SET state = ?, last_activity_at = ?, updated_at = ? WHERE id = ?",
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
    // A status read is an observation, not activity. Callers that have a
    // domain timestamp (for example an explicit provider event) can still
    // supply one, while watcher refreshes keep the existing recency value.
    let timestamp = now_iso();
    let mut statement = connection
        .prepare_cached(
            r#"
        UPDATE workspaces
        SET branch = ?, dirty = ?, changed_files = ?, last_activity_at = COALESCE(?, last_activity_at), updated_at = ?
        WHERE id = ?
        "#,
        )
        .map_err(sqlite_error)?;
    let changes = statement
        .execute((
            status.branch.as_str(),
            bool_to_i64(status.dirty),
            status.changed_files,
            status.last_activity_at.as_deref(),
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
    let mut statement = connection
        .prepare_cached("UPDATE workspaces SET pinned = ?, updated_at = ? WHERE id = ?")
        .map_err(sqlite_error)?;
    let changes = statement
        .execute((bool_to_i64(pinned), now_iso(), workspace_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("workspace", workspace_id));
    }
    find_workspace_by_id(connection, workspace_id)
}

/// Sets (or clears) the custom sidebar glyph for a workspace. Passing `None`
/// for both values resets the row to its live status marker.
pub fn set_workspace_icon(
    connection: &Connection,
    workspace_id: &str,
    icon: Option<&str>,
    icon_color: Option<&str>,
) -> ArgmaxResult<WorkspaceSummary> {
    let mut statement = connection
        .prepare_cached(
            "UPDATE workspaces SET icon = ?, icon_color = ?, updated_at = ? WHERE id = ?",
        )
        .map_err(sqlite_error)?;
    let changes = statement
        .execute((icon, icon_color, now_iso(), workspace_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("workspace", workspace_id));
    }
    find_workspace_by_id(connection, workspace_id)
}

/// Removes (or restores) a workspace from the sidebar's Priority section.
/// Dismissing stamps the current time and also clears a manual add — "remove
/// from priority" means remove, whichever door the row came in through.
pub fn set_workspace_priority_dismissed(
    connection: &Connection,
    workspace_id: &str,
    dismissed: bool,
) -> ArgmaxResult<WorkspaceSummary> {
    let timestamp = now_iso();
    let dismissed_at = dismissed.then(|| timestamp.clone());
    let mut statement = connection
        .prepare_cached(
            r#"
        UPDATE workspaces
        SET priority_dismissed_at = ?1,
            priority_added_at = CASE WHEN ?1 IS NULL THEN priority_added_at ELSE NULL END,
            updated_at = ?2
        WHERE id = ?3
        "#,
        )
        .map_err(sqlite_error)?;
    let changes = statement
        .execute((dismissed_at.as_deref(), timestamp.as_str(), workspace_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("workspace", workspace_id));
    }
    find_workspace_by_id(connection, workspace_id)
}

/// Manually adds (or removes) a workspace to the Priority section. Adding
/// clears any standing dismissal so the row actually appears.
pub fn set_workspace_priority_added(
    connection: &Connection,
    workspace_id: &str,
    added: bool,
) -> ArgmaxResult<WorkspaceSummary> {
    let timestamp = now_iso();
    let added_at = added.then(|| timestamp.clone());
    let mut statement = connection
        .prepare_cached(
            r#"
        UPDATE workspaces
        SET priority_added_at = ?1,
            priority_dismissed_at = CASE WHEN ?1 IS NULL THEN priority_dismissed_at ELSE NULL END,
            updated_at = ?2
        WHERE id = ?3
        "#,
        )
        .map_err(sqlite_error)?;
    let changes = statement
        .execute((added_at.as_deref(), timestamp.as_str(), workspace_id))
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
    let mut statement = connection.prepare_cached("UPDATE workspaces SET task_label = ?, task_label_auto = 0, updated_at = ? WHERE id = ?",
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
    let mut statement = connection.prepare_cached("UPDATE workspaces SET task_label = ?, updated_at = ? WHERE id = ? AND task_label_auto = 1",
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
        priority_dismissed_at: row.get("priority_dismissed_at")?,
        priority_added_at: row.get("priority_added_at")?,
        icon: row.get("icon")?,
        icon_color: row.get("icon_color")?,
        // PR fields are not workspace columns; attach_latest_pr fills them in
        // from gh_pr after the row maps.
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
