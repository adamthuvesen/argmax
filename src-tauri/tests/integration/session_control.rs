use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::support::git_repo::{run_git, seed_git_repo};
use argmax_lib::sessions::state::SessionState;
use argmax_lib::{
    error::ArgmaxResult,
    persistence::{
        after_turn::{insert_after_turn, list_after_turn, AfterTurnAction, ArchiveRequest},
        database::Database,
        events::{persist_timeline_event, PersistTimelineEventInput, SESSION_EVENT_PAGE_LIMIT},
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        session_messages::{
            insert_session_message, NewSessionMessage, MAX_MESSAGE_BODY_CHARS, MESSAGE_KIND,
        },
        sessions::{
            find_session_by_id, persist_session, record_session_launch, update_session_state,
            PersistSessionInput, SessionStateInput, LAUNCH_KIND_AGENT,
        },
        time::now_iso,
        workspaces::{find_workspace_by_id, persist_workspace, PersistWorkspaceInput},
    },
    providers::{
        flush_queue::DashboardDelta,
        runtime::{BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeHandle},
        session_service::ProviderSessionService,
        AgentMode, PermissionMode, ProviderId, ProviderLaunchInput, ReasoningEffort,
    },
    session_control::{
        SessionLaunchRegistry, SessionLaunchServer, SESSION_LAUNCH_SOCKET_ENV,
        SESSION_LAUNCH_TOKEN_ENV,
    },
    workspaces::WorkspaceService,
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

#[tokio::test]
async fn authenticated_request_launches_a_sidebar_session_with_inherited_settings() {
    let repo = tempfile::tempdir().expect("repo dir");
    let destination_repo = tempfile::tempdir().expect("destination repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    {
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-1".to_string(),
                name: "Argmax".to_string(),
                repo_path: repo.path().display().to_string(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: repo.path().join("worktrees").display().to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("project");
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-2".to_string(),
                name: "Destination".to_string(),
                repo_path: destination_repo.path().display().to_string(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: destination_repo
                        .path()
                        .join("worktrees")
                        .display()
                        .to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("destination project");
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "workspace-parent".to_string(),
                project_id: "project-1".to_string(),
                task_label: "Parent".to_string(),
                branch: "main".to_string(),
                base_ref: "main".to_string(),
                path: repo.path().display().to_string(),
                state: "running".to_string(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("parent workspace");
        persist_session(
            &connection,
            &PersistSessionInput {
                id: "session-parent".to_string(),
                workspace_id: "workspace-parent".to_string(),
                provider: "codex".to_string(),
                model_label: "GPT-5.6 Sol".to_string(),
                model_id: "gpt-5.6-sol".to_string(),
                reasoning_effort: Some("high".to_string()),
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "Parent task".to_string(),
                state: SessionState::Running,
            },
        )
        .expect("parent session");
    }

    let deltas = Arc::new(Mutex::new(Vec::<DashboardDelta>::new()));
    let provider_deltas = Arc::clone(&deltas);
    let launcher = Arc::new(RecordingLauncher::default());
    let providers = ProviderSessionService::with_launcher(
        Arc::clone(&database),
        launcher.clone(),
        move |delta| {
            provider_deltas.lock().expect("deltas poisoned").push(delta);
        },
    );
    let workspace_deltas = Arc::clone(&deltas);
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), move |delta| {
        workspace_deltas
            .lock()
            .expect("deltas poisoned")
            .push(delta);
    });

    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    let process_config = registry.issue(&ProviderLaunchInput {
        provider: ProviderId::Codex,
        session_id: "session-parent".to_string(),
        workspace_path: PathBuf::from(repo.path()),
        prompt: "Parent task".to_string(),
        model_label: "GPT-5.6 Sol".to_string(),
        model_id: "gpt-5.6-sol".to_string(),
        reasoning_effort: Some(ReasoningEffort::High),
        fast_mode: true,
        resume_conversation_id: None,
        resume_fork: false,
        permission_mode: PermissionMode::AutoApprove,
        agent_mode: AgentMode::Auto,
        cols: 120,
        rows: 32,
    });
    let environment = process_config.env_pairs().into_iter().collect::<Vec<_>>();
    let socket = environment
        .iter()
        .find(|(key, _)| key == SESSION_LAUNCH_SOCKET_ENV)
        .map(|(_, value)| value.clone())
        .expect("socket env");
    let token = environment
        .iter()
        .find(|(key, _)| key == SESSION_LAUNCH_TOKEN_ENV)
        .map(|(_, value)| value.clone())
        .expect("token env");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let launch_socket = socket.clone();
    let launch_token = token.clone();
    let response = tokio::task::spawn_blocking(move || {
        let mut stream = UnixStream::connect(launch_socket).expect("connect control socket");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        // Let the nonblocking listener accept before the first write. On macOS,
        // accepted sockets inherit O_NONBLOCK, so the server must explicitly
        // restore blocking mode before reading the request.
        std::thread::sleep(Duration::from_millis(150));
        let request = json!({
            "version": 1,
            "token": launch_token,
            "action": { "launch": { "prompt": "Summarize this repository quickly" } },
        });
        writeln!(stream, "{request}").expect("write request");
        stream.shutdown(Shutdown::Write).expect("finish request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        serde_json::from_str::<serde_json::Value>(&response).expect("response json")
    })
    .await
    .expect("client task");

    let launched = &response["launched"];
    assert!(response["error"].is_null(), "launch response: {response}");
    assert_eq!(launched["projectId"], "project-1");
    let session_id = launched["sessionId"].as_str().expect("session id");
    let workspace_id = launched["workspaceId"].as_str().expect("workspace id");
    {
        let connection = database.connection();
        let session = find_session_by_id(&connection, session_id).expect("launched session");
        let workspace =
            find_workspace_by_id(&connection, workspace_id).expect("launched workspace");
        assert_eq!(session.prompt, "Summarize this repository quickly");
        assert_eq!(
            session.launched_by_session_id.as_deref(),
            Some("session-parent"),
            "the sidebar row must say which session launched it"
        );
        assert_eq!(session.model_id, "gpt-5.6-sol");
        assert_eq!(session.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(workspace.path, repo.path().display().to_string());
        assert!(workspace.shared_workspace);
    }

    for _ in 0..50 {
        if !launcher
            .launches
            .lock()
            .expect("launches poisoned")
            .is_empty()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    {
        // Scoped rather than `drop`ped: clippy's await_holding_lock does not
        // see an explicit drop, and the awaits below are all past this point.
        let launches = launcher.launches.lock().expect("launches poisoned");
        assert_eq!(launches.len(), 1);
        assert!(launches[0].fast_mode);
        assert_eq!(launches[0].permission_mode, PermissionMode::AutoApprove);
        assert_eq!(launches[0].agent_mode, AgentMode::Auto);
    }

    {
        let connection = database.connection();
        connection
            .execute(
                "UPDATE sessions SET state = 'complete' WHERE id = 'session-parent'",
                [],
            )
            .expect("settle parent session");
        connection
            .execute(
                "UPDATE workspaces SET state = 'complete' WHERE id = 'workspace-parent'",
                [],
            )
            .expect("settle parent workspace");
    }
    let move_response = tokio::task::spawn_blocking(move || {
        let mut stream = UnixStream::connect(socket).expect("connect move socket");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        std::thread::sleep(Duration::from_millis(150));
        let request = json!({
            "version": 1,
            "token": token,
            "action": {
                "move": {
                    "project": "Destination",
                    "prompt": "Port the fix to this repo",
                    "keepSource": true,
                }
            },
        });
        writeln!(stream, "{request}").expect("write move request");
        stream
            .shutdown(Shutdown::Write)
            .expect("finish move request");
        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .expect("read move response");
        serde_json::from_str::<serde_json::Value>(&response).expect("move response json")
    })
    .await
    .expect("move client task");
    assert!(
        move_response["error"].is_null(),
        "move response: {move_response}"
    );
    assert_eq!(move_response["scheduled"]["scheduled"], true);
    assert_eq!(move_response["scheduled"]["projectId"], "project-2");
    assert!(registry.pending_after_turn("session-parent").is_some());
    registry.signal_turn_settled("session-parent");
    for _ in 0..100 {
        let moved_count = {
            let connection = database.connection();
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE w.project_id = 'project-2'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("moved session count")
        };
        if moved_count == 1 && registry.pending_after_turn("session-parent").is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(registry.pending_after_turn("session-parent").is_none());
    {
        let connection = database.connection();
        let moved_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE w.project_id = 'project-2' AND s.provider_conversation_id IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("moved session");
        assert_eq!(moved_count, 1);
    }

    // The move is only half the point: the chat has to pick the work up in the
    // destination checkout, which is a launch there with the prompt the mover
    // wrote and the handoff note that says where "here" now is.
    for _ in 0..100 {
        if launcher.launches.lock().expect("launches poisoned").len() > 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let launches = launcher.launches.lock().expect("launches poisoned");
    assert_eq!(
        launches.len(),
        2,
        "the moved chat launched once in the destination"
    );
    let continuation = launches.last().expect("destination launch");
    assert_eq!(
        continuation.workspace_path,
        destination_repo.path().to_path_buf()
    );
    assert!(
        continuation.prompt.contains("Port the fix to this repo"),
        "the destination turn carries the mover's prompt: {}",
        continuation.prompt
    );
    assert!(
        continuation
            .prompt
            .contains("This chat moved from Argmax to Destination"),
        "the destination turn carries the handoff note: {}",
        continuation.prompt
    );
    drop(launches);

    let deltas = deltas.lock().expect("deltas poisoned");
    assert!(deltas.iter().any(|delta| delta
        .sessions
        .iter()
        .any(|session| session.id == session_id)));
    assert!(deltas.iter().any(|delta| delta
        .workspaces
        .iter()
        .any(|workspace| workspace.id == workspace_id)));
}

/// The caps that keep an agent's launches from running away, checked where
/// they are enforced: the socket handler, not the tool wrapper.
#[tokio::test]
async fn launch_caps_and_self_messaging_are_refused_with_a_readable_error() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    {
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-1".to_string(),
                name: "Argmax".to_string(),
                repo_path: repo.path().display().to_string(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: repo.path().join("worktrees").display().to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("project");
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "workspace-parent".to_string(),
                project_id: "project-1".to_string(),
                task_label: "Parent".to_string(),
                branch: "main".to_string(),
                base_ref: "main".to_string(),
                path: repo.path().display().to_string(),
                state: "running".to_string(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("parent workspace");
        persist_session(
            &connection,
            &PersistSessionInput {
                id: "session-parent".to_string(),
                workspace_id: "workspace-parent".to_string(),
                provider: "codex".to_string(),
                model_label: "GPT-5.6 Sol".to_string(),
                model_id: "gpt-5.6-sol".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "Parent task".to_string(),
                state: SessionState::Running,
            },
        )
        .expect("parent session");
    }

    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    let process_config = registry.issue(&ProviderLaunchInput {
        provider: ProviderId::Codex,
        session_id: "session-parent".to_string(),
        workspace_path: PathBuf::from(repo.path()),
        prompt: "Parent task".to_string(),
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
    let environment = process_config.env_pairs().into_iter().collect::<Vec<_>>();
    let socket = environment
        .iter()
        .find(|(key, _)| key == SESSION_LAUNCH_SOCKET_ENV)
        .map(|(_, value)| value.clone())
        .expect("socket env");
    let token = environment
        .iter()
        .find(|(key, _)| key == SESSION_LAUNCH_TOKEN_ENV)
        .map(|(_, value)| value.clone())
        .expect("token env");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let ask = |request: serde_json::Value| {
        let socket = socket.clone();
        async move {
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
    };
    let launch = json!({
        "version": 1,
        "token": token,
        "action": { "launch": { "prompt": "Go one level deeper" } },
    });

    // A session two launches away from the user cannot start a third.
    database
        .connection()
        .execute(
            "UPDATE sessions SET launch_depth = 2 WHERE id = 'session-parent'",
            [],
        )
        .expect("seed depth");
    let refused = ask(launch.clone()).await;
    assert_eq!(refused["error"]["code"], "LAUNCH_DEPTH_EXCEEDED");
    assert!(
        refused["error"]["message"]
            .as_str()
            .expect("message")
            .contains("2 levels deep"),
        "the agent has to be told what the cap is: {refused}"
    );

    // Ten launched sessions is the per-session cap.
    {
        let connection = database.connection();
        connection
            .execute(
                "UPDATE sessions SET launch_depth = 0 WHERE id = 'session-parent'",
                [],
            )
            .expect("reset depth");
        for index in 0..10 {
            persist_session(
                &connection,
                &PersistSessionInput {
                    id: format!("session-child-{index}"),
                    workspace_id: "workspace-parent".to_string(),
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
            .expect("child session");
            record_session_launch(
                &connection,
                &format!("session-child-{index}"),
                "session-parent",
                1,
                LAUNCH_KIND_AGENT,
            )
            .expect("record lineage");
        }
    }
    let capped = ask(launch).await;
    assert_eq!(capped["error"]["code"], "LAUNCH_LIMIT_REACHED");

    let self_message = ask(json!({
        "version": 1,
        "token": token,
        "action": { "message": { "sessionId": "session-parent", "message": "hello me" } },
    }))
    .await;
    assert_eq!(self_message["error"]["code"], "MESSAGE_SELF");

    assert!(
        launcher
            .launches
            .lock()
            .expect("launches poisoned")
            .is_empty(),
        "a refused launch must not reach the provider"
    );
}

/// The Phase 2 surface end to end over the socket: look at a launched session,
/// read its transcript, wait on it, stop it, and see the completion notice
/// land in the launching session as a real turn.
#[tokio::test]
async fn observing_stopping_and_waiting_on_a_launched_session() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    {
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-1".to_string(),
                name: "Argmax".to_string(),
                repo_path: repo.path().display().to_string(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: repo.path().join("worktrees").display().to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("project");
        for (workspace_id, label) in [
            ("workspace-parent", "Parent"),
            ("workspace-child", "Count to ten"),
        ] {
            persist_workspace(
                &connection,
                &PersistWorkspaceInput {
                    id: workspace_id.to_string(),
                    project_id: "project-1".to_string(),
                    task_label: label.to_string(),
                    branch: "main".to_string(),
                    base_ref: "main".to_string(),
                    path: repo.path().display().to_string(),
                    state: "running".to_string(),
                    shared_workspace: true,
                    kind: "git".to_string(),
                    dirty: false,
                    changed_files: 0,
                },
            )
            .expect("workspace");
        }
        for (session_id, workspace_id, state) in [
            ("session-parent", "workspace-parent", SessionState::Complete),
            ("session-child", "workspace-child", SessionState::Running),
        ] {
            persist_session(
                &connection,
                &PersistSessionInput {
                    id: session_id.to_string(),
                    workspace_id: workspace_id.to_string(),
                    provider: "codex".to_string(),
                    model_label: "GPT-5.6 Sol".to_string(),
                    model_id: "gpt-5.6-sol".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "Task".to_string(),
                    state,
                },
            )
            .expect("session");
        }
        record_session_launch(
            &connection,
            "session-child",
            "session-parent",
            1,
            LAUNCH_KIND_AGENT,
        )
        .expect("record lineage");
        for (id, r#type, message, payload) in [
            (
                "event-1",
                "user.message",
                "Reply with exactly the word pong",
                json!({ "source": "composer" }),
            ),
            (
                "event-2",
                "command.started",
                "shell",
                json!({ "input": { "command": "echo pong" } }),
            ),
            (
                "event-3",
                "command.completed",
                "pong",
                json!({ "toolName": "shell" }),
            ),
            ("event-4", "message.completed", "pong", json!({})),
        ] {
            persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: id.to_string(),
                    session_id: "session-child".to_string(),
                    r#type: r#type.to_string(),
                    message: message.to_string(),
                    payload,
                    created_at: None,
                },
            )
            .expect("child event");
        }
    }

    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    providers.set_session_control(Arc::clone(&registry));
    let credential = |session_id: &str| {
        let config = registry.issue(&ProviderLaunchInput {
            provider: ProviderId::Codex,
            session_id: session_id.to_string(),
            workspace_path: PathBuf::from(repo.path()),
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
        let socket = environment
            .iter()
            .find(|(key, _)| key == SESSION_LAUNCH_SOCKET_ENV)
            .map(|(_, value)| value.clone())
            .expect("socket env");
        let token = environment
            .iter()
            .find(|(key, _)| key == SESSION_LAUNCH_TOKEN_ENV)
            .map(|(_, value)| value.clone())
            .expect("token env");
        (socket, token)
    };
    let (socket, parent_token) = credential("session-parent");
    let (_, child_token) = credential("session-child");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let ask = |request: serde_json::Value| {
        let socket = socket.clone();
        async move {
            tokio::task::spawn_blocking(move || {
                let mut stream = UnixStream::connect(socket).expect("connect control socket");
                stream
                    .set_read_timeout(Some(Duration::from_secs(30)))
                    .expect("read timeout");
                writeln!(stream, "{request}").expect("write request");
                stream.shutdown(Shutdown::Write).expect("finish request");
                let mut response = String::new();
                stream.read_to_string(&mut response).expect("read response");
                serde_json::from_str::<serde_json::Value>(&response).expect("response json")
            })
            .await
            .expect("client task")
        }
    };
    let as_parent = |action: serde_json::Value| {
        ask(json!({ "version": 1, "token": parent_token, "action": action }))
    };
    let as_child = |action: serde_json::Value| {
        ask(json!({ "version": 1, "token": child_token, "action": action }))
    };

    // Status reads the lineage and the last answer without touching the
    // transcript.
    let status = as_parent(json!({ "status": { "sessionId": "session-child" } })).await;
    assert_eq!(status["status"]["state"], "running");
    assert_eq!(status["status"]["launchedBySessionId"], "session-parent");
    assert_eq!(status["status"]["launchDepth"], 1);
    assert_eq!(status["status"]["lastAssistantText"], "pong");
    assert_eq!(status["status"]["unreadInbox"], 0);

    // Read returns the normalized timeline, not provider JSON.
    let read = as_parent(json!({ "read": { "sessionId": "session-child" } })).await;
    let entries = read["read"]["entries"].as_array().expect("entries");
    let kinds = entries
        .iter()
        .map(|entry| entry["kind"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    assert_eq!(kinds, vec!["user", "tool", "tool-result", "assistant"]);
    assert_eq!(entries[1]["text"], "shell echo pong");
    assert_eq!(entries[2]["text"], "shell -> ok");
    assert_eq!(entries[3]["text"], "pong");
    assert!(read["read"]["nextCursor"].as_i64().expect("cursor") > 0);

    // A wait on a session that is still working runs out rather than lying.
    let timed_out = as_parent(json!({
        "wait": { "sessions": ["session-child"], "timeoutS": 1 }
    }))
    .await;
    assert_eq!(timed_out["waited"]["timedOut"], true);

    // A session cannot stop its own turn.
    let stop_self = as_parent(json!({ "stop": { "sessionId": "session-parent" } })).await;
    assert_eq!(stop_self["error"]["code"], "STOP_SELF");

    // Stopping the child cancels it and leaves the launching session a
    // completion notice, delivered as an ordinary turn.
    let stopped = as_parent(json!({ "stop": { "sessionId": "session-child" } })).await;
    assert_eq!(stopped["stopped"]["sessionId"], "session-child");
    assert_eq!(stopped["stopped"]["state"], "cancelled");
    let notice = wait_for(|| {
        let connection = database.connection();
        connection
            .query_row(
                "SELECT body, kind FROM session_messages WHERE to_session_id = 'session-parent'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .ok()
    })
    .await
    .expect("a completion notice for the launching session");
    assert_eq!(notice.1, "completion");
    assert!(
        notice.0.contains("Count to ten")
            && notice.0.contains("cancelled")
            && notice.0.contains("pong"),
        "the notice must name the session, its state, and its answer: {}",
        notice.0
    );
    let origin = wait_for(|| {
        let connection = database.connection();
        connection
            .query_row(
                "SELECT payload_json FROM events WHERE session_id = 'session-parent' AND type = 'user.message'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
    })
    .await
    .expect("the notice arrives as a turn in the launching session");
    let origin: serde_json::Value = serde_json::from_str(&origin).expect("payload json");
    assert_eq!(origin["origin"]["kind"], "completion");
    assert_eq!(origin["origin"]["sessionId"], "session-child");
    assert_eq!(origin["origin"]["label"], "Count to ten");

    // A settled watched session ends the wait immediately.
    let waited = as_parent(json!({ "wait": { "timeoutS": 30 } })).await;
    assert_eq!(waited["waited"]["timedOut"], false);
    assert_eq!(
        waited["waited"]["sessions"][0]["sessionId"],
        "session-child"
    );
    assert_eq!(waited["waited"]["sessions"][0]["state"], "cancelled");

    // A message to a session that is mid-turn queues, and stays collectable
    // from that session's inbox until it is read.
    let first = as_parent(json!({
        "message": { "sessionId": "session-child", "message": "first" }
    }))
    .await;
    assert_eq!(first["messaged"]["queued"], false);
    let second = as_parent(json!({
        "message": { "sessionId": "session-child", "message": "second" }
    }))
    .await;
    assert_eq!(second["messaged"]["queued"], true);
    let child_status = as_parent(json!({ "status": { "sessionId": "session-child" } })).await;
    assert_eq!(child_status["status"]["unreadInbox"], 1);
    // The sender can see the mail piling up, but the recipient is the one that
    // has to act on it, and it is mid-turn. Its own tool results are the only
    // channel that reaches it there, so every answer it gets carries the flag —
    // here on a status call that has nothing to do with the inbox.
    let child_sees_mail = as_child(json!({ "status": { "sessionId": "session-parent" } })).await;
    assert_eq!(child_sees_mail["unreadInbox"], 1);
    let inbox = as_child(json!({ "inbox": {} })).await;
    assert!(
        inbox.get("unreadInbox").is_none(),
        "a read that emptied the inbox has nothing left to flag: {inbox}"
    );
    let messages = inbox["inbox"]["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["body"], "second");
    assert_eq!(messages[0]["kind"], "message");
    assert_eq!(messages[0]["fromSessionId"], "session-parent");
    assert_eq!(messages[0]["fromLabel"], "Parent");
    // Collected once: a second read comes back empty.
    let drained = as_child(json!({ "inbox": {} })).await;
    assert!(drained["inbox"]["messages"]
        .as_array()
        .expect("messages")
        .is_empty());
    assert!(
        drained.get("unreadInbox").is_none(),
        "a collected message must stop flagging: {drained}"
    );
}

/// Poll a database read until it answers, since the completion notice is
/// delivered on a background task.
async fn wait_for<T>(mut read: impl FnMut() -> Option<T>) -> Option<T> {
    for _ in 0..100 {
        if let Some(value) = read() {
            return Some(value);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

/// One project, one workspace per session, and the session rows themselves —
/// the floor a control-socket test stands on. Each entry is
/// `(session id, task label, state)`.
fn seed_sessions(database: &Database, repo_path: &str, sessions: &[(&str, &str, SessionState)]) {
    let connection = database.connection();
    persist_project(
        &connection,
        &PersistProjectInput {
            id: "project-1".to_string(),
            name: "Argmax".to_string(),
            repo_path: repo_path.to_string(),
            current_branch: "main".to_string(),
            default_branch: Some("main".to_string()),
            settings: ProjectSettings {
                archive_on_merge: false,
                worktree_location: format!("{repo_path}/worktrees"),
                setup_command: String::new(),
                check_commands: Vec::new(),
            },
        },
    )
    .expect("project");
    for (session_id, label, state) in sessions {
        let workspace_id = format!("workspace-{session_id}");
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: workspace_id.clone(),
                project_id: "project-1".to_string(),
                task_label: (*label).to_string(),
                branch: "main".to_string(),
                base_ref: "main".to_string(),
                path: repo_path.to_string(),
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
                id: (*session_id).to_string(),
                workspace_id,
                provider: "codex".to_string(),
                model_label: "GPT-5.6 Sol".to_string(),
                model_id: "gpt-5.6-sol".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "Task".to_string(),
                state: *state,
            },
        )
        .expect("session");
    }
}

/// The socket path and token a session's own agent would find in its
/// environment.
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

/// One request on the control socket, answered with the raw reply text — the
/// size of a reply is itself under test.
async fn ask_raw(socket: String, token: String, action: serde_json::Value) -> String {
    tokio::task::spawn_blocking(move || {
        let mut stream = UnixStream::connect(socket).expect("connect control socket");
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .expect("read timeout");
        let request = json!({ "version": 1, "token": token, "action": action });
        writeln!(stream, "{request}").expect("write request");
        stream.shutdown(Shutdown::Write).expect("finish request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        response
    })
    .await
    .expect("client task")
}

#[tokio::test]
async fn session_rename_updates_the_callers_sidebar_label() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[(
            "session-agent",
            "Long auto label from the opening prompt",
            SessionState::Running,
        )],
    );
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let providers = ProviderSessionService::with_launcher(
        Arc::clone(&database),
        Arc::new(RecordingLauncher::default()),
        |_| {},
    );
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    let (socket, token) = credential(&registry, repo.path(), "session-agent");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let response = ask_raw(
        socket,
        token,
        json!({ "rename": { "taskLabel": "Ship the fix" } }),
    )
    .await;
    let response: serde_json::Value = serde_json::from_str(&response).expect("response json");
    assert_eq!(response["renamed"]["sessionId"], "session-agent");
    assert_eq!(
        response["renamed"]["workspaceId"],
        "workspace-session-agent"
    );
    assert_eq!(response["renamed"]["taskLabel"], "Ship the fix");
    assert_eq!(
        response["renamed"]["previousTaskLabel"],
        "Long auto label from the opening prompt"
    );

    let connection = database.connection();
    let workspace =
        find_workspace_by_id(&connection, "workspace-session-agent").expect("workspace");
    assert_eq!(workspace.task_label, "Ship the fix");
    let task_label_auto: i64 = connection
        .query_row(
            "SELECT task_label_auto FROM workspaces WHERE id = 'workspace-session-agent'",
            [],
            |row| row.get(0),
        )
        .expect("task_label_auto");
    assert_eq!(
        task_label_auto, 0,
        "a manual rename stops autotitle overwriting"
    );
}

#[tokio::test]
async fn session_rename_truncates_overlong_labels() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Parent", SessionState::Running)],
    );
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let providers = ProviderSessionService::with_launcher(
        Arc::clone(&database),
        Arc::new(RecordingLauncher::default()),
        |_| {},
    );
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    let (socket, token) = credential(&registry, repo.path(), "session-agent");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let long = "å".repeat(80);
    let response = ask_raw(socket, token, json!({ "rename": { "taskLabel": long } })).await;
    let response: serde_json::Value = serde_json::from_str(&response).expect("response json");
    let landed = response["renamed"]["taskLabel"]
        .as_str()
        .expect("task label");
    assert!(landed.ends_with("..."));
    assert!(landed.chars().count() <= 64);
}

/// The client refuses a reply over the ceiling it read with, and the rows in a
/// refused reply have already been marked delivered — so a hand-over that
/// ignored the ceiling would destroy exactly the messages it was carrying. Big
/// messages must come back across several reads instead, losing none of them.
#[tokio::test]
async fn a_large_inbox_drains_across_reads_within_the_reply_ceiling() {
    // Mirrors `session_control::MAX_INBOX_RESPONSE_BYTES`.
    const MAX_INBOX_RESPONSE_BYTES: usize = 512 * 1024;
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[
            ("session-parent", "Parent", SessionState::Running),
            ("session-child", "Count to ten", SessionState::Running),
        ],
    );
    {
        let connection = database.connection();
        for marker in ["alpha", "beta", "gamma"] {
            insert_session_message(
                &connection,
                &NewSessionMessage {
                    id: format!("message-{marker}"),
                    from_session_id: Some("session-parent".to_string()),
                    to_session_id: "session-child".to_string(),
                    body: format!("{marker}:{}", "x".repeat(30 * 1024)),
                    kind: MESSAGE_KIND.to_string(),
                },
            )
            .expect("inbox row");
        }
    }

    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    providers.set_session_control(Arc::clone(&registry));
    let (socket, child_token) = credential(&registry, repo.path(), "session-child");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let mut collected = Vec::new();
    let mut reads = 0;
    loop {
        let raw = ask_raw(socket.clone(), child_token.clone(), json!({ "inbox": {} })).await;
        assert!(
            raw.len() <= MAX_INBOX_RESPONSE_BYTES,
            "an inbox reply of {} bytes is over the client's ceiling and would be refused",
            raw.len()
        );
        let response: serde_json::Value = serde_json::from_str(&raw).expect("response json");
        let messages = response["inbox"]["messages"]
            .as_array()
            .expect("messages")
            .clone();
        if messages.is_empty() {
            break;
        }
        reads += 1;
        assert!(reads <= 4, "the inbox never drained");
        for message in messages {
            let body = message["body"].as_str().expect("body");
            assert!(
                body.len() <= MAX_MESSAGE_BODY_CHARS + 32,
                "a stored body is capped, so no single row can outgrow the reply"
            );
            collected.push(body.split(':').next().expect("marker").to_string());
        }
    }
    assert_eq!(reads, 2, "three oversized messages take two reads");
    assert_eq!(collected, vec!["alpha", "beta", "gamma"]);
}

/// A body is capped in characters, not bytes, so 16K four-byte scalars is
/// 64 KiB on the wire — past the ceiling every ordinary reply is read under.
/// The hand-over takes its first row whatever it costs and marks it delivered,
/// so a client that refused that reply would lose the message outright. The
/// inbox reads under its own ceiling instead and the body comes back whole.
#[tokio::test]
async fn an_inbox_reply_carries_a_full_width_body_whole() {
    // Mirrors `session_control::MAX_RESPONSE_BYTES` and
    // `session_control::MAX_INBOX_RESPONSE_BYTES`.
    const MAX_RESPONSE_BYTES: usize = 64 * 1024;
    const MAX_INBOX_RESPONSE_BYTES: usize = 512 * 1024;
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[
            ("session-parent", "Parent", SessionState::Running),
            ("session-child", "Count to ten", SessionState::Running),
        ],
    );
    let body = "\u{1f642}".repeat(MAX_MESSAGE_BODY_CHARS);
    assert_eq!(
        body.len(),
        MAX_MESSAGE_BODY_CHARS * 4,
        "the widest body the character cap allows"
    );
    {
        let connection = database.connection();
        insert_session_message(
            &connection,
            &NewSessionMessage {
                id: "message-wide".to_string(),
                from_session_id: Some("session-parent".to_string()),
                to_session_id: "session-child".to_string(),
                body: body.clone(),
                kind: MESSAGE_KIND.to_string(),
            },
        )
        .expect("inbox row");
    }

    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    providers.set_session_control(Arc::clone(&registry));
    let (socket, child_token) = credential(&registry, repo.path(), "session-child");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let raw = ask_raw(socket.clone(), child_token.clone(), json!({ "inbox": {} })).await;
    assert!(
        raw.len() > MAX_RESPONSE_BYTES,
        "this reply is only readable because the inbox has its own ceiling"
    );
    assert!(
        raw.len() <= MAX_INBOX_RESPONSE_BYTES,
        "an inbox reply of {} bytes is over the client's ceiling and would be refused",
        raw.len()
    );
    let response: serde_json::Value = serde_json::from_str(&raw).expect("response json");
    let messages = response["inbox"]["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["body"].as_str().expect("body"), body);

    let raw = ask_raw(socket, child_token, json!({ "inbox": {} })).await;
    let response: serde_json::Value = serde_json::from_str(&raw).expect("response json");
    assert!(
        response["inbox"]["messages"]
            .as_array()
            .expect("messages")
            .is_empty(),
        "the delivered row is not handed over twice"
    );
}

/// A read with no cursor answers with the start of the transcript, the way the
/// tool says it does, and admits it stopped at the row limit so the caller
/// pages on rather than believing it has the whole thing.
#[tokio::test]
async fn a_cursorless_read_starts_at_the_beginning_and_reports_more_to_come() {
    const EVENT_COUNT: usize = 600;
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[
            ("session-parent", "Parent", SessionState::Running),
            ("session-child", "Count to ten", SessionState::Running),
        ],
    );
    {
        let connection = database.connection();
        for index in 0..EVENT_COUNT {
            persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: format!("event-{index}"),
                    session_id: "session-child".to_string(),
                    r#type: "message.completed".to_string(),
                    message: format!("answer {index}"),
                    payload: json!({}),
                    created_at: None,
                },
            )
            .expect("child event");
        }
    }

    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    providers.set_session_control(Arc::clone(&registry));
    let (socket, parent_token) = credential(&registry, repo.path(), "session-parent");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let first: serde_json::Value = serde_json::from_str(
        &ask_raw(
            socket.clone(),
            parent_token.clone(),
            json!({ "read": { "sessionId": "session-child" } }),
        )
        .await,
    )
    .expect("response json");
    let entries = first["read"]["entries"].as_array().expect("entries");
    assert_eq!(entries[0]["text"], "answer 0");
    assert_eq!(
        entries.len(),
        SESSION_EVENT_PAGE_LIMIT,
        "one page is the row limit"
    );
    assert_eq!(
        first["read"]["truncated"], true,
        "a page the row limit cut short must say so"
    );

    let cursor = first["read"]["nextCursor"].as_i64().expect("cursor");
    let second: serde_json::Value = serde_json::from_str(
        &ask_raw(
            socket,
            parent_token,
            json!({ "read": { "sessionId": "session-child", "cursor": cursor } }),
        )
        .await,
    )
    .expect("response json");
    let entries = second["read"]["entries"].as_array().expect("entries");
    assert_eq!(
        entries[0]["text"],
        format!("answer {SESSION_EVENT_PAGE_LIMIT}")
    );
    assert_eq!(entries.len(), EVENT_COUNT - SESSION_EVENT_PAGE_LIMIT);
    assert_eq!(second["read"]["truncated"], false);
}

/// A completion notice that queued behind the launcher's running turn has not
/// been delivered: the launcher never saw it. It has to stay collectable from
/// the inbox, the same rule an agent's own message follows.
#[tokio::test]
async fn a_completion_notice_queued_behind_a_running_turn_stays_collectable() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[
            ("session-parent", "Parent", SessionState::Running),
            ("session-child", "Count to ten", SessionState::Running),
        ],
    );
    {
        let connection = database.connection();
        record_session_launch(
            &connection,
            "session-child",
            "session-parent",
            1,
            LAUNCH_KIND_AGENT,
        )
        .expect("record lineage");
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "event-1".to_string(),
                session_id: "session-child".to_string(),
                r#type: "message.completed".to_string(),
                message: "pong".to_string(),
                payload: json!({}),
                created_at: None,
            },
        )
        .expect("child event");
    }

    let deltas = Arc::new(Mutex::new(Vec::<DashboardDelta>::new()));
    let provider_deltas = Arc::clone(&deltas);
    let launcher = Arc::new(RecordingLauncher::default());
    let providers = ProviderSessionService::with_launcher(
        Arc::clone(&database),
        launcher.clone(),
        move |delta| {
            provider_deltas.lock().expect("deltas poisoned").push(delta);
        },
    );
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    providers.set_session_control(Arc::clone(&registry));
    let (socket, parent_token) = credential(&registry, repo.path(), "session-parent");
    let (_, child_token) = credential(&registry, repo.path(), "session-child");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    // The child's first message starts the launcher's turn; the second proves
    // that turn is now running, since it queues instead of sending.
    let started: serde_json::Value = serde_json::from_str(
        &ask_raw(
            socket.clone(),
            child_token.clone(),
            json!({ "message": { "sessionId": "session-parent", "message": "starting" } }),
        )
        .await,
    )
    .expect("response json");
    assert_eq!(started["messaged"]["queued"], false);
    let queued: serde_json::Value = serde_json::from_str(
        &ask_raw(
            socket.clone(),
            child_token,
            json!({ "message": { "sessionId": "session-parent", "message": "mid-turn" } }),
        )
        .await,
    )
    .expect("response json");
    assert_eq!(
        queued["messaged"]["queued"], true,
        "the launcher must be mid-turn for this test to mean anything"
    );

    let stopped: serde_json::Value = serde_json::from_str(
        &ask_raw(
            socket.clone(),
            parent_token.clone(),
            json!({ "stop": { "sessionId": "session-child" } }),
        )
        .await,
    )
    .expect("response json");
    assert_eq!(stopped["stopped"]["state"], "cancelled");

    // The notice is delivered on a background task: wait until it has actually
    // been handed to the launcher and queued there before judging the row.
    let notice_queued = wait_for(|| {
        let deltas = deltas.lock().expect("deltas poisoned");
        deltas
            .iter()
            .filter_map(|delta| delta.pending_messages.as_ref())
            .filter_map(|pending| pending.get("session-parent"))
            .flatten()
            .any(|message| message.content.contains("finished with state cancelled"))
            .then_some(())
    })
    .await;
    assert!(
        notice_queued.is_some(),
        "the notice must reach the launcher's queue"
    );

    let delivered_at = {
        let connection = database.connection();
        connection
            .query_row(
                "SELECT delivered_at FROM session_messages WHERE kind = 'completion'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .expect("the completion row")
    };
    assert!(
        delivered_at.is_none(),
        "a queued notice has not been delivered: {delivered_at:?}"
    );

    let inbox: serde_json::Value =
        serde_json::from_str(&ask_raw(socket, parent_token, json!({ "inbox": {} })).await)
            .expect("response json");
    let notice = inbox["inbox"]["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find(|message| message["kind"] == "completion")
        .expect("the launcher collects the notice it never saw");
    assert!(notice["body"]
        .as_str()
        .expect("body")
        .contains("finished with state cancelled"));
}

/// A parent that launched two children and collected the first one must not be
/// handed that same child every time it asks about the second. The
/// argument-less wait reports each finish once; naming ids reads a session
/// again on purpose.
#[tokio::test]
async fn the_default_wait_hands_over_each_finished_session_once() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[
            ("session-parent", "Parent", SessionState::Running),
            ("session-first", "First", SessionState::Running),
            ("session-second", "Second", SessionState::Running),
        ],
    );
    {
        let connection = database.connection();
        for child in ["session-first", "session-second"] {
            record_session_launch(&connection, child, "session-parent", 1, LAUNCH_KIND_AGENT)
                .expect("record lineage");
        }
    }
    let settle = |session_id: &'static str| {
        let connection = database.connection();
        update_session_state(
            &connection,
            session_id,
            &SessionStateInput::transition(SessionState::Complete).finished_at(now_iso()),
        )
        .expect("settle session");
    };

    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    providers.set_session_control(Arc::clone(&registry));
    let (socket, token) = credential(&registry, repo.path(), "session-parent");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");
    let wait = |action: serde_json::Value| {
        let (socket, token) = (socket.clone(), token.clone());
        async move {
            serde_json::from_str::<serde_json::Value>(&ask_raw(socket, token, action).await)
                .expect("response json")
        }
    };
    let reported = |response: &serde_json::Value| {
        response["waited"]["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .map(|session| {
                session["sessionId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect::<Vec<_>>()
    };

    settle("session-first");
    let first = wait(json!({ "wait": { "timeoutS": 1 } })).await;
    assert_eq!(first["waited"]["timedOut"], false);
    assert_eq!(reported(&first), vec!["session-first"]);

    // The second child is still working, and the first has already been handed
    // over — so this wait has nothing to say and blocks until it runs out.
    let again = wait(json!({ "wait": { "timeoutS": 1 } })).await;
    assert_eq!(again["waited"]["timedOut"], true, "second wait: {again}");
    assert!(reported(&again).is_empty());

    settle("session-second");
    let second = wait(json!({ "wait": { "timeoutS": 1 } })).await;
    assert_eq!(second["waited"]["timedOut"], false);
    assert_eq!(reported(&second), vec!["session-second"]);

    // Naming a session asks about that session, so a finish already collected
    // is still readable.
    let named = wait(json!({ "wait": { "sessions": ["session-first"], "timeoutS": 1 } })).await;
    assert_eq!(named["waited"]["timedOut"], false);
    assert_eq!(reported(&named), vec!["session-first"]);
}

/// Archiving stops every provider process in the workspace, and the agent that
/// asked is one of them — so the tool must schedule the archive for the end of
/// the turn rather than run it inline. Run inline it would kill the caller
/// before it could write the report the request was made for.
#[tokio::test]
async fn archiving_a_workspace_is_scheduled_rather_than_immediate() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Land the PR", SessionState::Running)],
    );

    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    providers.set_session_control(Arc::clone(&registry));
    let (socket, token) = credential(&registry, repo.path(), "session-agent");
    let _server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let response = ask_raw(socket.clone(), token.clone(), json!({ "archive": {} })).await;
    let response: serde_json::Value = serde_json::from_str(&response).expect("response json");
    assert!(response["error"].is_null(), "archive response: {response}");
    let archiving = &response["archiving"];
    assert_eq!(archiving["scheduled"], true);
    assert_eq!(archiving["workspaceId"], "workspace-session-agent");
    // A shared checkout is every other session's tree too: archiving one ends
    // the chat and never removes a directory, so the result does not talk
    // about removing one.
    assert!(
        archiving.get("removesWorktree").is_none(),
        "archive result: {archiving}"
    );

    {
        let connection = database.connection();
        let workspace =
            find_workspace_by_id(&connection, "workspace-session-agent").expect("workspace");
        assert_ne!(
            workspace.state, "archived",
            "the turn is still open, so the archive must not have run yet"
        );
    }

    // A second request has nowhere to go: the slot is taken until the turn
    // settles and the archive finishes.
    let refused = ask_raw(socket, token, json!({ "archive": {} })).await;
    let refused: serde_json::Value = serde_json::from_str(&refused).expect("response json");
    assert_eq!(refused["error"]["code"], "ARCHIVE_ALREADY_PENDING");
}

/// The session ids with a disposal still promised on disk.
fn scheduled_sessions(database: &Database) -> Vec<String> {
    let connection = database.read_connection();
    list_after_turn(&connection)
        .expect("list scheduled after-turn actions")
        .into_iter()
        .map(|request| request.session_id)
        .collect()
}

/// The chat's own timeline as `(type, message)`, oldest first.
fn timeline_rows(database: &Database, session_id: &str) -> Vec<(String, String)> {
    let connection = database.read_connection();
    let mut statement = connection
        .prepare("SELECT type, message FROM events WHERE session_id = ? ORDER BY id")
        .expect("prepare timeline");
    let rows = statement
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query timeline")
        .collect::<Result<Vec<_>, _>>()
        .expect("timeline rows");
    rows
}

/// The boot sequence after a quit, with the session-control socket rebuilt
/// from scratch over the store the last run left behind.
fn relaunch(
    database: &Arc<Database>,
) -> (
    SessionLaunchServer,
    Arc<SessionLaunchRegistry>,
    Arc<ProviderSessionService>,
    Arc<RecordingLauncher>,
) {
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(database)).expect("rebind control socket");
    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(database), launcher.clone(), |_| {});
    providers.set_session_control(Arc::clone(&registry));
    providers
        .recover_orphaned_sessions()
        .expect("recover orphaned sessions");
    (server, registry, providers, launcher)
}

/// `workspace_archive` answers `{scheduled: true}` while the calling turn is
/// still running, and the agent reports the workspace closed on that answer.
/// Quitting before the turn settles used to end the promise there: the
/// workspace stayed live and the timeline said "scheduled" forever. The
/// promise is a row, so the next launch keeps it.
#[tokio::test]
async fn a_scheduled_archive_outlives_the_run_that_promised_it() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Land the PR", SessionState::Running)],
    );

    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    providers.set_session_control(Arc::clone(&registry));
    let (socket, token) = credential(&registry, repo.path(), "session-agent");
    let server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let response = ask_raw(socket, token, json!({ "archive": {} })).await;
    let response: serde_json::Value = serde_json::from_str(&response).expect("response json");
    assert_eq!(response["archiving"]["scheduled"], true);
    assert_eq!(scheduled_sessions(&database), vec!["session-agent"]);

    // The app quits with the turn still open. Nothing signals the turn's end,
    // so the archive never runs in this process.
    drop(server);
    drop(providers);
    drop(registry);
    {
        let connection = database.connection();
        let workspace =
            find_workspace_by_id(&connection, "workspace-session-agent").expect("workspace");
        assert_ne!(workspace.state, "archived");
    }

    let (_next_server, next_registry, next_providers, _next_launcher) = relaunch(&database);
    argmax_lib::session_control::resume_after_turn_actions(
        Arc::clone(&database),
        Arc::clone(&workspaces),
        next_providers,
        next_registry,
    )
    .await;

    {
        let connection = database.connection();
        let workspace =
            find_workspace_by_id(&connection, "workspace-session-agent").expect("workspace");
        assert_eq!(
            workspace.state, "archived",
            "the promise made in the last run is kept in this one"
        );
    }
    assert!(
        scheduled_sessions(&database).is_empty(),
        "a kept promise leaves no row for the launch after this one"
    );
    assert!(
        timeline_rows(&database, "session-agent")
            .iter()
            .any(|(kind, message)| {
                kind == "session.note"
                    && message == "Resuming the archive scheduled before Argmax last quit."
            }),
        "the chat says why it closed a day after it was asked to, as a notice rather than an error"
    );
}

/// A move is the other half of the same promise, and it has more to keep: the
/// destination has to exist and open with the turn the mover wrote.
#[tokio::test]
async fn a_scheduled_move_outlives_the_run_and_still_starts_the_destination() {
    let repo = tempfile::tempdir().expect("repo dir");
    let destination_repo = tempfile::tempdir().expect("destination repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Port the fix", SessionState::Running)],
    );
    {
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-2".to_string(),
                name: "Destination".to_string(),
                repo_path: destination_repo.path().display().to_string(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: destination_repo
                        .path()
                        .join("worktrees")
                        .display()
                        .to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("destination project");
    }

    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) =
        SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
    providers.set_session_control(Arc::clone(&registry));
    let (socket, token) = credential(&registry, repo.path(), "session-agent");
    let server = server
        .start(
            None,
            Arc::clone(&database),
            Arc::clone(&workspaces),
            Arc::clone(&providers),
        )
        .expect("start control socket");

    let response = ask_raw(
        socket,
        token,
        json!({ "move": { "project": "Destination", "prompt": "Port the fix to this repo" } }),
    )
    .await;
    let response: serde_json::Value = serde_json::from_str(&response).expect("response json");
    assert_eq!(response["scheduled"]["scheduled"], true);
    assert_eq!(scheduled_sessions(&database), vec!["session-agent"]);

    drop(server);
    drop(providers);
    drop(registry);

    let (_next_server, next_registry, next_providers, next_launcher) = relaunch(&database);
    argmax_lib::session_control::resume_after_turn_actions(
        Arc::clone(&database),
        Arc::clone(&workspaces),
        Arc::clone(&next_providers),
        next_registry,
    )
    .await;

    {
        let connection = database.connection();
        let moved: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE w.project_id = 'project-2'",
                [],
                |row| row.get(0),
            )
            .expect("moved session count");
        assert_eq!(moved, 1, "the chat landed in the destination project");
    }
    assert!(scheduled_sessions(&database).is_empty());

    // The move is only half the point: the destination has to pick the work
    // up, which is a launch there with the prompt the mover wrote. The launch
    // itself is backgrounded, so wait for it rather than for `send_input`.
    for _ in 0..100 {
        if !next_launcher
            .launches
            .lock()
            .expect("launches poisoned")
            .is_empty()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let launches = next_launcher.launches.lock().expect("launches poisoned");
    assert_eq!(launches.len(), 1, "the moved chat launched once");
    let continuation = launches.last().expect("destination launch");
    assert_eq!(
        continuation.workspace_path,
        destination_repo.path().to_path_buf()
    );
    assert!(
        continuation.prompt.contains("Port the fix to this repo"),
        "the destination turn carries the mover's prompt: {}",
        continuation.prompt
    );
}

/// The archive may have already happened — through the sidebar, or through the
/// archive-on-merge poller — while the promise was still on disk. Running it
/// again is at best noise, so recovery drops the row instead.
#[tokio::test]
async fn a_promise_whose_workspace_is_already_archived_is_dropped() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Land the PR", SessionState::Complete)],
    );
    {
        let connection = database.connection();
        insert_after_turn(
            &connection,
            "session-agent",
            &AfterTurnAction::Archive(ArchiveRequest {
                workspace_id: "workspace-session-agent".to_string(),
            }),
        )
        .expect("promise an archive");
        connection
            .execute(
                "UPDATE workspaces SET state = 'archived' WHERE id = 'workspace-session-agent'",
                [],
            )
            .expect("archive the workspace some other way");
    }

    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (_server, registry, providers, _launcher) = relaunch(&database);
    argmax_lib::session_control::resume_after_turn_actions(
        Arc::clone(&database),
        Arc::clone(&workspaces),
        providers,
        registry,
    )
    .await;

    assert!(scheduled_sessions(&database).is_empty());
    assert!(
        timeline_rows(&database, "session-agent").is_empty(),
        "nothing was left to do, so the chat is not told anything"
    );
}

