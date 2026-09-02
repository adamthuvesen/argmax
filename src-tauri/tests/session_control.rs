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
        events::{persist_timeline_event, PersistTimelineEventInput},
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
            ("session-parent", "workspace-parent", "complete"),
            ("session-child", "workspace-child", "running"),
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
                    state: state.to_string(),
                    attention: "normal".to_string(),
                },
            )
            .expect("session");
        }
        record_session_launch(&connection, "session-child", "session-parent", 1)
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
    let (server, registry) = SessionLaunchServer::bind().expect("bind control socket");
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
    let inbox = as_child(json!({ "inbox": {} })).await;
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
