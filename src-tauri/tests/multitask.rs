//! Multitask: a chat dispatches a sibling session that runs alongside its own
//! turn, in the same checkout, and reports back without interrupting.

mod support;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use argmax_lib::{
    error::ArgmaxResult,
    multitask::{dispatch, MultitaskRequest, FINISHED_EVENT, LAUNCHED_EVENT, MULTITASK_KIND},
    persistence::{
        database::Database,
        events::list_session_events_since,
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        session_messages::list_undelivered_messages_of_kind,
        sessions::{
            find_session_by_id, persist_session, record_session_launch, session_launch_lineage,
            PersistSessionInput, LAUNCH_KIND_AGENT,
        },
        time::now_iso,
        workspaces::{find_workspace_by_id, persist_workspace, PersistWorkspaceInput},
    },
    providers::{
        normalizer::ProviderOutputStream,
        runtime::{
            BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeEvent,
            ProviderRuntimeEventType, ProviderRuntimeHandle,
        },
        session_service::ProviderSessionService,
        ProviderLaunchInput,
    },
    workspaces::WorkspaceService,
};
use support::git_repo::seed_git_repo;

/// A launcher that never exits on its own, so a test decides when a turn ends.
#[derive(Default)]
struct ScriptedLauncher {
    launches: Mutex<Vec<ProviderLaunchInput>>,
    callbacks: Mutex<HashMap<String, EventCallback>>,
}

struct IdleHandle;

impl ProviderRuntimeHandle for IdleHandle {
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

impl ProviderProcessLauncher for ScriptedLauncher {
    fn launch<'a>(
        &'a self,
        input: ProviderLaunchInput,
        on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
        self.callbacks
            .lock()
            .expect("callbacks poisoned")
            .insert(input.session_id.clone(), on_event);
        self.launches.lock().expect("launches poisoned").push(input);
        Box::pin(async { Ok(Arc::new(IdleHandle) as Arc<dyn ProviderRuntimeHandle>) })
    }
}

impl ScriptedLauncher {
    fn launches(&self) -> Vec<ProviderLaunchInput> {
        self.launches.lock().expect("launches poisoned").clone()
    }

    fn prompt_for(&self, session_id: &str) -> String {
        self.launches()
            .into_iter()
            .find(|launch| launch.session_id == session_id)
            .map(|launch| launch.prompt)
            .unwrap_or_else(|| panic!("no launch recorded for {session_id}"))
    }

    fn callback(&self, session_id: &str) -> EventCallback {
        self.callbacks
            .lock()
            .expect("callbacks poisoned")
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| panic!("no callback registered for {session_id}"))
    }

    /// One assistant answer, then a clean exit — the shape every turn ends in.
    fn finish_turn(&self, session_id: &str, answer: &str) {
        let callback = self.callback(session_id);
        callback(ProviderRuntimeEvent {
            session_id: session_id.to_string(),
            r#type: ProviderRuntimeEventType::Output,
            stream: ProviderOutputStream::Stdout,
            message: format!(
                "{}\n",
                serde_json::json!({"type": "assistant", "text": answer})
            ),
            exit_code: None,
            created_at: now_iso(),
        });
        callback(ProviderRuntimeEvent {
            session_id: session_id.to_string(),
            r#type: ProviderRuntimeEventType::Exit,
            stream: ProviderOutputStream::System,
            message: "Provider exited with code 0.".to_string(),
            exit_code: Some(0),
            created_at: now_iso(),
        });
    }
}

struct Fixture {
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    launcher: Arc<ScriptedLauncher>,
    repo_path: String,
    _repo: support::git_repo::SeededGitRepo,
}

