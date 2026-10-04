//! A -> B -> A rejoin, invalid-native fallback, and fork first-turn planning.

use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::{
    continuity::{
        fresh_retry_input, is_definite_rejection, latest_turn_starter, observe_provider_line,
        plan_launch, record_resume_rejected, RESUME_REJECTED,
    },
    follow_up::{compose_follow_up_prompt, compose_follow_up_prompt_since},
    LaunchContinuity, PermissionMode, ProviderId, ProviderLaunchInput,
};
use crate::{
    error::ArgmaxError,
    persistence::{
        continuity::{find_binding, list_bindings, BindingState},
        database::Database,
        events::{persist_timeline_event, PersistTimelineEventInput},
        sessions::{
            clear_session_conversation, find_session_by_id, update_session_provider,
            update_session_provider_conversation_id, SessionProviderInput,
        },
    },
};

const WORKSPACE: &str = "/tmp/w1";

pub(crate) fn seed_session(connection: &Connection, provider: &str) {
    connection
        .execute(
            "INSERT INTO projects (id, name, repo_path, current_branch, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', '~/.argmax', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
            [],
        )
        .expect("project");
    connection
        .execute(
            "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES ('w1', 'p1', 'task', 'branch', 'main', ?1, 'complete', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
            [WORKSPACE],
        )
        .expect("workspace");
    connection
        .execute(
            "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, reasoning_effort, permission_mode, agent_mode, prompt, state, attention, started_at, last_activity_at) VALUES ('s1', 'w1', ?1, 'Model', 'model-id', NULL, 'auto-approve', 'auto', 'prompt', 'complete', 'none', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
            [provider],
        )
        .expect("session");
}

pub(crate) fn event(connection: &Connection, session: &str, id: &str, kind: &str, text: &str) {
    event_with(connection, session, id, kind, text, json!({}));
}

pub(crate) fn event_with(
    connection: &Connection,
    session: &str,
    id: &str,
    kind: &str,
    text: &str,
    payload: Value,
) {
    persist_timeline_event(
        connection,
        &PersistTimelineEventInput {
            id: id.to_string(),
            session_id: session.to_string(),
            r#type: kind.to_string(),
            message: text.to_string(),
            payload,
            created_at: None,
        },
    )
    .expect("event");
}

fn switch_to(connection: &Connection, provider: &str) {
    update_session_provider(
        connection,
        "s1",
        &SessionProviderInput {
            provider: provider.to_string(),
            model_label: "Model".to_string(),
            model_id: format!("{provider}-model"),
            reasoning_effort: None,
        },
    )
    .expect("switch");
}

fn plan(
    connection: &Connection,
    provider: ProviderId,
    switched: bool,
) -> super::continuity::LaunchPlan {
    let mut session = find_session_by_id(connection, "s1").expect("session");
    plan_launch(
        connection,
        &mut session,
        provider,
        Path::new(WORKSPACE),
        switched,
    )
    .expect("plan")
}

/// Claude -> Codex -> Claude.
fn claude_codex_claude(connection: &Connection) {
    seed_session(connection, "claude");
    event(connection, "s1", "u1", "user.message", "build the exporter");
    event(connection, "s1", "a1", "message.completed", "built it");
    update_session_provider_conversation_id(connection, "s1", "claude-conv").unwrap();
    switch_to(connection, "codex");
    event(connection, "s1", "u2", "user.message", "now review it");
    event(connection, "s1", "a2", "message.completed", "review done");
    update_session_provider_conversation_id(connection, "s1", "codex-thread").unwrap();
    switch_to(connection, "claude");
}

#[test]
fn returning_to_a_provider_resumes_its_conversation_and_sends_only_what_it_missed() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    claude_codex_claude(&connection);

    let plan = plan(&connection, ProviderId::Claude, true);
    assert_eq!(plan.resume_conversation_id.as_deref(), Some("claude-conv"));
    assert_eq!(plan.since_event_id.as_deref(), Some("a1"));
    assert!(plan.needs_fallback_prompt);

    let message = "carry on\n\nwith the second part";
    let prompt = compose_follow_up_prompt_since(
        &connection,
        "s1",
        message,
        true,
        plan.since_event_id.as_deref(),
    )
    .unwrap();
    assert!(prompt.contains("User: now review it"));
    assert!(prompt.contains("Assistant: review done"));
    // Claude's own conversation already holds the first exchange.
    assert!(!prompt.contains("build the exporter"));
    assert!(!prompt.contains("built it"));
    // The new message rides last, untouched and separate.
    assert!(prompt.ends_with(&format!("New user message:\n{message}")));
    assert!(prompt.find("Messages you missed").unwrap() < prompt.find("New user message").unwrap());
}

