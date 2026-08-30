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
        sessions::{find_session_by_id, persist_session, PersistSessionInput},
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
                    default_provider: "codex".to_string(),
                    default_model_label: "GPT-5.6 Sol".to_string(),
                    default_model_id: String::new(),
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

    let response = tokio::task::spawn_blocking(move || {
        let mut stream = UnixStream::connect(socket).expect("connect control socket");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        // Let the nonblocking listener accept before the first write. On macOS,
        // accepted sockets inherit O_NONBLOCK, so the server must explicitly
        // restore blocking mode before reading the request.
        std::thread::sleep(Duration::from_millis(150));
        let request = json!({
            "version": 1,
            "token": token,
            "project": null,
            "prompt": "Summarize this repository quickly",
            "worktree": false,
        });
        writeln!(stream, "{request}").expect("write request");
        stream.shutdown(Shutdown::Write).expect("finish request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        serde_json::from_str::<serde_json::Value>(&response).expect("response json")
    })
    .await
    .expect("client task");

    assert_eq!(response["ok"], true, "launch response: {response}");
    assert_eq!(response["projectId"], "project-1");
    let session_id = response["sessionId"].as_str().expect("session id");
    let workspace_id = response["workspaceId"].as_str().expect("workspace id");
    {
        let connection = database.connection();
        let session = find_session_by_id(&connection, session_id).expect("launched session");
        let workspace =
            find_workspace_by_id(&connection, workspace_id).expect("launched workspace");
        assert_eq!(session.prompt, "Summarize this repository quickly");
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
