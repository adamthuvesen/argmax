// Focused tests for `ProviderSessionService`.
//
// Drives the service against fake handles and a spawned fake CLI fixture
// so we can exercise the happy path without depending on installed
// provider binaries. Covers the public surfaces called out in the port
// plan (task 5.18):
//   - launch persists the session row + emits a delta
//   - send_input goes straight to the handle when it accepts input,
//     and queues otherwise
//   - terminate disposes the handle and flips the session to cancelled
//   - recover_orphaned_sessions marks `running` rows as failed on boot

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::{path::PathBuf, process::Command, time::Duration};

use argmax_lib::error::ArgmaxResult;
use argmax_lib::ipc::inputs::{
    ProvidersLaunchInput, ProvidersSendInput, ProvidersTerminateInput, TerminalCols, TerminalRows,
};
use argmax_lib::ipc::validation::{NonEmptyString, Prompt, ProviderId, SessionId, WorkspaceId};
use argmax_lib::persistence::time::now_iso;
use argmax_lib::persistence::{
    database::Database,
    events::{
        list_session_events_since, persist_raw_output, persist_timeline_event,
        PersistRawOutputInput, PersistTimelineEventInput,
    },
    projects::{persist_project, PersistProjectInput, ProjectSettings},
    sessions::{
        find_session_by_id, persist_session, update_session_provider_conversation_id,
        PersistSessionInput,
    },
    workspaces::{persist_workspace, PersistWorkspaceInput},
};
use argmax_lib::providers::runtime::{
    BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeEvent,
    ProviderRuntimeEventType, ProviderRuntimeHandle,
};
use argmax_lib::providers::session_service::ProviderSessionService;
use argmax_lib::providers::{
    flush_queue::DashboardDelta, normalizer::ProviderOutputStream, ProviderLaunchInput,
};
use serde_json::json;

// ---------------------------------------------------------------------------
// Test scaffolding: fake launcher + fake handle.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct FakeHandleState {
    sent_inputs: Vec<String>,
    resizes: Vec<(u16, u16)>,
    terminate_called: bool,
}

struct FakeHandle {
    accepts_input: AtomicBool,
    disposed: AtomicBool,
    state: Mutex<FakeHandleState>,
}

impl FakeHandle {
    fn new(accepts_input: bool) -> Arc<Self> {
        Arc::new(Self {
            accepts_input: AtomicBool::new(accepts_input),
            disposed: AtomicBool::new(false),
            state: Mutex::new(FakeHandleState::default()),
        })
    }
}

impl ProviderRuntimeHandle for FakeHandle {
    fn accepts_input(&self) -> bool {
        self.accepts_input.load(Ordering::SeqCst)
    }

    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    fn send_input(&self, input: &str) {
        self.state
            .lock()
            .expect("fake handle poisoned")
            .sent_inputs
            .push(input.to_owned());
    }

    fn resize(&self, cols: u16, rows: u16) {
        self.state
            .lock()
            .expect("fake handle poisoned")
            .resizes
            .push((cols, rows));
    }

    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>> {
        Box::pin(async move {
            self.disposed.store(true, Ordering::SeqCst);
            self.state
                .lock()
                .expect("fake handle poisoned")
                .terminate_called = true;
            Ok(())
        })
    }
}

struct FakeLauncher {
    handle: Arc<FakeHandle>,
}

impl FakeLauncher {
    fn new(handle: Arc<FakeHandle>) -> Self {
        Self { handle }
    }
}

struct FakeCliHandle {
    disposed: Arc<AtomicBool>,
}

impl ProviderRuntimeHandle for FakeCliHandle {
    fn accepts_input(&self) -> bool {
        false
    }

    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    fn send_input(&self, _input: &str) {}

    fn resize(&self, _cols: u16, _rows: u16) {}

    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>> {
        Box::pin(async move {
            self.disposed.store(true, Ordering::SeqCst);
            Ok(())
        })
    }
}

#[derive(Default)]
struct FakeCliLauncher {
    launches: Mutex<Vec<ProviderLaunchInput>>,
}

impl FakeCliLauncher {
    fn launch_count(&self) -> usize {
        self.launches.lock().expect("launches poisoned").len()
    }

    fn launches(&self) -> Vec<ProviderLaunchInput> {
        self.launches.lock().expect("launches poisoned").clone()
    }
}