#[test]
fn the_rejoined_binding_becomes_the_live_pointer_and_the_other_is_parked() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    claude_codex_claude(&connection);
    plan(&connection, ProviderId::Claude, true);

    let session = find_session_by_id(&connection, "s1").unwrap();
    assert_eq!(
        session.provider_conversation_id.as_deref(),
        Some("claude-conv")
    );
    let claude = find_binding(&connection, "s1", "claude", "claude-conv")
        .unwrap()
        .unwrap();
    let codex = find_binding(&connection, "s1", "codex", "codex-thread")
        .unwrap()
        .unwrap();
    assert_eq!(claude.state, BindingState::Active);
    assert_eq!(codex.state, BindingState::Parked);
    assert_eq!(codex.delivered_through_event_id.as_deref(), Some("a2"));
}

#[test]
fn a_second_switch_back_only_sends_what_happened_since_leaving() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    claude_codex_claude(&connection);
    plan(&connection, ProviderId::Claude, true);
    event(&connection, "s1", "u3", "user.message", "third ask");
    event(&connection, "s1", "a3", "message.completed", "third answer");
    // Claude answered, so it holds everything up to here.
    super::continuity::note_provider_output(&connection, "s1", ["message.completed"]).unwrap();
    switch_to(&connection, "codex");
    event(&connection, "s1", "u4", "user.message", "codex again");
    switch_to(&connection, "claude");

    let plan = plan(&connection, ProviderId::Claude, true);
    assert_eq!(plan.since_event_id.as_deref(), Some("a3"));
    let prompt = compose_follow_up_prompt_since(
        &connection,
        "s1",
        "next",
        true,
        plan.since_event_id.as_deref(),
    )
    .unwrap();
    assert!(prompt.contains("User: codex again"));
    assert!(!prompt.contains("third ask"));
}

#[test]
fn a_prompt_the_provider_never_answered_is_retold_after_a_switch() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    seed_session(&connection, "claude");
    event(&connection, "s1", "u1", "user.message", "first");
    event(&connection, "s1", "a1", "message.completed", "answered");
    update_session_provider_conversation_id(&connection, "s1", "claude-conv").unwrap();
    // The launch failed before any output: only an error follows the prompt.
    event(&connection, "s1", "u2", "user.message", "never admitted");
    event(&connection, "s1", "e1", "error", "launch failed");
    switch_to(&connection, "codex");
    switch_to(&connection, "claude");

    let plan = plan(&connection, ProviderId::Claude, true);
    assert_eq!(plan.since_event_id.as_deref(), Some("a1"));
    let prompt = compose_follow_up_prompt_since(
        &connection,
        "s1",
        "retry",
        true,
        plan.since_event_id.as_deref(),
    )
    .unwrap();
    assert!(prompt.contains("User: never admitted"));
}

#[test]
fn clearing_the_chat_forgets_every_parked_conversation() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    seed_session(&connection, "claude");
    event(&connection, "s1", "u1", "user.message", "hello");
    update_session_provider_conversation_id(&connection, "s1", "claude-conv").unwrap();
    switch_to(&connection, "codex");
    clear_session_conversation(&connection, "s1").unwrap();
    switch_to(&connection, "claude");

    let plan = plan(&connection, ProviderId::Claude, true);
    assert_eq!(plan.resume_conversation_id, None);
    assert_eq!(plan.since_event_id, None);
    // The cleared conversation is gone; the fresh launch names its own.
    assert_not_resumable(&connection, "claude", "claude-conv");
    assert_eq!(list_bindings(&connection, "s1").unwrap().len(), 1);
}

/// A binding that was invalidated, or superseded by a fresh conversation.
fn assert_not_resumable(connection: &Connection, provider: &str, conversation_id: &str) {
    let binding = find_binding(connection, "s1", provider, conversation_id).unwrap();
    assert!(
        binding.is_none_or(|binding| binding.state == BindingState::Invalid),
        "{conversation_id} is still resumable"
    );
}

#[test]
fn a_parked_conversation_from_another_provider_config_is_not_resumed() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    claude_codex_claude(&connection);
    connection
        .execute(
            "UPDATE provider_bindings SET config_identity = 'another-account' WHERE provider = 'claude'",
            [],
        )
        .unwrap();

    let plan = plan(&connection, ProviderId::Claude, true);
    assert_eq!(plan.resume_conversation_id, None);
    assert_not_resumable(&connection, "claude", "claude-conv");
}