/// A project with one running chat in its main checkout — the state a person is
/// in when they think of a small fix on the side.
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
                    worktree_location: format!("{repo_path}/.argmax/worktrees"),
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
                task_label: "Rewrite auth".to_string(),
                branch: "main".to_string(),
                base_ref: "main".to_string(),
                path: repo_path.clone(),
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
                id: "session-parent".to_string(),
                workspace_id: "workspace-parent".to_string(),
                provider: "claude".to_string(),
                model_label: "Opus 5".to_string(),
                model_id: "claude-opus-5".to_string(),
                reasoning_effort: Some("high".to_string()),
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "Rewrite auth".to_string(),
                state: "running".to_string(),
                attention: "normal".to_string(),
            },
        )
        .expect("session");
    }
    let launcher = Arc::new(ScriptedLauncher::default());
    let providers =
        ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    Fixture {
        database,
        workspaces,
        providers,
        launcher,
        repo_path,
        _repo: repo,
    }
}

async fn multitask(fixture: &Fixture, prompt: &str, worktree: bool) -> String {
    let session_id = dispatch(
        MultitaskRequest {
            parent_session_id: "session-parent".to_string(),
            prompt: prompt.to_string(),
            worktree,
            task_label: None,
        },
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        Arc::clone(&fixture.providers),
    )
    .await
    .expect("dispatch multitask")
    .session_id;
    wait_for_launch(&fixture.launcher, &session_id).await;
    session_id
}

