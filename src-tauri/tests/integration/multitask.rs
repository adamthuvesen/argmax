//! Multitask: a chat dispatches a sibling session that runs alongside its own
//! turn, in the same checkout, and reports back without interrupting.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::support::git_repo::seed_git_repo;
use argmax_lib::sessions::state::SessionState;
use argmax_lib::{
    error::{ArgmaxError, ArgmaxResult},
    multitask::{
        dispatch, dispatch_queued, MultitaskRequest, FINISHED_EVENT, LAUNCHED_EVENT, MULTITASK_KIND,
    },
    persistence::{
        authorship::PromptAuthor,
        database::Database,
        events::list_session_events_since,
        pending_messages::{list_session_pending_messages, replace_session_queue},
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
        flush_queue::{DashboardDelta, PendingMessage},
        normalizer::ProviderOutputStream,
        runtime::{
            BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeEvent,
            ProviderRuntimeEventType, ProviderRuntimeHandle,
        },
        session_service::ProviderSessionService,
        ProviderId, ProviderLaunchInput, ReasoningEffort,
    },
    workspaces::WorkspaceService,
};

/// A launcher that never exits on its own, so a test decides when a turn ends.
#[derive(Default)]
struct ScriptedLauncher {
    launches: Mutex<Vec<ProviderLaunchInput>>,
    callbacks: Mutex<HashMap<String, EventCallback>>,
    /// When set, every launch fails the way a missing or broken CLI does.
    fail_launches: Mutex<bool>,
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
        let fails = *self.fail_launches.lock().expect("fail_launches poisoned");
        Box::pin(async move {
            if fails {
                return Err(ArgmaxError::service(
                    "PROVIDER_LAUNCH_FAILED",
                    "no such CLI",
                ));
            }
            Ok(Arc::new(IdleHandle) as Arc<dyn ProviderRuntimeHandle>)
        })
    }
}

impl ScriptedLauncher {
    fn fail_launches(&self) {
        *self.fail_launches.lock().expect("fail_launches poisoned") = true;
    }

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

    /// The way a Cursor turn ends: an assistant message and a `result/success`
    /// row, with the process left alive for the next prompt. There is no exit
    /// event at all, which is why this is its own seam.
    fn finish_cursor_turn(&self, session_id: &str, answer: &str) {
        let callback = self.callback(session_id);
        for line in [
            serde_json::json!({"type": "assistant", "message": {"content": [{"type": "text", "text": answer}]}}),
            serde_json::json!({"type": "result", "subtype": "success"}),
        ] {
            callback(ProviderRuntimeEvent {
                session_id: session_id.to_string(),
                r#type: ProviderRuntimeEventType::Output,
                stream: ProviderOutputStream::Stdout,
                message: format!("{line}\n"),
                exit_code: None,
                created_at: now_iso(),
            });
        }
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
    deltas: Arc<Mutex<Vec<DashboardDelta>>>,
    repo_path: String,
    _repo: crate::support::git_repo::SeededGitRepo,
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
                    archive_on_merge: false,
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
                state: SessionState::Running,
            },
        )
        .expect("session");
    }
    let launcher = Arc::new(ScriptedLauncher::default());
    let deltas = Arc::new(Mutex::new(Vec::new()));
    let published = Arc::clone(&deltas);
    let providers = ProviderSessionService::with_launcher(
        Arc::clone(&database),
        launcher.clone(),
        move |delta| published.lock().expect("deltas poisoned").push(delta),
    );
    let workspaces = WorkspaceService::with_publisher(Arc::clone(&database), |_| {});
    Fixture {
        database,
        workspaces,
        providers,
        launcher,
        deltas,
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
            queued_settings: None,
        },
        argmax_lib::persistence::authorship::PromptAuthor::unattested(),
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