#[test]
fn a_parked_conversation_for_another_directory_is_not_resumed() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    claude_codex_claude(&connection);
    connection
        .execute(
            "UPDATE provider_bindings SET working_dir = '/tmp/elsewhere' WHERE provider = 'claude'",
            [],
        )
        .unwrap();
    assert_eq!(
        plan(&connection, ProviderId::Claude, true).resume_conversation_id,
        None
    );
}

#[test]
fn a_fresh_claude_launch_names_a_new_conversation_id() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    seed_session(&connection, "claude");
    let first = plan(&connection, ProviderId::Claude, false);
    let fresh = first.continuity.fresh_native_id.clone().expect("fresh id");
    // The CLI refuses an id whose transcript exists, and Argmax's session id
    // is spent by the first conversation.
    assert_ne!(fresh, "s1");
    // Not saved yet: Claude reports it at `system/init`. A launch that fails
    // before that must leave the pointer empty, or every later send would
    // resume a conversation that was never created.
    let session = find_session_by_id(&connection, "s1").unwrap();
    assert_eq!(session.provider_conversation_id, None);
    let again = plan(&connection, ProviderId::Claude, false);
    assert_eq!(again.resume_conversation_id, None);
    assert_ne!(again.continuity.fresh_native_id, Some(fresh));
    // Codex names its own thread, so it needs none.
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    seed_session(&connection, "codex");
    assert_eq!(
        super::continuity::plan_launch(
            &connection,
            &mut find_session_by_id(&connection, "s1").unwrap(),
            ProviderId::Codex,
            Path::new(WORKSPACE),
            false
        )
        .unwrap()
        .continuity
        .fresh_native_id,
        None
    );
}

fn launch_with(fallback: Option<&str>) -> ProviderLaunchInput {
    ProviderLaunchInput {
        provider: ProviderId::Claude,
        session_id: "s1".to_string(),
        workspace_path: WORKSPACE.into(),
        prompt: "native prompt".to_string(),
        model_label: "Model".to_string(),
        model_id: "model-id".to_string(),
        reasoning_effort: None,
        fast_mode: false,
        resume_conversation_id: Some("claude-conv".to_string()),
        resume_fork: false,
        permission_mode: PermissionMode::AutoApprove,
        agent_mode: super::AgentMode::Auto,
        cols: 80,
        rows: 24,
        continuity: Some(LaunchContinuity {
            fresh_fallback_prompt: fallback.map(str::to_string),
            ..LaunchContinuity::default()
        }),
    }
}

#[test]
fn a_definite_rejection_retries_once_fresh_with_the_fallback_prompt() {
    let launch = launch_with(Some("portable prompt"));
    let retry = fresh_retry_input(&launch).expect("retry");
    assert_eq!(retry.prompt, "portable prompt");
    assert_eq!(retry.resume_conversation_id, None);
    assert!(!retry.resume_fork);
    let retry_continuity = retry.continuity.expect("continuity");
    assert!(retry_continuity.fresh_native_id.is_some());
    // The retry cannot itself be retried.
    assert_eq!(retry_continuity.fresh_fallback_prompt, None);

    assert!(is_definite_rejection(&ArgmaxError::service(
        RESUME_REJECTED,
        "gone"
    )));
    // A timeout or a lost reply does not say whether the turn was admitted.
    assert!(!is_definite_rejection(&ArgmaxError::service(
        "CODEX_APP_SERVER_TIMEOUT",
        "slow"
    )));
}

#[test]
fn a_launch_without_a_fallback_prompt_is_never_retried() {
    assert!(fresh_retry_input(&launch_with(None)).is_none());
    let mut fresh_launch = launch_with(Some("portable"));
    fresh_launch.resume_conversation_id = None;
    assert!(fresh_retry_input(&fresh_launch).is_none());
}

#[test]
fn a_rejected_resume_stops_being_trusted_and_leaves_the_pointer_for_the_retrys_init() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    seed_session(&connection, "claude");
    update_session_provider_conversation_id(&connection, "s1", "claude-conv").unwrap();
    let retry = fresh_retry_input(&launch_with(Some("portable"))).unwrap();
    assert!(retry.continuity.as_ref().unwrap().fresh_native_id.is_some());

    record_resume_rejected(&connection, &retry, "claude-conv").unwrap();

    assert_not_resumable(&connection, "claude", "claude-conv");
    // The retry's own id arrives at its `system/init`; until then nothing points
    // at a conversation that may never exist.
    let session = find_session_by_id(&connection, "s1").unwrap();
    assert_eq!(session.provider_conversation_id, None);
}

