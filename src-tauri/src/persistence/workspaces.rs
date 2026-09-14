use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;
use specta::Type;

use super::gh::{list_session_prs, SessionPrSummary};
use super::time::now_iso;
use super::{bool_to_i64, json_error, sqlite_error};
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};

#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceViewedObservation {
    pub workspace_id: String,
    pub observed_activity_at: String,
}

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
    /// 'git' for real project checkouts, 'scratch' for repo-less side chats,
    /// 'popup' for the ephemeral "More details" mini-sessions.
    pub kind: String,
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
    /// 'git' | 'scratch' | 'popup' — see `PersistWorkspaceInput::kind`. Every
    /// repo-coupled surface (review, gh, branch chips, sidebar grouping) gates
    /// on this rather than on which UI created the workspace.
    pub kind: String,
    pub dirty: bool,
    pub changed_files: i64,
    pub last_activity_at: String,
    /// Latest workspace activity timestamp a client actually displayed. This
    /// is advanced from an observed snapshot, never from the acknowledgement
    /// request's wall clock, so activity racing the request stays unread.
    pub last_viewed_at: Option<String>,
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
    /// State of the displayed session's primary PR, filled in from canonical
    /// PR state and session evidence on every read path. The renderer merges
    /// workspace deltas by whole-object replacement, so a summary published
    /// with `None` here would erase the sidebar PR marker.
    pub pr_state: Option<String>,
    /// PR number paired with `pr_state`.
    pub pr_number: Option<i64>,
    /// GitHub's authoritative creation timestamp for the paired PR.
    pub pr_created_at: Option<String>,
    /// GitHub's authoritative merge timestamp for the paired PR.
    pub pr_merged_at: Option<String>,
    /// Aggregate checks across the displayed session's open worked PRs:
    /// 'pending' | 'success' | 'failure'. A red PR is something the person
    /// owes the branch, so the Priority section reads this directly.
    pub pr_check_state: Option<String>,
    /// When the poller last saw this PR change — a new head commit, a check
    /// rollup moving, a merge. It is the clock a dismissal of the PR row is
    /// measured against, so that marking a PR done holds until the PR itself
    /// does something new.
    pub pr_activity_at: Option<String>,
    /// All pull requests associated with the chat displayed for this
    /// workspace. Evidence activity determines their stable order.
    #[serde(default)]
    pub prs: Vec<SessionPrSummary>,
    /// Aggregate lifecycle state for the associated pull requests. OPEN wins,
    /// then CLOSED, then MERGED when every terminal PR merged.
    pub pr_summary_state: Option<String>,
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

/// Hard-delete a workspace. Sessions, events, and checks cascade. Only the
/// sync pruner calls this: workspaces Argmax created for its own sessions are
/// archived (a state flip), never deleted.
pub fn delete_workspace(connection: &Connection, workspace_id: &str) -> ArgmaxResult<()> {
    connection
        .prepare_cached("DELETE FROM workspaces WHERE id = ?")
        .map_err(sqlite_error)?
        .execute([workspace_id])
        .map_err(sqlite_error)?;
    Ok(())
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
    let session_id = connection
        .prepare_cached(
            r#"
            SELECT id FROM sessions
            WHERE workspace_id = ?1
            ORDER BY last_activity_at DESC, id DESC
            LIMIT 1
            "#,
        )
        .map_err(sqlite_error)?
        .query_row([workspace.id.as_str()], |row| row.get::<_, String>(0))
        .optional()
        .map_err(sqlite_error)?;
    if let Some(session_id) = session_id {
        workspace.prs = list_session_prs(connection, &session_id)?;
        workspace.pr_summary_state = aggregate_pr_state(&workspace.prs);
        if let Some(primary) = workspace.prs.iter().find(|pr| pr.is_primary) {
            workspace.pr_state = primary.pr_state.clone();
            workspace.pr_number = Some(primary.pr_number);
            workspace.pr_check_state = Some(aggregate_open_worked_checks(&workspace.prs));
            workspace.pr_activity_at = workspace
                .prs
                .iter()
                .filter(|pr| {
                    pr.relationship == "worked"
                        && matches!(pr.pr_state.as_deref(), None | Some("OPEN"))
                })
                .map(|pr| pr.updated_at.as_str())
                .max()
                .map(str::to_owned);
            let milestones = connection
                .prepare_cached(
                    r#"
                    SELECT pr_created_at, pr_merged_at
                    FROM gh_pull_requests prs
                    JOIN sessions ON sessions.id = ?1
                    JOIN workspaces ON workspaces.id = sessions.workspace_id
                    WHERE prs.project_id = workspaces.project_id
                      AND prs.pr_number = ?2
                    "#,
                )
                .map_err(sqlite_error)?
                .query_row((session_id.as_str(), primary.pr_number), |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })
                .optional()
                .map_err(sqlite_error)?;
            if let Some((created_at, merged_at)) = milestones {
                workspace.pr_created_at = created_at;
                workspace.pr_merged_at = merged_at;
            }
            return Ok(());
        }
    }

    Ok(())
}

