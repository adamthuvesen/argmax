// End-to-end tests for session sync: importing sessions that were started
// outside Argmax from the provider CLI's own transcript store, keeping them
// current, and pruning the ones the user never continued.
//
// Each test drives `run_sync` against a real (temp) home directory laid out
// like `~/.claude/projects/<slug>/<sessionId>.jsonl`, with a real in-memory
// SQLite and a real WorkspaceService.

mod support {
    pub mod git_repo;
}

use std::path::Path;
use std::sync::{Arc, Mutex};

use argmax_lib::persistence::{
    database::Database,
    events::list_session_events_since,
    projects::{persist_project, PersistProjectInput, ProjectSettings},
    sessions::{find_session_by_id, list_sessions_for_dashboard},
    synced::{list_synced_sessions, mark_synced_session_adopted},
};
use argmax_lib::providers::flush_queue::DashboardDelta;
use argmax_lib::sync::{run_sync, SyncConfig, WINDOW_24H, WINDOW_7D};
use argmax_lib::workspaces::WorkspaceService;

use support::git_repo::seed_git_repo;

const PROJECT_ID: &str = "p-sync-test";

fn capture_publisher() -> (
    impl Fn(DashboardDelta) + Send + Sync + 'static,
    Arc<Mutex<Vec<DashboardDelta>>>,
) {
    let sink = Arc::new(Mutex::new(Vec::new()));
    let writer = sink.clone();
    (
        move |delta| writer.lock().expect("sink poisoned").push(delta),
        sink,
    )
}

fn build_project(database: &Database, repo_path: &str) {
    let connection = database.connection();
    persist_project(
        &connection,
        &PersistProjectInput {
            id: PROJECT_ID.to_string(),
            name: "Sync Test".to_string(),
            repo_path: repo_path.to_string(),
            current_branch: "main".to_string(),
            default_branch: Some("main".to_string()),
            settings: ProjectSettings {
                worktree_location: String::new(),
                setup_command: String::new(),
                check_commands: vec![],
            },
        },
    )
    .expect("persist project");
}

fn claude_enabled() -> SyncConfig {
    SyncConfig {
        claude: true,
        window_hours: WINDOW_7D,
        ..SyncConfig::default()
    }
}

/// Write a Claude transcript into a temp `$HOME`, mirroring the real layout.
fn write_transcript(home: &Path, cwd: &str, session_id: &str, lines: &[String]) {
    let slug = cwd.replace(['/', '.', ' '], "-");
    let dir = home.join(".claude").join("projects").join(slug);
    std::fs::create_dir_all(&dir).expect("create transcript dir");
    std::fs::write(dir.join(format!("{session_id}.jsonl")), lines.join("\n"))
        .expect("write transcript");
}

/// Push a transcript's mtime forward: the sweep only re-reads a file whose
/// mtime moved, and temp writes can land in the same millisecond.
fn bump_mtime(path: &Path, seconds: u64) {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .expect("open transcript")
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(seconds))
        .expect("bump mtime");
}

fn user_line(cwd: &str, session_id: &str, timestamp: &str, text: &str) -> String {
    format!(
        r#"{{"type":"user","isSidechain":false,"cwd":"{cwd}","timestamp":"{timestamp}","sessionId":"{session_id}","message":{{"role":"user","content":"{text}"}}}}"#
    )
}

fn assistant_line(cwd: &str, session_id: &str, timestamp: &str, text: &str) -> String {
    format!(
        r#"{{"type":"assistant","isSidechain":false,"cwd":"{cwd}","timestamp":"{timestamp}","sessionId":"{session_id}","message":{{"role":"assistant","model":"claude-opus-5","content":[{{"type":"text","text":"{text}"}}]}}}}"#
    )
}

struct Harness {
    _repo: support::git_repo::SeededGitRepo,
    home: tempfile::TempDir,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    deltas: Arc<Mutex<Vec<DashboardDelta>>>,
    repo_path: String,
}