#[test]
fn the_fallback_prompt_carries_the_current_message_once() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    claude_codex_claude(&connection);
    // Composed at send time, before the current message is persisted.
    let fallback = compose_follow_up_prompt(&connection, "s1", "the new ask", false).unwrap();
    assert_eq!(fallback.matches("the new ask").count(), 1);
    assert!(fallback.contains("User: build the exporter"));
    assert!(fallback.ends_with("New user message:\nthe new ask"));
}

#[test]
fn a_steered_message_never_becomes_a_codex_turn_boundary() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    seed_session(&connection, "codex");
    update_session_provider_conversation_id(&connection, "s1", "thread-1").unwrap();
    event(&connection, "s1", "u1", "user.message", "start the work");
    observe_provider_line(
        &connection,
        "s1",
        r#"{"type":"thread.started","thread_id":"thread-1","turn_id":"turn-1"}"#,
    )
    .unwrap();
    // Guidance sent into the running turn: it started no provider turn.
    event_with(
        &connection,
        "s1",
        "steer1",
        "user.message",
        "also handle errors",
        json!({"delivery": "steer"}),
    );
    assert_eq!(
        latest_turn_starter(&connection, "s1").unwrap().as_deref(),
        Some("u1")
    );
    assert_eq!(
        crate::persistence::continuity::binding_turn(&connection, "s1", "codex", "thread-1", "u1")
            .unwrap()
            .as_deref(),
        Some("turn-1")
    );
    assert_eq!(
        crate::persistence::continuity::binding_turn(
            &connection,
            "s1",
            "codex",
            "thread-1",
            "steer1"
        )
        .unwrap(),
        None
    );
}

#[test]
fn a_turn_line_for_a_non_codex_session_is_ignored() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    seed_session(&connection, "claude");
    update_session_provider_conversation_id(&connection, "s1", "claude-conv").unwrap();
    event(&connection, "s1", "u1", "user.message", "hello");
    observe_provider_line(
        &connection,
        "s1",
        r#"{"type":"thread.started","thread_id":"claude-conv","turn_id":"turn-1"}"#,
    )
    .unwrap();
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM provider_binding_turns", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn a_failed_return_launch_still_owes_the_missed_context_on_the_next_send() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    claude_codex_claude(&connection);

    // The return send switches providers. Its launch then fails before the
    // provider admits anything, so no output ever arrives.
    let first = plan(&connection, ProviderId::Claude, true);
    assert_eq!(first.since_event_id.as_deref(), Some("a1"));
    event(&connection, "s1", "u3", "user.message", "retry the return");
    event(&connection, "s1", "e1", "error", "launch failed");
    super::continuity::note_provider_output(
        &connection,
        "s1",
        ["user.message", "error", "session.started"],
    )
    .unwrap();

    // The next send is not a switch, but the conversation is still owed B's work.
    let retry = plan(&connection, ProviderId::Claude, false);
    assert_eq!(retry.resume_conversation_id.as_deref(), Some("claude-conv"));
    assert_eq!(retry.since_event_id.as_deref(), Some("a1"));
    assert!(retry.needs_fallback_prompt);
    let prompt = compose_follow_up_prompt_since(
        &connection,
        "s1",
        "again",
        true,
        retry.since_event_id.as_deref(),
    )
    .unwrap();
    assert!(prompt.contains("User: now review it"));

    // Output from the provider proves it holds everything it was owed.
    super::continuity::note_provider_output(&connection, "s1", ["message.delta"]).unwrap();
    let settled = plan(&connection, ProviderId::Claude, false);
    assert_eq!(settled.since_event_id, None);
    assert!(!settled.needs_fallback_prompt);
}

#[test]
fn grok_names_no_conversation_id_of_its_own() {
    // Its ACP runtime mints the id on `session/new` and reports it at init;
    // seeding one would point the session at a conversation Grok never saw.
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    seed_session(&connection, "grok");
    let plan = plan(&connection, ProviderId::Grok, false);
    assert_eq!(plan.continuity.fresh_native_id, None);
    assert_eq!(
        find_session_by_id(&connection, "s1")
            .unwrap()
            .provider_conversation_id,
        None
    );
}