/// Everything a control socket with no window behind it can answer. The tools
/// that need the app's own services (checks, terminals) are refused here by
/// name, and covered where those services live.
struct ToolHarness {
    _server: SessionLaunchServer,
    socket: String,
    token: String,
    database: Arc<Database>,
    launcher: Arc<RecordingLauncher>,
}

impl ToolHarness {
    fn open(database: Arc<Database>, repo: &std::path::Path, session_id: &str) -> Self {
        let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
        let launcher = Arc::new(RecordingLauncher::default());
        let providers =
            ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
        let (server, registry) =
            SessionLaunchServer::bind(Arc::clone(&database)).expect("bind control socket");
        let (socket, token) = credential(&registry, repo, session_id);
        let server = server
            .start(
                None,
                Arc::clone(&database),
                Arc::clone(&workspaces),
                Arc::clone(&providers),
            )
            .expect("start control socket");
        Self {
            _server: server,
            socket,
            token,
            database,
            launcher,
        }
    }

    async fn ask(&self, action: serde_json::Value) -> serde_json::Value {
        let response = ask_raw(self.socket.clone(), self.token.clone(), action).await;
        serde_json::from_str(&response).expect("response json")
    }
}

#[tokio::test]
async fn launch_reasoning_and_permission_mode_override_the_inherited_values() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Parent", SessionState::Running)],
    );
    let harness = ToolHarness::open(Arc::clone(&database), repo.path(), "session-agent");

    let response = harness
        .ask(json!({
            "launch": {
                "prompt": "Review the change",
                "reasoning": "high",
                "permissionMode": "ask-each-time",
            }
        }))
        .await;
    assert!(response["error"].is_null(), "launch response: {response}");
    let session_id = response["launched"]["sessionId"]
        .as_str()
        .expect("session id");

    let launched = wait_for(|| {
        harness
            .launcher
            .launches
            .lock()
            .expect("launches poisoned")
            .first()
            .cloned()
    })
    .await
    .expect("provider launch");
    assert_eq!(launched.reasoning_effort, Some(ReasoningEffort::High));
    assert_eq!(launched.permission_mode, PermissionMode::AskEachTime);

    let connection = database.read_connection();
    let session = find_session_by_id(&connection, session_id).expect("persisted session");
    assert_eq!(session.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(session.permission_mode, "ask-each-time");
}

