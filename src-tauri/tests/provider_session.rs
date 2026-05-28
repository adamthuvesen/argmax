// Focused tests for `ProviderSessionService`.
//
// Drives the service against a fake launcher so we can exercise the
// happy path without spawning a real provider binary. Covers the four
// public surfaces called out in the port plan (task 5.18):
//   - launch persists the session row + emits a delta
//   - send_input goes straight to the handle when it accepts input,
//     and queues otherwise
//   - terminate disposes the handle and flips the session to cancelled
//   - recover_orphaned_sessions marks `running` rows as failed on boot

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use argmax_lib::error::ArgmaxResult;
use argmax_lib::ipc::inputs::{
    ProvidersLaunchInput, ProvidersSendInput, ProvidersTerminateInput, TerminalCols, TerminalRows,
};
use argmax_lib::ipc::validation::{NonEmptyString, Prompt, SessionId, WorkspaceId};
use argmax_lib::persistence::{
    database::Database,
    events::list_session_events_since,
    projects::{persist_project, PersistProjectInput, ProjectSettings},
    sessions::{find_session_by_id, persist_session, PersistSessionInput},
    workspaces::{persist_workspace, PersistWorkspaceInput},
};
use argmax_lib::providers::runtime::{
    BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeHandle,
};
use argmax_lib::providers::session_service::ProviderSessionService;
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
        agent_mode: None,
        permission_mode: None,
        cols: serde_json::from_value::<TerminalCols>(json!(120)).expect("cols valid"),
        rows: serde_json::from_value::<TerminalRows>(json!(32)).expect("rows valid"),
        attachments: None,
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
    let send = ProvidersSendInput {
        session_id: SessionId::try_from(session.id.clone()).expect("session id valid"),
        input: Prompt::try_from("follow-up".to_owned()).expect("prompt valid"),
        model_label: None,
        model_id: None,
        reasoning_effort: None,
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
    assert!(sent[0].contains("follow-up"));
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
    let send = ProvidersSendInput {
        session_id: SessionId::try_from(session.id.clone()).expect("session id valid"),
        input: Prompt::try_from("queued one".to_owned()).expect("prompt valid"),
        model_label: None,
        model_id: None,
        reasoning_effort: None,
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
