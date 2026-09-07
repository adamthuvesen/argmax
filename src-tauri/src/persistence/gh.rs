use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;
use specta::Type;

use super::sqlite_error;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrAttribution {
    Explicit,
    Inferred,
}

impl PrAttribution {
    fn as_str(self) -> &'static str {
        match self {
            Self::Explicit => "explicit",
            Self::Inferred => "inferred",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GhPrRecord {
    /// The session that observed this PR.
    pub session_id: String,
    pub pr_number: i64,
    pub head_sha: String,
    pub last_seen_check_state: String,
    pub updated_at: String,
    pub pr_state: Option<String>,
    pub notified_at: Option<String>,
    /// GitHub's authoritative PR creation timestamp.
    pub pr_created_at: Option<String>,
    /// GitHub's authoritative merge timestamp. Null until the PR is merged.
    pub pr_merged_at: Option<String>,
    /// Branch the PR was opened from, per `gh pr view --json headRefName`.
    /// Legacy rows without a branch retain a fallback on isolated workspaces.
    pub head_ref_name: Option<String>,
}

/// Record one GitHub observation and, when its provenance is trustworthy,
/// associate it with the observing session. GitHub-owned fields fan out to
/// every existing row for this PR in the same project, even when a new
/// inferred association is rejected. This keeps merge state coherent without
/// allowing a shared checkout's later HEAD to rewrite session history.
pub fn record_gh_pr_observation(
    connection: &Connection,
    input: &GhPrRecord,
    attribution: PrAttribution,
) -> ArgmaxResult<Option<GhPrRecord>> {
    let context = session_pr_context(connection, &input.session_id)?;
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let effective_input = effective_project_pr_record(&transaction, &context.project_id, input)?;

    sync_project_pr_rows(&transaction, &context.project_id, &effective_input)?;

    let existing_attribution = transaction
        .prepare_cached("SELECT attribution FROM gh_pr WHERE session_id = ? AND pr_number = ?")
        .map_err(sqlite_error)?
        .query_row((input.session_id.as_str(), input.pr_number), |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(sqlite_error)?;

    let accepted_attribution = match (attribution, existing_attribution.as_deref()) {
        (PrAttribution::Explicit, _) => Some("explicit"),
        (PrAttribution::Inferred, Some("explicit")) => Some("explicit"),
        (PrAttribution::Inferred, Some("inferred")) => Some("inferred"),
        // A cached refresh carries no new attribution evidence. In particular,
        // it must not launder a pre-v37 shared row into a trusted association.
        (PrAttribution::Inferred, Some("legacy")) => None,
        (PrAttribution::Inferred, None)
            if inferred_association_is_eligible(&transaction, &context, &effective_input)? =>
        {
            Some(attribution.as_str())
        }
        (PrAttribution::Inferred, None) => None,
        (PrAttribution::Inferred, Some(_)) => None,
    };

    let result = if let Some(stored_attribution) = accepted_attribution {
        upsert_gh_pr_with_attribution(&transaction, &effective_input, stored_attribution)?;
        find_gh_pr(&transaction, &input.session_id, input.pr_number)?
    } else {
        None
    };
    transaction.commit().map_err(sqlite_error)?;
    Ok(result)
}

fn effective_project_pr_record(
    connection: &Connection,
    project_id: &str,
    input: &GhPrRecord,
) -> ArgmaxResult<GhPrRecord> {
    let (has_existing_merge, existing_merged_at) = connection
        .prepare_cached(
            r#"
            SELECT EXISTS (
              SELECT 1
              FROM gh_pr
              JOIN sessions ON sessions.id = gh_pr.session_id
              JOIN workspaces ON workspaces.id = sessions.workspace_id
              WHERE workspaces.project_id = ?1
                AND gh_pr.pr_number = ?2
                AND gh_pr.pr_state = 'MERGED'
            ), (
              SELECT MAX(gh_pr.pr_merged_at)
              FROM gh_pr
              JOIN sessions ON sessions.id = gh_pr.session_id
              JOIN workspaces ON workspaces.id = sessions.workspace_id
              WHERE workspaces.project_id = ?1
                AND gh_pr.pr_number = ?2
                AND gh_pr.pr_state = 'MERGED'
            )
            "#,
        )
        .map_err(sqlite_error)?
        .query_row((project_id, input.pr_number), |row| {
            Ok((row.get::<_, bool>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(sqlite_error)?;
    if input.pr_state.as_deref() != Some("MERGED") && !has_existing_merge {
        return Ok(input.clone());
    }

    let mut effective = input.clone();
    effective.pr_state = Some("MERGED".to_owned());
    effective.pr_merged_at = input.pr_merged_at.clone().or(existing_merged_at);
    Ok(effective)
}

/// The branch trusted for attributing a new inferred PR observation.
/// Isolated workspaces own their branch, so their current branch is reliable.
/// Shared checkouts use only the branch captured while this session was active.
pub fn pr_branch_for_session(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<String>> {
    let context = session_pr_context(connection, session_id)?;
    Ok(context.trusted_branch)
}

pub fn upsert_gh_pr(connection: &Connection, input: &GhPrRecord) -> ArgmaxResult<GhPrRecord> {
    upsert_gh_pr_with_attribution(connection, input, "legacy")?;
    find_gh_pr(connection, &input.session_id, input.pr_number)
        .map(|row| row.unwrap_or(input.clone()))
}

fn upsert_gh_pr_with_attribution(
    connection: &Connection,
    input: &GhPrRecord,
    attribution: &str,
) -> ArgmaxResult<()> {
    // Reset notified_at when head_sha rotates so a new commit is treated
    // as a fresh notification target; preserve it on a same-sha update so
    // unrelated metadata changes don't replay the notification.
    let mut statement = connection
        .prepare_cached(
            r#"
        INSERT INTO gh_pr (
          session_id, pr_number, head_sha, last_seen_check_state, updated_at,
          pr_state, head_ref_name, pr_created_at, pr_merged_at, attribution
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, pr_number) DO UPDATE SET
          head_sha = excluded.head_sha,
          last_seen_check_state = excluded.last_seen_check_state,
          updated_at = excluded.updated_at,
          pr_state = CASE
            WHEN gh_pr.pr_state = 'MERGED' THEN 'MERGED'
            ELSE excluded.pr_state
          END,
          head_ref_name = COALESCE(excluded.head_ref_name, gh_pr.head_ref_name),
          pr_created_at = COALESCE(excluded.pr_created_at, gh_pr.pr_created_at),
          pr_merged_at = COALESCE(excluded.pr_merged_at, gh_pr.pr_merged_at),
          attribution = CASE
            WHEN gh_pr.attribution = 'explicit' THEN 'explicit'
            ELSE excluded.attribution
          END,
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
            input.pr_created_at.as_deref(),
            input.pr_merged_at.as_deref(),
            attribution,
        ))
        .map_err(sqlite_error)?;
    Ok(())
}

#[derive(Debug)]
struct SessionPrContext {
    project_id: String,
    shared_workspace: bool,
    state: String,
    completed_at: Option<String>,
    trusted_branch: Option<String>,
}

fn session_pr_context(connection: &Connection, session_id: &str) -> ArgmaxResult<SessionPrContext> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT workspaces.project_id,
                   workspaces.shared_workspace,
                   sessions.state,
                   sessions.completed_at,
                   CASE
                     WHEN workspaces.shared_workspace = 0 THEN NULLIF(workspaces.branch, '')
                     ELSE COALESCE(sessions.pr_branch_last_active, sessions.pr_branch_at_start)
                   END AS trusted_branch
            FROM sessions
            JOIN workspaces ON workspaces.id = sessions.workspace_id
            WHERE sessions.id = ?
            "#,
        )
        .map_err(sqlite_error)?;
    match statement.query_row([session_id], |row| {
        Ok(SessionPrContext {
            project_id: row.get("project_id")?,
            shared_workspace: row.get::<_, i64>("shared_workspace")? != 0,
            state: row.get("state")?,
            completed_at: row.get("completed_at")?,
            trusted_branch: row.get("trusted_branch")?,
        })
    }) {
        Ok(context) => Ok(context),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("session", session_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

fn inferred_association_is_eligible(
    connection: &Connection,
    context: &SessionPrContext,
    input: &GhPrRecord,
) -> ArgmaxResult<bool> {
    let branch_matches = context
        .trusted_branch
        .as_deref()
        .zip(input.head_ref_name.as_deref())
        .is_some_and(|(trusted, head)| trusted == head);
    if !branch_matches {
        return Ok(false);
    }
    if !context.shared_workspace {
        return Ok(true);
    }

    let is_active = matches!(context.state.as_str(), "running" | "waiting" | "blocked");
    if is_active {
        return Ok(true);
    }

    let Some(completed_at) = context.completed_at.as_deref() else {
        return Ok(false);
    };
    let Some(pr_created_at) = input.pr_created_at.as_deref() else {
        return Ok(false);
    };
    connection
        .query_row(
            r#"
            SELECT julianday(?1) IS NOT NULL
               AND julianday(?2) IS NOT NULL
               AND julianday(?1) <= julianday(?2)
            "#,
            (pr_created_at, completed_at),
            |row| row.get::<_, bool>(0),
        )
        .map_err(sqlite_error)
}

fn sync_project_pr_rows(
    connection: &Connection,
    project_id: &str,
    input: &GhPrRecord,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            UPDATE gh_pr
            SET head_sha = ?1,
                last_seen_check_state = ?2,
                updated_at = ?3,
                pr_state = CASE
                  WHEN gh_pr.pr_state = 'MERGED' THEN 'MERGED'
                  ELSE ?4
                END,
                head_ref_name = COALESCE(?5, gh_pr.head_ref_name),
                pr_created_at = COALESCE(?6, gh_pr.pr_created_at),
                pr_merged_at = COALESCE(?7, gh_pr.pr_merged_at),
                notified_at = CASE WHEN gh_pr.head_sha = ?1 THEN gh_pr.notified_at ELSE NULL END
            WHERE gh_pr.pr_number = ?8
              AND gh_pr.session_id IN (
                SELECT sessions.id
                FROM sessions
                JOIN workspaces ON workspaces.id = sessions.workspace_id
                WHERE workspaces.project_id = ?9
              )
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            input.head_sha.as_str(),
            input.last_seen_check_state.as_str(),
            input.updated_at.as_str(),
            input.pr_state.as_deref(),
            input.head_ref_name.as_deref(),
            input.pr_created_at.as_deref(),
            input.pr_merged_at.as_deref(),
            input.pr_number,
            project_id,
        ))
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn list_gh_pr_for_session(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<GhPrRecord>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT gh_pr.*
            FROM gh_pr
            JOIN sessions ON sessions.id = gh_pr.session_id
            JOIN workspaces ON workspaces.id = sessions.workspace_id
            WHERE gh_pr.session_id = ?
              AND (
                workspaces.shared_workspace = 0
                OR gh_pr.attribution = 'explicit'
                OR (
                  gh_pr.attribution = 'inferred'
                  AND (
                    sessions.state IN ('running', 'waiting', 'blocked')
                    OR (
                      sessions.completed_at IS NOT NULL
                      AND gh_pr.pr_created_at IS NOT NULL
                      AND julianday(sessions.completed_at) IS NOT NULL
                      AND julianday(gh_pr.pr_created_at) IS NOT NULL
                      AND julianday(gh_pr.pr_created_at) <= julianday(sessions.completed_at)
                    )
                  )
                )
              )
            ORDER BY gh_pr.pr_number ASC
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([session_id], row_to_gh_pr)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Sessions the poller should keep asking `gh` about: an open (or not yet
/// classified) PR whose workspace is still live. Archived workspaces are
/// excluded — their worktree is gone, so every poll fails and `pr_state`
/// never advances past OPEN, which would keep the row in this set forever.
pub fn list_open_gh_pr_session_ids(connection: &Connection) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT DISTINCT gh_pr.session_id AS id
        FROM gh_pr
        JOIN sessions ON sessions.id = gh_pr.session_id
        JOIN workspaces ON workspaces.id = sessions.workspace_id
        WHERE (gh_pr.pr_state IS NULL OR gh_pr.pr_state = 'OPEN')
          AND (
            workspaces.shared_workspace = 0
            OR gh_pr.attribution = 'explicit'
            OR (
              gh_pr.attribution = 'inferred'
              AND (
                sessions.state IN ('running', 'waiting', 'blocked')
                OR (
                  sessions.completed_at IS NOT NULL
                  AND gh_pr.pr_created_at IS NOT NULL
                  AND julianday(sessions.completed_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) <= julianday(sessions.completed_at)
                )
              )
            )
          )
          AND workspaces.state NOT IN ('archiving', 'archive-failed', 'archived')
        "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>("id"))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Whether any session in this workspace has already fired the check-failure
/// follow-up for this PR at this commit.
///
/// The guard has to span the workspace, not the observing session: the
/// follow-up is itself a session in the same checkout on the same branch, so
/// it observes the same PR on the next tick. Keyed per session, every launch
/// would add a new observer and the launches would double every tick — and
/// each one runs an agent in the checkout the others are already editing.
pub fn check_failure_launched_in_workspace(
    connection: &Connection,
    workspace_id: &str,
    pr_number: i64,
    head_sha: &str,
) -> ArgmaxResult<bool> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT 1
        FROM gh_pr
        JOIN sessions ON sessions.id = gh_pr.session_id
        JOIN workspaces ON workspaces.id = sessions.workspace_id
        WHERE sessions.workspace_id = ?1
          AND gh_pr.pr_number = ?2
          AND gh_pr.head_sha = ?3
          AND gh_pr.notified_at IS NOT NULL
          AND (
            workspaces.shared_workspace = 0
            OR gh_pr.attribution = 'explicit'
            OR (
              gh_pr.attribution = 'inferred'
              AND (
                sessions.state IN ('running', 'waiting', 'blocked')
                OR (
                  sessions.completed_at IS NOT NULL
                  AND gh_pr.pr_created_at IS NOT NULL
                  AND julianday(sessions.completed_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) <= julianday(sessions.completed_at)
                )
              )
            )
          )
        LIMIT 1
        "#,
        )
        .map_err(sqlite_error)?;
    statement
        .exists((workspace_id, pr_number, head_sha))
        .map_err(sqlite_error)
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
          AND (
            workspaces.shared_workspace = 0
            OR gh_pr.attribution = 'explicit'
            OR (
              gh_pr.attribution = 'inferred'
              AND (
                sessions.state IN ('running', 'waiting', 'blocked')
                OR (
                  sessions.completed_at IS NOT NULL
                  AND gh_pr.pr_created_at IS NOT NULL
                  AND julianday(sessions.completed_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) <= julianday(sessions.completed_at)
                )
              )
            )
          )
        ORDER BY gh_pr.updated_at DESC, gh_pr.pr_number DESC
        LIMIT 1
        "#,
        (project_id, branch),
    )
}

/// Sidebar marker for one workspace. Isolated workspaces resolve the PR on
/// their owned branch. Shared checkouts resolve only PRs attributed to their
/// own session, because another session may later move the checkout's HEAD.
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
        JOIN sessions AS observer_sessions ON observer_sessions.id = gh_pr.session_id
        JOIN workspaces AS observer_workspaces ON observer_workspaces.id = observer_sessions.workspace_id
        JOIN workspaces AS target_workspace ON target_workspace.id = ?3
        WHERE observer_workspaces.project_id = ?1
          AND target_workspace.project_id = ?1
          AND (
            observer_workspaces.shared_workspace = 0
            OR gh_pr.attribution = 'explicit'
            OR (
              gh_pr.attribution = 'inferred'
              AND (
                observer_sessions.state IN ('running', 'waiting', 'blocked')
                OR (
                  observer_sessions.completed_at IS NOT NULL
                  AND gh_pr.pr_created_at IS NOT NULL
                  AND julianday(observer_sessions.completed_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) <= julianday(observer_sessions.completed_at)
                )
              )
            )
          )
          AND (
            (
              target_workspace.shared_workspace = 1
              AND observer_sessions.workspace_id = target_workspace.id
            )
            OR (
              target_workspace.shared_workspace = 0
              AND (
                (?2 != '' AND gh_pr.head_ref_name = ?2)
                OR (gh_pr.head_ref_name IS NULL AND observer_sessions.workspace_id = target_workspace.id)
                OR (
                  gh_pr.attribution = 'explicit'
                  AND observer_sessions.workspace_id = target_workspace.id
                )
              )
            )
          )
        ORDER BY
          CASE
            WHEN target_workspace.shared_workspace = 0
              AND ?2 != ''
              AND gh_pr.head_ref_name = ?2
            THEN 0
            ELSE 1
          END,
          gh_pr.updated_at DESC,
          gh_pr.pr_number DESC
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
        pr_created_at: row.get("pr_created_at")?,
        pr_merged_at: row.get("pr_merged_at")?,
        head_ref_name: row.get("head_ref_name")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{
        persist_session, update_session_state, PersistSessionInput, SessionStateInput,
    };
    use crate::persistence::workspaces::{
        persist_workspace, update_workspace_status, PersistWorkspaceInput, WorkspaceStatusInput,
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

    fn add_session(
        connection: &Connection,
        project_id: &str,
        workspace_id: &str,
        session_id: &str,
        branch: &str,
        shared: bool,
    ) {
        persist_workspace(
            connection,
            &PersistWorkspaceInput {
                id: workspace_id.to_owned(),
                project_id: project_id.to_owned(),
                task_label: session_id.to_owned(),
                branch: branch.to_owned(),
                base_ref: "main".to_owned(),
                path: format!("/tmp/{project_id}/{workspace_id}"),
                state: "running".to_owned(),
                shared_workspace: shared,
                kind: "git".to_owned(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace");
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
    }

    fn pr(session_id: &str, state: &str, head_sha: &str) -> GhPrRecord {
        GhPrRecord {
            session_id: session_id.to_owned(),
            pr_number: 7,
            head_sha: head_sha.to_owned(),
            last_seen_check_state: "PENDING".to_owned(),
            updated_at: "2026-09-07T10:00:00.000Z".to_owned(),
            pr_state: Some(state.to_owned()),
            notified_at: None,
            pr_created_at: Some("2026-09-07T09:00:00.000Z".to_owned()),
            pr_merged_at: (state == "MERGED").then(|| "2026-09-07T09:30:00.000Z".to_owned()),
            head_ref_name: Some("feature/pr".to_owned()),
        }
    }

    #[test]
    fn observations_propagate_within_project_and_preserve_notification_per_head() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_project(&connection, "p2");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", false);
        add_session(&connection, "p1", "w2", "s2", "feature/pr", false);
        add_session(&connection, "p2", "w3", "s3", "feature/pr", false);

        for session_id in ["s1", "s2", "s3"] {
            upsert_gh_pr(&connection, &pr(session_id, "OPEN", "old")).expect("seed pr");
            mark_gh_pr_notified(&connection, session_id, 7, "old", "notified")
                .expect("mark notified");
        }

        record_gh_pr_observation(
            &connection,
            &pr("s1", "MERGED", "new"),
            PrAttribution::Explicit,
        )
        .expect("record merge")
        .expect("explicit association");
        for session_id in ["s1", "s2"] {
            let row = find_gh_pr(&connection, session_id, 7)
                .expect("read pr")
                .expect("pr exists");
            assert_eq!(row.pr_state.as_deref(), Some("MERGED"));
            assert_eq!(row.head_sha, "new");
            assert_eq!(row.notified_at, None, "new head resets each observer");
        }
        let other_project = find_gh_pr(&connection, "s3", 7)
            .expect("read other project")
            .expect("other project pr");
        assert_eq!(other_project.pr_state.as_deref(), Some("OPEN"));
        assert_eq!(other_project.head_sha, "old");
        assert_eq!(other_project.notified_at.as_deref(), Some("notified"));

        mark_gh_pr_notified(&connection, "s1", 7, "new", "merged-notified")
            .expect("mark merged notified");
        record_gh_pr_observation(
            &connection,
            &pr("s2", "OPEN", "new"),
            PrAttribution::Explicit,
        )
        .expect("record stale open")
        .expect("promote explicit");
        let first = find_gh_pr(&connection, "s1", 7)
            .expect("read first")
            .expect("first pr");
        let second = find_gh_pr(&connection, "s2", 7)
            .expect("read second")
            .expect("second pr");
        assert_eq!(first.pr_state.as_deref(), Some("MERGED"));
        assert_eq!(second.pr_state.as_deref(), Some("MERGED"));
        assert_eq!(first.notified_at.as_deref(), Some("merged-notified"));
    }

    #[test]
    fn merged_without_timestamp_is_irreversible_for_every_peer() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", false);
        add_session(&connection, "p1", "w2", "s2", "feature/pr", false);
        add_session(&connection, "p1", "w3", "s3", "feature/pr", false);
        let mut merged = pr("s1", "MERGED", "same");
        merged.pr_merged_at = None;
        upsert_gh_pr(&connection, &merged).expect("seed legacy merge");
        upsert_gh_pr(&connection, &pr("s2", "OPEN", "same")).expect("seed open peer");

        record_gh_pr_observation(
            &connection,
            &pr("s3", "OPEN", "same"),
            PrAttribution::Explicit,
        )
        .expect("record stale open")
        .expect("associate observer");
        for session_id in ["s1", "s2", "s3"] {
            assert_eq!(
                find_gh_pr(&connection, session_id, 7)
                    .expect("read row")
                    .expect("row")
                    .pr_state
                    .as_deref(),
                Some("MERGED")
            );
        }
    }

    #[test]
    fn shared_attribution_uses_frozen_branch_and_completion_cutoff() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", true);

        let accepted = record_gh_pr_observation(
            &connection,
            &pr("s1", "OPEN", "one"),
            PrAttribution::Inferred,
        )
        .expect("record inferred");
        assert!(accepted.is_some());
        update_session_state(
            &connection,
            "s1",
            &SessionStateInput::transition(SessionState::Complete)
                .finished_at("2026-09-07T10:00:00.000Z"),
        )
        .expect("complete session");
        update_workspace_status(
            &connection,
            "w1",
            &WorkspaceStatusInput {
                branch: "main".to_owned(),
                dirty: false,
                changed_files: 0,
                last_activity_at: None,
            },
        )
        .expect("move shared checkout");
        assert_eq!(
            pr_branch_for_session(&connection, "s1").unwrap().as_deref(),
            Some("feature/pr")
        );
        assert_eq!(list_gh_pr_for_session(&connection, "s1").unwrap().len(), 1);
        assert_eq!(
            latest_pr_for_workspace(&connection, "w1", "p1", "main")
                .unwrap()
                .unwrap()
                .pr_number,
            7
        );
        update_session_state(
            &connection,
            "s1",
            &SessionStateInput::transition(SessionState::Running),
        )
        .expect("resume session");
        assert_eq!(
            pr_branch_for_session(&connection, "s1").unwrap().as_deref(),
            Some("main"),
            "a resumed turn trusts the branch it actually resumed on"
        );

        add_session(&connection, "p1", "w2", "s2", "feature/pr", true);
        update_session_state(
            &connection,
            "s2",
            &SessionStateInput::transition(SessionState::Complete)
                .finished_at("2026-09-07T08:00:00.000Z"),
        )
        .expect("complete before pr");
        assert!(record_gh_pr_observation(
            &connection,
            &pr("s2", "OPEN", "one"),
            PrAttribution::Inferred,
        )
        .expect("reject late inference")
        .is_none());
        assert!(list_gh_pr_for_session(&connection, "s2")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn shared_legacy_rows_require_explicit_promotion() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", true);
        upsert_gh_pr(&connection, &pr("s1", "OPEN", "one")).expect("seed legacy row");
        assert!(list_gh_pr_for_session(&connection, "s1")
            .unwrap()
            .is_empty());
        assert!(record_gh_pr_observation(
            &connection,
            &pr("s1", "OPEN", "one"),
            PrAttribution::Inferred,
        )
        .expect("cached inferred refresh")
        .is_none());
        assert!(list_gh_pr_for_session(&connection, "s1")
            .unwrap()
            .is_empty());
        record_gh_pr_observation(
            &connection,
            &pr("s1", "OPEN", "one"),
            PrAttribution::Explicit,
        )
        .expect("explicit refresh")
        .expect("promoted row");
        assert_eq!(list_gh_pr_for_session(&connection, "s1").unwrap().len(), 1);
    }
}