#[tokio::test]
async fn launch_can_target_an_existing_checkout_or_fork_from_a_branch() {
    let repo = seed_git_repo(&[("README.md", "source")]);
    run_git(repo.path(), &["branch", "release"]);
    let sibling = repo.path().join("worktrees").join("feature");
    run_git(
        repo.path(),
        &[
            "worktree",
            "add",
            "-b",
            "feature",
            &sibling.display().to_string(),
        ],
    );
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Parent", SessionState::Running)],
    );
    let harness = ToolHarness::open(Arc::clone(&database), repo.path(), "session-agent");

    let attached = harness
        .ask(json!({
            "launch": {
                "prompt": "Work on the feature tree",
                "path": sibling.display().to_string(),
                "branch": "feature",
            }
        }))
        .await;
    assert!(attached["error"].is_null(), "attach launch: {attached}");
    assert_eq!(attached["launched"]["branch"], "feature");
    let attached_path = attached["launched"]["path"].as_str().expect("path");
    assert_eq!(
        std::fs::canonicalize(attached_path).expect("canonical launched path"),
        std::fs::canonicalize(&sibling).expect("canonical sibling")
    );
    let attached_id = attached["launched"]["workspaceId"]
        .as_str()
        .expect("workspace id");
    {
        let connection = database.read_connection();
        let workspace = find_workspace_by_id(&connection, attached_id).expect("workspace");
        assert!(
            workspace.shared_workspace,
            "an existing checkout is shared, so archive must not delete it"
        );
    }

    let mismatched = harness
        .ask(json!({
            "launch": {
                "prompt": "Wrong branch",
                "path": sibling.display().to_string(),
                "branch": "release",
            }
        }))
        .await;
    assert_eq!(mismatched["error"]["code"], "LAUNCH_BRANCH_MISMATCH");

    let isolated = harness
        .ask(json!({
            "launch": {
                "prompt": "Fork from release",
                "worktree": true,
                "branch": "release",
            }
        }))
        .await;
    assert!(isolated["error"].is_null(), "isolated launch: {isolated}");
    let isolated_id = isolated["launched"]["workspaceId"]
        .as_str()
        .expect("workspace id");
    {
        let connection = database.read_connection();
        let workspace = find_workspace_by_id(&connection, isolated_id).expect("workspace");
        assert!(!workspace.shared_workspace);
        assert_eq!(workspace.base_ref, "release");
        assert_ne!(workspace.path, repo.path().display().to_string());
    }

    let branch_only = harness
        .ask(json!({
            "launch": { "prompt": "Just a branch", "branch": "release" }
        }))
        .await;
    assert_eq!(
        branch_only["error"]["code"],
        "LAUNCH_BRANCH_NEEDS_DESTINATION"
    );

    let both = harness
        .ask(json!({
            "launch": {
                "prompt": "Both",
                "worktree": true,
                "path": sibling.display().to_string(),
            }
        }))
        .await;
    assert_eq!(both["error"]["code"], "LAUNCH_WORKTREE_WITH_PATH");
}