fn harness() -> Harness {
    let repo = seed_git_repo(&[("README.md", "hi")]);
    let repo_path = repo.path().display().to_string();
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(&database, &repo_path);
    let (publisher, deltas) = capture_publisher();
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), publisher);
    Harness {
        _repo: repo,
        home: tempfile::tempdir().expect("home"),
        database,
        workspaces,
        deltas,
        repo_path,
    }
}

impl Harness {
    fn sync(&self, config: &SyncConfig) -> argmax_lib::sync::SyncOutcome {
        run_sync(
            &self.database,
            &self.workspaces,
            config,
            self.home.path(),
            chrono::Utc::now().timestamp_millis(),
        )
        .expect("sync")
    }

    fn sessions(&self) -> Vec<argmax_lib::persistence::sessions::SessionSummary> {
        let connection = self.database.connection();
        list_sessions_for_dashboard(&connection, None, 100).expect("list sessions")
    }

    fn transcript_path(&self, session_id: &str) -> std::path::PathBuf {
        self.home
            .path()
            .join(".claude/projects")
            .join(self.repo_path.replace(['/', '.', ' '], "-"))
            .join(format!("{session_id}.jsonl"))
    }

    fn seed_session(&self, session_id: &str, prompt: &str) {
        write_transcript(
            self.home.path(),
            &self.repo_path,
            session_id,
            &[
                user_line(
                    &self.repo_path,
                    session_id,
                    "2026-08-30T10:00:00.000Z",
                    prompt,
                ),
                assistant_line(
                    &self.repo_path,
                    session_id,
                    "2026-08-30T10:00:05.000Z",
                    "On it.",
                ),
            ],
        );
    }
}

#[test]
fn imports_a_terminal_session_with_its_transcript_and_resume_id() {
    let harness = harness();
    harness.seed_session("sess-import", "Fix the flaky test");

    let outcome = harness.sync(&claude_enabled());
    assert_eq!(outcome.imported, 1);

    let sessions = harness.sessions();
    assert_eq!(sessions.len(), 1);
    let session = &sessions[0];
    assert!(session.imported, "session should be flagged as imported");
    assert_eq!(session.provider, "claude");
    assert_eq!(session.prompt, "Fix the flaky test");
    // The provider session id is the resume id: without it, continuing an
    // imported session in Argmax could not reach the real conversation.
    assert_eq!(
        session.provider_conversation_id.as_deref(),
        Some("sess-import")
    );
    assert_eq!(session.model_id, "claude-opus-5");

    // The transcript became real timeline events, not raw protocol text.
    let connection = harness.database.connection();
    let events = list_session_events_since(&connection, &session.id, None, None)
        .expect("events")
        .events;
    assert!(
        events.iter().any(|event| event.message.contains("On it.")),
        "assistant text should reach the timeline: {events:#?}"
    );
    drop(connection);

    // The sidebar learns about it through the normal delta channel.
    let deltas = harness.deltas.lock().expect("sink");
    assert!(deltas
        .iter()
        .any(|delta| !delta.sessions.is_empty() && !delta.workspaces.is_empty()));
}

