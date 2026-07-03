use super::approvals::{
    find_pending_approval, persist_approval, resolve_approval, FindPendingApprovalInput,
    PersistApprovalInput,
};
use super::checks::{
    find_checkpoint_by_id, persist_check, persist_checkpoint, update_check, PersistCheckInput,
    PersistCheckpointInput, UpdateCheckInput,
};
use super::database::Database;
use super::events::{
    list_session_events_since, persist_raw_output, persist_timeline_event, PersistRawOutputInput,
    PersistTimelineEventInput,
};
use super::gh::{
    list_gh_pr_for_session, list_open_gh_pr_session_ids, mark_gh_pr_notified, upsert_gh_pr,
    GhPrRecord,
};
use super::learnings::{
    delete_learning, insert_learning, list_learnings, search_events, update_learning,
    InsertLearningInput, UpdateLearningInput,
};
use super::projects::{
    delete_project, get_project_remote, persist_project, require_project, update_project_branch,
    update_project_remote, update_project_settings, PersistProjectInput, ProjectRemote,
    ProjectSettings,
};
use super::sessions::{
    list_session_ids_for_workspace, persist_session, update_session_agent_mode,
    update_session_last_activity, update_session_model, update_session_provider_conversation_id,
    update_session_state, PersistSessionInput, SessionAgentModeInput, SessionModelInput,
    SessionStateInput, UsageCounts,
};
use super::usage::{get_session_cost_summary, insert_usage_event, InsertUsageEventInput};
use super::workspaces::{
    find_workspace_by_id, persist_workspace, set_workspace_label, set_workspace_label_auto,
    set_workspace_pinned, update_workspace_state, update_workspace_status, PersistWorkspaceInput,
    WorkspaceStatusInput,
};
use crate::error::ArgmaxError;

#[test]
fn project_workspace_and_session_repositories_round_trip() {
    let database = Database::open_in_memory().expect("open db");
    let connection = database.connection();

    let project = persist_project(&connection, &project_input()).expect("persist project");
    assert_eq!(project.repo_path, "/tmp/repo");
    assert_eq!(project.settings.check_commands, vec!["npm test"]);

    let updated_settings = ProjectSettings {
        default_provider: "codex".to_owned(),
        default_model_label: "GPT-5.5".to_owned(),
        worktree_location: "~/.argmax/worktrees".to_owned(),
        setup_command: "npm install".to_owned(),
        check_commands: vec!["npm test".to_owned(), "npm run lint".to_owned()],
    };
    let updated = update_project_settings(&connection, "p1", &updated_settings)
        .expect("update project settings");
    assert_eq!(updated.settings.default_provider, "codex");
    assert_eq!(updated.settings.check_commands.len(), 2);

    let branched =
        update_project_branch(&connection, "p1", "feature/rust").expect("update project branch");
    assert_eq!(branched.current_branch, "feature/rust");

    update_project_remote(
        &connection,
        "p1",
        Some(&ProjectRemote {
            owner: "acme".to_owned(),
            name: "argmax".to_owned(),
        }),
    )
    .expect("update remote");
    assert_eq!(
        get_project_remote(&connection, "p1").expect("get remote"),
        Some(ProjectRemote {
            owner: "acme".to_owned(),
            name: "argmax".to_owned(),
        })
    );

    let workspace = persist_workspace(&connection, &workspace_input()).expect("persist workspace");
    assert_eq!(workspace.project_id, "p1");
    assert!(!workspace.pinned);

    let status = update_workspace_status(
        &connection,
        "w1",
        &WorkspaceStatusInput {
            branch: "feature/rust".to_owned(),
            dirty: true,
            changed_files: 3,
            last_activity_at: Some("2026-05-24T10:00:00.000Z".to_owned()),
        },
    )
    .expect("update workspace status");
    assert!(status.dirty);
    assert_eq!(status.changed_files, 3);

    assert!(
        set_workspace_pinned(&connection, "w1", true)
            .expect("pin workspace")
            .pinned
    );
    assert_eq!(
        update_workspace_state(&connection, "w1", "kept")
            .expect("keep workspace")
            .state,
        "kept"
    );

    let session = persist_session(&connection, &session_input()).expect("persist session");
    assert_eq!(session.permission_mode, "auto-approve");
    assert_eq!(session.agent_mode.as_deref(), Some("auto"));

    let modeled = update_session_model(
        &connection,
        "s1",
        &SessionModelInput {
            model_label: "GPT-5.5".to_owned(),
            model_id: "gpt-5.5".to_owned(),
            reasoning_effort: Some("medium".to_owned()),
        },
    )
    .expect("update model");
    assert_eq!(modeled.model_id, "gpt-5.5");
    assert_eq!(modeled.reasoning_effort.as_deref(), Some("medium"));

    let agent_mode = update_session_agent_mode(
        &connection,
        "s1",
        &SessionAgentModeInput {
            agent_mode: "plan".to_owned(),
        },
    )
    .expect("update agent mode");
    assert_eq!(agent_mode.agent_mode.as_deref(), Some("plan"));

    let resumed = update_session_provider_conversation_id(&connection, "s1", "provider-thread-1")
        .expect("update provider conversation");
    assert_eq!(
        resumed.provider_conversation_id.as_deref(),
        Some("provider-thread-1")
    );

    let waiting = update_session_state(
        &connection,
        "s1",
        &SessionStateInput {
            state: "waiting".to_owned(),
            attention: "blocked".to_owned(),
            completed_at: None,
            last_activity_at: Some("2026-05-24T10:02:00.000Z".to_owned()),
        },
    )
    .expect("update session state");
    assert_eq!(waiting.state, "waiting");

    let ticked = update_session_last_activity(&connection, "s1", "2026-05-24T10:03:00.000Z")
        .expect("update last activity");
    assert_eq!(ticked.last_activity_at, "2026-05-24T10:03:00.000Z");

    assert_eq!(
        list_session_ids_for_workspace(&connection, "w1").expect("list sessions"),
        vec!["s1"]
    );

    let missing = find_workspace_by_id(&connection, "missing").expect_err("missing workspace");
    assert!(matches!(missing, ArgmaxError::RecordNotFound { .. }));

    delete_project(&connection, "p1").expect("delete project");
    let deleted = require_project(&connection, "p1").expect_err("project deleted");
    assert!(matches!(deleted, ArgmaxError::RecordNotFound { .. }));
}