/// Attention is what a launcher actually wants to know — does a person need to
/// look? — and it has to be on both reads, since a launcher that has one
/// session in mind calls `session_status` and never lists.
#[tokio::test]
async fn attention_rides_on_both_the_list_and_the_status_read() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[
            ("session-agent", "Parent", SessionState::Running),
            ("session-child", "Child", SessionState::Complete),
        ],
    );
    {
        // Attention is derived once, on the write that settles a turn: a
        // finished turn nobody has looked at is `review-ready`, and that is the
        // row the parent must see.
        let connection = database.connection();
        update_session_state(
            &connection,
            "session-child",
            &SessionStateInput::transition(SessionState::Complete),
        )
        .expect("settle the child");
    }
    let harness = ToolHarness::open(Arc::clone(&database), repo.path(), "session-agent");

    let listed = harness.ask(json!({ "list": {} })).await;
    let child = listed["listed"]["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|entry| entry["sessionId"] == "session-child")
        .cloned()
        .expect("the child is listed");
    assert_eq!(child["attention"], "review-ready");

    let status = harness
        .ask(json!({ "status": { "sessionId": "session-child" } }))
        .await;
    assert_eq!(status["status"]["attention"], "review-ready");
    assert_eq!(status["status"]["state"], "complete");
}

/// The point of `workspace_status` is the peer read: an agent has `git status`
/// for its own tree, and no way at all to see another session's.
#[tokio::test]
async fn workspace_status_answers_for_a_peer_and_for_the_caller() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[
            ("session-agent", "Parent", SessionState::Running),
            ("session-peer", "Peer work", SessionState::Running),
        ],
    );
    {
        let connection = database.connection();
        connection
            .execute(
                "UPDATE workspaces SET shared_workspace = 0, dirty = 1, changed_files = 3, \
                 branch = 'argmax/peer' WHERE id = 'workspace-session-peer'",
                [],
            )
            .expect("make the peer an isolated worktree");
    }
    let harness = ToolHarness::open(Arc::clone(&database), repo.path(), "session-agent");

    let own = harness.ask(json!({ "workspace-status": {} })).await;
    assert_eq!(own["workspaceStatus"]["sessionId"], "session-agent");
    assert_eq!(own["workspaceStatus"]["sharedCheckout"], true);
    assert_eq!(
        own["workspaceStatus"]["archivable"], false,
        "archiving a checkout the user also works in only closes the chat"
    );

    let peer = harness
        .ask(json!({ "workspace-status": { "session": "session-peer" } }))
        .await;
    let peer = &peer["workspaceStatus"];
    assert_eq!(peer["workspaceId"], "workspace-session-peer");
    assert_eq!(peer["taskLabel"], "Peer work");
    assert_eq!(peer["branch"], "argmax/peer");
    assert_eq!(peer["sharedCheckout"], false);
    assert_eq!(peer["archivable"], true);
    assert_eq!(peer["dirty"], true);
    assert_eq!(peer["changedFiles"], 3);
    assert_eq!(peer["projectName"], "Argmax");

    let missing = harness
        .ask(json!({ "workspace-status": { "session": "nobody" } }))
        .await;
    assert_eq!(missing["error"]["code"], "RECORD_NOT_FOUND");
}