impl ProviderProcessLauncher for FakeCliLauncher {
    fn launch<'a>(
        &'a self,
        input: ProviderLaunchInput,
        on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
        let session_id = input.session_id.clone();
        let prompt = input.prompt.clone();
        let script_path = fake_provider_script_path();
        let disposed = Arc::new(AtomicBool::new(false));
        let thread_disposed = Arc::clone(&disposed);
        self.launches.lock().expect("launches poisoned").push(input);
        std::thread::spawn(move || {
            let output = Command::new("sh")
                .arg(script_path)
                .env("FAKE_PROVIDER_PROMPT", prompt)
                .output();
            let was_disposed = thread_disposed.load(Ordering::SeqCst);
            if was_disposed {
                return;
            }
            match output {
                Ok(output) => {
                    if !output.stdout.is_empty() {
                        on_event(ProviderRuntimeEvent {
                            session_id: session_id.clone(),
                            r#type: ProviderRuntimeEventType::Output,
                            stream: ProviderOutputStream::Stdout,
                            message: String::from_utf8_lossy(&output.stdout).into_owned(),
                            exit_code: None,
                            created_at: now_iso(),
                        });
                    }
                    if !output.stderr.is_empty() {
                        on_event(ProviderRuntimeEvent {
                            session_id: session_id.clone(),
                            r#type: ProviderRuntimeEventType::Output,
                            stream: ProviderOutputStream::Stderr,
                            message: String::from_utf8_lossy(&output.stderr).into_owned(),
                            exit_code: None,
                            created_at: now_iso(),
                        });
                    }
                    let code = output.status.code().unwrap_or(1);
                    on_event(ProviderRuntimeEvent {
                        session_id,
                        r#type: if code == 0 {
                            ProviderRuntimeEventType::Exit
                        } else {
                            ProviderRuntimeEventType::Error
                        },
                        stream: ProviderOutputStream::System,
                        message: format!("Fake provider CLI exited with code {code}."),
                        exit_code: Some(code),
                        created_at: now_iso(),
                    });
                }
                Err(error) => {
                    on_event(ProviderRuntimeEvent {
                        session_id,
                        r#type: ProviderRuntimeEventType::Error,
                        stream: ProviderOutputStream::System,
                        message: format!("Fake provider CLI failed to spawn: {error}"),
                        exit_code: Some(1),
                        created_at: now_iso(),
                    });
                }
            }
        });
        let handle = Arc::new(FakeCliHandle { disposed }) as Arc<dyn ProviderRuntimeHandle>;
        Box::pin(async move { Ok(handle) })
    }
}

/// Emits one stdout chunk with no trailing newline and keeps the process
/// alive until `terminate` — reproduces interactive CLIs that answer without
/// closing the PTY.
#[derive(Default)]
struct StallLineLauncher;

impl ProviderProcessLauncher for StallLineLauncher {
    fn launch<'a>(
        &'a self,
        input: ProviderLaunchInput,
        on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
        let session_id = input.session_id.clone();
        let disposed = Arc::new(AtomicBool::new(false));
        std::thread::spawn(move || {
            on_event(ProviderRuntimeEvent {
                session_id: session_id.clone(),
                r#type: ProviderRuntimeEventType::Output,
                stream: ProviderOutputStream::Stdout,
                message: r#"{"type":"assistant","text":"Buffered without newline"}"#.to_string(),
                exit_code: None,
                created_at: now_iso(),
            });
        });
        let handle = Arc::new(FakeCliHandle { disposed }) as Arc<dyn ProviderRuntimeHandle>;
        Box::pin(async move { Ok(handle) })
    }
}

impl ProviderProcessLauncher for FakeLauncher {
    fn launch<'a>(
        &'a self,
        _input: argmax_lib::providers::ProviderLaunchInput,
        _on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
        let handle = self.handle.clone() as Arc<dyn ProviderRuntimeHandle>;
        Box::pin(async move { Ok(handle) })
    }
}

// A launcher whose spawn future blocks until `release` is notified, so tests
// can deterministically observe the Pending window: launch() returns while the
// handle is still spawning, the test exercises send_input/terminate against the
// Pending handle, then releases the spawn to resolve.
struct GatedLauncher {
    handle: Arc<FakeHandle>,
    release: Arc<tokio::sync::Notify>,
}

impl ProviderProcessLauncher for GatedLauncher {
    fn launch<'a>(
        &'a self,
        _input: argmax_lib::providers::ProviderLaunchInput,
        _on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
        let handle = self.handle.clone() as Arc<dyn ProviderRuntimeHandle>;
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            release.notified().await;
            Ok(handle)
        })
    }
}

#[derive(Default)]
struct ManualExitLauncher {
    launches: Mutex<Vec<ProviderLaunchInput>>,
    callbacks: Mutex<HashMap<String, EventCallback>>,
}