#[test]
fn workspace_auto_label_updates_until_manual_rename() {
    let database = Database::open_in_memory().expect("open db");
    let connection = database.connection();
    persist_project(&connection, &project_input()).expect("persist project");
    persist_workspace(&connection, &workspace_input()).expect("persist workspace");

    let generated = set_workspace_label_auto(&connection, "w1", "Generated Session Title")
        .expect("auto label")
        .expect("workspace updated");
    assert_eq!(generated.task_label, "Generated Session Title");

    let manual = set_workspace_label(&connection, "w1", "My Manual Title").expect("manual label");
    assert_eq!(manual.task_label, "My Manual Title");

    let skipped = set_workspace_label_auto(&connection, "w1", "Late Generated Title")
        .expect("late auto label");
    assert!(skipped.is_none());
    assert_eq!(
        find_workspace_by_id(&connection, "w1")
            .expect("workspace")
            .task_label,
        "My Manual Title"
    );
}

#[test]
fn event_approval_check_and_usage_repositories_round_trip() {
    let database = Database::open_in_memory().expect("open db");
    let connection = database.connection();
    persist_project(&connection, &project_input()).expect("persist project");
    persist_workspace(&connection, &workspace_input()).expect("persist workspace");
    persist_session(&connection, &session_input()).expect("persist session");

    let event = persist_timeline_event(
        &connection,
        &PersistTimelineEventInput {
            id: "e1".to_owned(),
            session_id: "s1".to_owned(),
            r#type: "message.delta".to_owned(),
            message: "hello".to_owned(),
            payload: serde_json::json!({ "role": "assistant" }),
            created_at: Some("2026-05-24T10:00:00.000Z".to_owned()),
        },
    )
    .expect("persist event");
    let raw = persist_raw_output(
        &connection,
        &PersistRawOutputInput {
            id: "r1".to_owned(),
            session_id: "s1".to_owned(),
            stream: "stdout".to_owned(),
            content: "{\"type\":\"assistant\"}".to_owned(),
            created_at: Some("2026-05-24T10:00:00.000Z".to_owned()),
        },
    )
    .expect("persist raw");
    assert!(event.row_cursor.unwrap() > 0);
    assert!(raw.row_cursor.unwrap() > 0);

    let tail = list_session_events_since(&connection, "s1", None, None).expect("read tail");
    assert_eq!(tail.events[0].payload["role"], "assistant");
    assert_eq!(tail.raw_outputs[0].content, "{\"type\":\"assistant\"}");

    connection
        .execute(
            "INSERT INTO events (id, session_id, type, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                "e-bad",
                "s1",
                "message.delta",
                "corrupt payload",
                "{not valid json",
                "2026-05-24T10:00:01.000Z",
            ),
        )
        .expect("insert corrupt payload");
    let tail = list_session_events_since(&connection, "s1", None, None).expect("read corrupt tail");
    let corrupt = tail
        .events
        .iter()
        .find(|event| event.id == "e-bad")
        .expect("corrupt event returned");
    assert_eq!(corrupt.payload["parseError"], true);
    assert_eq!(corrupt.payload["rawPayload"], "{not valid json");

    let approval = persist_approval(
        &connection,
        &PersistApprovalInput {
            id: "a1".to_owned(),
            session_id: "s1".to_owned(),
            command: "git push".to_owned(),
            cwd: "/tmp/repo".to_owned(),
            provider: "codex".to_owned(),
            risk_level: "medium".to_owned(),
            status: "pending".to_owned(),
            created_at: Some("2026-05-24T10:01:00.000Z".to_owned()),
        },
    )
    .expect("persist approval");
    assert_eq!(approval.status, "pending");
    assert!(find_pending_approval(
        &connection,
        &FindPendingApprovalInput {
            session_id: "s1".to_owned(),
            command: "git push".to_owned(),
            cwd: "/tmp/repo".to_owned(),
            provider: "codex".to_owned(),
        },
    )
    .expect("find pending")
    .is_some());
    assert_eq!(
        resolve_approval(&connection, "a1", "approved")
            .expect("resolve approval")
            .status,
        "approved"
    );

    let check = persist_check(
        &connection,
        &PersistCheckInput {
            id: "c1".to_owned(),
            workspace_id: "w1".to_owned(),
            command: "npm test".to_owned(),
            status: "running".to_owned(),
            started_at: Some("2026-05-24T10:02:00.000Z".to_owned()),
        },
    )
    .expect("persist check");
    assert_eq!(check.status, "running");
    let completed = update_check(
        &connection,
        "c1",
        &UpdateCheckInput {
            status: "passed".to_owned(),
            exit_code: Some(0),
            summary: Some("green".to_owned()),
            completed_at: Some("2026-05-24T10:03:00.000Z".to_owned()),
        },
    )
    .expect("update check");
    assert_eq!(completed.exit_code, Some(0));

    let checkpoint = persist_checkpoint(
        &connection,
        &PersistCheckpointInput {
            id: "cp1".to_owned(),
            workspace_id: "w1".to_owned(),
            label: "before cleanup".to_owned(),
            branch: "feature/rust".to_owned(),
            git_ref: Some("abc123".to_owned()),
            patch_path: Some("/tmp/checkpoints/cp1.patch".to_owned()),
            created_at: Some("2026-05-24T10:04:00.000Z".to_owned()),
        },
    )
    .expect("persist checkpoint");
    assert_eq!(checkpoint.label, "before cleanup");
    assert_eq!(
        find_checkpoint_by_id(&connection, "cp1")
            .expect("find checkpoint")
            .git_ref
            .as_deref(),
        Some("abc123")
    );

    insert_usage_event(
        &connection,
        &InsertUsageEventInput {
            session_id: "s1".to_owned(),
            event_id: Some("e1".to_owned()),
            model_id: "gpt-5.5".to_owned(),
            tokens: UsageCounts {
                input: 10,
                output: 20,
                cache_read: 3,
                cache_write: 4,
            },
            cost_usd: 0.42,
            created_at: Some("2026-05-24T10:05:00.000Z".to_owned()),
        },
    )
    .expect("insert usage");
    let summary = get_session_cost_summary(&connection, "s1").expect("cost summary");
    assert_eq!(summary.model_id.as_deref(), Some("gpt-5.5"));
    assert_eq!(summary.tokens.output, 20);
    assert_eq!(summary.cost_usd, 0.42);
}