#[test]
fn the_migration_seed_skips_children_that_still_hold_their_sources_id() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    seed_session(&connection, "claude");
    update_session_provider_conversation_id(&connection, "s1", "own-conv").unwrap();
    connection
        .execute(
            "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, permission_mode, prompt, state, attention, started_at, last_activity_at, provider_conversation_id, resume_fork) VALUES ('child', 'w1', 'claude', 'Model', 'model-id', 'auto-approve', 'prompt', 'complete', 'none', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z', 'source-conv', 1)",
            [],
        )
        .unwrap();
    connection
        .execute("DELETE FROM provider_bindings", [])
        .unwrap();

    let migration = crate::persistence::continuity::MIGRATION_SQL;
    let seed = &migration[migration.find("INSERT INTO provider_bindings").unwrap()..];
    connection
        .execute_batch(&seed[..=seed.find(';').unwrap()])
        .unwrap();

    let bound: Vec<String> = connection
        .prepare("SELECT session_id FROM provider_bindings")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    // Without the filter the child could switch away and back and then resume
    // its source's conversation as its own.
    assert_eq!(bound, ["s1"]);
}

#[test]
fn leaving_again_after_a_failed_return_keeps_the_older_owed_boundary() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    claude_codex_claude(&connection);

    // Return to Claude. The launch fails before any output.
    let first = plan(&connection, ProviderId::Claude, true);
    assert_eq!(first.since_event_id.as_deref(), Some("a1"));

    // The person goes back to Codex for another turn, then returns again.
    switch_to(&connection, "codex");
    event(&connection, "s1", "u3", "user.message", "one more review");
    event(
        &connection,
        "s1",
        "a3",
        "message.completed",
        "second review done",
    );
    switch_to(&connection, "claude");

    let second = plan(&connection, ProviderId::Claude, true);
    // Claude still has not seen anything since a1, so both Codex turns are owed.
    assert_eq!(second.since_event_id.as_deref(), Some("a1"));
    let prompt = compose_follow_up_prompt_since(
        &connection,
        "s1",
        "go",
        true,
        second.since_event_id.as_deref(),
    )
    .unwrap();
    assert!(prompt.contains("User: now review it") && prompt.contains("Assistant: review done"));
    assert!(prompt.contains("Assistant: second review done"));
}

#[test]
fn a_parked_binding_that_was_answered_parks_at_the_newest_event_as_before() {
    let database = Database::open_in_memory().unwrap();
    let connection = database.connection();
    claude_codex_claude(&connection);
    plan(&connection, ProviderId::Claude, true);
    event(&connection, "s1", "u3", "user.message", "continue");
    event(&connection, "s1", "a3", "message.completed", "continued");
    super::continuity::note_provider_output(&connection, "s1", ["message.completed"]).unwrap();

    switch_to(&connection, "codex");
    switch_to(&connection, "claude");
    assert_eq!(
        plan(&connection, ProviderId::Claude, true)
            .since_event_id
            .as_deref(),
        Some("a3")
    );
}

#[tokio::test]
async fn grok_rejects_a_resume_it_cannot_list_before_sending_anything() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let server = temp.path().join("fake-grok-acp");
    // Answers every request with an empty result: `session/list` names no
    // session, so the resume target is missing.
    std::fs::write(
        &server,
        "#!/bin/sh\nid=1\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\" >> requests.jsonl\n  printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{}}\\n' \"$id\"\n  id=$((id + 1))\ndone\n",
    )
    .unwrap();
    std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut input = super::continuity_tests::grok_input(temp.path());
    input.resume_conversation_id = Some("gone".to_string());
    let sessions = super::grok_acp::GrokAcpSessions::new();
    let callback: super::runtime::EventCallback = std::sync::Arc::new(|_| {});
    let error = sessions
        .launch_turn(server.to_str().unwrap(), &input, None, None, callback)
        .await
        .err()
        .expect("the resume is refused");
    assert!(is_definite_rejection(&error), "{error:?}");
    // No prompt reached Grok.
    let requests = std::fs::read_to_string(temp.path().join("requests.jsonl")).unwrap();
    assert!(!requests.contains("session/prompt"), "{requests}");
}

pub(crate) fn grok_input(dir: &Path) -> ProviderLaunchInput {
    let mut input = launch_with(None);
    input.provider = ProviderId::Grok;
    input.workspace_path = dir.to_path_buf();
    input.resume_conversation_id = None;
    input.continuity = None;
    input
}