/// A diff read is bounded on purpose: `truncated` is the cue to name a file,
/// and the file list has to arrive whole even when the diff does not.
#[tokio::test]
async fn workspace_diff_lists_changed_files_and_caps_the_diff() {
    let repo = crate::support::git_repo::seed_git_repo(&[("kept.txt", "one\n")]);
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Parent", SessionState::Running)],
    );
    std::fs::write(repo.path().join("kept.txt"), "one\ntwo\n").expect("edit the tracked file");
    std::fs::write(
        repo.path().join("added.txt"),
        "line\n".repeat(400).as_bytes(),
    )
    .expect("write a big new file");
    for index in 0..105 {
        std::fs::write(repo.path().join(format!("extra-{index:03}.txt")), "extra\n")
            .expect("write another changed file");
    }
    let harness = ToolHarness::open(Arc::clone(&database), repo.path(), "session-agent");

    let response = harness.ask(json!({ "workspace-diff": {} })).await;
    let diff = &response["workspaceDiff"];
    assert!(response["error"].is_null(), "diff response: {response}");
    let paths = diff["files"]
        .as_array()
        .expect("files")
        .iter()
        .map(|file| file["path"].as_str().unwrap_or_default().to_string())
        .collect::<Vec<_>>();
    assert!(paths.contains(&"kept.txt".to_string()), "paths: {paths:?}");
    assert!(paths.contains(&"added.txt".to_string()), "paths: {paths:?}");
    assert_eq!(diff["comparison"], "workingTree");

    let capped = harness
        .ask(json!({ "workspace-diff": { "maxChars": 200 } }))
        .await;
    let capped = &capped["workspaceDiff"];
    assert_eq!(capped["truncated"], true);
    assert!(
        capped["diff"].as_str().expect("diff").chars().count() <= 200,
        "the reply honors the budget it was given"
    );

    let one_file = harness
        .ask(json!({ "workspace-diff": { "filePath": "kept.txt" } }))
        .await;
    let one_file = &one_file["workspaceDiff"];
    let text = one_file["diff"].as_str().expect("file diff");
    assert!(text.contains("kept.txt"), "narrowed diff: {text}");
    assert!(
        !text.contains("added.txt"),
        "naming a file is what narrows it: {text}"
    );
    assert_eq!(one_file["files"].as_array().expect("files").len(), 1);
    assert_eq!(
        one_file["truncated"], false,
        "unrelated files cannot make a complete file-scoped diff look truncated"
    );
}

