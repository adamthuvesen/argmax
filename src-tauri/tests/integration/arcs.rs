//! Arcs, phase 3: launching a coordinator, the membership inheritance and
//! preamble that follow from it, the caps that keep an Arc's launches
//! bounded, and `arc_status`.

use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::support::git_repo::seed_git_repo;
use argmax_lib::sessions::state::SessionState;
use argmax_lib::{
    arcs::{launch_coordinator, LaunchCoordinatorRequest},
    error::ArgmaxResult,
    ipc::inputs::{ProvidersLaunchInput, TerminalCols, TerminalRows},
    ipc::validation::{NonEmptyString, Prompt, WorkspaceId},
    persistence::{
        arcs::{
            count_active_members, create_arc, get_arc, set_arc_coordinator_session, set_arc_state,
            ArcCreateInput, ArcState,
        },
        database::Database,
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        sessions::{
            find_session_by_id, persist_session, record_session_arc, record_session_launch,
            session_launch_lineage, PersistSessionInput, LAUNCH_KIND_AGENT,
        },
        workspaces::{find_workspace_by_id, persist_workspace, PersistWorkspaceInput},
    },
    providers::{
        runtime::{BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeHandle},
        session_service::ProviderSessionService,
        AgentMode, PermissionMode, ProviderId, ProviderLaunchInput,
    },
    session_control::{
        SessionLaunchRegistry, SessionLaunchServer, SESSION_LAUNCH_SOCKET_ENV,
        SESSION_LAUNCH_TOKEN_ENV,
    },
    workspaces::{orchestration::MoveDestination, WorkspaceService},
};
use serde_json::json;

struct NoopHandle;

impl ProviderRuntimeHandle for NoopHandle {
    fn accepts_input(&self) -> bool {
        false
    }

    fn disposed(&self) -> bool {
        false
    }

    fn send_input(&self, _input: &str) {}

    fn resize(&self, _cols: u16, _rows: u16) {}

    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>> {
        Box::pin(async { Ok(()) })
    }
}

/// Records every launch it is handed, so a test can read back the prompt and
/// checkout a launch actually carried.
#[derive(Default)]
struct RecordingLauncher {
    launches: Mutex<Vec<ProviderLaunchInput>>,
}

impl ProviderProcessLauncher for RecordingLauncher {
    fn launch<'a>(
        &'a self,
        input: ProviderLaunchInput,
        _on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
        Box::pin(async move {
            self.launches.lock().expect("launches poisoned").push(input);
            let handle: Arc<dyn ProviderRuntimeHandle> = Arc::new(NoopHandle);
            Ok(handle)
        })
    }
}

impl RecordingLauncher {
    fn prompt_for(&self, session_id: &str) -> String {
        self.launches
            .lock()
            .expect("launches poisoned")
            .iter()
            .find(|launch| launch.session_id == session_id)
            .map(|launch| launch.prompt.clone())
            .unwrap_or_else(|| panic!("no launch recorded for {session_id}"))
    }
}

