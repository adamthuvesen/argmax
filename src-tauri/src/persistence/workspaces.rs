use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;
use specta::Type;
use std::collections::HashMap;

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
            attach_latest_prs(connection, &mut workspaces)?;
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
            attach_latest_prs(connection, &mut workspaces)?;
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

/// Batched equivalent of calling `attach_latest_pr` once per row. `list_workspaces`
/// used to run two prepared statements per workspace (up to `DASHBOARD_ROW_LIMIT`
/// rows); this runs two statements total for the whole page. Output must match
/// `attach_latest_pr` exactly for every row, including "latest session" and PR
/// ordering/tie-breaking.
fn attach_latest_prs(
    connection: &Connection,
    workspaces: &mut [WorkspaceSummary],
) -> ArgmaxResult<()> {
    if workspaces.is_empty() {
        return Ok(());
    }
    let workspace_ids: Vec<&str> = workspaces.iter().map(|w| w.id.as_str()).collect();
    let ids_json = serde_json::to_string(&workspace_ids).map_err(json_error)?;

    // Latest session per workspace, one row per workspace via a per-partition
    // row number — the same `ORDER BY last_activity_at DESC, id DESC LIMIT 1`
    // tie-break as the single-row lookup above, computed for every requested
    // workspace at once instead of one query per row.
    let mut latest_session_of: HashMap<String, String> = HashMap::new();
    {
        let mut statement = connection
            .prepare_cached(
                r#"
                SELECT workspace_id, id FROM (
                  SELECT workspace_id, id,
                         ROW_NUMBER() OVER (
                           PARTITION BY workspace_id
                           ORDER BY last_activity_at DESC, id DESC
                         ) AS rn
                  FROM sessions
                  WHERE workspace_id IN (SELECT value FROM json_each(?1))
                )
                WHERE rn = 1
                "#,
            )
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map([ids_json.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(sqlite_error)?;
        for row in rows {
            let (workspace_id, session_id) = row.map_err(sqlite_error)?;
            latest_session_of.insert(workspace_id, session_id);
        }
    }
    if latest_session_of.is_empty() {
        return Ok(());
    }

    let session_ids: Vec<&str> = latest_session_of.values().map(String::as_str).collect();
    let sessions_json = serde_json::to_string(&session_ids).map_err(json_error)?;

    // Every non-dismissed PR link for those sessions, in the same relationship
    // + relationship-state + activity ordering `list_session_prs` uses for a
    // single session — `links.session_id` is only a leading sort key so rows
    // stay grouped per session, it never reorders rows within a session. The
    // canonical PR's `pr_created_at` / `pr_merged_at` ride along on every row
    // so the primary row's milestones come from this same join instead of a
    // third query (the single-row path's `milestones` lookup above resolves
    // to the identical `gh_pull_requests` row via the session's workspace).
    // (session PR summary, its PR's created-at, its PR's merged-at)
    type PrRow = (SessionPrSummary, Option<String>, Option<String>);
    let mut prs_by_session: HashMap<String, Vec<PrRow>> = HashMap::new();
    {
        let mut statement = connection
            .prepare_cached(
                r#"
                SELECT links.session_id,
                       links.pr_number,
                       prs.url,
                       prs.title,
                       prs.pr_state,
                       prs.head_ref_name,
                       links.relationship,
                       links.activity_at,
                       prs.updated_at,
                       prs.last_seen_check_state,
                       links.is_pinned,
                       prs.refresh_error,
                       prs.pr_created_at,
                       prs.pr_merged_at
                FROM session_pr_links links
                JOIN gh_pull_requests prs
                  ON prs.project_id = links.project_id
                 AND prs.pr_number = links.pr_number
                WHERE links.session_id IN (SELECT value FROM json_each(?1))
                  AND links.dismissed_at IS NULL
                ORDER BY
                  links.session_id,
                  links.is_pinned DESC,
                  CASE
                    WHEN links.relationship = 'worked'
                      AND (prs.pr_state IS NULL OR prs.pr_state = 'OPEN') THEN 0
                    WHEN links.relationship = 'worked' THEN 1
                    WHEN links.relationship = 'referenced' THEN 2
                    ELSE 3
                  END,
                  links.activity_at DESC,
                  links.pr_number DESC
                "#,
            )
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map([sessions_json.as_str()], |row| {
                let session_id: String = row.get(0)?;
                let summary = SessionPrSummary {
                    session_id: session_id.clone(),
                    pr_number: row.get(1)?,
                    url: row.get(2)?,
                    title: row.get(3)?,
                    pr_state: row.get(4)?,
                    head_ref_name: row.get(5)?,
                    relationship: row.get(6)?,
                    activity_at: row.get(7)?,
                    updated_at: row.get(8)?,
                    check_state: row.get(9)?,
                    is_primary: false,
                    is_pinned: row.get::<_, i64>(10)? != 0,
                    refresh_error: row.get(11)?,
                };
                let pr_created_at: Option<String> = row.get(12)?;
                let pr_merged_at: Option<String> = row.get(13)?;
                Ok((session_id, summary, pr_created_at, pr_merged_at))
            })
            .map_err(sqlite_error)?;
        for row in rows {
            let (session_id, summary, pr_created_at, pr_merged_at) = row.map_err(sqlite_error)?;
            prs_by_session.entry(session_id).or_default().push((
                summary,
                pr_created_at,
                pr_merged_at,
            ));
        }
    }

    for workspace in workspaces.iter_mut() {
        let Some(session_id) = latest_session_of.get(&workspace.id) else {
            continue;
        };
        let Some(rows) = prs_by_session.remove(session_id) else {
            continue;
        };

        // Mirrors `list_session_prs`: the first row that is pinned, or whose
        // relationship isn't "unverified", is the primary.
        let mut primary_index = None;
        let mut primary_milestones: (Option<String>, Option<String>) = (None, None);
        let mut summaries = Vec::with_capacity(rows.len());
        for (index, (summary, pr_created_at, pr_merged_at)) in rows.into_iter().enumerate() {
            if primary_index.is_none()
                && (summary.is_pinned || summary.relationship != "unverified")
            {
                primary_index = Some(index);
                primary_milestones = (pr_created_at, pr_merged_at);
            }
            summaries.push(summary);
        }

        workspace.prs = summaries;
        workspace.pr_summary_state = aggregate_pr_state(&workspace.prs);
        if let Some(index) = primary_index {
            workspace.prs[index].is_primary = true;
            let primary = &workspace.prs[index];
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
            workspace.pr_created_at = primary_milestones.0;
            workspace.pr_merged_at = primary_milestones.1;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::gh::{record_session_pr_evidence, store_gh_pr_observation, GhPrRecord};
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{
        persist_session, update_session_state, PersistSessionInput, SessionStateInput,
    };
    use crate::persistence::Database;
    use crate::sessions::state::SessionState;

    fn add_project(connection: &Connection, id: &str) {
        persist_project(
            connection,
            &PersistProjectInput {
                id: id.to_owned(),
                name: id.to_owned(),
                repo_path: format!("/tmp/{id}"),
                current_branch: "main".to_owned(),
                default_branch: Some("main".to_owned()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: format!("/tmp/{id}/worktrees"),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("persist project");
    }

    fn add_workspace(connection: &Connection, project_id: &str, workspace_id: &str) {
        persist_workspace(
            connection,
            &PersistWorkspaceInput {
                id: workspace_id.to_owned(),
                project_id: project_id.to_owned(),
                task_label: workspace_id.to_owned(),
                branch: "feature/a".to_owned(),
                base_ref: "main".to_owned(),
                path: format!("/tmp/{project_id}/{workspace_id}"),
                state: "running".to_owned(),
                shared_workspace: false,
                kind: "git".to_owned(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace");
    }

    /// Adds a session and stamps its `last_activity_at`, so tests can control
    /// which session in a workspace is "latest" without racing the clock.
    fn add_session_at(connection: &Connection, workspace_id: &str, session_id: &str, at: &str) {
        persist_session(
            connection,
            &PersistSessionInput {
                id: session_id.to_owned(),
                workspace_id: workspace_id.to_owned(),
                provider: "codex".to_owned(),
                model_label: "Default".to_owned(),
                model_id: "default".to_owned(),
                reasoning_effort: None,
                permission_mode: None,
                agent_mode: None,
                prompt: "test".to_owned(),
                state: SessionState::Running,
            },
        )
        .expect("persist session");
        update_session_state(
            connection,
            session_id,
            &SessionStateInput::transition(SessionState::Running).active_at(at.to_owned()),
        )
        .expect("stamp last_activity_at");
    }

    fn worked_pr(session_id: &str, pr_number: i64, created_at: &str) -> GhPrRecord {
        GhPrRecord {
            session_id: session_id.to_owned(),
            pr_number,
            head_sha: "sha".to_owned(),
            last_seen_check_state: "success".to_owned(),
            updated_at: created_at.to_owned(),
            pr_state: Some("OPEN".to_owned()),
            notified_at: None,
            pr_created_at: Some(created_at.to_owned()),
            pr_merged_at: None,
            head_ref_name: Some("feature/a".to_owned()),
        }
    }

    /// Pins the batched `attach_latest_prs` path (used by `list_workspaces`)
    /// against the exact behaviour `attach_latest_pr` has for a single
    /// workspace: when a workspace has several sessions, only the most
    /// recently active session's PRs are attached, and one workspace's PR
    /// evidence never leaks onto a sibling workspace's summary.
    #[test]
    fn list_workspaces_attaches_only_the_latest_sessions_pr() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");

        add_workspace(&connection, "p1", "w1");
        add_session_at(&connection, "w1", "s1-old", "2025-01-01T00:00:00.000Z");
        add_session_at(&connection, "w1", "s2-new", "2025-06-01T00:00:00.000Z");

        add_workspace(&connection, "p1", "w2");
        add_session_at(&connection, "w2", "s3", "2025-03-01T00:00:00.000Z");

        // The older session in w1 gets its own PR — this must not surface on
        // the workspace once a newer session in the same workspace also has one.
        record_session_pr_evidence(
            &connection,
            "s1-old",
            7,
            "worked",
            "evidence-old",
            "2025-01-01T00:00:00.000Z",
        )
        .expect("record old evidence");
        store_gh_pr_observation(
            &connection,
            &worked_pr("s1-old", 7, "2025-01-01T00:00:00.000Z"),
        )
        .expect("store old pr");

        record_session_pr_evidence(
            &connection,
            "s2-new",
            42,
            "worked",
            "evidence-new",
            "2025-06-01T00:00:00.000Z",
        )
        .expect("record new evidence");
        store_gh_pr_observation(
            &connection,
            &worked_pr("s2-new", 42, "2025-06-01T12:00:00.000Z"),
        )
        .expect("store new pr");

        let workspaces = list_workspaces(&connection, None, 10).expect("list workspaces");

        let w1 = workspaces
            .iter()
            .find(|w| w.id == "w1")
            .expect("w1 present");
        assert_eq!(
            w1.pr_number,
            Some(42),
            "w1 must show its latest session's PR"
        );
        assert_eq!(w1.pr_state.as_deref(), Some("OPEN"));
        assert_eq!(
            w1.pr_created_at.as_deref(),
            Some("2025-06-01T12:00:00.000Z")
        );
        assert_eq!(w1.prs.len(), 1);
        assert_eq!(w1.prs[0].session_id, "s2-new");

        let w2 = workspaces
            .iter()
            .find(|w| w.id == "w2")
            .expect("w2 present");
        assert_eq!(w2.pr_number, None);
        assert!(w2.prs.is_empty());
        assert_eq!(w2.pr_summary_state, None);
    }
}