#[test]
fn gh_and_learning_repositories_round_trip() {
    let database = Database::open_in_memory().expect("open db");
    let connection = database.connection();
    persist_project(&connection, &project_input()).expect("persist project");
    persist_workspace(&connection, &workspace_input()).expect("persist workspace");
    persist_session(&connection, &session_input()).expect("persist session");

    let gh = upsert_gh_pr(
        &connection,
        &GhPrRecord {
            session_id: "s1".to_owned(),
            pr_number: 7,
            head_sha: "abc".to_owned(),
            last_seen_check_state: "PENDING".to_owned(),
            updated_at: "2026-05-24T10:00:00.000Z".to_owned(),
            pr_state: Some("OPEN".to_owned()),
            notified_at: None,
        },
    )
    .expect("upsert gh pr");
    assert_eq!(gh.pr_number, 7);
    mark_gh_pr_notified(&connection, "s1", 7, "abc", "2026-05-24T10:01:00.000Z")
        .expect("mark notified");
    assert_eq!(
        list_gh_pr_for_session(&connection, "s1").expect("list prs")[0]
            .notified_at
            .as_deref(),
        Some("2026-05-24T10:01:00.000Z")
    );
    assert_eq!(
        list_open_gh_pr_session_ids(&connection).expect("open prs"),
        vec!["s1"]
    );

    persist_timeline_event(
        &connection,
        &PersistTimelineEventInput {
            id: "e-search".to_owned(),
            session_id: "s1".to_owned(),
            r#type: "message.delta".to_owned(),
            message: "FTS search can find this peculiar phrase".to_owned(),
            payload: serde_json::json!({}),
            created_at: Some("2026-05-24T10:02:00.000Z".to_owned()),
        },
    )
    .expect("persist searchable event");
    let learning = insert_learning(
        &connection,
        &InsertLearningInput {
            id: Some("l1".to_owned()),
            project_id: "p1".to_owned(),
            kind: "convention".to_owned(),
            summary: "Use rowid cursors for tails".to_owned(),
            evidence_session_id: Some("s1".to_owned()),
            evidence_event_id: Some("e-search".to_owned()),
        },
    )
    .expect("insert learning");
    assert_eq!(learning.kind, "convention");
    let verified = update_learning(
        &connection,
        &UpdateLearningInput {
            id: "l1".to_owned(),
            summary: None,
            verified: Some(true),
        },
    )
    .expect("update learning");
    assert!(verified.verified);
    assert_eq!(
        list_learnings(&connection, "p1", 10).expect("list learnings")[0].id,
        "l1"
    );
    assert_eq!(
        search_events(&connection, "peculiar phrase", 10).expect("search events")[0].event_id,
        "e-search"
    );
    assert_eq!(
        search_events(&connection, "pecu phr", 10).expect("search prefix events")[0].event_id,
        "e-search"
    );
    assert!(search_events(&connection, "\"peculiar\" OR nope", 10)
        .expect("search escapes query syntax")
        .is_empty());

    delete_learning(&connection, "l1").expect("delete learning");
    assert!(list_learnings(&connection, "p1", 10)
        .expect("list after delete")
        .is_empty());
}