/// The provider handle resolves after `launch` returns (the CLI spawn is
/// backgrounded — see `spawn_provider_in_background`), so a test that wants
/// the launched prompt waits for the spawn to land.
async fn wait_for_launch(launcher: &RecordingLauncher, session_id: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if launcher
            .launches
            .lock()
            .expect("launches poisoned")
            .iter()
            .any(|launch| launch.session_id == session_id)
        {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {session_id} to launch"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

struct Fixture {
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    launcher: Arc<RecordingLauncher>,
    repo_path: String,
    app_data_dir: tempfile::TempDir,
    _repo: crate::support::git_repo::SeededGitRepo,
}

/// One registered project with a seeded git repo, ready for `launch_coordinator`
/// or a hand-seeded session to launch out of.
fn fixture() -> Fixture {
    let repo = seed_git_repo(&[("README.md", "# argmax\n")]);
    let repo_path = repo.path().display().to_string();
    let database = Arc::new(Database::open_in_memory().expect("database"));
    {
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-1".to_string(),
                name: "Argmax".to_string(),
                repo_path: repo_path.clone(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: format!("{repo_path}/.argmax/worktrees"),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("project");
    }
    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    Fixture {
        database,
        workspaces,
        providers,
        launcher,
        repo_path,
        app_data_dir: tempfile::tempdir().expect("app data dir"),
        _repo: repo,
    }
}

fn new_arc(fixture: &Fixture, name: &str) -> argmax_lib::persistence::arcs::ArcRecord {
    let connection = fixture.database.connection();
    create_arc(
        &connection,
        fixture.app_data_dir.path(),
        &ArcCreateInput {
            name: name.to_string(),
            brief: "Ship the Ragnar rollout end to end.".to_string(),
            home_project_id: "project-1".to_string(),
            dir: None,
        },
    )
    .expect("create arc")
}

fn coordinator_request(arc_id: &str) -> LaunchCoordinatorRequest {
    LaunchCoordinatorRequest {
        arc_id: arc_id.to_string(),
        provider: ProviderId::Codex,
        model_label: None,
        model_id: None,
        reasoning_effort: None,
        permission_mode: PermissionMode::ProviderDefaults,
    }
}

#[tokio::test]
async fn launch_coordinator_sets_the_pointer_arc_id_shared_checkout_and_preamble() {
    let fixture = fixture();
    let arc = new_arc(&fixture, "Ragnar rollout");

    let updated = launch_coordinator(
        coordinator_request(&arc.id),
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        Arc::clone(&fixture.providers),
    )
    .await
    .expect("launch coordinator");

    let coordinator_id = updated
        .coordinator_session_id
        .clone()
        .expect("coordinator pointer set");

    let connection = fixture.database.connection();
    let session = find_session_by_id(&connection, &coordinator_id).expect("coordinator session");
    assert_eq!(session.arc_id.as_deref(), Some(arc.id.as_str()));
    assert_eq!(session.launched_by_session_id, None, "no launcher");
    assert_eq!(
        session_launch_lineage(&connection, &coordinator_id)
            .unwrap()
            .depth,
        0
    );

    let workspace = find_workspace_by_id(&connection, &session.workspace_id).expect("workspace");
    assert!(
        workspace.shared_workspace,
        "shared checkout, not a worktree"
    );
    assert_eq!(workspace.path, fixture.repo_path);
    assert!(workspace.task_label.contains("coordinator"));

    wait_for_launch(&fixture.launcher, &coordinator_id).await;
    let prompt = fixture.launcher.prompt_for(&coordinator_id);
    assert!(prompt.contains("coordinator of Arc \"Ragnar rollout\""));
    assert!(prompt.contains("Ship the Ragnar rollout end to end."));
}

/// `launch_coordinator` used to hardcode `PermissionMode::ProviderDefaults`
/// regardless of what the caller resolved from the user's default-agent
/// choice for the provider (`ipc::arcs::arc_launch_coordinator_impl` now
/// resolves it the same way `providers:launch` does). A coordinator launch
/// must honor it exactly like every other launch path.
#[tokio::test]
async fn launch_coordinator_uses_the_requested_permission_mode() {
    let fixture = fixture();
    let arc = new_arc(&fixture, "Ragnar rollout");

    let updated = launch_coordinator(
        LaunchCoordinatorRequest {
            permission_mode: PermissionMode::AskEachTime,
            ..coordinator_request(&arc.id)
        },
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        Arc::clone(&fixture.providers),
    )
    .await
    .expect("launch coordinator");
    let coordinator_id = updated
        .coordinator_session_id
        .clone()
        .expect("coordinator pointer set");

    wait_for_launch(&fixture.launcher, &coordinator_id).await;
    let permission_mode = fixture
        .launcher
        .launches
        .lock()
        .expect("launches poisoned")
        .iter()
        .find(|launch| launch.session_id == coordinator_id)
        .map(|launch| launch.permission_mode)
        .expect("launch recorded");
    assert_eq!(permission_mode, PermissionMode::AskEachTime);
}

#[tokio::test]
async fn launch_coordinator_refuses_a_done_arc() {
    let fixture = fixture();
    let arc = new_arc(&fixture, "Ragnar rollout");
    {
        let connection = fixture.database.connection();
        set_arc_state(&connection, &arc.id, ArcState::Done).expect("mark done");
    }

    let error = launch_coordinator(
        coordinator_request(&arc.id),
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        Arc::clone(&fixture.providers),
    )
    .await
    .expect_err("done arc refuses a coordinator");

    assert!(
        matches!(&error, argmax_lib::error::ArgmaxError::ServiceError { sub_code, .. } if sub_code == "ARC_DONE"),
        "{error:?}"
    );
    assert!(fixture.launcher.launches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn relaunching_a_coordinator_keeps_the_old_sessions_arc_id_and_repoints() {
    let fixture = fixture();
    let arc = new_arc(&fixture, "Ragnar rollout");

    let first = launch_coordinator(
        coordinator_request(&arc.id),
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        Arc::clone(&fixture.providers),
    )
    .await
    .expect("first coordinator");
    let first_id = first.coordinator_session_id.clone().expect("first pointer");

    let second = launch_coordinator(
        coordinator_request(&arc.id),
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        Arc::clone(&fixture.providers),
    )
    .await
    .expect("second coordinator");
    let second_id = second
        .coordinator_session_id
        .clone()
        .expect("second pointer");

    assert_ne!(first_id, second_id);
    assert_eq!(
        get_arc(&fixture.database.connection(), &arc.id)
            .unwrap()
            .coordinator_session_id,
        Some(second_id)
    );

    let connection = fixture.database.connection();
    let old = find_session_by_id(&connection, &first_id).expect("old coordinator still exists");
    assert_eq!(old.arc_id.as_deref(), Some(arc.id.as_str()));
}

/// The socket path and token a session's own agent would find in its
/// environment — what `launch_session` (an agent's own `session_launch`) is
/// reached through, since it is private to the `session_control` module.
fn credential(
    registry: &SessionLaunchRegistry,
    repo: &std::path::Path,
    session_id: &str,
) -> (String, String) {
    let config = registry.issue(&ProviderLaunchInput {
        provider: ProviderId::Codex,
        session_id: session_id.to_string(),
        workspace_path: PathBuf::from(repo),
        prompt: "Task".to_string(),
        model_label: "GPT-5.6 Sol".to_string(),
        model_id: "gpt-5.6-sol".to_string(),
        reasoning_effort: None,
        fast_mode: false,
        resume_conversation_id: None,
        resume_fork: false,
        permission_mode: PermissionMode::AutoApprove,
        agent_mode: AgentMode::Auto,
        cols: 120,
        rows: 32,
    });
    let environment = config.env_pairs().into_iter().collect::<Vec<_>>();
    let value = |key: &str| {
        environment
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
            .expect("credential env")
    };
    (
        value(SESSION_LAUNCH_SOCKET_ENV),
        value(SESSION_LAUNCH_TOKEN_ENV),
    )
}

struct ControlFixture {
    fixture: Fixture,
    registry: Arc<SessionLaunchRegistry>,
    _server: SessionLaunchServer,
}

async fn control_fixture() -> ControlFixture {
    let fixture = fixture();
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&fixture.database)).expect("bind control socket");
    let server = server
        .start(
            None,
            Arc::clone(&fixture.database),
            Arc::clone(&fixture.workspaces),
            Arc::clone(&fixture.providers),
        )
        .expect("start control socket");
    ControlFixture {
        fixture,
        registry,
        _server: server,
    }
}

/// One request/response round trip over the control socket.
async fn ask(socket: &str, request: serde_json::Value) -> serde_json::Value {
    let socket = socket.to_string();
    tokio::task::spawn_blocking(move || {
        let mut stream = UnixStream::connect(socket).expect("connect control socket");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        std::thread::sleep(Duration::from_millis(150));
        writeln!(stream, "{request}").expect("write request");
        stream.shutdown(Shutdown::Write).expect("finish request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        serde_json::from_str::<serde_json::Value>(&response).expect("response json")
    })
    .await
    .expect("client task")
}

/// A workspace and session already attached to an Arc, ready to launch from.
fn seed_arc_session(fixture: &Fixture, arc_id: &str, session_id: &str, state: SessionState) {
    let connection = fixture.database.connection();
    persist_workspace(
        &connection,
        &PersistWorkspaceInput {
            id: format!("workspace-{session_id}"),
            project_id: "project-1".to_string(),
            task_label: session_id.to_string(),
            branch: "main".to_string(),
            base_ref: "main".to_string(),
            path: fixture.repo_path.clone(),
            state: "running".to_string(),
            shared_workspace: true,
            kind: "git".to_string(),
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("workspace");
    persist_session(
        &connection,
        &PersistSessionInput {
            id: session_id.to_string(),
            workspace_id: format!("workspace-{session_id}"),
            provider: "codex".to_string(),
            model_label: "GPT-5.6 Sol".to_string(),
            model_id: "gpt-5.6-sol".to_string(),
            reasoning_effort: None,
            permission_mode: Some("auto-approve".to_string()),
            agent_mode: Some("auto".to_string()),
            prompt: "Work".to_string(),
            state,
        },
    )
    .expect("session");
    record_session_arc(&connection, session_id, arc_id).expect("attach to arc");
}

#[tokio::test]
async fn a_member_launched_by_the_coordinator_inherits_arc_id_and_the_preamble_and_so_does_a_depth_two_launch(
) {
    let control = control_fixture().await;
    let fixture = &control.fixture;
    let arc = new_arc(fixture, "Ragnar rollout");
    seed_arc_session(
        fixture,
        &arc.id,
        "session-coordinator",
        SessionState::Running,
    );
    {
        let connection = fixture.database.connection();
        argmax_lib::persistence::arcs::set_arc_coordinator_session(
            &connection,
            &arc.id,
            Some("session-coordinator"),
        )
        .expect("point coordinator");
    }

    let (socket, token) = credential(
        &control.registry,
        std::path::Path::new(&fixture.repo_path),
        "session-coordinator",
    );
    let response = ask(
        &socket,
        json!({
            "version": 1,
            "token": token,
            "action": { "launch": { "prompt": "Build the importer" } },
        }),
    )
    .await;
    let member_id = response["launched"]["sessionId"]
        .as_str()
        .unwrap_or_else(|| panic!("expected a launch, got {response}"))
        .to_string();

    {
        let connection = fixture.database.connection();
        let member = find_session_by_id(&connection, &member_id).expect("member session");
        assert_eq!(member.arc_id.as_deref(), Some(arc.id.as_str()));
    }
    wait_for_launch(&fixture.launcher, &member_id).await;
    let member_prompt = fixture.launcher.prompt_for(&member_id);
    assert!(member_prompt.contains("part of Arc \"Ragnar rollout\""));
    assert!(member_prompt.contains("Build the importer"));

    // A depth-two launch from that member inherits the same way.
    let (member_socket, member_token) = credential(
        &control.registry,
        std::path::Path::new(&fixture.repo_path),
        &member_id,
    );
    let grandchild_response = ask(
        &member_socket,
        json!({
            "version": 1,
            "token": member_token,
            "action": { "launch": { "prompt": "One more piece" } },
        }),
    )
    .await;
    let grandchild_id = grandchild_response["launched"]["sessionId"]
        .as_str()
        .unwrap_or_else(|| panic!("expected a launch, got {grandchild_response}"))
        .to_string();
    let connection = fixture.database.connection();
    let grandchild = find_session_by_id(&connection, &grandchild_id).expect("grandchild session");
    assert_eq!(grandchild.arc_id.as_deref(), Some(arc.id.as_str()));
    assert_eq!(
        session_launch_lineage(&connection, &grandchild_id)
            .unwrap()
            .depth,
        2
    );
    wait_for_launch(&fixture.launcher, &grandchild_id).await;
    assert!(fixture
        .launcher
        .prompt_for(&grandchild_id)
        .contains("part of Arc \"Ragnar rollout\""));
}

#[tokio::test]
async fn the_current_coordinator_is_exempt_from_the_lifetime_launch_cap_a_member_is_not() {
    let control = control_fixture().await;
    let fixture = &control.fixture;
    let arc = new_arc(fixture, "Ragnar rollout");
    seed_arc_session(
        fixture,
        &arc.id,
        "session-coordinator",
        SessionState::Running,
    );
    seed_arc_session(fixture, &arc.id, "session-member", SessionState::Running);
    {
        let connection = fixture.database.connection();
        argmax_lib::persistence::arcs::set_arc_coordinator_session(
            &connection,
            &arc.id,
            Some("session-coordinator"),
        )
        .expect("point coordinator");
        for index in 0..10 {
            let child_id = format!("session-coordinator-child-{index}");
            persist_session(
                &connection,
                &PersistSessionInput {
                    id: child_id.clone(),
                    workspace_id: "workspace-session-coordinator".to_string(),
                    provider: "codex".to_string(),
                    model_label: "GPT-5.6 Sol".to_string(),
                    model_id: "gpt-5.6-sol".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "Child task".to_string(),
                    state: SessionState::Complete,
                },
            )
            .expect("coordinator child session");
            record_session_launch(
                &connection,
                &child_id,
                "session-coordinator",
                1,
                LAUNCH_KIND_AGENT,
            )
            .expect("record coordinator lineage");

            let member_child_id = format!("session-member-child-{index}");
            persist_session(
                &connection,
                &PersistSessionInput {
                    id: member_child_id.clone(),
                    workspace_id: "workspace-session-member".to_string(),
                    provider: "codex".to_string(),
                    model_label: "GPT-5.6 Sol".to_string(),
                    model_id: "gpt-5.6-sol".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "Child task".to_string(),
                    state: SessionState::Complete,
                },
            )
            .expect("member child session");
            record_session_launch(
                &connection,
                &member_child_id,
                "session-member",
                1,
                LAUNCH_KIND_AGENT,
            )
            .expect("record member lineage");
        }
    }

    let (coordinator_socket, coordinator_token) = credential(
        &control.registry,
        std::path::Path::new(&fixture.repo_path),
        "session-coordinator",
    );
    let coordinator_response = ask(
        &coordinator_socket,
        json!({
            "version": 1,
            "token": coordinator_token,
            "action": { "launch": { "prompt": "An eleventh piece" } },
        }),
    )
    .await;
    assert!(
        coordinator_response.get("launched").is_some(),
        "the coordinator's eleventh launch must succeed: {coordinator_response}"
    );

    let (member_socket, member_token) = credential(
        &control.registry,
        std::path::Path::new(&fixture.repo_path),
        "session-member",
    );
    let member_response = ask(
        &member_socket,
        json!({
            "version": 1,
            "token": member_token,
            "action": { "launch": { "prompt": "An eleventh piece" } },
        }),
    )
    .await;
    assert_eq!(member_response["error"]["code"], "LAUNCH_LIMIT_REACHED");
}

#[tokio::test]
async fn a_ninth_active_member_is_refused_capacity_reached() {
    let control = control_fixture().await;
    let fixture = &control.fixture;
    let arc = new_arc(fixture, "Ragnar rollout");
    seed_arc_session(
        fixture,
        &arc.id,
        "session-coordinator",
        SessionState::Running,
    );
    for index in 0..8 {
        seed_arc_session(
            fixture,
            &arc.id,
            &format!("session-active-{index}"),
            SessionState::Running,
        );
    }
    assert_eq!(
        count_active_members(&fixture.database.connection(), &arc.id, None).unwrap(),
        9
    );

    let (socket, token) = credential(
        &control.registry,
        std::path::Path::new(&fixture.repo_path),
        "session-coordinator",
    );
    let response = ask(
        &socket,
        json!({
            "version": 1,
            "token": token,
            "action": { "launch": { "prompt": "One too many" } },
        }),
    )
    .await;
    assert_eq!(
        response["error"]["code"], "ARC_CAPACITY_REACHED",
        "{response}"
    );
}

/// A launch's own workspace, on a checkout distinct from every other test's
/// so `checkout_write_lock` never serialises two of these launches for a
/// reason unrelated to the Arc cap this test exists to race.
fn race_workspace(fixture: &Fixture, id: &str, checkout: &std::path::Path) {
    persist_workspace(
        &fixture.database.connection(),
        &PersistWorkspaceInput {
            id: id.to_string(),
            project_id: "project-1".to_string(),
            task_label: id.to_string(),
            branch: "main".to_string(),
            base_ref: "main".to_string(),
            path: checkout.display().to_string(),
            state: "running".to_string(),
            shared_workspace: true,
            kind: "git".to_string(),
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("race workspace");
}

fn race_launch_input(workspace_id: &str, arc_id: &str) -> ProvidersLaunchInput {
    ProvidersLaunchInput {
        workspace_id: WorkspaceId::try_from(workspace_id.to_string()).expect("workspace id valid"),
        provider: ProviderId::Codex,
        prompt: Prompt::try_from("Race the cap".to_string()).expect("prompt valid"),
        model_label: NonEmptyString::try_from("GPT-5.6 Sol".to_string()).expect("label valid"),
        model_id: NonEmptyString::try_from("gpt-5.6-sol".to_string()).expect("id valid"),
        reasoning_effort: None,
        fast_mode: false,
        agent_mode: None,
        permission_mode: None,
        cols: serde_json::from_value::<TerminalCols>(json!(120)).expect("cols valid"),
        rows: serde_json::from_value::<TerminalRows>(json!(32)).expect("rows valid"),
        attachments: None,
        goal_condition: None,
        goal_max_turns: None,
        arc_id: Some(arc_id.to_string()),
        arc_is_coordinator_launch: false,
    }
}

/// The bug Fix C closes: `ProviderSessionService::launch` used to check the
/// Arc's active-member cap on its own connection, well before the session it
/// was about to launch existed to count against it. Two concurrent launches
/// could each read the same "7 active, room for one more" count and both
/// pass, landing the Arc at 9 active members against an 8-member cap. The
/// cap check now runs inside the same write transaction as the session
/// insert, holding the database's single connection mutex continuously
/// across both, so the two launches racing it from real OS threads
/// (`multi_thread` runtime, spawned tasks — not just interleaved futures on
/// one thread) are serialised at that point: one commits an 8th active
/// member, and the other's check then sees 8 and is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_launches_racing_the_active_member_cap_only_one_succeeds() {
    let fixture = fixture();
    let arc = new_arc(&fixture, "Ragnar rollout");
    for index in 0..7 {
        seed_arc_session(
            &fixture,
            &arc.id,
            &format!("session-active-{index}"),
            SessionState::Running,
        );
    }
    assert_eq!(
        count_active_members(&fixture.database.connection(), &arc.id, None).unwrap(),
        7
    );

    // Real (if unregistered) git repos, not bare temp dirs: the launch this
    // test drives also kicks off a background git-branch capture on the
    // workspace path, and a real repo keeps that from being the thing under
    // test here.
    let checkout_a = seed_git_repo(&[("README.md", "# race a\n")]);
    let checkout_b = seed_git_repo(&[("README.md", "# race b\n")]);
    race_workspace(&fixture, "workspace-race-a", checkout_a.path());
    race_workspace(&fixture, "workspace-race-b", checkout_b.path());

    let providers_a = Arc::clone(&fixture.providers);
    let input_a = race_launch_input("workspace-race-a", &arc.id);
    let task_a = tokio::spawn(async move { providers_a.launch(input_a).await });
    let providers_b = Arc::clone(&fixture.providers);
    let input_b = race_launch_input("workspace-race-b", &arc.id);
    let task_b = tokio::spawn(async move { providers_b.launch(input_b).await });
    let (first, second) = tokio::join!(task_a, task_b);
    let results = [first.expect("task a"), second.expect("task b")];

    let successes = results.iter().filter(|result| result.is_ok()).count();
    assert_eq!(
        successes, 1,
        "exactly one of the two concurrent launches should pass the cap: {results:?}"
    );
    let refusal = results
        .iter()
        .find_map(|result| result.as_ref().err())
        .expect("one launch refused");
    assert!(
        matches!(
            refusal,
            argmax_lib::error::ArgmaxError::ServiceError { sub_code, .. }
                if sub_code == "ARC_CAPACITY_REACHED"
        ),
        "{refusal:?}"
    );
    assert_eq!(
        count_active_members(&fixture.database.connection(), &arc.id, None).unwrap(),
        8,
        "the cap holds at exactly 8, not 9"
    );

    let winner = results
        .into_iter()
        .find_map(|result| result.ok())
        .expect("one launch succeeded");
    // `arc_id` is set at insert time, in the same transaction as the cap
    // check — not by a follow-up update this test would otherwise have to
    // wait for.
    assert_eq!(winner.arc_id.as_deref(), Some(arc.id.as_str()));
}

#[tokio::test]
async fn a_forty_first_launch_in_a_day_is_refused_budget_reached() {
    let control = control_fixture().await;
    let fixture = &control.fixture;
    let arc = new_arc(fixture, "Ragnar rollout");
    seed_arc_session(
        fixture,
        &arc.id,
        "session-coordinator",
        SessionState::Running,
    );
    // Complete, so they do not also trip the active-member cap: this test is
    // only about the rolling 24-hour launch budget.
    for index in 0..40 {
        seed_arc_session(
            fixture,
            &arc.id,
            &format!("session-done-{index}"),
            SessionState::Complete,
        );
    }

    let (socket, token) = credential(
        &control.registry,
        std::path::Path::new(&fixture.repo_path),
        "session-coordinator",
    );
    let response = ask(
        &socket,
        json!({
            "version": 1,
            "token": token,
            "action": { "launch": { "prompt": "One too many today" } },
        }),
    )
    .await;
    assert_eq!(
        response["error"]["code"], "ARC_LAUNCH_BUDGET_REACHED",
        "{response}"
    );
}

#[tokio::test]
async fn arc_status_answers_for_a_member_and_refuses_a_session_outside_any_arc() {
    let control = control_fixture().await;
    let fixture = &control.fixture;
    let arc = new_arc(fixture, "Ragnar rollout");
    seed_arc_session(
        fixture,
        &arc.id,
        "session-coordinator",
        SessionState::Running,
    );
    seed_arc_session(fixture, &arc.id, "session-member", SessionState::Running);
    {
        let connection = fixture.database.connection();
        argmax_lib::persistence::arcs::set_arc_coordinator_session(
            &connection,
            &arc.id,
            Some("session-coordinator"),
        )
        .expect("point coordinator");
    }
    // A session outside any Arc, to prove the refusal.
    persist_workspace(
        &fixture.database.connection(),
        &PersistWorkspaceInput {
            id: "workspace-outsider".to_string(),
            project_id: "project-1".to_string(),
            task_label: "Outsider".to_string(),
            branch: "main".to_string(),
            base_ref: "main".to_string(),
            path: fixture.repo_path.clone(),
            state: "running".to_string(),
            shared_workspace: true,
            kind: "git".to_string(),
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("outsider workspace");
    persist_session(
        &fixture.database.connection(),
        &PersistSessionInput {
            id: "session-outsider".to_string(),
            workspace_id: "workspace-outsider".to_string(),
            provider: "codex".to_string(),
            model_label: "GPT-5.6 Sol".to_string(),
            model_id: "gpt-5.6-sol".to_string(),
            reasoning_effort: None,
            permission_mode: Some("auto-approve".to_string()),
            agent_mode: Some("auto".to_string()),
            prompt: "Unrelated".to_string(),
            state: SessionState::Running,
        },
    )
    .expect("outsider session");

    let (member_socket, member_token) = credential(
        &control.registry,
        std::path::Path::new(&fixture.repo_path),
        "session-member",
    );
    let status = ask(
        &member_socket,
        json!({
            "version": 1,
            "token": member_token,
            "action": { "arc-status": {} },
        }),
    )
    .await;
    let outcome = &status["arcStatus"];
    assert_eq!(outcome["arcId"], arc.id);
    assert_eq!(outcome["callerIsCoordinator"], false);
    assert_eq!(outcome["coordinatorSessionId"], "session-coordinator");
    let members = outcome["members"].as_array().expect("members array");
    assert_eq!(members.len(), 2, "{status}");
    assert!(members
        .iter()
        .any(|member| member["sessionId"] == "session-member"));

    let (outsider_socket, outsider_token) = credential(
        &control.registry,
        std::path::Path::new(&fixture.repo_path),
        "session-outsider",
    );
    let refused = ask(
        &outsider_socket,
        json!({
            "version": 1,
            "token": outsider_token,
            "action": { "arc-status": {} },
        }),
    )
    .await;
    assert_eq!(refused["error"]["code"], "NOT_IN_ARC", "{refused}");
}

/// A second registered project. `repo_path` is unique per project (`persist_project`
/// upserts on conflict there), so this points at a sibling path rather than
/// reusing the fixture's seeded checkout; `move_session`'s project destination
/// only reads the project row and never revalidates the working tree it
/// points at.
fn second_project(fixture: &Fixture) -> String {
    let repo_path = format!("{}-secondary", fixture.repo_path);
    let connection = fixture.database.connection();
    persist_project(
        &connection,
        &PersistProjectInput {
            id: "project-2".to_string(),
            name: "Ragnar".to_string(),
            repo_path: repo_path.clone(),
            current_branch: "main".to_string(),
            default_branch: Some("main".to_string()),
            settings: ProjectSettings {
                archive_on_merge: false,
                worktree_location: format!("{repo_path}/.argmax/worktrees"),
                setup_command: String::new(),
                check_commands: Vec::new(),
            },
        },
    )
    .expect("second project");
    "project-2".to_string()
}

#[tokio::test]
async fn moving_the_coordinators_session_carries_arc_id_and_repoints_the_coordinator() {
    let fixture = fixture();
    let arc = new_arc(&fixture, "Ragnar rollout");
    let destination_project = second_project(&fixture);
    seed_arc_session(
        &fixture,
        &arc.id,
        "session-coordinator",
        SessionState::Complete,
    );
    {
        let connection = fixture.database.connection();
        set_arc_coordinator_session(&connection, &arc.id, Some("session-coordinator"))
            .expect("point coordinator");
    }

    let moved = fixture
        .workspaces
        .move_session(
            "session-coordinator",
            MoveDestination::Project {
                project_id: destination_project,
                worktree: false,
            },
            true,
        )
        .await
        .expect("move coordinator session");

    assert_eq!(moved.session.arc_id.as_deref(), Some(arc.id.as_str()));

    let connection = fixture.database.connection();
    let arc_after = get_arc(&connection, &arc.id).expect("arc after move");
    assert_eq!(
        arc_after.coordinator_session_id.as_deref(),
        Some(moved.session.id.as_str()),
        "the arc repoints at the coordinator's new session"
    );

    // The old row keeps its own arc_id — its membership is not cleared by
    // the move, only the coordinator pointer moves off of it.
    let old = find_session_by_id(&connection, "session-coordinator").expect("old session");
    assert_eq!(old.arc_id.as_deref(), Some(arc.id.as_str()));
}

#[tokio::test]
async fn moving_a_members_session_carries_arc_id_without_repointing_the_coordinator() {
    let fixture = fixture();
    let arc = new_arc(&fixture, "Ragnar rollout");
    let destination_project = second_project(&fixture);
    seed_arc_session(
        &fixture,
        &arc.id,
        "session-coordinator",
        SessionState::Complete,
    );
    seed_arc_session(&fixture, &arc.id, "session-member", SessionState::Complete);
    {
        let connection = fixture.database.connection();
        set_arc_coordinator_session(&connection, &arc.id, Some("session-coordinator"))
            .expect("point coordinator");
    }

    let moved = fixture
        .workspaces
        .move_session(
            "session-member",
            MoveDestination::Project {
                project_id: destination_project,
                worktree: false,
            },
            true,
        )
        .await
        .expect("move member session");

    assert_eq!(moved.session.arc_id.as_deref(), Some(arc.id.as_str()));

    let connection = fixture.database.connection();
    let arc_after = get_arc(&connection, &arc.id).expect("arc after move");
    assert_eq!(
        arc_after.coordinator_session_id.as_deref(),
        Some("session-coordinator"),
        "a member's move leaves the coordinator pointer alone"
    );
}