impl ManualExitLauncher {
    fn launch_count(&self) -> usize {
        self.launches.lock().expect("launches poisoned").len()
    }

    fn launches(&self) -> Vec<ProviderLaunchInput> {
        self.launches.lock().expect("launches poisoned").clone()
    }

    fn emit_exit(&self, session_id: &str, exit_code: i32) {
        let callback = self
            .callbacks
            .lock()
            .expect("callbacks poisoned")
            .get(session_id)
            .cloned()
            .expect("session callback registered");
        callback(ProviderRuntimeEvent {
            session_id: session_id.to_string(),
            r#type: if exit_code == 0 {
                ProviderRuntimeEventType::Exit
            } else {
                ProviderRuntimeEventType::Error
            },
            stream: ProviderOutputStream::System,
            message: format!("Manual provider exit {exit_code}."),
            exit_code: Some(exit_code),
            created_at: now_iso(),
        });
    }
}

impl ProviderProcessLauncher for ManualExitLauncher {
    fn launch<'a>(
        &'a self,
        input: ProviderLaunchInput,
        on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
        let session_id = input.session_id.clone();
        self.launches.lock().expect("launches poisoned").push(input);
        self.callbacks
            .lock()
            .expect("callbacks poisoned")
            .insert(session_id, on_event);
        let handle = FakeHandle::new(false) as Arc<dyn ProviderRuntimeHandle>;
        Box::pin(async move { Ok(handle) })
    }
}

