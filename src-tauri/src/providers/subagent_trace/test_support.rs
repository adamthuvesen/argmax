//! Fixtures shared by the per-provider trace tests.

use chrono::{Datelike, Utc};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

use super::reconcile::SYNTHETIC_LAUNCH_MARKER;
use crate::persistence::{
    events::{
        list_imported_trace_events, list_session_agent_events, persist_timeline_event,
        PersistTimelineEventInput,
    },
    projects::{persist_project, PersistProjectInput, ProjectSettings},
    sessions::{persist_session, PersistSessionInput},
    workspaces::{persist_workspace, PersistWorkspaceInput},
};
use crate::sessions::state::SessionState;

pub(super) fn seed_session(connection: &Connection, provider: &str, session_id: &str) {
    persist_project(
        connection,
        &PersistProjectInput {
            id: "p1".to_string(),
            name: "Project".to_string(),
            repo_path: format!("/tmp/repo-{provider}-{session_id}"),
            current_branch: "main".to_string(),
            default_branch: Some("main".to_string()),
            settings: ProjectSettings {
                archive_on_merge: false,
                worktree_location: "/tmp/worktrees".to_string(),
                setup_command: String::new(),
                check_commands: Vec::new(),
            },
        },
    )
    .expect("project");
    persist_workspace(
        connection,
        &PersistWorkspaceInput {
            id: "w1".to_string(),
            project_id: "p1".to_string(),
            task_label: "Task".to_string(),
            branch: "branch".to_string(),
            base_ref: "main".to_string(),
            path: "/tmp/repo".to_string(),
            state: "running".to_string(),
            shared_workspace: false,
            kind: "git".to_string(),
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("workspace");
    persist_session(
        connection,
        &PersistSessionInput {
            id: session_id.to_string(),
            workspace_id: "w1".to_string(),
            provider: provider.to_string(),
            model_label: "Model".to_string(),
            model_id: "model".to_string(),
            reasoning_effort: None,
            permission_mode: Some("auto-approve".to_string()),
            agent_mode: Some("auto".to_string()),
            prompt: "Prompt".to_string(),
            state: SessionState::Running,
        },
    )
    .expect("session");
}

pub(super) fn seed_parent_agent(
    connection: &Connection,
    parent_tool_use_id: &str,
    start_payload: Value,
    completion_payload: Value,
) {
    persist_timeline_event(
        connection,
        &PersistTimelineEventInput {
            id: "parent-start".to_string(),
            session_id: "s1".to_string(),
            r#type: "command.started".to_string(),
            message: "agent".to_string(),
            payload: start_payload,
            created_at: Some("2026-07-08T14:46:49.000Z".to_string()),
        },
    )
    .expect("start");
    persist_timeline_event(
        connection,
        &PersistTimelineEventInput {
            id: "parent-complete".to_string(),
            session_id: "s1".to_string(),
            r#type: "command.completed".to_string(),
            message: "agent complete".to_string(),
            payload: completion_payload,
            created_at: Some("2026-07-08T14:47:01.000Z".to_string()),
        },
    )
    .expect(parent_tool_use_id);
}

/// A child rollout that names `parent-thread` as its parent, optionally
/// closed by the `task_complete` Codex writes when the child is done.
pub(super) fn child_trace(finished: bool) -> String {
    let mut lines = String::new();
    lines.push_str(
        r#"{"timestamp":"2026-07-08T14:46:49.290Z","type":"session_meta","payload":{"id":"child-thread","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent-thread","nickname":"Scout","role":"researcher","task_name":"Inspect directory"}}}}}"#,
    );
    lines.push('\n');
    lines.push_str(
        r#"{"timestamp":"2026-07-08T14:46:58.064Z","type":"event_msg","payload":{"type":"agent_message","message":"Looking around."}}"#,
    );
    lines.push('\n');
    lines.push_str(
        r#"{"timestamp":"2026-07-08T14:46:58.834Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call_1","arguments":"{\"cmd\":\"ls\"}"}}"#,
    );
    lines.push('\n');
    if finished {
        lines.push_str(
            r#"{"timestamp":"2026-07-08T14:47:01.533Z","type":"event_msg","payload":{"type":"agent_message","message":"All done."}}"#,
        );
        lines.push('\n');
        lines.push_str(
            r#"{"timestamp":"2026-07-08T14:47:01.900Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"All done."}}"#,
        );
        lines.push('\n');
    }
    lines
}

/// Reconciliation looks in the day window around the session's start, so
/// the fixture lands where a rollout written now would.
pub(super) fn write_codex_child_trace(home: &Path, child_id: &str, contents: &str) {
    let today = Utc::now();
    let directory = home.join(format!(
        ".codex/sessions/{:04}/{:02}/{:02}",
        today.year(),
        today.month(),
        today.day()
    ));
    fs::create_dir_all(&directory).expect("trace dir");
    fs::write(
        directory.join(format!("rollout-{child_id}.jsonl")),
        contents,
    )
    .expect("write trace");
}

/// The launch row the provider owed us, dated now so the launch-driven
/// import searches the same day window the fixture was written into.
pub(super) fn seed_real_launch(connection: &Connection, tool_use_id: &str, child_id: &str) {
    let created_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let payload = json!({
        "id": tool_use_id,
        "name": "spawn_agent",
        "input": { "receiver_thread_ids": [child_id] }
    });
    for (suffix, event_type) in [("start", "command.started"), ("end", "command.completed")] {
        persist_timeline_event(
            connection,
            &PersistTimelineEventInput {
                id: format!("{tool_use_id}-{suffix}"),
                session_id: "s1".to_string(),
                r#type: event_type.to_string(),
                message: "spawn_agent".to_string(),
                payload: payload.clone(),
                created_at: Some(created_at.clone()),
            },
        )
        .expect("real launch row");
    }
}

pub(super) fn session_events(
    connection: &Connection,
) -> Vec<crate::persistence::events::TimelineEvent> {
    crate::persistence::events::list_all_session_events(connection, "s1").expect("events")
}

pub(super) fn synthetic_launch_completed(connection: &Connection) -> bool {
    session_events(connection).iter().any(|event| {
        event.r#type == "command.completed" && event.payload[SYNTHETIC_LAUNCH_MARKER] == json!(true)
    })
}

pub(super) fn imported_trace_row_count(connection: &Connection, parent_tool_use_id: &str) -> usize {
    list_imported_trace_events(connection, "s1", parent_tool_use_id)
        .expect("imported rows")
        .len()
}

pub(super) fn imported_trace_cursors(
    connection: &Connection,
    parent_tool_use_id: &str,
) -> Vec<i64> {
    list_imported_trace_events(connection, "s1", parent_tool_use_id)
        .expect("imported rows")
        .into_iter()
        .filter_map(|event| event.row_cursor)
        .collect()
}

pub(super) fn trace_event_ids_for_child(
    connection: &Connection,
    parent_tool_use_id: &str,
    child_id: &str,
) -> Vec<String> {
    list_session_agent_events(connection, "s1", parent_tool_use_id)
        .expect("agent events")
        .events
        .into_iter()
        .filter(|event| {
            event.payload["providerChildSessionId"] == json!(child_id)
                && event.payload["traceImported"] == json!(true)
        })
        .map(|event| event.id)
        .collect()
}