async fn wait_for_state(database: &Database, session_id: &str, expected: SessionState) {
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
    let worktree_parent = std::path::Path::new(&worktree_path)
        .parent()
        .expect("worktree path has a parent");
    std::fs::create_dir_all(worktree_parent).expect("create worktree parent");
    crate::support::git_repo::run_git(
        fixture._repo.path(),
        &[
            "worktree",
            "add",
            "-b",
            "argmax/rewrite-auth",
            worktree_path.as_str(),
            "main",
        ],
    );
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
    assert_eq!(parent.state, SessionState::Running);
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
    // An open phone chat only rereads history when the host publishes a
    // change for that session. Persisting the notice alone needs a reopen.
    let deltas = fixture.deltas.lock().expect("deltas poisoned");
    assert!(deltas.iter().any(|delta| {
        delta.dashboard_changed
            && delta.events.iter().any(|event| {
                event.session_id == "session-parent"
                    && event.r#type == LAUNCHED_EVENT
                    && event.payload["childSessionId"].as_str() == Some(child_id.as_str())
            })
    }));
    drop(deltas);

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
    wait_for_state(&fixture.database, &child_id, SessionState::Complete).await;
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

/// Cursor ends a turn on `result/success` and keeps its process alive, so it
/// never reaches the exit handler every other provider reports back from.
#[tokio::test]
async fn a_cursor_multitask_reports_back_even_though_its_process_never_exits() {
    let fixture = fixture();
    {
        let connection = fixture.database.connection();
        connection
            .execute(
                "UPDATE sessions SET provider = 'cursor', model_id = 'composer-2.5', \
                 model_label = 'Composer 2.5 (Cursor)' WHERE id = 'session-parent'",
                [],
            )
            .expect("make the parent a Cursor chat");
    }
    let child_id = multitask(&fixture, "Do we have a semantic layer?", false).await;

    fixture
        .launcher
        .finish_cursor_turn(&child_id, "Yes, in models/4_semantic_models.");
    wait_for_state(&fixture.database, &child_id, SessionState::Complete).await;
    wait_for_event(&fixture.database, "session-parent", FINISHED_EVENT).await;

    // The row the chat draws, carrying what the multitask actually found.
    let connection = fixture.database.connection();
    let pending =
        list_undelivered_messages_of_kind(&connection, "session-parent", MULTITASK_KIND, 10)
            .expect("inbox");
    assert_eq!(pending.len(), 1);
    assert!(pending[0]
        .body
        .contains("Yes, in models/4_semantic_models."));
}

/// A multitask whose CLI never starts still ends this session's turn, and the
/// chat that dispatched it is owed that news: the row falls back to the finish
/// event once the failed session ages out of the snapshot, so without one it
/// would claim to be running for as long as the transcript lives.
#[tokio::test]
async fn a_multitask_that_cannot_start_still_reports_back() {
    let fixture = fixture();
    fixture.launcher.fail_launches();

    let child_id = dispatch(
        MultitaskRequest {
            parent_session_id: "session-parent".to_string(),
            prompt: "Fix the README typo".to_string(),
            worktree: false,
            task_label: None,
            queued_settings: None,
        },
        argmax_lib::persistence::authorship::PromptAuthor::unattested(),
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        Arc::clone(&fixture.providers),
    )
    .await
    .expect("dispatch survives a launch that fails")
    .session_id;

    wait_for_state(&fixture.database, &child_id, SessionState::Failed).await;
    wait_for_event(&fixture.database, "session-parent", FINISHED_EVENT).await;

    let connection = fixture.database.connection();
    let finished = list_session_events_since(&connection, "session-parent", None, None)
        .expect("list events")
        .events
        .into_iter()
        .find(|event| event.r#type == FINISHED_EVENT)
        .expect("a finish row in the parent");
    assert_eq!(finished.payload["state"], "failed");
    assert_eq!(finished.payload["childSessionId"], child_id);
}

#[tokio::test]
async fn queued_multitask_uses_the_claimed_prompt_and_deletes_its_queue_row() {
    let fixture = fixture();
    let message = PendingMessage {
        id: "pending-1".to_string(),
        session_id: "session-parent".to_string(),
        content: "Use the queued prompt".to_string(),
        agent_mode: "auto".to_string(),
        provider: None,
        model_label: None,
        model_id: None,
        reasoning_effort: None,
        fast_mode: false,
        attachments: Vec::new(),
        agent_references: Vec::new(),
        origin: None,
        recovery_status: None,
        queued_at: now_iso(),
        author: argmax_lib::persistence::authorship::PromptAuthor::unattested(),
    };
    {
        let mut connection = fixture.database.connection();
        replace_session_queue(
            &mut connection,
            "session-parent",
            &VecDeque::from([message]),
        )
        .expect("persist queue");
    }
    let providers = ProviderSessionService::with_launcher(
        Arc::clone(&fixture.database),
        fixture.launcher.clone(),
        |_| {},
    );

    let launched = dispatch_queued(
        MultitaskRequest {
            parent_session_id: "session-parent".to_string(),
            prompt: "stale renderer copy".to_string(),
            worktree: false,
            task_label: None,
            queued_settings: None,
        },
        "pending-1",
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        providers,
    )
    .await
    .expect("dispatch queued multitask");
    wait_for_launch(&fixture.launcher, &launched.session_id).await;
    assert!(fixture
        .launcher
        .prompt_for(&launched.session_id)
        .ends_with("Use the queued prompt"));
    let connection = fixture.database.connection();
    assert!(
        list_session_pending_messages(&connection, "session-parent")
            .expect("queue after launch")
            .is_empty(),
        "successful dispatch removes the hidden claim"
    );
}

/// Queue one row with the given settings on the parent, promote it to a
/// multitask, and return what the child was launched with.
async fn launch_queued_with(
    fixture: &Fixture,
    provider: Option<ProviderId>,
    model: Option<(&str, &str)>,
    reasoning_effort: Option<&str>,
    fast_mode: bool,
) -> ProviderLaunchInput {
    launch_queued_row(
        fixture,
        "Run this elsewhere",
        PromptAuthor::unattested(),
        None,
        RowSettings {
            provider,
            model,
            reasoning_effort,
            fast_mode,
        },
    )
    .await
}

/// The provider, model, effort and fast-mode choice a queued row was sent with.
#[derive(Default)]
struct RowSettings<'a> {
    provider: Option<ProviderId>,
    model: Option<(&'a str, &'a str)>,
    reasoning_effort: Option<&'a str>,
    fast_mode: bool,
}

/// The same, for a row with a given author and origin.
async fn launch_queued_row(
    fixture: &Fixture,
    content: &str,
    author: PromptAuthor,
    origin: Option<argmax_lib::providers::session_service::MessageOrigin>,
    RowSettings {
        provider,
        model,
        reasoning_effort,
        fast_mode,
    }: RowSettings<'_>,
) -> ProviderLaunchInput {
    let message = PendingMessage {
        id: "pending-1".to_string(),
        session_id: "session-parent".to_string(),
        content: content.to_string(),
        agent_mode: "auto".to_string(),
        provider,
        model_label: model.map(|(label, _)| label.to_string()),
        model_id: model.map(|(_, id)| id.to_string()),
        reasoning_effort: reasoning_effort.map(str::to_string),
        fast_mode,
        attachments: Vec::new(),
        agent_references: Vec::new(),
        origin,
        recovery_status: None,
        queued_at: now_iso(),
        author,
    };
    {
        let mut connection = fixture.database.connection();
        replace_session_queue(
            &mut connection,
            "session-parent",
            &VecDeque::from([message]),
        )
        .expect("persist queue");
    }
    let providers = ProviderSessionService::with_launcher(
        Arc::clone(&fixture.database),
        fixture.launcher.clone(),
        |_| {},
    );
    let launched = dispatch_queued(
        MultitaskRequest {
            parent_session_id: "session-parent".to_string(),
            prompt: "stale renderer copy".to_string(),
            worktree: false,
            task_label: None,
            queued_settings: None,
        },
        "pending-1",
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        providers,
    )
    .await
    .expect("dispatch queued multitask");
    wait_for_launch(&fixture.launcher, &launched.session_id).await;
    fixture
        .launcher
        .launches()
        .into_iter()
        .find(|launch| launch.session_id == launched.session_id)
        .expect("child launch")
}

#[tokio::test]
async fn queued_multitask_keeps_a_different_model_effort_and_fast_mode_on_the_same_provider() {
    let fixture = fixture();

    let launch = launch_queued_with(
        &fixture,
        None,
        Some(("Sonnet 5.5", "claude-sonnet-5-5")),
        Some("medium"),
        true,
    )
    .await;

    assert_eq!(launch.provider, ProviderId::Claude);
    assert_eq!(launch.model_id, "claude-sonnet-5-5");
    assert_eq!(launch.model_label, "Sonnet 5.5");
    assert_eq!(launch.reasoning_effort, Some(ReasoningEffort::Medium));
    assert!(launch.fast_mode);
    let connection = fixture.database.connection();
    let child = find_session_by_id(&connection, &launch.session_id).expect("child session");
    assert_eq!(child.model_id, "claude-sonnet-5-5");
}

#[tokio::test]
async fn queued_multitask_runs_on_the_provider_the_row_was_queued_for() {
    let fixture = fixture();

    let launch = launch_queued_with(
        &fixture,
        Some(ProviderId::Codex),
        Some(("GPT-6 Luna", "gpt-6-luna")),
        Some("high"),
        false,
    )
    .await;

    assert_eq!(launch.provider, ProviderId::Codex);
    assert_eq!(launch.model_id, "gpt-6-luna");
    assert_eq!(launch.reasoning_effort, Some(ReasoningEffort::High));
    assert!(!launch.fast_mode);
}

#[tokio::test]
async fn queued_multitask_without_settings_runs_as_the_parent_does() {
    let fixture = fixture();

    let launch = launch_queued_with(&fixture, None, None, None, false).await;

    assert_eq!(launch.provider, ProviderId::Claude);
    assert_eq!(launch.model_id, "claude-opus-5");
    assert_eq!(launch.reasoning_effort, Some(ReasoningEffort::High));
    assert!(!launch.fast_mode);
}

/// The opening prompt of a typed multitask is stored as the person's, but it
/// holds text Argmax adds from strings the parent chat's agent controls (its
/// task label and branch). A chat link there must not become a read grant; a
/// chip the person typed still does.
#[tokio::test]
async fn an_agent_set_label_cannot_smuggle_a_grant_into_a_typed_multitask() {
    let fixture = fixture();
    fixture
        .database
        .connection()
        .execute(
            "UPDATE workspaces SET task_label = '[x](argmax://chat/chat-x)' WHERE id = 'workspace-parent'",
            [],
        )
        .expect("rename the parent chat");

    let launched = dispatch(
        MultitaskRequest {
            parent_session_id: "session-parent".to_string(),
            prompt: "compare with [Billing](argmax://chat/chat-y?v=1)".to_string(),
            worktree: false,
            task_label: None,
            queued_settings: None,
        },
        PromptAuthor::person(argmax_lib::ipc::attest_person_for_tests()),
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        Arc::clone(&fixture.providers),
    )
    .await
    .expect("dispatch multitask");

    let grants = |target: &str| {
        argmax_lib::persistence::events::human_prompt_references_session(
            &fixture.database.connection(),
            &launched.session_id,
            target,
        )
        .expect("grant check")
    };
    assert!(!grants("chat-x"), "the agent-set label must grant nothing");
    assert!(grants("chat-y"), "the person's own chip still grants");
}

/// The child's opening prompt is a person's only when a person wrote it: typed
/// into the composer's Multitask, or queued by the person and then promoted.
/// An agent's queued message promoted by hand, and any prompt dispatched
/// without a person's mark, grants nothing.
#[tokio::test]
async fn a_multitask_child_opens_with_the_author_its_prompt_had() {
    let referenced = |text: &str| format!("{text} [x](argmax://chat/chat-x?v=1)");
    let grants = |fixture: &Fixture, child: &str| {
        argmax_lib::persistence::events::human_prompt_references_session(
            &fixture.database.connection(),
            child,
            "chat-x",
        )
        .expect("grant check")
    };
    let person = || PromptAuthor::person(argmax_lib::ipc::attest_person_for_tests());

    // Typed into the composer's Multitask.
    for (author, expected) in [(person(), true), (PromptAuthor::unattested(), false)] {
        let fixture = fixture();
        let launched = dispatch(
            MultitaskRequest {
                parent_session_id: "session-parent".to_string(),
                prompt: referenced("typed"),
                worktree: false,
                task_label: None,
                queued_settings: None,
            },
            author,
            Arc::clone(&fixture.database),
            Arc::clone(&fixture.workspaces),
            Arc::clone(&fixture.providers),
        )
        .await
        .expect("dispatch multitask");
        assert_eq!(grants(&fixture, &launched.session_id), expected, "typed");
    }

    // A queued row keeps its author when it is promoted.
    let origin = argmax_lib::providers::session_service::MessageOrigin {
        session_id: "session-sender".to_string(),
        label: "Sender".to_string(),
        kind: "message".to_string(),
        message_id: None,
    };
    for (author, origin, expected) in [
        (person(), None, true),
        (PromptAuthor::unattested(), Some(origin), false),
    ] {
        let fixture = fixture();
        let launch = launch_queued_row(
            &fixture,
            &referenced("queued"),
            author,
            origin,
            RowSettings::default(),
        )
        .await;
        assert_eq!(grants(&fixture, &launch.session_id), expected, "queued");
    }
}

#[tokio::test]
async fn queued_multitask_restores_its_claim_when_dispatch_is_refused() {
    let fixture = fixture();
    let message = PendingMessage {
        id: "pending-1".to_string(),
        session_id: "session-parent".to_string(),
        content: "Keep this queued".to_string(),
        agent_mode: "auto".to_string(),
        provider: None,
        model_label: None,
        model_id: None,
        reasoning_effort: None,
        fast_mode: false,
        attachments: Vec::new(),
        agent_references: Vec::new(),
        origin: None,
        recovery_status: None,
        queued_at: now_iso(),
        author: argmax_lib::persistence::authorship::PromptAuthor::unattested(),
    };
    {
        let mut connection = fixture.database.connection();
        replace_session_queue(
            &mut connection,
            "session-parent",
            &VecDeque::from([message]),
        )
        .expect("persist queue");
        connection
            .execute(
                "UPDATE workspaces SET state = 'archiving' WHERE id = 'workspace-parent'",
                [],
            )
            .expect("archive workspace");
    }
    let providers = ProviderSessionService::with_launcher(
        Arc::clone(&fixture.database),
        fixture.launcher.clone(),
        |_| {},
    );

    let error = dispatch_queued(
        MultitaskRequest {
            parent_session_id: "session-parent".to_string(),
            prompt: "Keep this queued".to_string(),
            worktree: false,
            task_label: None,
            queued_settings: None,
        },
        "pending-1",
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        Arc::clone(&providers),
    )
    .await
    .expect_err("archived workspace rejects dispatch");
    assert!(matches!(
        error,
        ArgmaxError::ServiceError { ref sub_code, .. }
            if sub_code == "MULTITASK_WORKSPACE_ARCHIVED"
    ));
    assert_eq!(
        providers.pending_messages_snapshot()["session-parent"][0].content,
        "Keep this queued"
    );
    let connection = fixture.database.connection();
    assert_eq!(
        list_session_pending_messages(&connection, "session-parent")
            .expect("restored queue")
            .len(),
        1
    );
}

#[tokio::test]
async fn the_result_rides_on_the_parents_next_prompt_but_not_on_the_persisted_message() {
    let fixture = fixture();
    let child_id = multitask(&fixture, "Fix the README typo", false).await;
    fixture
        .launcher
        .finish_turn(&child_id, "Fixed the typo in README.md.");
    wait_for_state(&fixture.database, &child_id, SessionState::Complete).await;
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