// `launch` now returns before the provider process finishes spawning, so the
// handle is briefly Pending. Poll until it resolves before asserting behavior
// that depends on a live handle.
async fn wait_for_resolved(service: &ProviderSessionService, session_id: &str) {
    for _ in 0..500 {
        if service.is_handle_resolved(session_id) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("provider handle did not resolve in time");
}

// ---------------------------------------------------------------------------
// DB fixture helpers.
// ---------------------------------------------------------------------------

const PROJECT_ID: &str = "p-test";
const WORKSPACE_ID: &str = "w-test";

fn seed_project_and_workspace(db: &Database) {
    let connection = db.connection();
    persist_project(
        &connection,
        &PersistProjectInput {
            id: PROJECT_ID.to_owned(),
            name: "argmax-test".to_owned(),
            repo_path: "/tmp/repo".to_owned(),
            current_branch: "main".to_owned(),
            default_branch: Some("main".to_owned()),
            settings: ProjectSettings {
                default_provider: "claude".to_owned(),
                default_model_label: "Sonnet 4.6".to_owned(),
                worktree_location: "/tmp/worktrees".to_owned(),
                setup_command: String::new(),
                check_commands: vec!["npm test".to_owned()],
            },
        },
    )
    .expect("persist project");
    persist_workspace(
        &connection,
        &PersistWorkspaceInput {
            id: WORKSPACE_ID.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            task_label: "test workspace".to_owned(),
            branch: "feature/test".to_owned(),
            base_ref: "main".to_owned(),
            path: "/tmp/repo".to_owned(),
            state: "idle".to_owned(),
            shared_workspace: false,
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("persist workspace");
}

fn build_launch_input() -> ProvidersLaunchInput {
    ProvidersLaunchInput {
        workspace_id: WorkspaceId::try_from(WORKSPACE_ID.to_owned()).expect("workspace id valid"),
        provider: argmax_lib::ipc::validation::ProviderId::Claude,
        prompt: Prompt::try_from("hello world".to_owned()).expect("prompt valid"),
        model_label: NonEmptyString::try_from("Sonnet 4.6".to_owned()).expect("label valid"),
        model_id: NonEmptyString::try_from("claude-sonnet-4-6".to_owned()).expect("id valid"),
        reasoning_effort: None,
        fast_mode: false,
        agent_mode: None,
        permission_mode: None,
        cols: serde_json::from_value::<TerminalCols>(json!(120)).expect("cols valid"),
        rows: serde_json::from_value::<TerminalRows>(json!(32)).expect("rows valid"),
        attachments: None,
    }
}

fn fake_provider_script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/provider/fake_provider_cli.sh")
}

async fn wait_for_session_state(database: &Database, session_id: &str, expected: &str) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let state = {
            let connection = database.connection();
            find_session_by_id(&connection, session_id)
                .expect("find session")
                .state
        };
        if state == expected {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {session_id} to reach {expected}; last state was {state}",
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

async fn wait_for_launch_count(launcher: &FakeCliLauncher, expected: usize) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let count = launcher.launch_count();
        if count == expected {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {expected} fake CLI launches; got {count}",
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

async fn wait_for_manual_launch_count(launcher: &ManualExitLauncher, expected: usize) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let count = launcher.launch_count();
        if count == expected {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {expected} manual launches; got {count}",
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

async fn wait_for_event(database: &Database, session_id: &str, event_type: &str, message: &str) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let found = {
            let connection = database.connection();
            let tail = list_session_events_since(&connection, session_id, None, None)
                .expect("list events");
            tail.events
                .iter()
                .any(|event| event.r#type == event_type && event.message.contains(message))
        };
        if found {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {event_type} containing {message}",
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn launch_persists_session_and_seeds_timeline() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let handle = FakeHandle::new(true);
    let service = ProviderSessionService::with_launcher(
        database.clone(),
        Arc::new(FakeLauncher::new(handle.clone())),
        |_| {},
    );

    let session = service
        .launch(build_launch_input())
        .await
        .expect("launch ok");
    assert_eq!(session.state, "running");
    assert_eq!(session.provider, "claude");
    assert_eq!(session.workspace_id, WORKSPACE_ID);

    // Two seed events: user.message + session.started.
    let connection = database.connection();
    let tail = list_session_events_since(&connection, &session.id, None, None)
        .expect("list events since head");
    let types: Vec<_> = tail
        .events
        .iter()
        .map(|event| event.r#type.as_str())
        .collect();
    assert!(
        types.contains(&"user.message"),
        "missing user.message: {types:?}"
    );
    assert!(
        types.contains(&"session.started"),
        "missing session.started: {types:?}",
    );

    assert_eq!(service.open_handle_count(), 1);
}

#[tokio::test]
async fn fake_cli_streams_normalized_events_to_db_and_dashboard_delta() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let deltas = Arc::new(Mutex::new(Vec::<DashboardDelta>::new()));
    let launcher = Arc::new(FakeCliLauncher::default());
    let service = ProviderSessionService::with_launcher(database.clone(), launcher.clone(), {
        let deltas = Arc::clone(&deltas);
        move |delta| deltas.lock().expect("deltas poisoned").push(delta)
    });

    let session = service
        .launch(build_launch_input())
        .await
        .expect("launch ok");

    wait_for_session_state(&database, &session.id, "complete").await;
    wait_for_event(
        &database,
        &session.id,
        "message.delta",
        "fake cli: hello world",
    )
    .await;

    let persisted_delta_event = {
        let deltas = deltas.lock().expect("deltas poisoned");
        let event = deltas
            .iter()
            .flat_map(|delta| delta.events.iter())
            .find(|event| {
                event.r#type == "message.delta" && event.message == "fake cli: hello world"
            })
            .cloned()
            .expect("dashboard delta carried fake CLI message");
        let connection = database.connection();
        let tail =
            list_session_events_since(&connection, &session.id, None, None).expect("list events");
        tail.events
            .iter()
            .any(|persisted| persisted.id == event.id && persisted.message == event.message)
    };
    assert!(
        persisted_delta_event,
        "dashboard delta event should be visible from DB immediately after publish",
    );

    let send = ProvidersSendInput {
        session_id: SessionId::try_from(session.id.clone()).expect("session id valid"),
        input: Prompt::try_from("follow up".to_owned()).expect("prompt valid"),
        provider: None,
        model_label: None,
        model_id: None,
        reasoning_effort: None,
        fast_mode: false,
        agent_mode: None,
        attachments: None,
    };
    let result = service.send_input(send).await.expect("send_input ok");
    assert!(result.ok);
    assert!(
        !result.queued,
        "completed structured sessions relaunch the fake CLI for follow-up input",
    );

    wait_for_launch_count(&launcher, 2).await;
    wait_for_session_state(&database, &session.id, "complete").await;
    wait_for_event(&database, &session.id, "user.message", "follow up").await;
    wait_for_event(
        &database,
        &session.id,
        "message.delta",
        "New user message: follow up",
    )
    .await;

    let launches = launcher.launches();
    assert_eq!(launches[0].prompt, "hello world");
    assert!(launches[1].prompt.contains("User: hello world"));
    assert!(launches[1].prompt.contains("New user message:\nfollow up"));
}

#[tokio::test]
async fn cursor_follow_up_infers_missing_resume_id_from_raw_output() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let launcher = Arc::new(FakeCliLauncher::default());
    let service = ProviderSessionService::with_launcher(database.clone(), launcher.clone(), |_| {});

    let session = {
        let connection = database.connection();
        let session = persist_session(
            &connection,
            &PersistSessionInput {
                id: "cursor-session".to_owned(),
                workspace_id: WORKSPACE_ID.to_owned(),
                provider: "cursor".to_owned(),
                model_label: "Composer 2.5 (Cursor)".to_owned(),
                model_id: "composer-2.5".to_owned(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_owned()),
                agent_mode: Some("auto".to_owned()),
                prompt: "first prompt".to_owned(),
                state: "complete".to_owned(),
                attention: "none".to_owned(),
            },
        )
        .expect("persist cursor session");
        persist_raw_output(
            &connection,
            &PersistRawOutputInput {
                id: "cursor-raw-init".to_owned(),
                session_id: session.id.clone(),
                stream: "stdout".to_owned(),
                content: "T\n{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"cursor-resume-1\"}\n"
                    .to_owned(),
                created_at: None,
            },
        )
        .expect("persist cursor raw init");
        session
    };

    let result = service
        .send_input(ProvidersSendInput {
            session_id: SessionId::try_from(session.id.clone()).expect("session id valid"),
            input: Prompt::try_from("follow up".to_owned()).expect("prompt valid"),
            provider: None,
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: false,
            agent_mode: None,
            attachments: None,
        })
        .await
        .expect("send_input ok");
    assert!(result.ok);
    assert!(!result.queued);

    wait_for_launch_count(&launcher, 1).await;
    let launches = launcher.launches();
    assert_eq!(
        launches[0].resume_conversation_id.as_deref(),
        Some("cursor-resume-1")
    );

    let connection = database.connection();
    let persisted = find_session_by_id(&connection, &session.id).expect("find session");
    assert_eq!(
        persisted.provider_conversation_id.as_deref(),
        Some("cursor-resume-1")
    );
}

// Switching provider on an idle session relaunches under the new provider,
// drops the old provider's native resume id, and carries context as transcript.
#[tokio::test]
async fn provider_switch_relaunches_new_provider_fresh() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let launcher = Arc::new(FakeCliLauncher::default());
    let service = ProviderSessionService::with_launcher(database.clone(), launcher.clone(), |_| {});

    let session = {
        let connection = database.connection();
        let session = persist_session(
            &connection,
            &PersistSessionInput {
                id: "switch-session".to_owned(),
                workspace_id: WORKSPACE_ID.to_owned(),
                provider: "claude".to_owned(),
                model_label: "Claude Haiku 4.5".to_owned(),
                model_id: "claude-haiku-4-5".to_owned(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_owned()),
                agent_mode: Some("auto".to_owned()),
                prompt: "first".to_owned(),
                state: "complete".to_owned(),
                attention: "none".to_owned(),
            },
        )
        .expect("persist claude session");
        update_session_provider_conversation_id(&connection, &session.id, "claude-resume-1")
            .expect("seed resume id");
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "switch-assistant-1".to_owned(),
                session_id: session.id.clone(),
                r#type: "message.completed".to_owned(),
                message: "Claude already explained the plan.".to_owned(),
                payload: json!({}),
                created_at: None,
            },
        )
        .expect("seed assistant event");
        session
    };

    let result = service
        .send_input(ProvidersSendInput {
            session_id: SessionId::try_from(session.id.clone()).expect("session id valid"),
            input: Prompt::try_from("now in codex".to_owned()).expect("prompt valid"),
            provider: Some(ProviderId::Codex),
            model_label: Some(NonEmptyString::try_from("GPT-5.5".to_owned()).expect("label valid")),
            model_id: Some(NonEmptyString::try_from("gpt-5.5".to_owned()).expect("id valid")),
            reasoning_effort: None,
            fast_mode: false,
            agent_mode: None,
            attachments: None,
        })
        .await
        .expect("send_input ok");
    assert!(result.ok);
    assert!(!result.queued);

    wait_for_launch_count(&launcher, 1).await;
    let launches = launcher.launches();
    assert_eq!(launches[0].provider, ProviderId::Codex);
    assert_eq!(launches[0].model_id, "gpt-5.5");
    // The Claude resume id must not bleed into the Codex relaunch.
    assert_eq!(launches[0].resume_conversation_id, None);
    // Context still rides along as visible transcript text.
    assert!(launches[0]
        .prompt
        .contains("Assistant: Claude already explained the plan."));
    assert!(launches[0]
        .prompt
        .contains("New user message:\nnow in codex"));

    // Scope the connection guard: `wait_for_event` below re-locks the single
    // shared DB connection, so it must not be held across that await.
    {
        let connection = database.connection();
        let persisted = find_session_by_id(&connection, &session.id).expect("find session");
        assert_eq!(persisted.provider, "codex");
        assert_eq!(persisted.model_id, "gpt-5.5");
        assert_eq!(persisted.provider_conversation_id, None);
    }

    wait_for_event(&database, &session.id, "session.provider-changed", "Codex").await;
}

#[tokio::test]
async fn completed_session_follow_up_launch_includes_visible_transcript_context() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let launcher = Arc::new(FakeCliLauncher::default());
    let service = ProviderSessionService::with_launcher(database.clone(), launcher.clone(), |_| {});

    let session = {
        let connection = database.connection();
        let session = persist_session(
            &connection,
            &PersistSessionInput {
                id: "claude-session".to_owned(),
                workspace_id: WORKSPACE_ID.to_owned(),
                provider: "claude".to_owned(),
                model_label: "Claude Haiku 4.5".to_owned(),
                model_id: "claude-haiku-4-5".to_owned(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_owned()),
                agent_mode: Some("auto".to_owned()),
                prompt: "ok".to_owned(),
                state: "complete".to_owned(),
                attention: "none".to_owned(),
            },
        )
        .expect("persist claude session");
        let session =
            update_session_provider_conversation_id(&connection, &session.id, "claude-session")
                .expect("persist provider conversation id");
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "user-ok".to_owned(),
                session_id: session.id.clone(),
                r#type: "user.message".to_owned(),
                message: "ok".to_owned(),
                payload: json!({}),
                created_at: None,
            },
        )
        .expect("persist user event");
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "assistant-ready".to_owned(),
                session_id: session.id.clone(),
                r#type: "message.completed".to_owned(),
                message: "Ready. What's next?".to_owned(),
                payload: json!({}),
                created_at: None,
            },
        )
        .expect("persist assistant event");
        session
    };

    let result = service
        .send_input(ProvidersSendInput {
            session_id: SessionId::try_from(session.id.clone()).expect("session id valid"),
            input: Prompt::try_from("hmm".to_owned()).expect("prompt valid"),
            provider: None,
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: false,
            agent_mode: None,
            attachments: None,
        })
        .await
        .expect("send_input ok");
    assert!(result.ok);
    assert!(!result.queued);

    wait_for_launch_count(&launcher, 1).await;
    let launches = launcher.launches();
    assert_eq!(
        launches[0].resume_conversation_id.as_deref(),
        Some("claude-session")
    );
    assert!(launches[0]
        .prompt
        .contains("The user is continuing this Argmax chat session."));
    assert!(launches[0].prompt.contains("User: ok"));
    assert!(launches[0]
        .prompt
        .contains("Assistant: Ready. What's next?"));
    assert!(launches[0].prompt.contains("New user message:\nhmm"));

    let connection = database.connection();
    let tail =
        list_session_events_since(&connection, &session.id, None, None).expect("list events");
    let follow_up = tail
        .events
        .iter()
        .find(|event| event.r#type == "user.message" && event.message == "hmm");
    assert!(
        follow_up.is_some(),
        "visible timeline keeps the raw user text"
    );
}