fn events(database: &Database, session_id: &str) -> Vec<(String, String)> {
    let connection = database.connection();
    list_session_events_since(&connection, session_id, None, None)
        .expect("list events")
        .events
        .into_iter()
        .map(|event| (event.r#type, event.message))
        .collect()
}

/// The provider handle resolves after `launch` returns, so a test that wants
/// the launched prompt (or to end that turn) waits for the spawn to land.
async fn wait_for_launch(launcher: &ScriptedLauncher, session_id: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if launcher
            .launches()
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

async fn wait_for_state(database: &Database, session_id: &str, expected: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
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
            "timed out waiting for {session_id} to be {expected}, last saw {state}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_event(database: &Database, session_id: &str, event_type: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if events(database, session_id)
            .iter()
            .any(|(kind, _)| kind == event_type)
        {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for a {event_type} row on {session_id}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The parent is in a worktree, which is the app's headline case: its checkout
/// is not the project root, so "the same checkout" has to mean the parent's.
#[tokio::test]
async fn a_multitask_shares_the_parents_worktree_not_the_projects_checkout() {
    let fixture = fixture();
    let worktree_path = format!("{}/.argmax/worktrees/rewrite-auth", fixture.repo_path);
    {
        let connection = fixture.database.connection();
        connection
            .execute(
                "UPDATE workspaces SET path = ?, branch = ?, base_ref = ?, shared_workspace = 0 \
                 WHERE id = 'workspace-parent'",
                rusqlite::params![&worktree_path, "argmax/rewrite-auth", "main"],
            )
            .expect("point the parent at a worktree");
    }

    let child_id = multitask(&fixture, "Fix the README typo", false).await;

    let connection = fixture.database.connection();
    let child = find_session_by_id(&connection, &child_id).expect("child session");
    let child_workspace =
        find_workspace_by_id(&connection, &child.workspace_id).expect("child workspace");
    drop(connection);

    // The tree the person is looking at, on the branch the guardrail preamble
    // names. Taking the project's checkout put the fix on another branch
    // entirely while both agents were told they shared a tree.
    assert_eq!(child_workspace.path, worktree_path);
    assert_eq!(child_workspace.branch, "argmax/rewrite-auth");
    assert!(child_workspace.shared_workspace);
    let launch = fixture
        .launcher
        .launches()
        .into_iter()
        .find(|launch| launch.session_id == child_id)
        .expect("the child launched");
    assert!(
        launch.prompt.contains("argmax/rewrite-auth"),
        "the preamble names the branch the child is actually on: {}",
        launch.prompt
    );
}

#[tokio::test]
async fn a_multitask_runs_in_the_parents_checkout_without_touching_its_turn() {
    let fixture = fixture();
    let child_id = multitask(&fixture, "Fix the README typo", false).await;

    let connection = fixture.database.connection();
    let child = find_session_by_id(&connection, &child_id).expect("child session");
    let child_workspace =
        find_workspace_by_id(&connection, &child.workspace_id).expect("child workspace");
    let parent = find_session_by_id(&connection, "session-parent").expect("parent session");
    drop(connection);

    // Same tree, same branch: the whole point is a fix beside the work you are
    // already doing, not an isolated experiment.
    assert_eq!(child_workspace.path, fixture.repo_path);
    assert_eq!(child_workspace.branch, "main");
    assert!(child_workspace.shared_workspace);
    assert_eq!(
        child.launched_by_session_id.as_deref(),
        Some("session-parent")
    );
    assert_eq!(child_workspace.task_label, "Fix the README typo");
    // Inherited, so the side fix runs on the agent the person already chose.
    assert_eq!(child.provider, "claude");
    assert_eq!(child.model_id, "claude-opus-5");
    assert_eq!(child.reasoning_effort.as_deref(), Some("high"));

    // The parent keeps running: no state change, no second launch against it.
    assert_eq!(parent.state, "running");
    let launched_sessions: Vec<String> = fixture
        .launcher
        .launches()
        .into_iter()
        .map(|launch| launch.session_id)
        .collect();
    assert_eq!(launched_sessions, vec![child_id.clone()]);

    // The dispatch is anchored in the parent's timeline, which is what the
    // card in the chat hangs off.
    let parent_events = events(&fixture.database, "session-parent");
    assert!(parent_events
        .iter()
        .any(|(kind, message)| kind == LAUNCHED_EVENT && message.contains("Fix the README typo")));

    // The shared checkout is the dangerous part, so the prompt says so.
    let prompt = fixture.launcher.prompt_for(&child_id);
    assert!(prompt.contains("Rewrite auth"));
    assert!(prompt.contains("git stash"));
    assert!(prompt.ends_with("Fix the README typo"));
}

#[tokio::test]
async fn an_isolated_multitask_gets_its_own_worktree() {
    let fixture = fixture();
    let child_id = multitask(&fixture, "Try the risky refactor", true).await;

    let connection = fixture.database.connection();
    let child = find_session_by_id(&connection, &child_id).expect("child session");
    let workspace = find_workspace_by_id(&connection, &child.workspace_id).expect("workspace");
    drop(connection);

    assert_ne!(workspace.path, fixture.repo_path);
    assert!(!workspace.shared_workspace);
    // Nothing to collide with, so none of the shared-checkout warnings.
    assert_eq!(
        fixture.launcher.prompt_for(&child_id),
        "Try the risky refactor"
    );
}

#[tokio::test]
async fn a_finished_multitask_reports_back_without_starting_a_turn() {
    let fixture = fixture();
    let child_id = multitask(&fixture, "Fix the README typo", false).await;

    fixture
        .launcher
        .finish_turn(&child_id, "Fixed the typo in README.md.");
    wait_for_state(&fixture.database, &child_id, "complete").await;
    wait_for_event(&fixture.database, "session-parent", FINISHED_EVENT).await;

    let parent_events = events(&fixture.database, "session-parent");
    // The parent learns about it as a marker in its timeline...
    assert!(parent_events
        .iter()
        .any(|(kind, message)| kind == FINISHED_EVENT && message.contains("finished alongside")));
    // ...and never as a turn: no user message was injected, and the parent's
    // provider was never relaunched to be told.
    assert!(!parent_events.iter().any(|(kind, _)| kind == "user.message"));
    assert!(fixture
        .launcher
        .launches()
        .iter()
        .all(|launch| launch.session_id != "session-parent"));

    // The result waits in the inbox for the parent's next prompt.
    let connection = fixture.database.connection();
    let pending =
        list_undelivered_messages_of_kind(&connection, "session-parent", MULTITASK_KIND, 10)
            .expect("inbox");
    assert_eq!(pending.len(), 1);
    assert!(pending[0].body.contains("Fixed the typo in README.md."));
}

#[tokio::test]
async fn the_result_rides_on_the_parents_next_prompt_but_not_on_the_persisted_message() {
    let fixture = fixture();
    let child_id = multitask(&fixture, "Fix the README typo", false).await;
    fixture
        .launcher
        .finish_turn(&child_id, "Fixed the typo in README.md.");
    wait_for_state(&fixture.database, &child_id, "complete").await;
    wait_for_event(&fixture.database, "session-parent", FINISHED_EVENT).await;

    // The person then types their next message in the parent chat.
    fixture
        .providers
        .send_input(send_input("session-parent", "Now add tests"))
        .await
        .expect("send follow-up");
    wait_for_launch(&fixture.launcher, "session-parent").await;

    let prompt = fixture.launcher.prompt_for("session-parent");
    assert!(prompt.contains("ran alongside you"));
    assert!(prompt.contains("Fixed the typo in README.md."));
    assert!(prompt.contains("Now add tests"));

    // What the person sees in their own bubble is what they typed.
    let user_messages: Vec<String> = events(&fixture.database, "session-parent")
        .into_iter()
        .filter(|(kind, _)| kind == "user.message")
        .map(|(_, message)| message)
        .collect();
    assert_eq!(user_messages, vec!["Now add tests".to_string()]);

    // Told once: the row is delivered, so the next prompt is clean.
    let connection = fixture.database.connection();
    assert!(
        list_undelivered_messages_of_kind(&connection, "session-parent", MULTITASK_KIND, 10)
            .expect("inbox")
            .is_empty()
    );
}

#[tokio::test]
async fn a_multitask_starts_its_own_lineage_however_deep_the_parent_sits() {
    let fixture = fixture();
    {
        let connection = fixture.database.connection();
        // The parent is itself two agent launches deep — the last level an
        // agent may launch from.
        record_session_launch(
            &connection,
            "session-parent",
            "session-parent",
            2,
            LAUNCH_KIND_AGENT,
        )
        .expect("record parent lineage");
    }

    let child = multitask(&fixture, "Fix the changelog date", false).await;

    let connection = fixture.database.connection();
    let lineage = session_launch_lineage(&connection, &child).expect("lineage");
    // A person asked for this chat, so it is not another rung on the agent
    // ladder: it starts at the top and can still launch agents of its own.
    assert_eq!(lineage.depth, 0);
    assert_eq!(
        find_session_by_id(&connection, &child)
            .expect("child")
            .launched_by_session_id
            .as_deref(),
        Some("session-parent")
    );
}

#[tokio::test]
async fn multitasks_do_not_count_against_the_agent_launch_cap() {
    let fixture = fixture();
    for index in 0..3 {
        multitask(&fixture, &format!("Side fix {index}"), false).await;
    }

    let connection = fixture.database.connection();
    // The caps exist to stop an agent fanning out on its own. A person
    // dispatching work from their own chat is not that, so these do not count.
    let lineage = session_launch_lineage(&connection, "session-parent").expect("lineage");
    assert_eq!(lineage.launched, 0);

    // An agent launch on the same parent still does.
    record_session_launch(
        &connection,
        "session-parent",
        "session-parent",
        1,
        LAUNCH_KIND_AGENT,
    )
    .expect("record agent launch");
    assert_eq!(
        session_launch_lineage(&connection, "session-parent")
            .expect("lineage")
            .launched,
        1
    );
}

fn send_input(session_id: &str, input: &str) -> argmax_lib::ipc::inputs::ProvidersSendInput {
    serde_json::from_value(serde_json::json!({
        "sessionId": session_id,
        "input": input,
        "fastMode": false,
    }))
    .expect("send input")
}