/// The writer is what makes the read worth having: a project with nothing
/// filed answers every search with an empty list.
#[tokio::test]
async fn a_filed_learning_comes_back_from_a_search_and_counts_its_hit() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Parent", SessionState::Running)],
    );
    let harness = ToolHarness::open(Arc::clone(&database), repo.path(), "session-agent");

    let added = harness
        .ask(json!({
            "learnings-add": {
                "kind": "pitfall",
                "summary": "The tauri bridge check runs before typecheck, so a missing channel fails first",
            }
        }))
        .await;
    assert!(added["error"].is_null(), "add response: {added}");
    assert_eq!(added["learned"]["kind"], "pitfall");
    assert_eq!(added["learned"]["projectId"], "project-1");
    assert_eq!(added["learned"]["hits"], 0);

    harness
        .ask(json!({
            "learnings-add": { "kind": "command", "summary": "npm run precheck is the pre-push gate" }
        }))
        .await;

    let found = harness
        .ask(json!({ "learnings-search": { "query": "bridge channel" } }))
        .await;
    let learnings = found["learningsFound"]["learnings"]
        .as_array()
        .expect("learnings");
    assert_eq!(learnings.len(), 1, "search narrows: {learnings:?}");
    assert!(learnings[0]["summary"]
        .as_str()
        .expect("summary")
        .contains("bridge check"));

    // An empty query is "show me what this project knows", not a match on
    // nothing — and the served rows have earned a hit.
    let all = harness.ask(json!({ "learnings-search": {} })).await;
    let all = all["learningsFound"]["learnings"]
        .as_array()
        .expect("learnings");
    assert_eq!(all.len(), 2);
    let hit = all
        .iter()
        .find(|learning| {
            learning["summary"]
                .as_str()
                .is_some_and(|summary| summary.contains("bridge check"))
        })
        .expect("the learning the narrow search served");
    assert_eq!(
        hit["hits"], 1,
        "a served row counts a hit, and the row nobody read does not: {all:?}"
    );

    let refused = harness
        .ask(json!({ "learnings-add": { "kind": "vibes", "summary": "anything" } }))
        .await;
    assert_eq!(refused["error"]["code"], "LEARNING_KIND_INVALID");
    let empty = harness
        .ask(json!({ "learnings-add": { "kind": "pitfall", "summary": "   " } }))
        .await;
    assert_eq!(empty["error"]["code"], "LEARNING_SUMMARY_EMPTY");
}