#[tokio::test]
async fn send_input_routes_to_handle_when_accepting() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let handle = FakeHandle::new(true);
    let service = ProviderSessionService::with_launcher(
        database.clone(),
        Arc::new(FakeLauncher::new(handle.clone())),
        |_| {},
    );

    let session = service
        .launch(build_launch_input())
        .await
        .expect("launch ok");
    wait_for_resolved(&service, &session.id).await;
    let send = ProvidersSendInput {
        session_id: SessionId::try_from(session.id.clone()).expect("session id valid"),
        input: Prompt::try_from("- follow-up\nwith context".to_owned()).expect("prompt valid"),
        provider: None,
        model_label: None,
        model_id: None,
        reasoning_effort: None,
        fast_mode: false,
        agent_mode: None,
        attachments: None,
    };
    let result = service.send_input(send).await.expect("send_input ok");
    assert!(result.ok);
    assert!(!result.queued, "should not queue when handle accepts input");

    let sent = handle
        .state
        .lock()
        .expect("fake handle poisoned")
        .sent_inputs
        .clone();
    assert_eq!(sent.len(), 1);
    assert!(sent[0].contains("- follow-up\nwith context"));
}

#[tokio::test]
async fn send_input_queues_when_handle_rejecting() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let handle = FakeHandle::new(false);
    let service = ProviderSessionService::with_launcher(
        database.clone(),
        Arc::new(FakeLauncher::new(handle.clone())),
        |_| {},
    );

    let session = service
        .launch(build_launch_input())
        .await
        .expect("launch ok");
    wait_for_resolved(&service, &session.id).await;
    let send = ProvidersSendInput {
        session_id: SessionId::try_from(session.id.clone()).expect("session id valid"),
        input: Prompt::try_from("queued one".to_owned()).expect("prompt valid"),
        provider: None,
        model_label: None,
        model_id: None,
        reasoning_effort: None,
        fast_mode: false,
        agent_mode: None,
        attachments: None,
    };
    let result = service.send_input(send).await.expect("send_input ok");
    assert!(result.ok);
    assert!(result.queued, "should queue when handle is not accepting");

    let sent = handle
        .state
        .lock()
        .expect("fake handle poisoned")
        .sent_inputs
        .clone();
    assert!(sent.is_empty(), "rejected handle should not receive bytes");
}

