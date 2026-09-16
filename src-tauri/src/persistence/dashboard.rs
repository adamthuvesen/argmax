use rusqlite::Connection;
use serde::Serialize;
use specta::Type;

use super::arcs::{list_arc_summaries, ArcSummary};
use super::checks::{list_checks, CheckRun};
use super::events::{
    list_session_agent_events_for_identity, list_session_changes_since,
    list_session_changes_since_with_budget, SessionEventsSinceResult,
};
use super::projects::{list_projects, ProjectSummary};
use super::sessions::{list_sessions_for_dashboard, SessionSummary};
use super::sqlite_error;
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
    pub pending_messages:
        std::collections::BTreeMap<String, Vec<crate::providers::flush_queue::PendingMessage>>,
    pub arcs: Vec<ArcSummary>,
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
    let arcs = list_arc_summaries(connection)?;
    Ok(DashboardListSnapshot {
        projects,
        workspaces: status.workspaces,
        sessions: status.sessions,
        checks: status.checks,
        pending_messages: Default::default(),
        arcs,
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
    change_cursor: Option<i64>,
) -> ArgmaxResult<SessionEventsSinceResult> {
    list_session_changes_since(
        connection,
        session_id,
        event_cursor,
        raw_output_cursor,
        change_cursor,
    )
}

pub fn list_session_tail_for_remote(
    connection: &Connection,
    session_id: &str,
    event_cursor: Option<i64>,
    raw_output_cursor: Option<i64>,
    change_cursor: Option<i64>,
    change_page_budget_bytes: usize,
) -> ArgmaxResult<SessionEventsSinceResult> {
    list_session_changes_since_with_budget(
        connection,
        session_id,
        event_cursor,
        raw_output_cursor,
        change_cursor,
        Some(change_page_budget_bytes),
    )
}

pub fn list_session_agent_tail(
    connection: &Connection,
    session_id: &str,
    parent_tool_use_id: &str,
    provider_parent_conversation_id: Option<&str>,
    provider_child_session_id: Option<&str>,
) -> ArgmaxResult<SessionEventsSinceResult> {
    list_session_agent_events_for_identity(
        connection,
        session_id,
        parent_tool_use_id,
        provider_parent_conversation_id,
        provider_child_session_id,
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{approvals::list_pending_approvals, Database};

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

        let approvals =
            list_pending_approvals(&connection, DASHBOARD_ROW_LIMIT).expect("list pending");

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

        let initial = list_session_tail(&connection, "s1", None, None, None).expect("initial tail");
        insert_event(&connection, "e2", "two");
        insert_raw(&connection, "r2", "two");

        let next = list_session_tail(
            &connection,
            "s1",
            Some(initial.event_cursor),
            Some(initial.raw_output_cursor),
            None,
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
    fn dashboard_prs_belong_to_the_displayed_session() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        seed_project(&connection);
        seed_workspace(&connection, "w1", "complete", "2026-05-24T10:00:00.000Z");
        seed_session(&connection, "s1", "w1", "2026-05-24T10:00:00.000Z");
        seed_gh_pr(&connection, "s1", 11, "OPEN", "2026-05-24T10:01:00.000Z");
        seed_session(&connection, "s2", "w1", "2026-05-24T10:05:00.000Z");
        let snapshot = list_dashboard(&connection).unwrap();
        assert_eq!(
            snapshot.workspaces[0].pr_number, None,
            "a new chat must not inherit the previous chat's PR"
        );
        assert!(snapshot.workspaces[0].prs.is_empty());

        seed_gh_pr(&connection, "s2", 22, "MERGED", "2026-05-24T10:06:00.000Z");
        connection.execute(
            "UPDATE gh_pull_requests SET pr_created_at = ?1, pr_merged_at = ?2 WHERE project_id = 'p1' AND pr_number = 22",
            ("2026-05-24T10:02:00.000Z", "2026-05-24T10:06:00.000Z"),
        ).unwrap();
        let snapshot = list_dashboard(&connection).unwrap();
        let workspace = &snapshot.workspaces[0];
        assert_eq!(workspace.pr_number, Some(22));
        assert_eq!(workspace.pr_state.as_deref(), Some("MERGED"));
        assert_eq!(
            workspace.pr_created_at.as_deref(),
            Some("2026-05-24T10:02:00.000Z")
        );
        assert_eq!(
            workspace.pr_merged_at.as_deref(),
            Some("2026-05-24T10:06:00.000Z")
        );
        assert_eq!(workspace.prs.len(), 1);
    }

    #[test]
    fn sharing_a_branch_does_not_share_session_prs() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        seed_project(&connection);
        for (workspace, session) in [("w1", "s1"), ("w2", "s2")] {
            seed_workspace_on_branch(
                &connection,
                workspace,
                "complete",
                "2026-05-24T10:00:00.000Z",
                "adam/feature",
            );
            seed_session(&connection, session, workspace, "2026-05-24T10:00:00.000Z");
        }
        seed_gh_pr_on_branch(
            &connection,
            "s1",
            4174,
            "OPEN",
            "2026-05-24T10:01:00.000Z",
            "adam/feature",
        );
        let snapshot = list_dashboard(&connection).unwrap();
        let sibling = snapshot.workspaces.iter().find(|w| w.id == "w2").unwrap();
        assert_eq!(sibling.pr_number, None);
        assert!(sibling.prs.is_empty());
    }

    #[test]
    fn session_history_retains_work_from_other_branches_and_prioritizes_open_work() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        seed_project(&connection);
        seed_workspace_on_branch(
            &connection,
            "w1",
            "complete",
            "2026-05-24T10:00:00.000Z",
            "main",
        );
        seed_session(&connection, "s1", "w1", "2026-05-24T10:00:00.000Z");
        seed_gh_pr_on_branch(
            &connection,
            "s1",
            755,
            "MERGED",
            "2026-05-24T10:01:00.000Z",
            "feature/old",
        );
        seed_gh_pr_on_branch(
            &connection,
            "s1",
            762,
            "OPEN",
            "2026-05-24T10:02:00.000Z",
            "feature/new",
        );
        let snapshot = list_dashboard(&connection).unwrap();
        let workspace = &snapshot.workspaces[0];
        assert_eq!(workspace.pr_number, Some(762));
        assert_eq!(workspace.pr_summary_state.as_deref(), Some("OPEN"));
        assert_eq!(workspace.prs.len(), 2);
        assert_eq!(
            workspace.prs[0].head_ref_name.as_deref(),
            Some("feature/new")
        );
    }

    #[test]
    fn unverified_and_dismissed_links_cannot_supply_a_workspace_marker() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        seed_dashboard(&connection);
        super::super::gh::record_session_pr_evidence(
            &connection,
            "s1",
            5,
            "unverified",
            "legacy-5",
            "2026-05-24T10:01:00.000Z",
        )
        .unwrap();
        let snapshot = list_dashboard(&connection).unwrap();
        assert_eq!(snapshot.workspaces[0].pr_number, None);
        assert_eq!(snapshot.workspaces[0].pr_summary_state, None);
        assert_eq!(snapshot.workspaces[0].prs.len(), 1);
        super::super::gh::dismiss_session_pr(&connection, "s1", 5).unwrap();
        super::super::gh::record_session_pr_evidence(
            &connection,
            "s1",
            5,
            "worked",
            "create-5",
            "2026-05-24T10:02:00.000Z",
        )
        .unwrap();
        let snapshot = list_dashboard(&connection).unwrap();
        assert_eq!(snapshot.workspaces[0].pr_number, None);
        assert!(snapshot.workspaces[0].prs.is_empty());
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
        let record = super::super::gh::GhPrRecord {
            session_id: session_id.into(),
            pr_number,
            head_sha: "sha".into(),
            last_seen_check_state: "success".into(),
            updated_at: updated_at.into(),
            pr_state: Some(pr_state.into()),
            notified_at: None,
            pr_created_at: None,
            pr_merged_at: None,
            head_ref_name: Some(head_ref_name.into()),
        };
        super::super::gh::store_gh_pr_observation(connection, &record).unwrap();
        super::super::gh::record_session_pr_evidence(
            connection,
            session_id,
            pr_number,
            "worked",
            &format!("create-{pr_number}"),
            updated_at,
        )
        .unwrap();
    }

    fn seed_dashboard(connection: &rusqlite::Connection) {
        seed_project(connection);
        seed_workspace(connection, "w1", "running", "2026-05-24T10:00:00.000Z");
        seed_session(connection, "s1", "w1", "2026-05-24T10:00:00.000Z");
    }

    fn seed_project(connection: &rusqlite::Connection) {
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, name, repo_path, current_branch, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', '~/.argmax', '2026-05-24T09:00:00.000Z', '2026-05-24T09:00:00.000Z')",
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