/// `session_list` only reveals projects that already have open chats, so this
/// is the read that says what else exists to launch into.
#[tokio::test]
async fn project_list_reports_every_registered_repository_with_its_checks() {
    let repo = tempfile::tempdir().expect("repo dir");
    let other = tempfile::tempdir().expect("other repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Parent", SessionState::Running)],
    );
    {
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-2".to_string(),
                name: "Quiet".to_string(),
                repo_path: other.path().display().to_string(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: other.path().join("worktrees").display().to_string(),
                    setup_command: String::new(),
                    check_commands: vec!["npm test".to_string(), "npm run lint".to_string()],
                },
            },
        )
        .expect("a project with no sessions in it");
    }
    let harness = ToolHarness::open(Arc::clone(&database), repo.path(), "session-agent");

    let response = harness.ask(json!({ "projects": {} })).await;
    let projects = response["projects"]["projects"]
        .as_array()
        .expect("projects");
    let quiet = projects
        .iter()
        .find(|project| project["name"] == "Quiet")
        .expect("a project with no open chats is still listed");
    assert_eq!(quiet["projectId"], "project-2");
    assert_eq!(
        quiet["checkCommands"],
        json!(["npm test", "npm run lint"]),
        "checks_run with no command runs these"
    );
    assert!(projects.iter().any(|project| project["name"] == "Argmax"));
}