#[tokio::test]
async fn queued_follow_up_drains_after_provider_thread_completion() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let launcher = Arc::new(ManualExitLauncher::default());
    let service = ProviderSessionService::with_launcher(database.clone(), launcher.clone(), |_| {});

    let session = service
        .launch(build_launch_input())
        .await
        .expect("launch ok");
    wait_for_resolved(&service, &session.id).await;

    let result = service
        .send_input(ProvidersSendInput {
            session_id: SessionId::try_from(session.id.clone()).expect("session id valid"),
            input: Prompt::try_from("queued after done".to_owned()).expect("prompt valid"),
            provider: None,
            model_label: Some(
                NonEmptyString::try_from("Claude Sonnet 4.6".to_owned())
                    .expect("model label valid"),
            ),
            model_id: Some(
                NonEmptyString::try_from("claude-sonnet-4-6".to_owned()).expect("model id valid"),
            ),
            reasoning_effort: None,
            fast_mode: true,
            agent_mode: None,
            attachments: None,
        })
        .await
        .expect("send_input ok");
    assert!(
        result.queued,
        "live non-accepting handle should queue follow-up"
    );

    let launcher_for_thread = Arc::clone(&launcher);
    let session_id_for_thread = session.id.clone();
    let join = std::thread::spawn(move || {
        launcher_for_thread.emit_exit(&session_id_for_thread, 0);
    });
    assert!(
        join.join().is_ok(),
        "provider event callback must be safe outside a Tokio runtime"
    );
    wait_for_manual_launch_count(&launcher, 2).await;
    wait_for_event(&database, &session.id, "user.message", "queued after done").await;

    let launches = launcher.launches();
    assert_eq!(launches[0].prompt, "hello world");
    assert!(launches[1]
        .prompt
        .contains("New user message:\nqueued after done"));
    assert_eq!(launches[1].model_label, "Claude Sonnet 4.6");
    assert_eq!(launches[1].model_id, "claude-sonnet-4-6");
    assert!(launches[1].fast_mode);
}

