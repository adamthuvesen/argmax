//! Arc timeline and starting an Arc from an existing chat: the rows each write
//! point records, and what a promotion changes.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::support::git_repo::seed_git_repo;
use argmax_lib::sessions::state::SessionState;
use argmax_lib::{
    arcs::{launch_coordinator, promote_session, LaunchCoordinatorRequest, PromoteSessionRequest},
    error::{ArgmaxError, ArgmaxResult},
    ipc::inputs::{ProvidersLaunchInput, TerminalCols, TerminalRows},
    ipc::validation::{NonEmptyString, Prompt, WorkspaceId},
    persistence::{
        arc_events::{list_arc_timeline, ArcEventKind, ArcTimelineEvent},
        arcs::{
            create_arc, get_arc, set_arc_state, update_arc, ArcCreateInput, ArcState,
            ArcUpdateInput,
        },
        database::Database,
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        session_messages::session_message_exists,
        sessions::{
            find_session_by_id, persist_session, record_session_launch, PersistSessionInput,
        },
        time::now_iso,
        workspaces::{persist_workspace, PersistWorkspaceInput},
    },
    providers::{
        normalizer::ProviderOutputStream,
        runtime::{
            BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeEvent,
            ProviderRuntimeEventType, ProviderRuntimeHandle,
        },
        session_service::ProviderSessionService,
        PermissionMode, ProviderId, ProviderLaunchInput,
    },
    workspaces::WorkspaceService,
};
use serde_json::json;

#[derive(Default)]
struct ScriptedLauncher {
    callbacks: Mutex<HashMap<String, EventCallback>>,
    prompts: Mutex<HashMap<String, Vec<String>>>,
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
        self.prompts
            .lock()
            .expect("prompts poisoned")
            .entry(input.session_id.clone())
            .or_default()
            .push(input.prompt);
        Box::pin(async { Ok(Arc::new(IdleHandle) as Arc<dyn ProviderRuntimeHandle>) })
    }
}