/// A follow-up is a one-shot scheduled task pointed at the calling chat, so
/// the wake carries this transcript instead of starting cold.
#[tokio::test]
async fn a_scheduled_followup_is_a_one_shot_task_aimed_at_the_caller() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Land the PR", SessionState::Running)],
    );
    let harness = ToolHarness::open(Arc::clone(&database), repo.path(), "session-agent");

    let response = harness
        .ask(json!({
            "schedule-followup": {
                "prompt": "Check whether CI went green and merge if it did",
                "inSeconds": 600,
            }
        }))
        .await;
    assert!(response["error"].is_null(), "followup response: {response}");
    let followup = &response["followup"];
    assert_eq!(followup["sessionId"], "session-agent");
    assert_eq!(
        followup["name"],
        "Check whether CI went green and merge if it did"
    );
    let followup_id = followup["followupId"].as_str().expect("followup id");

    let routine = {
        let connection = harness.database.read_connection();
        argmax_lib::persistence::routines::find_routine_by_id(&connection, followup_id)
            .expect("the follow-up is a scheduled task the user can see")
    };
    assert_eq!(
        routine.run_target,
        argmax_lib::persistence::routines::RoutineRunTarget::SameSession
    );
    assert_eq!(
        routine.last_session_id.as_deref(),
        Some("session-agent"),
        "the wake has to land in this chat, not a fresh one"
    );
    assert_eq!(
        routine.run_once_at.as_deref(),
        Some(followup["runAt"].as_str().expect("run at"))
    );
    assert_eq!(
        routine.next_run_at.as_deref(),
        routine.run_once_at.as_deref()
    );
    assert!(routine.enabled);
    assert!(routine.cron_expr.is_none(), "a follow-up never recurs");
    assert_eq!(
        routine.provider, "codex",
        "it wakes as the chat it belongs to"
    );

    for refusal in [
        json!({ "schedule-followup": { "prompt": "x", "inSeconds": 60, "at": "2030-01-01T00:00:00Z" } }),
        json!({ "schedule-followup": { "prompt": "x" } }),
        json!({ "schedule-followup": { "prompt": "  ", "inSeconds": 60 } }),
    ] {
        let response = harness.ask(refusal).await;
        assert!(
            response["error"]["code"].is_string(),
            "a refused follow-up says why: {response}"
        );
    }
}

/// Managing a project's scheduled tasks: a wake this chat set can be paused,
/// which leaves the row for the user (or a later resume) to switch back on,
/// and deleted, which takes it away. A routine in another project is refused
/// whichever way it is addressed.
#[tokio::test]
async fn a_schedule_can_be_listed_paused_resumed_or_deleted() {
    let repo = tempfile::tempdir().expect("repo dir");
    let other = tempfile::tempdir().expect("other repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Land the PR", SessionState::Running)],
    );
    {
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-2".to_string(),
                name: "Quiet".to_string(),
                repo_path: other.path().display().to_string(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: other.path().join("worktrees").display().to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("a second project");
        argmax_lib::persistence::routines::upsert_routine(
            &connection,
            &argmax_lib::persistence::routines::UpsertRoutineInput {
                id: "routine-elsewhere".to_string(),
                name: "Nightly sync".to_string(),
                project_id: "project-2".to_string(),
                prompt: "Sync the changelog".to_string(),
                provider: "codex".to_string(),
                model_label: "GPT".to_string(),
                model_id: "gpt-5.6-sol".to_string(),
                run_target: argmax_lib::persistence::routines::RoutineRunTarget::Worktree,
                cron_expr: Some("0 3 * * *".to_string()),
                run_once_at: None,
                enabled: true,
            },
            Some("2030-01-01T03:00:00.000Z".to_string()),
        )
        .expect("another project's routine");
    }
    let harness = ToolHarness::open(Arc::clone(&database), repo.path(), "session-agent");

    let followup = harness
        .ask(json!({
            "schedule-followup": { "prompt": "Check CI", "inSeconds": 600 }
        }))
        .await;
    let schedule_id = followup["followup"]["followupId"]
        .as_str()
        .expect("followup id")
        .to_string();

    let listed = harness.ask(json!({ "schedule-list": {} })).await;
    let schedules = listed["schedules"]["schedules"]
        .as_array()
        .expect("schedules");
    assert_eq!(
        schedules.len(),
        1,
        "only this project's tasks are listed: {listed}"
    );
    assert_eq!(schedules[0]["scheduleId"], schedule_id.as_str());
    assert_eq!(schedules[0]["sessionId"], "session-agent");
    assert_eq!(schedules[0]["enabled"], true);
    assert_eq!(schedules[0]["prompt"], "Check CI");

    let paused = harness
        .ask(json!({ "schedule-cancel": { "scheduleId": schedule_id, "disable": true } }))
        .await;
    assert_eq!(paused["scheduleCancelled"]["deleted"], false);
    {
        let connection = harness.database.read_connection();
        let routine =
            argmax_lib::persistence::routines::find_routine_by_id(&connection, &schedule_id)
                .expect("a paused task is still the user's to resume");
        assert!(!routine.enabled);
        assert!(routine.next_run_at.is_none(), "a paused task is not due");
    }

    let resumed = harness
        .ask(json!({ "schedule-resume": { "scheduleId": schedule_id } }))
        .await;
    assert_eq!(
        resumed["scheduleResumed"]["nextRunAt"], followup["followup"]["runAt"],
        "a resumed one-shot keeps its own time"
    );
    {
        let connection = harness.database.read_connection();
        let routine =
            argmax_lib::persistence::routines::find_routine_by_id(&connection, &schedule_id)
                .expect("the resumed task");
        assert!(routine.enabled);
        assert!(routine.next_run_at.is_some(), "a resumed task is due again");
    }

    for refusal in [
        json!({ "schedule-cancel": { "scheduleId": "routine-elsewhere" } }),
        json!({ "schedule-resume": { "scheduleId": "routine-elsewhere" } }),
    ] {
        let refused = harness.ask(refusal).await;
        assert_eq!(refused["error"]["code"], "SCHEDULE_OTHER_PROJECT");
    }

    let deleted = harness
        .ask(json!({ "schedule-cancel": { "scheduleId": schedule_id } }))
        .await;
    assert_eq!(deleted["scheduleCancelled"]["deleted"], true);
    {
        let connection = harness.database.read_connection();
        assert!(
            argmax_lib::persistence::routines::find_routine_by_id(&connection, &schedule_id)
                .is_err(),
            "a deleted task is gone"
        );
    }
}

/// The two tools that need the app's own services. With no window behind the
/// socket they must refuse by name rather than panicking — this is also the
/// path a headless `argmax session` CLI call takes.
#[tokio::test]
async fn checks_and_terminals_refuse_cleanly_without_a_window() {
    let repo = tempfile::tempdir().expect("repo dir");
    let database = Arc::new(Database::open_in_memory().expect("database"));
    seed_sessions(
        &database,
        &repo.path().display().to_string(),
        &[("session-agent", "Parent", SessionState::Running)],
    );
    let harness = ToolHarness::open(Arc::clone(&database), repo.path(), "session-agent");

    let checks = harness
        .ask(json!({ "checks-run": { "command": "true" } }))
        .await;
    assert_eq!(checks["error"]["code"], "CHECKS_UNAVAILABLE");
    let unbounded = harness
        .ask(json!({ "checks-run": { "command": "true", "timeoutMs": 1_800_001 } }))
        .await;
    assert_eq!(unbounded["error"]["code"], "CHECK_TIMEOUT_INVALID");
    let spawned = harness.ask(json!({ "terminal-spawn": {} })).await;
    assert_eq!(spawned["error"]["code"], "TERMINAL_UNAVAILABLE");

    // The project's own list is consulted before the service is: a project
    // with no checks configured is the agent's problem to fix, not the app's.
    let unconfigured = harness.ask(json!({ "checks-run": {} })).await;
    assert_eq!(unconfigured["error"]["code"], "CHECKS_NOT_CONFIGURED");
}