#[tokio::test]
async fn terminate_disposes_handle_and_cancels_session() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let handle = FakeHandle::new(true);
    let service = ProviderSessionService::with_launcher(
        database.clone(),
        Arc::new(FakeLauncher::new(handle.clone())),
        |_| {},
    );

    let session = service
        .launch(build_launch_input())
        .await
        .expect("launch ok");
    let session_id = session.id.clone();
    wait_for_resolved(&service, &session_id).await;

    service
        .terminate(ProvidersTerminateInput {
            session_id: SessionId::try_from(session_id.clone()).expect("session id valid"),
        })
        .await
        .expect("terminate ok");

    assert!(handle.disposed.load(Ordering::SeqCst));
    assert!(
        handle
            .state
            .lock()
            .expect("fake handle poisoned")
            .terminate_called
    );
    assert_eq!(service.open_handle_count(), 0);

    let connection = database.connection();
    let persisted = find_session_by_id(&connection, &session_id).expect("find session");
    assert_eq!(persisted.state, "cancelled");
}

// A follow-up sent while the provider is still spawning must queue, never fall
// through to the relaunch path (which would double-spawn the provider).
#[tokio::test]
async fn send_input_during_spawn_queues_instead_of_relaunching() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let handle = FakeHandle::new(true);
    let release = Arc::new(tokio::sync::Notify::new());
    let service = ProviderSessionService::with_launcher(
        database.clone(),
        Arc::new(GatedLauncher {
            handle: handle.clone(),
            release: release.clone(),
        }),
        |_| {},
    );

    // launch() returns immediately; the spawn is parked on `release`, so the
    // handle stays Pending.
    let session = service
        .launch(build_launch_input())
        .await
        .expect("launch ok");
    assert!(!service.is_handle_resolved(&session.id));

    let send = ProvidersSendInput {
        session_id: SessionId::try_from(session.id.clone()).expect("session id valid"),
        input: Prompt::try_from("during spawn".to_owned()).expect("prompt valid"),
        provider: None,
        model_label: None,
        model_id: None,
        reasoning_effort: None,
        fast_mode: false,
        agent_mode: None,
        attachments: None,
    };
    let result = service.send_input(send).await.expect("send_input ok");
    assert!(result.queued, "message sent during spawn should queue");
    assert!(
        handle
            .state
            .lock()
            .expect("fake handle poisoned")
            .sent_inputs
            .is_empty(),
        "queued message must not reach the handle directly"
    );

    // Let the spawn resolve; the handle wires up cleanly afterwards.
    release.notify_one();
    wait_for_resolved(&service, &session.id).await;
}

