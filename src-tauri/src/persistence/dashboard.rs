use rusqlite::Connection;
use serde::Serialize;
use specta::Type;

use super::approvals::{list_pending_approvals, ApprovalRequest};
use super::checks::{list_checks, CheckRun};
use super::events::{
    list_session_agent_events, list_session_events_since, SessionEventsSinceResult,
};
use super::projects::{list_projects, ProjectSummary};
use super::sessions::{list_sessions_for_dashboard, SessionSummary};
use super::workspaces::{list_workspaces, WorkspaceSummary};
use crate::error::ArgmaxResult;

pub const DASHBOARD_ROW_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AttentionCounts {
    pub pending_approvals: i64,
    pub waiting_sessions: i64,
    pub total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardListSnapshot {
    pub projects: Vec<ProjectSummary>,
    pub workspaces: Vec<WorkspaceSummary>,
    pub sessions: Vec<SessionSummary>,
    pub checks: Vec<CheckRun>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusSnapshot {
    pub workspaces: Vec<WorkspaceSummary>,
    pub sessions: Vec<SessionSummary>,
    pub checks: Vec<CheckRun>,
}

pub fn list_dashboard(connection: &Connection) -> ArgmaxResult<DashboardListSnapshot> {
    let projects = list_projects(connection)?;
    let status = list_workspace_status(connection, None)?;
    Ok(DashboardListSnapshot {
        projects,
        workspaces: status.workspaces,
        sessions: status.sessions,
        checks: status.checks,
    })
}

pub fn list_workspace_status(
    connection: &Connection,
    workspace_ids: Option<&[String]>,
) -> ArgmaxResult<WorkspaceStatusSnapshot> {
    let tx = connection.unchecked_transaction().map_err(sqlite_error)?;
    let ids = workspace_ids.map(dedupe_workspace_ids);
    let ids_ref = ids.as_deref();

    let workspaces = list_workspaces(&tx, ids_ref, DASHBOARD_ROW_LIMIT)?;
    let sessions = list_sessions_for_dashboard(&tx, ids_ref, DASHBOARD_ROW_LIMIT)?;
    let checks = list_checks(&tx, ids_ref, DASHBOARD_ROW_LIMIT)?;

    tx.commit().map_err(sqlite_error)?;
    Ok(WorkspaceStatusSnapshot {
        workspaces,
        sessions,
        checks,
    })
}

pub fn list_session_tail(
    connection: &Connection,
    session_id: &str,
    event_cursor: Option<i64>,
    raw_output_cursor: Option<i64>,
) -> ArgmaxResult<SessionEventsSinceResult> {
    list_session_events_since(connection, session_id, event_cursor, raw_output_cursor)
}

pub fn list_session_agent_tail(
    connection: &Connection,
    session_id: &str,
    parent_tool_use_id: &str,
) -> ArgmaxResult<SessionEventsSinceResult> {
    list_session_agent_events(connection, session_id, parent_tool_use_id)
}

pub fn list_pending(connection: &Connection) -> ArgmaxResult<Vec<ApprovalRequest>> {
    list_pending_approvals(connection, DASHBOARD_ROW_LIMIT)
}

pub fn list_running_session_ids(connection: &Connection) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached("SELECT id FROM sessions WHERE state = 'running'")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>("id"))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Sessions that finished at or after `since_iso`. The GH poller includes these
/// so an agent that opened a PR and completed before the next tick still gets
/// a `gh pr view` against its branch.
pub fn list_recently_completed_session_ids(
    connection: &Connection,
    since_iso: &str,
) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT id FROM sessions WHERE completed_at IS NOT NULL AND completed_at >= ?",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([since_iso], |row| row.get::<_, String>("id"))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn count_attention(connection: &Connection) -> ArgmaxResult<AttentionCounts> {
    let pending_approvals = count_where(
        connection,
        "SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'",
    )?;
    let waiting_sessions = count_where(
        connection,
        "SELECT COUNT(*) AS count FROM sessions WHERE state = 'waiting'",
    )?;
    Ok(AttentionCounts {
        pending_approvals,
        waiting_sessions,
        total: pending_approvals + waiting_sessions,
    })
}