fn aggregate_pr_state(prs: &[SessionPrSummary]) -> Option<String> {
    let verified = prs.iter().filter(|pr| pr.relationship != "unverified");
    let prs = verified.collect::<Vec<_>>();
    if prs.is_empty() {
        None
    } else if prs
        .iter()
        .any(|pr| matches!(pr.pr_state.as_deref(), None | Some("OPEN")))
    {
        Some("OPEN".to_owned())
    } else if prs
        .iter()
        .all(|pr| pr.pr_state.as_deref() == Some("MERGED"))
    {
        Some("MERGED".to_owned())
    } else {
        Some("CLOSED".to_owned())
    }
}

fn aggregate_open_worked_checks(prs: &[SessionPrSummary]) -> String {
    let states = prs
        .iter()
        .filter(|pr| {
            pr.relationship == "worked" && matches!(pr.pr_state.as_deref(), None | Some("OPEN"))
        })
        .map(|pr| pr.check_state.as_str())
        .collect::<Vec<_>>();
    if states.contains(&"failure") {
        "failure"
    } else if states
        .iter()
        .any(|state| matches!(*state, "pending" | "unknown"))
    {
        "pending"
    } else if states.is_empty() {
        "unknown"
    } else {
        "success"
    }
    .to_owned()
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
          kind, dirty, changed_files, last_activity_at, last_viewed_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
            input.kind.as_str(),
            bool_to_i64(input.dirty),
            input.changed_files,
            timestamp.as_str(),
            timestamp.as_str(),
            timestamp.as_str(),
            timestamp.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_workspace_by_id(connection, &input.id)
}

/// Advances read state to activity timestamps the client actually observed.
/// The transaction makes the comparison and update atomic with concurrent
/// provider activity. It returns only rows whose read state moved.
pub fn mark_workspaces_viewed(
    connection: &Connection,
    observations: &[WorkspaceViewedObservation],
) -> ArgmaxResult<Vec<WorkspaceSummary>> {
    if observations.is_empty() {
        return Ok(Vec::new());
    }
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let mut changed_ids = Vec::new();

    for observation in observations {
        let current_activity: Option<String> = transaction
            .prepare_cached("SELECT last_activity_at FROM workspaces WHERE id = ?")
            .map_err(sqlite_error)?
            .query_row([observation.workspace_id.as_str()], |row| row.get(0))
            .ok();
        // A workspace deleted between the client's snapshot and this call is
        // not an error: skipping it keeps the other observations in the
        // batch, and read state for a row that no longer exists is moot.
        let Some(current_activity) = current_activity else {
            continue;
        };

        if observation.observed_activity_at > current_activity {
            return Err(ArgmaxError::invalid(InvalidInputIssue::at(
                vec!["workspaces".to_owned(), "observedActivityAt".to_owned()],
                "WORKSPACE_ACTIVITY_NOT_OBSERVED",
                "observed activity timestamp is newer than the workspace activity",
            )));
        }

        let changes = transaction
            .prepare_cached(
                r#"
                UPDATE workspaces
                SET last_viewed_at = ?1, updated_at = ?2
                WHERE id = ?3 AND (last_viewed_at IS NULL OR last_viewed_at < ?1)
                "#,
            )
            .map_err(sqlite_error)?
            .execute((
                observation.observed_activity_at.as_str(),
                now_iso(),
                observation.workspace_id.as_str(),
            ))
            .map_err(sqlite_error)?;
        if changes > 0 && !changed_ids.contains(&observation.workspace_id) {
            changed_ids.push(observation.workspace_id.clone());
        }
    }

    transaction.commit().map_err(sqlite_error)?;
    list_workspaces(connection, Some(&changed_ids), changed_ids.len())
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
    // A shared checkout's live branch is only trustworthy while a turn is in
    // flight. Freeze that observation when the session settles so a later
    // branch switch cannot retroactively assign another session's PR.
    connection
        .prepare_cached(
            r#"
            UPDATE sessions
            SET pr_branch_last_active = NULLIF(?1, '')
            WHERE workspace_id = ?2
              AND state IN ('running', 'waiting', 'blocked')
            "#,
        )
        .map_err(sqlite_error)?
        .execute((status.branch.as_str(), workspace_id))
        .map_err(sqlite_error)?;
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
        kind: row.get("kind")?,
        dirty: row.get::<_, i64>("dirty")? == 1,
        changed_files: row.get("changed_files")?,
        last_activity_at: row.get("last_activity_at")?,
        last_viewed_at: row.get("last_viewed_at")?,
        pinned: row.get::<_, i64>("pinned")? == 1,
        priority_dismissed_at: row.get("priority_dismissed_at")?,
        priority_added_at: row.get("priority_added_at")?,
        icon: row.get("icon")?,
        icon_color: row.get("icon_color")?,
        // PR fields are not workspace columns; attach_latest_pr fills them in
        // from gh_pr after the row maps.
        pr_state: None,
        pr_number: None,
        pr_created_at: None,
        pr_merged_at: None,
        pr_check_state: None,
        pr_activity_at: None,
        prs: Vec::new(),
        pr_summary_state: None,
    })
}