// Terminating while the provider is still spawning must dispose the handle once
// it resolves, so the process never runs orphaned.
#[tokio::test]
async fn terminate_during_spawn_disposes_handle_on_resolve() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let handle = FakeHandle::new(true);
    let release = Arc::new(tokio::sync::Notify::new());
    let service = ProviderSessionService::with_launcher(
        database.clone(),
        Arc::new(GatedLauncher {
            handle: handle.clone(),
            release: release.clone(),
        }),
        |_| {},
    );

    let session = service
        .launch(build_launch_input())
        .await
        .expect("launch ok");
    let session_id = session.id.clone();

    // Terminate while still Pending — removes the entry and cancels the session.
    service
        .terminate(ProvidersTerminateInput {
            session_id: SessionId::try_from(session_id.clone()).expect("session id valid"),
        })
        .await
        .expect("terminate ok");

    // Release the parked spawn; the resolve path must dispose the handle.
    release.notify_one();
    for _ in 0..500 {
        if handle.disposed.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert!(
        handle.disposed.load(Ordering::SeqCst),
        "handle spawned after terminate must be disposed"
    );
    assert_eq!(service.open_handle_count(), 0);

    let connection = database.connection();
    let persisted = find_session_by_id(&connection, &session_id).expect("find session");
    assert_eq!(persisted.state, "cancelled");
}

#[test]
fn recover_orphaned_sessions_marks_running_rows_failed() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let connection = database.connection();
    let orphan = persist_session(
        &connection,
        &PersistSessionInput {
            id: "orphan-1".to_owned(),
            workspace_id: WORKSPACE_ID.to_owned(),
            provider: "claude".to_owned(),
            model_label: "Sonnet 4.6".to_owned(),
            model_id: "claude-sonnet-4-6".to_owned(),
            reasoning_effort: None,
            permission_mode: Some("auto-approve".to_owned()),
            agent_mode: Some("auto".to_owned()),
            prompt: "before crash".to_owned(),
            state: "running".to_owned(),
            attention: "normal".to_owned(),
        },
    )
    .expect("seed orphan");
    drop(connection);
    assert_eq!(orphan.state, "running");

    let service = ProviderSessionService::new(database.clone());
    let recovered = service
        .recover_orphaned_sessions()
        .expect("recovery sweeps");
    assert_eq!(recovered, 1);

    let connection = database.connection();
    let after = find_session_by_id(&connection, "orphan-1").expect("find orphan");
    assert_eq!(after.state, "failed");
    assert_eq!(after.attention, "failed");

    let tail = list_session_events_since(&connection, "orphan-1", None, None).expect("list events");
    let types: Vec<_> = tail
        .events
        .iter()
        .map(|event| event.r#type.as_str())
        .collect();
    assert!(
        types.contains(&"process_did_not_survive_restart"),
        "missing recovery event: {types:?}",
    );
}

#[tokio::test]
async fn idle_flush_publishes_buffered_line_before_terminate() {
    let database = Arc::new(Database::open_in_memory().expect("open db"));
    seed_project_and_workspace(&database);
    let deltas = Arc::new(Mutex::new(Vec::<DashboardDelta>::new()));
    let service =
        ProviderSessionService::with_launcher(database.clone(), Arc::new(StallLineLauncher), {
            let deltas = Arc::clone(&deltas);
            move |delta| {
                deltas.lock().expect("deltas poisoned").push(delta);
            }
        });

    let session = service
        .launch(build_launch_input())
        .await
        .expect("launch ok");

    tokio::time::sleep(Duration::from_millis(120)).await;

    let flushed_before_stop = deltas
        .lock()
        .expect("deltas poisoned")
        .iter()
        .flat_map(|delta| delta.events.iter())
        .any(|event| event.message.contains("Buffered without newline"));
    assert!(
        flushed_before_stop,
        "idle stream flush should publish the buffered assistant line before terminate"
    );

    service
        .terminate(ProvidersTerminateInput {
            session_id: SessionId::try_from(session.id).expect("session id valid"),
        })
        .await
        .expect("terminate ok");
}