impl ScriptedLauncher {
    async fn wait_for(&self, session_id: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while !self
            .callbacks
            .lock()
            .expect("callbacks poisoned")
            .contains_key(session_id)
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "{session_id} never launched"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn prompts_for(&self, session_id: &str) -> Vec<String> {
        self.prompts
            .lock()
            .expect("prompts poisoned")
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    /// One assistant answer, then a clean exit.
    fn finish_turn(&self, session_id: &str, answer: &str) {
        let callback = self
            .callbacks
            .lock()
            .expect("callbacks poisoned")
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| panic!("no callback for {session_id}"));
        callback(ProviderRuntimeEvent {
            session_id: session_id.to_string(),
            r#type: ProviderRuntimeEventType::Output,
            stream: ProviderOutputStream::Stdout,
            message: format!("{}\n", json!({"type": "assistant", "text": answer})),
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
    app_data_dir: tempfile::TempDir,
    _repo: crate::support::git_repo::SeededGitRepo,
}

fn fixture() -> Fixture {
    let repo = seed_git_repo(&[("README.md", "# argmax\n")]);
    let repo_path = repo.path().display().to_string();
    let database = Arc::new(Database::open_in_memory().expect("database"));
    persist_project(
        &database.connection(),
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
        app_data_dir: tempfile::tempdir().expect("app data dir"),
        _repo: repo,
    }
}

fn timeline(fixture: &Fixture, arc_id: &str) -> Vec<ArcTimelineEvent> {
    list_arc_timeline(&fixture.database.connection(), arc_id, None, 200)
        .expect("timeline")
        .events
}

fn kinds(events: &[ArcTimelineEvent]) -> Vec<ArcEventKind> {
    events.iter().map(|event| event.kind).collect()
}

fn seed_chat(fixture: &Fixture, session_id: &str, workspace_state: &str, state: SessionState) {
    let connection = fixture.database.connection();
    persist_workspace(
        &connection,
        &PersistWorkspaceInput {
            id: format!("workspace-{session_id}"),
            project_id: "project-1".to_string(),
            task_label: format!("Chat {session_id}"),
            branch: "main".to_string(),
            base_ref: "main".to_string(),
            path: fixture.repo_path.clone(),
            state: workspace_state.to_string(),
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
            provider: "claude".to_string(),
            model_label: "Sonnet 5".to_string(),
            model_id: "claude-sonnet-5".to_string(),
            reasoning_effort: None,
            permission_mode: Some("auto-approve".to_string()),
            agent_mode: Some("auto".to_string()),
            prompt: "Build the pricing page".to_string(),
            state,
        },
    )
    .expect("session");
}

#[tokio::test]
async fn an_arc_records_its_story_newest_first_and_pages_without_overlap() {
    let fixture = fixture();
    let arc = create_arc(
        &fixture.database.connection(),
        fixture.app_data_dir.path(),
        &ArcCreateInput {
            name: "Pricing rollout".to_string(),
            brief: "Ship the new tiers.".to_string(),
            home_project_id: "project-1".to_string(),
            dir: None,
        },
    )
    .expect("arc");

    let arc = launch_coordinator(
        LaunchCoordinatorRequest {
            arc_id: arc.id.clone(),
            provider: ProviderId::Claude,
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            permission_mode: PermissionMode::ProviderDefaults,
        },
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.workspaces),
        Arc::clone(&fixture.providers),
    )
    .await
    .expect("coordinator");
    let coordinator = arc.coordinator_session_id.clone().expect("coordinator id");

    seed_chat(&fixture, "member-host", "running", SessionState::Complete);
    let member = fixture
        .providers
        .launch(ProvidersLaunchInput {
            workspace_id: WorkspaceId::try_from("workspace-member-host".to_string()).unwrap(),
            provider: ProviderId::Claude,
            prompt: Prompt::try_from("Build the pricing page".to_string()).unwrap(),
            model_label: NonEmptyString::try_from("Sonnet 5".to_string()).unwrap(),
            model_id: NonEmptyString::try_from("claude-sonnet-5".to_string()).unwrap(),
            reasoning_effort: None,
            fast_mode: false,
            agent_mode: None,
            permission_mode: None,
            cols: serde_json::from_value::<TerminalCols>(json!(120)).unwrap(),
            rows: serde_json::from_value::<TerminalRows>(json!(32)).unwrap(),
            attachments: None,
            goal_condition: None,
            goal_max_turns: None,
            arc_id: Some(arc.id.clone()),
            arc_is_coordinator_launch: false,
        })
        .await
        .expect("member launch");

    fixture.launcher.wait_for(&member.id).await;
    fixture.launcher.finish_turn(
        &member.id,
        "Built the pricing page.\n\nLearnings for the arc: run npm test.",
    );

    fixture.launcher.wait_for(&coordinator).await;
    std::fs::write(
        std::path::Path::new(&arc.dir).join("NOTES.md"),
        "# Pricing rollout\n\n## Done\n- pricing page\n",
    )
    .expect("notes");
    fixture.launcher.finish_turn(
        &coordinator,
        "Recorded the pricing page as done.\n\nNext: checkout.",
    );
    // A coordinator turn that wrote nothing down leaves no row.
    fixture.launcher.finish_turn(&coordinator, "Noted.");

    update_arc(
        &fixture.database.connection(),
        &arc.id,
        &ArcUpdateInput {
            name: None,
            brief: Some("Ship the new tiers, then retire the old ones.".to_string()),
        },
    )
    .expect("brief");
    set_arc_state(&fixture.database.connection(), &arc.id, ArcState::Paused).expect("pause");

    let events = timeline(&fixture, &arc.id);
    assert_eq!(
        kinds(&events),
        vec![
            ArcEventKind::StateChanged,
            ArcEventKind::BriefUpdated,
            ArcEventKind::NotesUpdated,
            ArcEventKind::MemberFinished,
            ArcEventKind::MemberLaunched,
            ArcEventKind::CoordinatorStarted,
            ArcEventKind::Created,
        ]
    );
    assert_eq!(events[0].title, "Paused");
    let notes = &events[2];
    assert_eq!(notes.status.as_deref(), Some("+3 −0"));
    assert_eq!(notes.title, "Pricing rollout");
    assert_eq!(
        notes.detail.as_deref(),
        Some("Recorded the pricing page as done.")
    );
    let finished = &events[3];
    assert_eq!(finished.status.as_deref(), Some("complete"));
    assert_eq!(finished.detail.as_deref(), Some("Built the pricing page."));
    assert!(finished.session_available);
    assert_eq!(finished.project_name.as_deref(), Some("Argmax"));
    assert_eq!(events[5].title, "Coordinator started");

    let first = list_arc_timeline(&fixture.database.connection(), &arc.id, None, 3).unwrap();
    assert_eq!(first.events.len(), 3);
    let cursor = first.next_cursor.expect("more pages");
    let rest =
        list_arc_timeline(&fixture.database.connection(), &arc.id, Some(&cursor), 10).unwrap();
    assert_eq!(rest.events.len(), 4);
    assert!(rest.next_cursor.is_none());
    let mut ids: Vec<_> = first
        .events
        .iter()
        .chain(rest.events.iter())
        .map(|e| e.id.clone())
        .collect();
    ids.dedup();
    assert_eq!(ids.len(), 7, "pages neither overlap nor skip");
}

#[tokio::test]
async fn starting_an_arc_from_a_chat_points_it_at_the_chat_and_brings_its_live_children() {
    let fixture = fixture();
    seed_chat(&fixture, "chat", "complete", SessionState::Complete);
    seed_chat(&fixture, "child-live", "complete", SessionState::Complete);
    seed_chat(
        &fixture,
        "child-archived",
        "archived",
        SessionState::Complete,
    );
    {
        let connection = fixture.database.connection();
        record_session_launch(&connection, "child-live", "chat", 1, "agent").unwrap();
        record_session_launch(&connection, "child-archived", "chat", 1, "agent").unwrap();
    }

    let arc = promote_session(
        PromoteSessionRequest {
            session_id: "chat".to_string(),
            name: "Pricing rollout".to_string(),
            brief: "Ship the new tiers.".to_string(),
            dir: None,
        },
        fixture.app_data_dir.path(),
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.providers),
    )
    .await
    .expect("promote");

    assert_eq!(arc.coordinator_session_id.as_deref(), Some("chat"));
    {
        let connection = fixture.database.connection();
        assert_eq!(
            get_arc(&connection, &arc.id).unwrap().home_project_id,
            "project-1"
        );
        let arc_of = |id: &str| find_session_by_id(&connection, id).unwrap().arc_id;
        assert_eq!(arc_of("chat").as_deref(), Some(arc.id.as_str()));
        assert_eq!(arc_of("child-live").as_deref(), Some(arc.id.as_str()));
        assert_eq!(
            arc_of("child-archived"),
            None,
            "an archived child stays out"
        );
        assert!(session_message_exists(&connection, &format!("arc:{}:promoted", arc.id)).unwrap());
    }
    let events = timeline(&fixture, &arc.id);
    assert_eq!(
        kinds(&events),
        vec![
            ArcEventKind::MemberLaunched,
            ArcEventKind::CoordinatorStarted,
            ArcEventKind::Created,
        ]
    );
    assert_eq!(events[0].status.as_deref(), Some("adopted"));
    assert_eq!(events[1].title, "Started from an existing chat");

    fixture.launcher.wait_for("chat").await;
    let told = fixture.launcher.prompts_for("chat").join("\n");
    assert!(told.contains("This chat now coordinates Arc \"Pricing rollout\""));
    assert!(told.contains("The one session you launched earlier is now a member"));

    let again = promote_session(
        PromoteSessionRequest {
            session_id: "chat".to_string(),
            name: "Twice".to_string(),
            brief: "Again.".to_string(),
            dir: None,
        },
        fixture.app_data_dir.path(),
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.providers),
    )
    .await;
    assert!(
        matches!(again, Err(ArgmaxError::ServiceError { ref sub_code, .. }) if sub_code == "ARC_SESSION_IN_ARC")
    );
}

#[tokio::test]
async fn a_chat_mid_turn_cannot_start_an_arc() {
    let fixture = fixture();
    seed_chat(&fixture, "busy", "running", SessionState::Running);
    let result = promote_session(
        PromoteSessionRequest {
            session_id: "busy".to_string(),
            name: "Pricing rollout".to_string(),
            brief: "Ship the new tiers.".to_string(),
            dir: None,
        },
        fixture.app_data_dir.path(),
        Arc::clone(&fixture.database),
        Arc::clone(&fixture.providers),
    )
    .await;
    assert!(
        matches!(result, Err(ArgmaxError::ServiceError { ref sub_code, .. }) if sub_code == "ARC_SESSION_BUSY")
    );
    let count: i64 = fixture
        .database
        .connection()
        .query_row("SELECT COUNT(*) FROM arcs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0, "nothing is created for a refused promotion");
}
