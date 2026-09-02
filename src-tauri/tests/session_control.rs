#![cfg(unix)]

use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use argmax_lib::{
    error::ArgmaxResult,
    persistence::{
        database::Database,
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        sessions::{
            find_session_by_id, persist_session, record_session_launch, PersistSessionInput,
        },
        workspaces::{find_workspace_by_id, persist_workspace, PersistWorkspaceInput},
    },
    providers::{
        flush_queue::DashboardDelta,
        runtime::{BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeHandle},
        session_service::ProviderSessionService,
        AgentMode, PermissionMode, ProviderId, ProviderLaunchInput, ReasoningEffort,
    },
    session_control::{SessionLaunchServer, SESSION_LAUNCH_SOCKET_ENV, SESSION_LAUNCH_TOKEN_ENV},
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
                state: "running".to_string(),
                attention: "normal".to_string(),
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

    let (server, registry) = SessionLaunchServer::bind().expect("bind control socket");
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
    let launches = launcher.launches.lock().expect("launches poisoned");
    assert_eq!(launches.len(), 1);
    assert!(launches[0].fast_mode);
    assert_eq!(launches[0].permission_mode, PermissionMode::AutoApprove);
    assert_eq!(launches[0].agent_mode, AgentMode::Auto);
    drop(launches);

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
            "action": { "move": { "project": "Destination", "keepSource": true } },
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
    assert!(registry.has_pending_move("session-parent"));
    registry.settle_move("session-parent");
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
        if moved_count == 1 && !registry.has_pending_move("session-parent") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!registry.has_pending_move("session-parent"));
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
                state: "running".to_string(),
                attention: "normal".to_string(),
            },
        )
        .expect("parent session");
    }

    let launcher = Arc::new(RecordingLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    let (server, registry) = SessionLaunchServer::bind().expect("bind control socket");
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
                    state: "complete".to_string(),
                    attention: "normal".to_string(),
                },
            )
            .expect("child session");
            record_session_launch(
                &connection,
                &format!("session-child-{index}"),
                "session-parent",
                1,
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