#[test]
fn an_imported_session_keeps_both_sides_of_the_conversation() {
    let harness = harness();
    let cwd = harness.repo_path.clone();
    // Content blocks and a bare string are both shapes Claude's transcript
    // writes for a typed prompt; a tool result rides the same `user` type.
    let array_prompt = format!(
        r#"{{"type":"user","isSidechain":false,"cwd":"{cwd}","timestamp":"2026-08-30T10:05:00.000Z","sessionId":"sess-both","message":{{"role":"user","content":[{{"type":"text","text":"And also this"}}]}}}}"#
    );
    let tool_result = format!(
        r#"{{"type":"user","isSidechain":false,"cwd":"{cwd}","timestamp":"2026-08-30T10:05:02.000Z","sessionId":"sess-both","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_1","content":"done"}}]}}}}"#
    );
    write_transcript(
        harness.home.path(),
        &cwd,
        "sess-both",
        &[
            user_line(
                &cwd,
                "sess-both",
                "2026-08-30T10:00:00.000Z",
                "Fix the flaky test",
            ),
            assistant_line(&cwd, "sess-both", "2026-08-30T10:00:05.000Z", "On it."),
            array_prompt,
            tool_result,
        ],
    );

    assert_eq!(harness.sync(&claude_enabled()).imported, 1);
    let session_id = harness.sessions()[0].id.clone();
    let connection = harness.database.connection();
    let events = list_session_events_since(&connection, &session_id, None, None)
        .expect("events")
        .events;

    let prompts = events
        .iter()
        .filter(|event| event.r#type == "user.message")
        .map(|event| event.message.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        prompts,
        vec!["Fix the flaky test", "And also this"],
        "both prompt shapes must reach the timeline: {events:#?}"
    );
    // A tool-result row is not a prompt; it stays the normalizer's business.
    assert!(
        !events
            .iter()
            .any(|event| event.r#type == "user.message" && event.message.contains("done")),
        "a tool result must not become a user message: {events:#?}"
    );
    // Each event carries the timestamp of the line it came from, not one
    // sweep instant for the whole batch.
    let prompt = events
        .iter()
        .find(|event| event.r#type == "user.message")
        .expect("prompt event");
    assert_eq!(prompt.created_at, "2026-08-30T10:00:00.000Z");
}

#[test]
fn model_facing_bodies_never_become_imported_prompts() {
    let harness = harness();
    let cwd = harness.repo_path.clone();
    // Claude's transcript store writes no `isSynthetic` flag on these.
    let skill_body = format!(
        r#"{{"type":"user","isSidechain":false,"cwd":"{cwd}","timestamp":"2026-08-30T10:01:00.000Z","sessionId":"sess-hidden","message":{{"role":"user","content":[{{"type":"text","text":"Base directory for this skill: /repo/.claude/skills/review\n\n# Review"}}]}}}}"#
    );
    write_transcript(
        harness.home.path(),
        &cwd,
        "sess-hidden",
        &[
            user_line(&cwd, "sess-hidden", "2026-08-30T10:00:00.000Z", "Review it"),
            skill_body,
            assistant_line(&cwd, "sess-hidden", "2026-08-30T10:02:00.000Z", "On it."),
        ],
    );

    assert_eq!(harness.sync(&claude_enabled()).imported, 1);
    let session_id = harness.sessions()[0].id.clone();
    let connection = harness.database.connection();
    let events = list_session_events_since(&connection, &session_id, None, None)
        .expect("events")
        .events;
    assert!(
        !events
            .iter()
            .any(|event| event.message.contains("Base directory for this skill")),
        "a skill body is written for the model, not the chat: {events:#?}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.r#type == "user.message")
            .count(),
        1
    );
}

#[test]
fn sessions_outside_a_registered_project_are_ignored() {
    let harness = harness();
    // Same shape, but the cwd belongs to no registered project.
    write_transcript(
        harness.home.path(),
        "/somewhere/else",
        "sess-elsewhere",
        &[user_line(
            "/somewhere/else",
            "sess-elsewhere",
            "2026-08-30T10:00:00.000Z",
            "not our repo",
        )],
    );

    assert_eq!(harness.sync(&claude_enabled()).imported, 0);
    assert!(harness.sessions().is_empty());
}

#[test]
fn re_running_sync_neither_duplicates_sessions_nor_events() {
    let harness = harness();
    harness.seed_session("sess-idempotent", "Hello");

    let config = claude_enabled();
    assert_eq!(harness.sync(&config).imported, 1);
    let first = harness.sessions();
    let event_count = {
        let connection = harness.database.connection();
        list_session_events_since(&connection, &first[0].id, None, None)
            .expect("events")
            .events
            .len()
    };

    // A second sweep sees the same file: nothing new to import or write.
    let second_outcome = harness.sync(&config);
    assert_eq!(second_outcome.imported, 0);
    assert_eq!(harness.sessions().len(), 1);

    let connection = harness.database.connection();
    let after = list_session_events_since(&connection, &first[0].id, None, None)
        .expect("events")
        .events
        .len();
    assert_eq!(after, event_count, "re-reading must not duplicate bubbles");
    assert_eq!(second_outcome.extended, 0);
}

#[test]
fn a_growing_transcript_extends_the_imported_session() {
    let harness = harness();
    harness.seed_session("sess-growing", "Start");
    assert_eq!(harness.sync(&claude_enabled()).imported, 1);
    let session_id = harness.sessions()[0].id.clone();

    // The terminal session keeps working: more lines land in the same file.
    write_transcript(
        harness.home.path(),
        &harness.repo_path,
        "sess-growing",
        &[
            user_line(
                &harness.repo_path,
                "sess-growing",
                "2026-08-30T10:00:00.000Z",
                "Start",
            ),
            assistant_line(
                &harness.repo_path,
                "sess-growing",
                "2026-08-30T10:00:05.000Z",
                "On it.",
            ),
            user_line(
                &harness.repo_path,
                "sess-growing",
                "2026-08-30T10:05:00.000Z",
                "And also this",
            ),
            assistant_line(
                &harness.repo_path,
                "sess-growing",
                "2026-08-30T10:05:05.000Z",
                "Second answer",
            ),
        ],
    );
    // mtime must move for the sweep to notice; temp writes can land in the
    // same millisecond, so push it forward explicitly.
    let path = harness
        .home
        .path()
        .join(".claude/projects")
        .join(harness.repo_path.replace(['/', '.', ' '], "-"))
        .join("sess-growing.jsonl");
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("open transcript");
    file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
        .expect("bump mtime");

    let outcome = harness.sync(&claude_enabled());
    assert_eq!(outcome.imported, 0, "same session, not a new one");
    assert_eq!(outcome.extended, 1);

    let connection = harness.database.connection();
    let events = list_session_events_since(&connection, &session_id, None, None)
        .expect("events")
        .events;
    assert!(events
        .iter()
        .any(|event| event.message.contains("Second answer")));
    // And still exactly one of the original.
    assert_eq!(
        events
            .iter()
            .filter(|event| event.message.contains("On it."))
            .count(),
        1
    );
}

#[test]
fn consecutive_extends_keep_appending_every_new_line() {
    let harness = harness();
    harness.seed_session("sess-repeat", "Start");
    assert_eq!(harness.sync(&claude_enabled()).imported, 1);
    let session_id = harness.sessions()[0].id.clone();

    let mut lines = vec![
        user_line(
            &harness.repo_path,
            "sess-repeat",
            "2026-08-30T10:00:00.000Z",
            "Start",
        ),
        assistant_line(
            &harness.repo_path,
            "sess-repeat",
            "2026-08-30T10:00:05.000Z",
            "On it.",
        ),
    ];
    // Three rounds, not one: the cursor is an absolute line index, and a
    // single extend cannot tell an absolute cursor from a relative one. A
    // cursor that adds itself to the new index runs away (2 → 6 → 12) and
    // silences the session from the second extend onwards.
    for round in 1..=3 {
        lines.push(user_line(
            &harness.repo_path,
            "sess-repeat",
            "2026-08-30T10:00:00.000Z",
            &format!("Follow-up {round}"),
        ));
        lines.push(assistant_line(
            &harness.repo_path,
            "sess-repeat",
            "2026-08-30T10:00:05.000Z",
            &format!("Answer {round}"),
        ));
        write_transcript(
            harness.home.path(),
            &harness.repo_path,
            "sess-repeat",
            &lines,
        );
        bump_mtime(&harness.transcript_path("sess-repeat"), round * 5);

        let outcome = harness.sync(&claude_enabled());
        assert_eq!(
            outcome.extended, 1,
            "round {round} should extend the session"
        );

        let connection = harness.database.connection();
        let events = list_session_events_since(&connection, &session_id, None, None)
            .expect("events")
            .events;
        assert!(
            events
                .iter()
                .any(|event| event.message.contains(&format!("Answer {round}"))),
            "round {round} answer never reached the timeline: {events:#?}"
        );
    }

    // And still exactly one copy of everything that came before.
    let connection = harness.database.connection();
    let events = list_session_events_since(&connection, &session_id, None, None)
        .expect("events")
        .events;
    for round in 1..=3 {
        assert_eq!(
            events
                .iter()
                .filter(|event| event.message.contains(&format!("Answer {round}")))
                .count(),
            1
        );
    }
}

#[test]
fn a_transcript_with_no_assistant_reply_yet_imports_a_launchable_model() {
    let harness = harness();
    // The sweep can land between a terminal prompt and its first assistant
    // chunk, and only the assistant lines carry the model. An empty model id
    // would persist a session the CLI refuses to resume.
    write_transcript(
        harness.home.path(),
        &harness.repo_path,
        "sess-no-model",
        &[user_line(
            &harness.repo_path,
            "sess-no-model",
            "2026-08-30T10:00:00.000Z",
            "Just asked",
        )],
    );

    assert_eq!(harness.sync(&claude_enabled()).imported, 1);
    let session = &harness.sessions()[0];
    assert!(
        !session.model_id.is_empty(),
        "imported model id must be launchable"
    );
    assert!(!session.model_label.is_empty());
}

#[test]
fn turning_sync_off_prunes_imports_the_user_never_continued() {
    let harness = harness();
    harness.seed_session("sess-untouched", "Never continued");
    harness.seed_session("sess-adopted", "Continued in Argmax");
    assert_eq!(harness.sync(&claude_enabled()).imported, 2);
    assert_eq!(harness.sessions().len(), 2);

    // The user continues one of them inside Argmax.
    let adopted_id = harness
        .sessions()
        .into_iter()
        .find(|session| session.prompt == "Continued in Argmax")
        .expect("adopted session")
        .id;
    {
        let connection = harness.database.connection();
        assert!(mark_synced_session_adopted(&connection, &adopted_id).expect("adopt"));
    }

    // Turning the provider off disposes of the untouched import only.
    let outcome = harness.sync(&SyncConfig::default());
    assert_eq!(outcome.pruned, 1);

    let remaining = harness.sessions();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, adopted_id);

    // The renderer is told to drop the pruned row — the delta protocol is
    // otherwise pure whole-object replacement with no way to say "gone".
    let deltas = harness.deltas.lock().expect("sink");
    assert!(deltas
        .iter()
        .any(|delta| !delta.removed_session_ids.is_empty()
            && !delta.removed_workspace_ids.is_empty()));
}

#[test]
fn re_enabling_sync_re_imports_a_pruned_session() {
    let harness = harness();
    harness.seed_session("sess-roundtrip", "Comes back");

    assert_eq!(harness.sync(&claude_enabled()).imported, 1);
    assert_eq!(harness.sync(&SyncConfig::default()).pruned, 1);
    assert!(harness.sessions().is_empty());

    // The provider's own file is still the source of truth, so nothing was
    // actually lost by turning sync off.
    assert_eq!(harness.sync(&claude_enabled()).imported, 1);
    assert_eq!(harness.sessions().len(), 1);
}

#[test]
fn shrinking_the_window_prunes_sessions_that_fell_outside_it() {
    let harness = harness();
    let old_session = "sess-old";
    write_transcript(
        harness.home.path(),
        &harness.repo_path,
        old_session,
        &[user_line(
            &harness.repo_path,
            old_session,
            // Started three days ago: inside a 7d window, outside a 24h one.
            &(chrono::Utc::now() - chrono::Duration::days(3)).to_rfc3339(),
            "Three days ago",
        )],
    );

    // Discovery keys on file mtime, so age the file to match its content:
    // this is a session that both started and last ran three days ago.
    let path = harness
        .home
        .path()
        .join(".claude/projects")
        .join(harness.repo_path.replace(['/', '.', ' '], "-"))
        .join(format!("{old_session}.jsonl"));
    let three_days_ago =
        std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 24 * 60 * 60);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("open transcript")
        .set_modified(three_days_ago)
        .expect("age the transcript");

    assert_eq!(harness.sync(&claude_enabled()).imported, 1);
    assert_eq!(harness.sessions().len(), 1);

    let narrowed = SyncConfig {
        claude: true,
        window_hours: WINDOW_24H,
        ..SyncConfig::default()
    };
    assert_eq!(harness.sync(&narrowed).pruned, 1);
    assert!(
        harness.sessions().is_empty(),
        "the window setting must describe what the sidebar shows"
    );
}

#[test]
fn a_session_argmax_launched_is_never_imported_as_a_duplicate() {
    let harness = harness();
    harness.seed_session("sess-native", "Launched by Argmax");

    // Stand in for a session Argmax started itself: same provider
    // conversation id, already in the database.
    let workspace = harness
        .workspaces
        .create_current_for_import(PROJECT_ID, "native")
        .expect("workspace");
    {
        let connection = harness.database.connection();
        let session = argmax_lib::persistence::sessions::persist_session(
            &connection,
            &argmax_lib::persistence::sessions::PersistSessionInput {
                id: "native-session".to_string(),
                workspace_id: workspace.id.clone(),
                provider: "claude".to_string(),
                model_label: "Opus 5".to_string(),
                model_id: "claude-opus-5".to_string(),
                reasoning_effort: None,
                permission_mode: None,
                agent_mode: None,
                prompt: "Launched by Argmax".to_string(),
                state: "complete".to_string(),
                attention: "normal".to_string(),
            },
        )
        .expect("persist session");
        argmax_lib::persistence::sessions::update_session_provider_conversation_id(
            &connection,
            &session.id,
            "sess-native",
        )
        .expect("set conversation id");
    }

    assert_eq!(harness.sync(&claude_enabled()).imported, 0);
    assert_eq!(harness.sessions().len(), 1);
    assert!(!harness.sessions()[0].imported);
}

#[test]
fn an_import_whose_transcript_disappeared_is_pruned() {
    let harness = harness();
    harness.seed_session("sess-vanishing", "Here for now");
    assert_eq!(harness.sync(&claude_enabled()).imported, 1);

    let source = {
        let connection = harness.database.connection();
        list_synced_sessions(&connection, "claude").expect("synced")[0]
            .source_path
            .clone()
    };
    std::fs::remove_file(&source).expect("remove transcript");

    assert_eq!(harness.sync(&claude_enabled()).pruned, 1);
    assert!(harness.sessions().is_empty());
}

#[test]
fn an_adopted_session_survives_losing_its_transcript() {
    let harness = harness();
    harness.seed_session("sess-adopted-vanishing", "Continued");
    assert_eq!(harness.sync(&claude_enabled()).imported, 1);
    let session_id = harness.sessions()[0].id.clone();

    let source = {
        let connection = harness.database.connection();
        assert!(mark_synced_session_adopted(&connection, &session_id).expect("adopt"));
        list_synced_sessions(&connection, "claude").expect("synced")[0]
            .source_path
            .clone()
    };
    std::fs::remove_file(&source).expect("remove transcript");

    assert_eq!(harness.sync(&claude_enabled()).pruned, 0);
    let connection = harness.database.connection();
    assert!(find_session_by_id(&connection, &session_id).is_ok());
}

/// Smoke test against the real `~/.claude` store and this checkout. Ignored by
/// default (it depends on the developer's own machine); run it with
/// `cargo test --test session_sync -- --ignored --nocapture` to see what a
/// sweep would import here.
#[test]
#[ignore = "reads the developer's real ~/.claude transcripts"]
fn smoke_test_against_the_real_claude_store() {
    let home = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"));
    let cutoff = chrono::Utc::now().timestamp_millis() - 7 * 24 * 3_600_000;
    let discovered = argmax_lib::sync::claude::discover(&home, cutoff);
    println!(
        "discovered {} transcripts in the last 7 days",
        discovered.len()
    );
    for session in discovered.iter().take(5) {
        println!(
            "  {} | cwd={} | started={} | prompt={:?}",
            session.external_id,
            session.cwd.display(),
            session.started_at,
            session.prompt.chars().take(60).collect::<String>()
        );
    }
    assert!(
        discovered
            .iter()
            .all(|session| !session.external_id.is_empty()),
        "every discovered session needs an id to resume with"
    );
}