#[test]
fn workspace_summaries_carry_latest_pr_on_every_read_path() {
    let database = Database::open_in_memory().expect("open db");
    let connection = database.connection();
    persist_project(&connection, &project_input()).expect("persist project");
    persist_workspace(&connection, &workspace_input()).expect("persist workspace");
    persist_session(&connection, &session_input()).expect("persist session");
    upsert_gh_pr(
        &connection,
        &GhPrRecord {
            session_id: "s1".to_owned(),
            pr_number: 12,
            head_sha: "abc".to_owned(),
            last_seen_check_state: "PENDING".to_owned(),
            updated_at: "2026-05-24T10:00:00.000Z".to_owned(),
            pr_state: Some("OPEN".to_owned()),
            notified_at: None,
        },
    )
    .expect("upsert gh pr");

    // Regression: delta publishers (state flips, pin toggles, watcher status
    // refreshes) build their WorkspaceSummary from these read paths, and the
    // renderer merges workspace deltas by whole-object replacement — a summary
    // with pr_state = None here erased the sidebar PR marker.
    let after_state = update_workspace_state(&connection, "w1", "complete").expect("update state");
    assert_eq!(after_state.pr_state.as_deref(), Some("OPEN"));
    assert_eq!(after_state.pr_number, Some(12));

    let found = find_workspace_by_id(&connection, "w1").expect("find workspace");
    assert_eq!(found.pr_state.as_deref(), Some("OPEN"));
    assert_eq!(found.pr_number, Some(12));
}

fn project_input() -> PersistProjectInput {
    PersistProjectInput {
        id: "p1".to_owned(),
        name: "Argmax".to_owned(),
        repo_path: "/tmp/repo".to_owned(),
        current_branch: "main".to_owned(),
        default_branch: Some("main".to_owned()),
        settings: ProjectSettings {
            default_provider: "claude".to_owned(),
            default_model_label: "Sonnet".to_owned(),
            worktree_location: "~/.argmax".to_owned(),
            setup_command: String::new(),
            check_commands: vec!["npm test".to_owned()],
        },
    }
}

fn workspace_input() -> PersistWorkspaceInput {
    PersistWorkspaceInput {
        id: "w1".to_owned(),
        project_id: "p1".to_owned(),
        task_label: "port persistence".to_owned(),
        branch: "feature/rust".to_owned(),
        base_ref: "main".to_owned(),
        path: "/tmp/repo/.worktrees/w1".to_owned(),
        state: "running".to_owned(),
        shared_workspace: false,
        dirty: false,
        changed_files: 0,
    }
}

fn session_input() -> PersistSessionInput {
    PersistSessionInput {
        id: "s1".to_owned(),
        workspace_id: "w1".to_owned(),
        provider: "codex".to_owned(),
        model_label: "GPT-5.5".to_owned(),
        model_id: "gpt-5.5".to_owned(),
        reasoning_effort: None,
        permission_mode: None,
        agent_mode: None,
        prompt: "make it excellent".to_owned(),
        state: "running".to_owned(),
        attention: "normal".to_owned(),
    }
}