fn count_where(connection: &Connection, sql: &'static str) -> ArgmaxResult<i64> {
    let mut statement = connection.prepare_cached(sql).map_err(sqlite_error)?;
    statement
        .query_row([], |row| row.get::<_, i64>("count"))
        .map_err(sqlite_error)
}

fn dedupe_workspace_ids(ids: &[String]) -> Vec<String> {
    // Don't pre-truncate the id set: the per-table queries already apply their
    // own LIMIT, so capping here would silently drop the most-active workspaces
    // when more than DASHBOARD_ROW_LIMIT ids are requested.
    let mut out = Vec::new();
    for id in ids {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

fn sqlite_error(error: rusqlite::Error) -> crate::error::ArgmaxError {
    crate::error::ArgmaxError::service("SQLITE", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::Database;

    #[test]
    fn dashboard_list_excludes_events_raw_outputs_and_approvals() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_dashboard(&connection);

        let snapshot = list_dashboard(&connection).expect("list dashboard");
        let json = serde_json::to_value(&snapshot).expect("serialize dashboard");

        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(snapshot.workspaces.len(), 1);
        assert_eq!(snapshot.sessions.len(), 1);
        assert!(json.get("events").is_none());
        assert!(json.get("rawOutputs").is_none());
        assert!(json.get("approvals").is_none());
    }

    #[test]
    fn pending_approvals_read_filters_resolved_rows() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_dashboard(&connection);
        connection
            .execute(
                "INSERT INTO approvals (id, session_id, command, cwd, provider, risk_level, status, created_at, resolved_at) VALUES
                ('a1', 's1', 'git push', '/tmp', 'codex', 'medium', 'approved', '2026-05-24T10:00:00.000Z', '2026-05-24T10:01:00.000Z'),
                ('a2', 's1', 'rm -rf dist', '/tmp', 'codex', 'high', 'pending', '2026-05-24T10:02:00.000Z', NULL)",
                [],
            )
            .expect("insert approvals");

        let approvals = list_pending(&connection).expect("list pending");

        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].id, "a2");
    }

    #[test]
    fn workspace_status_can_be_sliced_by_workspace_id() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_project(&connection);
        seed_workspace(&connection, "w1", "running", "2026-05-24T10:00:00.000Z");
        seed_workspace(&connection, "w2", "complete", "2026-05-24T11:00:00.000Z");
        seed_session(&connection, "s1", "w1", "2026-05-24T10:00:00.000Z");
        seed_session(&connection, "s2", "w2", "2026-05-24T11:00:00.000Z");

        let ids = vec!["w2".to_owned()];
        let status = list_workspace_status(&connection, Some(&ids)).expect("workspace status");

        assert_eq!(
            status.workspaces.iter().map(|w| &w.id).collect::<Vec<_>>(),
            vec!["w2"]
        );
        assert_eq!(
            status.sessions.iter().map(|s| &s.id).collect::<Vec<_>>(),
            vec!["s2"]
        );
    }

    #[test]
    fn session_tail_uses_rowid_cursors() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_dashboard(&connection);
        insert_event(&connection, "e1", "one");
        insert_raw(&connection, "r1", "one");

        let initial = list_session_tail(&connection, "s1", None, None).expect("initial tail");
        insert_event(&connection, "e2", "two");
        insert_raw(&connection, "r2", "two");

        let next = list_session_tail(
            &connection,
            "s1",
            Some(initial.event_cursor),
            Some(initial.raw_output_cursor),
        )
        .expect("next tail");

        assert_eq!(
            initial.events.iter().map(|e| &e.id).collect::<Vec<_>>(),
            vec!["e1"]
        );
        assert_eq!(
            next.events.iter().map(|e| &e.id).collect::<Vec<_>>(),
            vec!["e2"]
        );
        assert!(next.event_cursor > initial.event_cursor);
        assert!(next.raw_output_cursor > initial.raw_output_cursor);
    }

    #[test]
    fn attention_counts_and_running_sessions_match_dashboard_filters() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_dashboard(&connection);
        seed_session(&connection, "s-waiting", "w1", "2026-05-24T10:01:00.000Z");
        connection
            .execute(
                "UPDATE sessions SET state = 'waiting' WHERE id = 's-waiting'",
                [],
            )
            .expect("mark waiting");
        connection
            .execute(
                "INSERT INTO approvals (id, session_id, command, cwd, provider, risk_level, status, created_at, resolved_at) VALUES
                ('a1', 's1', 'git push', '/tmp', 'codex', 'medium', 'approved', '2026-05-24T10:00:00.000Z', '2026-05-24T10:01:00.000Z'),
                ('a2', 's1', 'npm test', '/tmp', 'codex', 'medium', 'pending', '2026-05-24T10:02:00.000Z', NULL)",
                [],
            )
            .expect("insert approvals");

        let running = list_running_session_ids(&connection).expect("running session ids");
        let counts = count_attention(&connection).expect("attention counts");

        assert_eq!(running, vec!["s1"]);
        assert_eq!(
            counts,
            AttentionCounts {
                pending_approvals: 1,
                waiting_sessions: 1,
                total: 2,
            }
        );
    }

    #[test]
    fn recently_completed_session_ids_are_bounded_by_completed_at() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_dashboard(&connection);
        seed_session(&connection, "s-old", "w1", "2026-05-24T10:00:00.000Z");
        seed_session(&connection, "s-new", "w1", "2026-05-24T10:05:00.000Z");
        connection
            .execute(
                "UPDATE sessions SET state = 'complete', completed_at = '2026-05-24T09:00:00.000Z' WHERE id = 's-old'",
                [],
            )
            .expect("complete old");
        connection
            .execute(
                "UPDATE sessions SET state = 'complete', completed_at = '2026-05-24T10:05:00.000Z' WHERE id = 's-new'",
                [],
            )
            .expect("complete new");

        let ids = list_recently_completed_session_ids(&connection, "2026-05-24T10:00:00.000Z")
            .expect("recently completed");
        assert_eq!(ids, vec!["s-new"]);
    }

    #[test]
    fn dashboard_includes_latest_session_for_visible_workspace() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_project(&connection);
        seed_workspace(&connection, "w-old", "running", "2026-05-24T12:00:00.000Z");

        for i in 0..=DASHBOARD_ROW_LIMIT {
            let workspace_id = format!("w-hot-{i}");
            let session_id = format!("s-hot-{i}");
            seed_workspace(
                &connection,
                &workspace_id,
                "running",
                "2026-05-24T11:00:00.000Z",
            );
            seed_session(
                &connection,
                &session_id,
                &workspace_id,
                "2026-05-24T11:00:00.000Z",
            );
        }
        seed_session(&connection, "s-old", "w-old", "2026-05-24T09:00:00.000Z");

        let snapshot = list_dashboard(&connection).expect("dashboard");

        assert!(snapshot
            .workspaces
            .iter()
            .any(|workspace| workspace.id == "w-old"));
        assert!(snapshot
            .sessions
            .iter()
            .any(|session| session.id == "s-old"));
    }

    #[test]
    fn dashboard_workspace_carries_most_recent_pr_across_sessions() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_project(&connection);
        seed_workspace(&connection, "w1", "complete", "2026-05-24T10:00:00.000Z");
        seed_session(&connection, "s1", "w1", "2026-05-24T10:00:00.000Z");
        seed_session(&connection, "s2", "w1", "2026-05-24T10:05:00.000Z");
        // s1 has an older OPEN PR; s2 has a newer MERGED PR. The newer one wins.
        seed_gh_pr(&connection, "s1", 11, "OPEN", "2026-05-24T10:01:00.000Z");
        seed_gh_pr(&connection, "s2", 22, "MERGED", "2026-05-24T10:06:00.000Z");

        let snapshot = list_dashboard(&connection).expect("dashboard");
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|w| w.id == "w1")
            .expect("workspace present");

        assert_eq!(workspace.pr_state.as_deref(), Some("MERGED"));
        assert_eq!(workspace.pr_number, Some(22));
    }

    #[test]
    fn dashboard_workspace_sees_pr_observed_by_a_sibling_on_the_same_branch() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_project(&connection);
        // Two workspaces sharing one checkout and one branch — the shared-
        // workspace default. Only w1's session was mid-turn when the poller
        // looked, so only it recorded the PR. w2 is on the same branch and
        // must show the same PR rather than looking PR-less.
        seed_workspace_on_branch(
            &connection,
            "w1",
            "complete",
            "2026-05-24T10:00:00.000Z",
            "adam/feature",
        );
        seed_workspace_on_branch(
            &connection,
            "w2",
            "complete",
            "2026-05-24T10:00:00.000Z",
            "adam/feature",
        );
        seed_session(&connection, "s1", "w1", "2026-05-24T10:00:00.000Z");
        seed_session(&connection, "s2", "w2", "2026-05-24T10:00:00.000Z");
        seed_gh_pr_on_branch(
            &connection,
            "s1",
            4174,
            "OPEN",
            "2026-05-24T10:01:00.000Z",
            "adam/feature",
        );

        let snapshot = list_dashboard(&connection).expect("dashboard");
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|w| w.id == "w2")
            .expect("workspace present");

        assert_eq!(workspace.pr_state.as_deref(), Some("OPEN"));
        assert_eq!(workspace.pr_number, Some(4174));
    }

    #[test]
    fn dashboard_workspace_ignores_a_pr_from_a_branch_it_has_left() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_project(&connection);
        // A long-lived shared workspace accumulates PR rows across months of
        // branches. Only the PR for the branch it is on now may surface.
        seed_workspace_on_branch(
            &connection,
            "w1",
            "complete",
            "2026-05-24T10:00:00.000Z",
            "adam/current",
        );
        seed_session(&connection, "s1", "w1", "2026-05-24T10:00:00.000Z");
        seed_gh_pr_on_branch(
            &connection,
            "s1",
            1091,
            "MERGED",
            "2026-05-24T10:01:00.000Z",
            "adam/old",
        );
        seed_gh_pr_on_branch(
            &connection,
            "s1",
            1124,
            "OPEN",
            "2026-05-24T10:02:00.000Z",
            "adam/current",
        );
        seed_gh_pr_on_branch(
            &connection,
            "s1",
            1158,
            "MERGED",
            "2026-05-24T10:03:00.000Z",
            "adam/newer-other",
        );

        let snapshot = list_dashboard(&connection).expect("dashboard");
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|w| w.id == "w1")
            .expect("workspace present");

        // 1158 is the most recent row, but it belongs to another branch.
        assert_eq!(workspace.pr_state.as_deref(), Some("OPEN"));
        assert_eq!(workspace.pr_number, Some(1124));
    }

    #[test]
    fn dashboard_workspace_keeps_a_legacy_pr_row_on_the_observing_workspace() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_project(&connection);
        seed_workspace_on_branch(
            &connection,
            "w1",
            "complete",
            "2026-05-24T10:00:00.000Z",
            "adam/feature",
        );
        seed_workspace_on_branch(
            &connection,
            "w2",
            "complete",
            "2026-05-24T10:00:00.000Z",
            "adam/feature",
        );
        seed_session(&connection, "s1", "w1", "2026-05-24T10:00:00.000Z");
        seed_session(&connection, "s2", "w2", "2026-05-24T10:00:00.000Z");
        // Pre-migration row: branch unknown. The observing workspace still
        // shows it; a sibling on the same branch cannot claim it.
        connection
            .execute(
                "INSERT INTO gh_pr (session_id, pr_number, head_sha, last_seen_check_state, updated_at, pr_state) VALUES ('s1', 5, 'sha', 'success', '2026-05-24T10:01:00.000Z', 'OPEN')",
                [],
            )
            .expect("insert gh_pr");

        let snapshot = list_dashboard(&connection).expect("dashboard");
        let observed = snapshot
            .workspaces
            .iter()
            .find(|w| w.id == "w1")
            .expect("workspace present");
        let sibling = snapshot
            .workspaces
            .iter()
            .find(|w| w.id == "w2")
            .expect("sibling present");

        assert_eq!(observed.pr_state.as_deref(), Some("OPEN"));
        assert_eq!(observed.pr_number, Some(5));
        assert_eq!(sibling.pr_state, None);
        assert_eq!(sibling.pr_number, None);
    }

    #[test]
    fn dashboard_workspace_without_pr_has_none() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_dashboard(&connection);

        let snapshot = list_dashboard(&connection).expect("dashboard");
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|w| w.id == "w1")
            .expect("workspace present");

        assert_eq!(workspace.pr_state, None);
        assert_eq!(workspace.pr_number, None);
    }

    fn seed_gh_pr(
        connection: &rusqlite::Connection,
        session_id: &str,
        pr_number: i64,
        pr_state: &str,
        updated_at: &str,
    ) {
        seed_gh_pr_on_branch(
            connection, session_id, pr_number, pr_state, updated_at, "branch",
        );
    }

    fn seed_gh_pr_on_branch(
        connection: &rusqlite::Connection,
        session_id: &str,
        pr_number: i64,
        pr_state: &str,
        updated_at: &str,
        head_ref_name: &str,
    ) {
        connection
            .execute(
                "INSERT INTO gh_pr (session_id, pr_number, head_sha, last_seen_check_state, updated_at, pr_state, head_ref_name) VALUES (?, ?, 'sha', 'success', ?, ?, ?)",
                (session_id, pr_number, updated_at, pr_state, head_ref_name),
            )
            .expect("insert gh_pr");
    }

    fn seed_dashboard(connection: &rusqlite::Connection) {
        seed_project(connection);
        seed_workspace(connection, "w1", "running", "2026-05-24T10:00:00.000Z");
        seed_session(connection, "s1", "w1", "2026-05-24T10:00:00.000Z");
    }

    fn seed_project(connection: &rusqlite::Connection) {
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, name, repo_path, current_branch, default_provider, default_model_label, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', 'claude', 'Sonnet', '~/.argmax', '2026-05-24T09:00:00.000Z', '2026-05-24T09:00:00.000Z')",
                [],
            )
            .expect("insert project");
    }

    fn seed_workspace(connection: &rusqlite::Connection, id: &str, state: &str, ts: &str) {
        seed_workspace_on_branch(connection, id, state, ts, "branch");
    }

    fn seed_workspace_on_branch(
        connection: &rusqlite::Connection,
        id: &str,
        state: &str,
        ts: &str,
        branch: &str,
    ) {
        connection
            .execute(
                "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES (?, 'p1', 'task', ?, 'main', '/tmp/ws', ?, ?, ?, ?)",
                (id, branch, state, ts, ts, ts),
            )
            .expect("insert workspace");
    }

    fn seed_session(connection: &rusqlite::Connection, id: &str, workspace_id: &str, ts: &str) {
        connection
            .execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, prompt, state, attention, started_at, last_activity_at) VALUES (?, ?, 'claude', 'Sonnet', 'claude-sonnet', 'hello', 'running', 'normal', ?, ?)",
                (id, workspace_id, ts, ts),
            )
            .expect("insert session");
    }

    fn insert_event(connection: &rusqlite::Connection, id: &str, message: &str) {
        connection
            .execute(
                "INSERT INTO events (id, session_id, type, message, payload_json, created_at) VALUES (?, 's1', 'message.delta', ?, '{}', '2026-05-24T10:00:00.000Z')",
                (id, message),
            )
            .expect("insert event");
    }

    fn insert_raw(connection: &rusqlite::Connection, id: &str, content: &str) {
        connection
            .execute(
                "INSERT INTO raw_outputs (id, session_id, stream, content, created_at) VALUES (?, 's1', 'stdout', ?, '2026-05-24T10:00:00.000Z')",
                (id, content),
            )
            .expect("insert raw output");
    }
}
