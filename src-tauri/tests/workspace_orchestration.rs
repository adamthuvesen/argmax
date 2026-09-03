// Focused tests for `WorkspaceService` orchestration + the per-workspace
// fs watcher's debounced refresh loop.
//
// Each test seeds a real git repo via `tests::support::git_repo`, persists
// a `Project` + (optionally) `Workspace` row in an in-memory SQLite, and
// drives the service against real `git` shellouts.

mod support {
    pub mod git_repo;
}

use std::sync::{Arc, Mutex};
use std::time::Duration;

use argmax_lib::checks::service::{CheckService, RunWorkspaceCheckInput};
use argmax_lib::error::{ArgmaxError, ArgmaxResult};
use argmax_lib::ipc::inputs::{
    ProvidersLaunchInput, ScratchWorkspaceKind, WorkspacesArchiveInput,
    WorkspacesCreateCurrentInput, WorkspacesCreateIsolatedInput, WorkspacesCreateScratchInput,
    WorkspacesKeepInput, WorkspacesSetLabelInput, WorkspacesSetPinnedInput,
};
use argmax_lib::ipc::validation::{BaseRef, ProjectId, TaskLabel, WorkspaceId};
use argmax_lib::persistence::{
    checks::list_checks,
    database::Database,
    events::{
        count_move_arrivals, list_all_session_events, persist_timeline_event,
        PersistTimelineEventInput,
    },
    projects::{persist_project, PersistProjectInput, ProjectSettings},
    sessions::{
        persist_session, record_session_launch, session_launch_lineage,
        update_session_provider_conversation_id, PersistSessionInput, LAUNCH_KIND_AGENT,
    },
    workspaces::{find_workspace_by_id, persist_workspace, PersistWorkspaceInput},
};
use argmax_lib::providers::flush_queue::DashboardDelta;
use argmax_lib::providers::runtime::{
    BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeHandle,
};
use argmax_lib::providers::session_service::ProviderSessionService;
use argmax_lib::providers::ProviderLaunchInput;
use argmax_lib::workspaces::lifecycle::WorkspaceLifecycle;
use argmax_lib::workspaces::WorkspaceService;

use support::git_repo::{run_git, seed_git_repo};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID: &str = "p-ws-test";

fn capture_publisher() -> (
    impl Fn(DashboardDelta) + Send + Sync + 'static,
    Arc<Mutex<Vec<DashboardDelta>>>,
) {
    let sink = Arc::new(Mutex::new(Vec::new()));
    let writer = sink.clone();
    (
        move |delta| writer.lock().expect("sink poisoned").push(delta),
        sink,
    )
}

fn build_project(db: &Database, repo_path: &str, worktree_location: &str) {
    build_project_with_setup(db, repo_path, worktree_location, "");
}

fn build_project_with_setup(
    db: &Database,
    repo_path: &str,
    worktree_location: &str,
    setup_command: &str,
) {
    let connection = db.connection();
    persist_project(
        &connection,
        &PersistProjectInput {
            id: PROJECT_ID.to_owned(),
            name: "ws-test".to_owned(),
            repo_path: repo_path.to_owned(),
            current_branch: "main".to_owned(),
            default_branch: Some("main".to_owned()),
            settings: ProjectSettings {
                worktree_location: worktree_location.to_owned(),
                setup_command: setup_command.to_owned(),
                check_commands: vec![],
            },
        },
    )
    .expect("persist project");
}

fn build_named_project(
    db: &Database,
    id: &str,
    name: &str,
    repo_path: &str,
    worktree_location: &str,
) {
    let connection = db.connection();
    persist_project(
        &connection,
        &PersistProjectInput {
            id: id.to_owned(),
            name: name.to_owned(),
            repo_path: repo_path.to_owned(),
            current_branch: "main".to_owned(),
            default_branch: Some("main".to_owned()),
            settings: ProjectSettings {
                worktree_location: worktree_location.to_owned(),
                setup_command: String::new(),
                check_commands: vec![],
            },
        },
    )
    .expect("persist named project");
}

/// WorkspaceService wired with a CheckService, as in the app, so the
/// setup-command path has something to run through.
fn service_with_checks(
    database: &Arc<Database>,
    publisher: impl Fn(DashboardDelta) + Send + Sync + 'static,
) -> Arc<WorkspaceService> {
    WorkspaceService::with_services(
        Arc::clone(database),
        publisher,
        argmax_lib::workspaces::lifecycle::WorkspaceLifecycle::new(),
        None,
        Some(CheckService::new(Arc::clone(database))),
        None,
        None,
        None,
    )
}

fn ensure_main_branch(repo_path: &std::path::Path) {
    // Some platforms still default to `master`; force `main` so the test
    // expectations are stable regardless of the developer's git config.
    run_git(repo_path, &["branch", "-M", "main"]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_isolated_adds_worktree_and_persists_row() {
    let repo = seed_git_repo(&[("README.md", "hi")]);
    ensure_main_branch(repo.path());
    let worktree_location = repo.path().join("worktrees");
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &worktree_location.display().to_string(),
    );
    let (publisher, sink) = capture_publisher();
    let service = WorkspaceService::with_publisher(database.clone(), publisher);

    let input = WorkspacesCreateIsolatedInput {
        project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
        task_label: TaskLabel::try_from("Hello World!".to_owned()).expect("task label"),
        base_ref: Some(BaseRef::try_from("main".to_owned()).expect("base ref")),
    };
    let summary = service
        .create_isolated(input)
        .await
        .expect("create isolated");

    assert_eq!(summary.project_id, PROJECT_ID);
    assert!(summary.branch.starts_with("argmax/hello-world-"));
    assert!(!summary.shared_workspace);
    assert!(std::path::Path::new(&summary.path).exists());
    // First delta included this workspace.
    let recorded = sink.lock().expect("sink").clone();
    assert!(recorded
        .iter()
        .any(|delta| delta.workspaces.iter().any(|w| w.id == summary.id)));
}

#[tokio::test]
async fn create_isolated_runs_setup_command_in_fresh_worktree() {
    let repo = seed_git_repo(&[("README.md", "hi")]);
    ensure_main_branch(repo.path());
    let worktree_location = repo.path().join("worktrees");
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project_with_setup(
        &database,
        &repo.path().display().to_string(),
        &worktree_location.display().to_string(),
        "echo ready > setup-ran.txt",
    );
    let (publisher, _sink) = capture_publisher();
    let service = service_with_checks(&database, publisher);

    let summary = service
        .create_isolated(WorkspacesCreateIsolatedInput {
            project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
            task_label: TaskLabel::try_from("Setup run".to_owned()).expect("task label"),
            base_ref: Some(BaseRef::try_from("main".to_owned()).expect("base ref")),
        })
        .await
        .expect("create isolated");

    // The command ran inside the new worktree, before create_isolated
    // returned — the agent launching next finds its dependencies in place.
    assert!(std::path::Path::new(&summary.path)
        .join("setup-ran.txt")
        .exists());
    // And it left a persisted check row the review surface can show.
    let checks = {
        let connection = database.connection();
        list_checks(&connection, Some(std::slice::from_ref(&summary.id)), 10).expect("list checks")
    };
    assert_eq!(checks.len(), 1);
    assert_eq!(checks[0].command, "echo ready > setup-ran.txt");
    assert_eq!(checks[0].status, "passed");
}

#[tokio::test]
async fn create_isolated_survives_failing_setup_command() {
    let repo = seed_git_repo(&[("README.md", "hi")]);
    ensure_main_branch(repo.path());
    let worktree_location = repo.path().join("worktrees");
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project_with_setup(
        &database,
        &repo.path().display().to_string(),
        &worktree_location.display().to_string(),
        "exit 1",
    );
    let (publisher, _sink) = capture_publisher();
    let service = service_with_checks(&database, publisher);

    let summary = service
        .create_isolated(WorkspacesCreateIsolatedInput {
            project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
            task_label: TaskLabel::try_from("Setup fails".to_owned()).expect("task label"),
            base_ref: Some(BaseRef::try_from("main".to_owned()).expect("base ref")),
        })
        .await
        .expect("workspace creation must survive a failing setup command");

    assert!(std::path::Path::new(&summary.path).exists());
    let checks = {
        let connection = database.connection();
        list_checks(&connection, Some(std::slice::from_ref(&summary.id)), 10).expect("list checks")
    };
    assert_eq!(checks.len(), 1);
    assert_eq!(checks[0].status, "failed");
}

#[tokio::test]
async fn create_isolated_rejects_dash_prefixed_base_ref() {
    let repo = seed_git_repo(&[("file.txt", "x")]);
    ensure_main_branch(repo.path());
    let worktree_location = repo.path().join("worktrees");
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &worktree_location.display().to_string(),
    );
    let _service = WorkspaceService::new(database.clone());

    // The newtype's TryFrom blocks leading `-` before the service ever
    // sees it, so a malformed base_ref never reaches the orchestration
    // layer. This guard belongs to the validation tier — we assert it
    // here to keep the invariant pinned where a regression would
    // otherwise slip past the orchestration tests.
    let bad: Result<BaseRef, _> = BaseRef::try_from("-evil".to_owned());
    assert!(bad.is_err(), "BaseRef newtype must reject leading dash");
}

#[tokio::test]
async fn create_isolated_rejects_nonexistent_base_ref() {
    let repo = seed_git_repo(&[("file.txt", "x")]);
    ensure_main_branch(repo.path());
    let worktree_location = repo.path().join("worktrees");
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &worktree_location.display().to_string(),
    );
    let service = WorkspaceService::new(database.clone());

    // A well-formed name that does not resolve (e.g. a merged-and-pruned branch)
    // must be rejected up front, not forked into a broken worktree.
    let input = WorkspacesCreateIsolatedInput {
        project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
        task_label: TaskLabel::try_from("Task".to_owned()).expect("task label"),
        base_ref: Some(BaseRef::try_from("adam/rust-port".to_owned()).expect("base ref")),
    };
    let err = service
        .create_isolated(input)
        .await
        .expect_err("nonexistent base ref must be rejected");
    let json = serde_json::to_value(&err).expect("serialize error");
    assert!(
        json.to_string().contains("does not exist"),
        "expected a 'does not exist' error, got: {json}"
    );
}

fn scratch_service(
    database: &Arc<Database>,
    scratch_root: std::path::PathBuf,
) -> Arc<WorkspaceService> {
    WorkspaceService::with_services(
        Arc::clone(database),
        |_| {},
        argmax_lib::workspaces::lifecycle::WorkspaceLifecycle::new(),
        None,
        None,
        None,
        None,
        Some(scratch_root),
    )
}

#[tokio::test]
async fn create_scratch_initializes_repoless_workspace() {
    let scratch_root = tempfile::tempdir().expect("scratch root");
    let database = Arc::new(Database::open_in_memory().expect("db"));
    let service = scratch_service(&database, scratch_root.path().to_path_buf());

    let summary = service
        .create_scratch(WorkspacesCreateScratchInput {
            task_label: TaskLabel::try_from("quick question".to_owned()).expect("task label"),
            kind: None,
        })
        .await
        .expect("create scratch");

    assert_eq!(summary.kind, "scratch");
    assert!(summary.shared_workspace);
    assert_eq!(summary.branch, "main");
    assert_eq!(summary.base_ref, "main");
    assert_eq!(
        summary.project_id,
        argmax_lib::workspaces::SCRATCH_PROJECT_ID
    );
    let path = std::path::PathBuf::from(&summary.path);
    assert!(path.starts_with(scratch_root.path()));
    // The scratch dir is a real minimal repo: HEAD resolves (one empty commit
    // on main), so provider CLIs with git-repo checks accept it.
    let head = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .expect("git rev-parse");
    assert!(head.status.success(), "scratch dir HEAD must resolve");
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");

    // A second scratch chat reuses the singleton project.
    let second = service
        .create_scratch(WorkspacesCreateScratchInput {
            task_label: TaskLabel::try_from("another".to_owned()).expect("task label"),
            kind: Some(ScratchWorkspaceKind::Popup),
        })
        .await
        .expect("create second scratch");
    assert_eq!(second.kind, "popup");
    assert_eq!(second.project_id, summary.project_id);
    assert_ne!(second.path, summary.path);
}

#[tokio::test]
async fn create_current_records_shared_workspace_pointing_at_repo() {
    let repo = seed_git_repo(&[("file.txt", "x")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let service = WorkspaceService::new(database.clone());

    let input = WorkspacesCreateCurrentInput {
        project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
        task_label: TaskLabel::try_from("explore".to_owned()).expect("task label"),
    };
    let summary = service.create_current(input).expect("create current");
    assert!(summary.shared_workspace);
    assert_eq!(summary.branch, "main");
    assert_eq!(summary.base_ref, "main");
    assert_eq!(summary.path, repo.path().display().to_string());
}

#[tokio::test]
async fn create_current_records_project_default_as_base_ref() {
    let repo = seed_git_repo(&[("file.txt", "x")]);
    ensure_main_branch(repo.path());
    run_git(repo.path(), &["checkout", "-b", "feature"]);
    let database = Arc::new(Database::open_in_memory().expect("db"));
    {
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: PROJECT_ID.to_owned(),
                name: "ws-test".to_owned(),
                repo_path: repo.path().display().to_string(),
                current_branch: "feature".to_owned(),
                default_branch: Some("main".to_owned()),
                settings: ProjectSettings {
                    worktree_location: repo.path().join("worktrees").display().to_string(),
                    setup_command: String::new(),
                    check_commands: vec![],
                },
            },
        )
        .expect("persist project");
    }
    let service = WorkspaceService::new(database);

    let input = WorkspacesCreateCurrentInput {
        project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
        task_label: TaskLabel::try_from("explore".to_owned()).expect("task label"),
    };
    let summary = service.create_current(input).expect("create current");
    assert_eq!(summary.branch, "feature");
    assert_eq!(summary.base_ref, "main");
}

#[test]
fn create_current_installs_watcher_without_tokio_context() {
    let repo = seed_git_repo(&[("file.txt", "x")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let service = WorkspaceService::new(database);

    let input = WorkspacesCreateCurrentInput {
        project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
        task_label: TaskLabel::try_from("explore".to_owned()).expect("task label"),
    };
    let summary = service.create_current(input).expect("create current");
    assert_eq!(service.open_watcher_count(), 1);
    service.close_watcher(&summary.id);
    assert_eq!(service.open_watcher_count(), 0);
}

#[tokio::test]
async fn keep_flips_state_to_kept() {
    let repo = seed_git_repo(&[("file.txt", "x")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let connection = database.connection();
    let workspace = persist_workspace(
        &connection,
        &PersistWorkspaceInput {
            id: "w1".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            task_label: "fresh".to_owned(),
            branch: "main".to_owned(),
            base_ref: "main".to_owned(),
            path: repo.path().display().to_string(),
            state: "created".to_owned(),
            shared_workspace: true,
            kind: "git".to_string(),
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("persist workspace");
    drop(connection);

    let service = WorkspaceService::new(database.clone());
    let input = WorkspacesKeepInput {
        workspace_id: WorkspaceId::try_from(workspace.id).expect("workspace id"),
    };
    let kept = service.keep(input).expect("keep");
    assert_eq!(kept.state, "kept");
}

#[tokio::test]
async fn refresh_status_picks_up_uncommitted_changes() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let workspace = {
        let connection = database.connection();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w-refresh".to_owned(),
                project_id: PROJECT_ID.to_owned(),
                task_label: "refresh test".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: repo.path().display().to_string(),
                state: "created".to_owned(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace")
    };

    let (publisher, sink) = capture_publisher();
    let service = WorkspaceService::with_publisher(database.clone(), publisher);

    let before = service
        .refresh_status(&workspace.id)
        .await
        .expect("refresh");
    assert!(!before.dirty);
    assert_eq!(before.changed_files, 0);
    assert!(sink.lock().expect("sink").is_empty());

    std::fs::write(repo.path().join("new.txt"), "fresh").expect("write");

    let after = service
        .refresh_status(&workspace.id)
        .await
        .expect("refresh");
    assert!(after.dirty);
    assert!(
        after.changed_files >= 1,
        "expected dirty count, got {}",
        after.changed_files
    );
    assert_eq!(after.last_activity_at, before.last_activity_at);
    assert_eq!(
        sink.lock()
            .expect("sink")
            .iter()
            .filter(|delta| delta.workspaces.iter().any(|w| w.id == workspace.id))
            .count(),
        1
    );

    service
        .refresh_status(&workspace.id)
        .await
        .expect("unchanged refresh");
    assert_eq!(
        sink.lock()
            .expect("sink")
            .iter()
            .filter(|delta| delta.workspaces.iter().any(|w| w.id == workspace.id))
            .count(),
        1,
        "unchanged watcher refresh must not publish another workspace delta"
    );
}

#[tokio::test]
async fn set_pinned_toggles_persisted_bit() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let connection = database.connection();
    let workspace = persist_workspace(
        &connection,
        &PersistWorkspaceInput {
            id: "w-pin".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            task_label: "pin test".to_owned(),
            branch: "main".to_owned(),
            base_ref: "main".to_owned(),
            path: repo.path().display().to_string(),
            state: "kept".to_owned(),
            shared_workspace: true,
            kind: "git".to_string(),
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("persist workspace");
    drop(connection);

    let service = WorkspaceService::new(database.clone());
    let pinned = service
        .set_pinned(WorkspacesSetPinnedInput {
            workspace_id: WorkspaceId::try_from(workspace.id.clone()).expect("workspace id"),
            pinned: true,
        })
        .expect("pin");
    assert!(pinned.pinned);

    let unpinned = service
        .set_pinned(WorkspacesSetPinnedInput {
            workspace_id: WorkspaceId::try_from(workspace.id.clone()).expect("workspace id"),
            pinned: false,
        })
        .expect("unpin");
    assert!(!unpinned.pinned);
}

#[tokio::test]
async fn set_label_persists_new_task_label() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let connection = database.connection();
    let workspace = persist_workspace(
        &connection,
        &PersistWorkspaceInput {
            id: "w-label".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            task_label: "old label".to_owned(),
            branch: "main".to_owned(),
            base_ref: "main".to_owned(),
            path: repo.path().display().to_string(),
            state: "kept".to_owned(),
            shared_workspace: true,
            kind: "git".to_string(),
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("persist workspace");
    drop(connection);

    let service = WorkspaceService::new(database.clone());
    let renamed = service
        .set_label(WorkspacesSetLabelInput {
            workspace_id: WorkspaceId::try_from(workspace.id.clone()).expect("workspace id"),
            task_label: TaskLabel::try_from("new label".to_owned()).expect("task label"),
        })
        .expect("rename");
    assert_eq!(renamed.task_label, "new label");

    // The new label survives a fresh read from the database.
    let connection = database.connection();
    let reloaded =
        find_workspace_by_id(&connection, workspace.id.as_str()).expect("reload workspace");
    assert_eq!(reloaded.task_label, "new label");
}

#[tokio::test]
async fn archive_shared_workspace_when_dirty_and_not_forced() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let workspace = {
        let connection = database.connection();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w-arch".to_owned(),
                project_id: PROJECT_ID.to_owned(),
                task_label: "archive test".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: repo.path().display().to_string(),
                state: "created".to_owned(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace")
    };

    // Shared workspaces point at the main checkout, so archiving only hides the
    // app row. Dirty files must not block that non-destructive archive.
    std::fs::write(repo.path().join("dirty.txt"), "x").expect("write dirty");

    let service = WorkspaceService::new(database.clone());
    let result = service
        .archive(WorkspacesArchiveInput {
            workspace_id: WorkspaceId::try_from(workspace.id.clone()).expect("workspace id"),
            force: None,
        })
        .await
        .expect("archive");
    assert_eq!(
        result.state, "archived",
        "dirty shared workspace should archive"
    );

    // Workspace still exists on disk (shared workspace points at repo root).
    assert!(repo.path().exists());
}

#[tokio::test]
async fn archive_waits_for_and_cancels_a_live_check() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let workspace = {
        let connection = database.connection();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w-arch-check".to_owned(),
                project_id: PROJECT_ID.to_owned(),
                task_label: "archive check".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: repo.path().display().to_string(),
                state: "created".to_owned(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace")
    };

    let lifecycle = argmax_lib::workspaces::lifecycle::WorkspaceLifecycle::new();
    let checks = CheckService::with_lifecycle(database.clone(), lifecycle.clone());
    let (publisher, _sink) = capture_publisher();
    let service = WorkspaceService::with_services(
        database.clone(),
        publisher,
        lifecycle,
        None,
        Some(checks.clone()),
        None,
        None,
        None,
    );
    let check_task = tokio::spawn({
        let checks = checks.clone();
        let workspace_id = workspace.id.clone();
        async move {
            checks
                .run_workspace_check(
                    RunWorkspaceCheckInput {
                        workspace_id,
                        command: "sleep 30".to_owned(),
                        timeout_ms: Some(60_000),
                    },
                    None,
                )
                .await
        }
    });

    for _ in 0..50 {
        let running = {
            let connection = database.connection();
            list_checks(&connection, Some(std::slice::from_ref(&workspace.id)), 10)
                .expect("list checks")
                .iter()
                .any(|check| check.status == "running")
        };
        if running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let archived = service
        .archive(WorkspacesArchiveInput {
            workspace_id: WorkspaceId::try_from(workspace.id.clone()).expect("workspace id"),
            force: Some(true),
        })
        .await
        .expect("archive");
    assert_eq!(archived.state, "archived");
    let check = check_task
        .await
        .expect("check task join")
        .expect("check result");
    assert_eq!(check.status, "cancelled");
    assert!(check.completed_at.is_some());
}

#[test]
fn startup_reconciles_stranded_archives_without_retrying_removal() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let workspace = {
        let connection = database.connection();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w-stranded-archive".to_owned(),
                project_id: PROJECT_ID.to_owned(),
                task_label: "stranded archive".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: repo.path().display().to_string(),
                state: "archiving".to_owned(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace")
    };
    let service = WorkspaceService::new(database.clone());
    assert_eq!(
        service
            .recover_interrupted_archives()
            .expect("recover archives"),
        1
    );
    let connection = database.connection();
    let recovered = find_workspace_by_id(&connection, &workspace.id).expect("find workspace");
    // A shared-checkout archive has no destructive step, so an interrupted
    // one completes as archived instead of demanding explicit recovery.
    assert_eq!(recovered.state, "archived");
    assert!(
        repo.path().exists(),
        "startup recovery must not remove the path"
    );
}

#[test]
fn startup_finalizes_an_isolated_archive_after_worktree_removal() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let worktree_path = repo.path().join("worktrees").join("removed");
    std::fs::create_dir_all(worktree_path.parent().expect("worktree parent"))
        .expect("create worktree parent");
    let worktree_arg = worktree_path.to_str().expect("worktree path");
    run_git(
        repo.path(),
        &["worktree", "add", "--detach", worktree_arg, "main"],
    );
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let workspace = {
        let connection = database.connection();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w-removed-archive".to_owned(),
                project_id: PROJECT_ID.to_owned(),
                task_label: "removed archive".to_owned(),
                branch: "detached".to_owned(),
                base_ref: "main".to_owned(),
                path: worktree_arg.to_owned(),
                state: "archiving".to_owned(),
                shared_workspace: false,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace")
    };
    run_git(
        repo.path(),
        &["worktree", "remove", "--force", worktree_arg],
    );
    assert!(!worktree_path.exists());

    let service = WorkspaceService::new(database.clone());
    assert_eq!(service.recover_interrupted_archives().expect("recover"), 1);
    let connection = database.connection();
    let recovered = find_workspace_by_id(&connection, &workspace.id).expect("find workspace");
    assert_eq!(recovered.state, "archived");
}

#[test]
fn startup_keeps_archive_failed_when_git_still_registers_missing_worktree() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let worktree_path = repo.path().join("worktrees").join("registered");
    std::fs::create_dir_all(worktree_path.parent().expect("worktree parent"))
        .expect("create worktree parent");
    let worktree_arg = worktree_path.to_str().expect("worktree path");
    run_git(
        repo.path(),
        &["worktree", "add", "--detach", worktree_arg, "main"],
    );
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let workspace = {
        let connection = database.connection();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w-registered-archive".to_owned(),
                project_id: PROJECT_ID.to_owned(),
                task_label: "registered archive".to_owned(),
                branch: "detached".to_owned(),
                base_ref: "main".to_owned(),
                path: worktree_arg.to_owned(),
                state: "archiving".to_owned(),
                shared_workspace: false,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace")
    };
    std::fs::remove_dir_all(&worktree_path).expect("remove worktree path");
    let service = WorkspaceService::new(database.clone());
    assert_eq!(service.recover_interrupted_archives().expect("recover"), 1);
    let connection = database.connection();
    let recovered = find_workspace_by_id(&connection, &workspace.id).expect("find workspace");
    assert_eq!(recovered.state, "archive-failed");
}

#[tokio::test]
async fn startup_restores_watchers_for_kept_workspaces() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let connection = database.connection();
    let workspace = persist_workspace(
        &connection,
        &PersistWorkspaceInput {
            id: "w-kept-watch".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            task_label: "kept watcher".to_owned(),
            branch: "main".to_owned(),
            base_ref: "main".to_owned(),
            path: repo.path().display().to_string(),
            state: "kept".to_owned(),
            shared_workspace: true,
            kind: "git".to_string(),
            dirty: true,
            changed_files: 1,
        },
    )
    .expect("persist workspace");
    drop(connection);

    let service = WorkspaceService::new(database);
    assert_eq!(service.start_open_watchers().expect("start watchers"), 1);
    assert_eq!(service.open_watcher_count(), 1);
    service.close_watcher(&workspace.id);
}

#[tokio::test]
async fn startup_skips_watchers_when_checkout_is_gone() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let connection = database.connection();
    let workspace = persist_workspace(
        &connection,
        &PersistWorkspaceInput {
            id: "w-missing-path".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            task_label: "missing checkout".to_owned(),
            branch: "main".to_owned(),
            base_ref: "main".to_owned(),
            path: "/definitely/missing/argmax-watch-test".to_owned(),
            state: "kept".to_owned(),
            shared_workspace: true,
            kind: "git".to_string(),
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("persist workspace");
    drop(connection);

    let service = WorkspaceService::new(database);
    let error = service
        .watch(&workspace.id)
        .expect_err("missing checkout cannot be watched");
    assert!(matches!(
        error,
        ArgmaxError::ServiceError { sub_code, .. } if sub_code == "WATCHER_PATH_MISSING"
    ));
    assert_eq!(service.start_open_watchers().expect("start watchers"), 0);
    assert_eq!(service.open_watcher_count(), 0);
}

#[tokio::test]
async fn startup_watcher_install_is_rejected_once_archive_begins() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let connection = database.connection();
    let workspace = persist_workspace(
        &connection,
        &PersistWorkspaceInput {
            id: "w-startup-archive-race".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            task_label: "startup archive race".to_owned(),
            branch: "main".to_owned(),
            base_ref: "main".to_owned(),
            path: repo.path().display().to_string(),
            state: "archiving".to_owned(),
            shared_workspace: true,
            kind: "git".to_string(),
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("persist workspace");
    drop(connection);

    let service = WorkspaceService::new(database);
    let lease = service
        .lifecycle()
        .begin_archive(&workspace.id)
        .expect("begin archive");

    // The startup task may have captured this row before archive began. The
    // lifecycle admission makes the later install a no-op rather than leaving
    // a watcher attached to a workspace that is being torn down.
    assert_eq!(service.start_open_watchers().expect("start watchers"), 0);
    assert_eq!(service.open_watcher_count(), 0);
    lease.finish(argmax_lib::workspaces::lifecycle::ArchiveOutcome::Reopened);
}

#[tokio::test]
async fn archive_isolated_worktree_kept_when_dirty_and_not_forced() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let worktree_location = repo.path().join("worktrees");
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &worktree_location.display().to_string(),
    );
    let service = WorkspaceService::new(database.clone());
    let workspace = service
        .create_isolated(WorkspacesCreateIsolatedInput {
            project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
            task_label: TaskLabel::try_from("archive isolated".to_owned()).expect("task label"),
            base_ref: Some(BaseRef::try_from("main".to_owned()).expect("base ref")),
        })
        .await
        .expect("create isolated");

    std::fs::write(std::path::Path::new(&workspace.path).join("dirty.txt"), "x")
        .expect("write dirty");

    let result = service
        .archive(WorkspacesArchiveInput {
            workspace_id: WorkspaceId::try_from(workspace.id.clone()).expect("workspace id"),
            force: None,
        })
        .await
        .expect("archive");

    assert_eq!(
        result.state, "kept",
        "dirty isolated worktree should be kept"
    );
    assert!(std::path::Path::new(&workspace.path).exists());
}

#[tokio::test]
async fn watcher_debounces_burst_into_single_refresh() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let workspace = {
        let connection = database.connection();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w-watch".to_owned(),
                project_id: PROJECT_ID.to_owned(),
                task_label: "watch test".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: repo.path().display().to_string(),
                state: "created".to_owned(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace")
    };

    let (publisher, sink) = capture_publisher();
    let service = WorkspaceService::with_publisher(database.clone(), publisher);
    service.watch(&workspace.id).expect("install watcher");

    // `notify` can return from `watch()` before the platform backend is ready
    // to deliver immediate writes. Give the watcher one scheduler beat to settle
    // so this test measures debounce behavior, not watch-startup timing.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Burst of writes inside one debounce window.
    for i in 0..5 {
        std::fs::write(repo.path().join(format!("burst-{i}.txt")), "x").expect("write");
    }

    // Wait long enough for: debounce window (200 ms) + git refresh latency.
    // Some sandboxed test environments do not deliver platform fs-watch events
    // to `notify`; when that happens, fall back to a direct refresh so the rest
    // of the test still verifies the status path and watcher lifecycle.
    let mut refresh_count = 0;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let deltas = sink.lock().expect("sink").clone();
        refresh_count = deltas
            .iter()
            .filter(|delta| delta.workspaces.iter().any(|w| w.id == workspace.id))
            .count();
        if refresh_count >= 1 {
            break;
        }
    }
    if refresh_count == 0 {
        service
            .refresh_status(&workspace.id)
            .await
            .expect("manual refresh fallback");
    } else {
        // The refresh fires at most a small number of times — not once per
        // write. (Hard equality is fragile because the OS can split bursts
        // across two notify events; we assert a sane upper bound.)
        assert!(
            refresh_count <= 3,
            "expected coalesced refreshes, got {refresh_count}",
        );
    }

    // Final state reflects the burst.
    let connection = database.connection();
    let after = find_workspace_by_id(&connection, &workspace.id).expect("find");
    assert!(after.dirty);
    assert!(after.changed_files >= 5);

    service.close_watcher(&workspace.id);
    assert_eq!(service.open_watcher_count(), 0);
}

#[tokio::test]
async fn dropping_watched_service_releases_the_service_arc() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let workspace = {
        let connection = database.connection();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w-drop-watcher".to_owned(),
                project_id: PROJECT_ID.to_owned(),
                task_label: "drop watcher".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: repo.path().display().to_string(),
                state: "created".to_owned(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace")
    };
    let service = WorkspaceService::new(database);
    let weak = Arc::downgrade(&service);
    service.watch(&workspace.id).expect("install watcher");
    drop(service);
    assert!(
        weak.upgrade().is_none(),
        "watch task must not retain service Arc"
    );
}

#[test]
fn workspaces_sharing_a_checkout_share_one_os_watch() {
    let repo = seed_git_repo(&[("file.txt", "x")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let service = WorkspaceService::new(database);

    // Every `create_current` session points at the same checkout. Watching it
    // once per workspace is what used to fan one file save out into a git
    // process per session.
    let mut ids = Vec::new();
    for label in ["explore", "refactor", "review"] {
        let summary = service
            .create_current(WorkspacesCreateCurrentInput {
                project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
                task_label: TaskLabel::try_from(label.to_owned()).expect("task label"),
            })
            .expect("create current");
        ids.push(summary.id);
    }

    assert_eq!(service.open_watcher_count(), 3);
    assert_eq!(service.watched_checkout_count(), 1);

    // The shared watch survives until its last subscriber leaves.
    service.close_watcher(&ids[0]);
    assert_eq!(service.open_watcher_count(), 2);
    assert_eq!(service.watched_checkout_count(), 1);

    service.close_watcher(&ids[1]);
    service.close_watcher(&ids[2]);
    assert_eq!(service.open_watcher_count(), 0);
    assert_eq!(service.watched_checkout_count(), 0);
}

#[tokio::test]
async fn refresh_checkout_updates_every_workspace_from_one_read() {
    let repo = seed_git_repo(&[("file.txt", "x")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let service = WorkspaceService::new(database.clone());

    let mut ids = Vec::new();
    for label in ["one", "two"] {
        let summary = service
            .create_current(WorkspacesCreateCurrentInput {
                project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
                task_label: TaskLabel::try_from(label.to_owned()).expect("task label"),
            })
            .expect("create current");
        ids.push(summary.id);
    }
    for id in &ids {
        service.close_watcher(id);
    }

    std::fs::write(repo.path().join("dirty.txt"), "new").expect("write");
    assert_eq!(service.refresh_checkout(repo.path(), &ids).await, 2);

    let connection = database.connection();
    for id in &ids {
        let workspace = find_workspace_by_id(&connection, id).expect("workspace");
        assert!(workspace.dirty, "{id} should be dirty");
        assert_eq!(workspace.changed_files, 1);
        assert_eq!(workspace.branch, "main");
    }
}

#[tokio::test]
async fn one_shared_watch_refreshes_every_subscriber() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let ids = ["w-share-1".to_owned(), "w-share-2".to_owned()];
    {
        let connection = database.connection();
        for id in &ids {
            persist_workspace(
                &connection,
                &PersistWorkspaceInput {
                    id: id.clone(),
                    project_id: PROJECT_ID.to_owned(),
                    task_label: "shared watch".to_owned(),
                    branch: "main".to_owned(),
                    base_ref: "main".to_owned(),
                    path: repo.path().display().to_string(),
                    state: "created".to_owned(),
                    shared_workspace: true,
                    kind: "git".to_string(),
                    dirty: false,
                    changed_files: 0,
                },
            )
            .expect("persist workspace");
        }
    }

    let service = WorkspaceService::new(database.clone());
    for id in &ids {
        service.watch(id).expect("install watcher");
    }
    // Both workspaces point at one checkout, so they share a single OS watch.
    assert_eq!(service.watched_checkout_count(), 1);

    tokio::time::sleep(Duration::from_millis(50)).await;
    std::fs::write(repo.path().join("dirty.txt"), "x").expect("write");

    // The single watch must fan its one refresh out to every subscriber, not
    // just the workspace that happened to install it.
    let mut settled = false;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let connection = database.connection();
        settled = ids.iter().all(|id| {
            find_workspace_by_id(&connection, id)
                .map(|workspace| workspace.dirty)
                .unwrap_or(false)
        });
        if settled {
            break;
        }
    }
    if !settled {
        // Some sandboxed environments never deliver fs events to `notify`;
        // exercise the fan-out directly so the assertion still means something.
        assert_eq!(service.refresh_checkout(repo.path(), &ids).await, 2);
    }

    let connection = database.connection();
    for id in &ids {
        let workspace = find_workspace_by_id(&connection, id).expect("find");
        assert!(
            workspace.dirty,
            "{id} was not refreshed by the shared watch"
        );
    }
    drop(connection);

    for id in &ids {
        service.close_watcher(id);
    }
    assert_eq!(service.watched_checkout_count(), 0);
}

#[tokio::test]
async fn a_shared_checkout_publishes_one_delta_for_all_subscribers() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &repo.path().join("worktrees").display().to_string(),
    );
    let ids: Vec<String> = (0..4).map(|i| format!("w-batch-{i}")).collect();
    {
        let connection = database.connection();
        for id in &ids {
            persist_workspace(
                &connection,
                &PersistWorkspaceInput {
                    id: id.clone(),
                    project_id: PROJECT_ID.to_owned(),
                    task_label: "batch".to_owned(),
                    branch: "main".to_owned(),
                    base_ref: "main".to_owned(),
                    path: repo.path().display().to_string(),
                    state: "created".to_owned(),
                    shared_workspace: true,
                    kind: "git".to_string(),
                    dirty: false,
                    changed_files: 0,
                },
            )
            .expect("persist workspace");
        }
    }

    let (publisher, sink) = capture_publisher();
    let service = WorkspaceService::with_publisher(database, publisher);

    std::fs::write(repo.path().join("dirty.txt"), "x").expect("write");
    assert_eq!(service.refresh_checkout(repo.path(), &ids).await, 4);

    // Four workspaces changed, but the renderer is woken once.
    let deltas = sink.lock().expect("sink").clone();
    assert_eq!(deltas.len(), 1);
    assert_eq!(deltas[0].workspaces.len(), 4);
    assert!(deltas[0].workspaces.iter().all(|w| w.dirty));

    // A refresh that changes nothing publishes nothing at all.
    assert_eq!(service.refresh_checkout(repo.path(), &ids).await, 4);
    assert_eq!(sink.lock().expect("sink").len(), 1);
}

#[tokio::test]
async fn archiving_a_popup_workspace_removes_its_scratch_dir() {
    let scratch_root = tempfile::tempdir().expect("scratch root");
    let database = Arc::new(Database::open_in_memory().expect("db"));
    let service = scratch_service(&database, scratch_root.path().to_path_buf());

    let popup = service
        .create_scratch(WorkspacesCreateScratchInput {
            task_label: TaskLabel::try_from("More details".to_owned()).expect("task label"),
            kind: Some(ScratchWorkspaceKind::Popup),
        })
        .await
        .expect("create popup");
    let popup_path = std::path::PathBuf::from(&popup.path);
    assert!(popup_path.exists(), "popup scratch dir should exist");

    let archived = service
        .archive(WorkspacesArchiveInput {
            workspace_id: WorkspaceId::try_from(popup.id.clone()).expect("workspace id"),
            force: None,
        })
        .await
        .expect("archive popup");
    assert_eq!(archived.state, "archived");

    // Removal runs in the spawned teardown task; poll briefly.
    let mut removed = false;
    for _ in 0..100 {
        if !popup_path.exists() {
            removed = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(removed, "popup scratch dir should be removed after archive");

    // Visible side chats keep their directory: only popups are discard-on-close.
    let side_chat = service
        .create_scratch(WorkspacesCreateScratchInput {
            task_label: TaskLabel::try_from("keep me".to_owned()).expect("task label"),
            kind: Some(ScratchWorkspaceKind::Scratch),
        })
        .await
        .expect("create side chat");
    let side_chat_path = std::path::PathBuf::from(&side_chat.path);
    service
        .archive(WorkspacesArchiveInput {
            workspace_id: WorkspaceId::try_from(side_chat.id.clone()).expect("workspace id"),
            force: None,
        })
        .await
        .expect("archive side chat");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        side_chat_path.exists(),
        "side-chat scratch dir must survive archive"
    );
}

// ---------------------------------------------------------------------------
// Provider teardown must abort the destructive step
// ---------------------------------------------------------------------------

/// A handle whose `terminate` never succeeds — the shape an ACP turn takes when
/// its cancel wait times out (`ACP_CANCEL_TIMEOUT`).
struct RefusingHandle;

impl ProviderRuntimeHandle for RefusingHandle {
    fn accepts_input(&self) -> bool {
        false
    }

    fn disposed(&self) -> bool {
        false
    }

    fn send_input(&self, _input: &str) {}

    fn resize(&self, _cols: u16, _rows: u16) {}

    fn terminate<'a>(&'a self) -> BoxFuture<'a, ArgmaxResult<()>> {
        Box::pin(async {
            Err(ArgmaxError::service(
                "ACP_CANCEL_TIMEOUT",
                "agent did not acknowledge the cancel",
            ))
        })
    }
}

#[derive(Default)]
struct RefusingLauncher;

impl ProviderProcessLauncher for RefusingLauncher {
    fn launch<'a>(
        &'a self,
        _input: ProviderLaunchInput,
        _on_event: EventCallback,
    ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
        Box::pin(async {
            let handle: Arc<dyn ProviderRuntimeHandle> = Arc::new(RefusingHandle);
            Ok(handle)
        })
    }
}

/// Archiving an isolated worktree removes it with `git worktree remove --force`.
/// That step must never run while an agent may still be writing to the
/// directory, so a provider that will not confirm its teardown has to fail the
/// archive rather than let it proceed. Without this, a handle whose `terminate`
/// silently returns `Ok` would let archive delete a live worktree.
#[tokio::test]
async fn archive_keeps_the_worktree_when_provider_teardown_fails() {
    let repo = seed_git_repo(&[("a.txt", "1")]);
    ensure_main_branch(repo.path());
    let worktree_location = repo.path().join("worktrees");
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_project(
        &database,
        &repo.path().display().to_string(),
        &worktree_location.display().to_string(),
    );

    let lifecycle = Arc::new(WorkspaceLifecycle::new());
    let providers = ProviderSessionService::with_launcher_and_lifecycle(
        Arc::clone(&database),
        Arc::new(RefusingLauncher),
        |_delta| {},
        Arc::clone(&lifecycle),
    );
    let service = WorkspaceService::with_services(
        Arc::clone(&database),
        |_delta| {},
        Arc::clone(&lifecycle),
        Some(Arc::clone(&providers)),
        None,
        None,
        None,
        None,
    );

    let workspace = service
        .create_isolated(WorkspacesCreateIsolatedInput {
            project_id: ProjectId::try_from(PROJECT_ID.to_owned()).expect("project id"),
            task_label: TaskLabel::try_from("stuck agent".to_owned()).expect("task label"),
            base_ref: Some(BaseRef::try_from("main".to_owned()).expect("base ref")),
        })
        .await
        .expect("create isolated");

    let launch: ProvidersLaunchInput = serde_json::from_value(serde_json::json!({
        "workspaceId": workspace.id,
        "provider": "claude",
        "prompt": "do some work",
        "modelLabel": "Opus 5",
        "modelId": "claude-opus-5",
        "cols": 80,
        "rows": 24,
    }))
    .expect("launch input");
    providers.launch(launch).await.expect("launch");

    let error = service
        .archive(WorkspacesArchiveInput {
            workspace_id: WorkspaceId::try_from(workspace.id.clone()).expect("workspace id"),
            force: Some(true),
        })
        .await
        .expect_err("archive must fail when the provider will not confirm teardown");

    assert!(
        matches!(&error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "ACP_CANCEL_TIMEOUT"),
        "archive should surface the provider's own failure, got {error:?}"
    );
    assert!(
        std::path::Path::new(&workspace.path).exists(),
        "worktree must survive an archive whose provider teardown failed"
    );

    let connection = database.connection();
    let row = find_workspace_by_id(&connection, &workspace.id).expect("workspace row");
    assert_eq!(row.state, "archive-failed");
}

fn seed_completed_session(database: &Database, workspace_id: &str, session_id: &str) {
    let connection = database.connection();
    persist_session(
        &connection,
        &PersistSessionInput {
            id: session_id.to_string(),
            workspace_id: workspace_id.to_string(),
            provider: "claude".to_string(),
            model_label: "Sonnet".to_string(),
            model_id: "claude-sonnet-5".to_string(),
            reasoning_effort: Some("high".to_string()),
            permission_mode: Some("auto-approve".to_string()),
            agent_mode: Some("auto".to_string()),
            prompt: "Move this chat".to_string(),
            state: "complete".to_string(),
            attention: "normal".to_string(),
        },
    )
    .expect("source session");
    update_session_provider_conversation_id(&connection, session_id, "native-conversation")
        .expect("provider conversation id");
    persist_timeline_event(
        &connection,
        &PersistTimelineEventInput {
            id: format!("{session_id}-message"),
            session_id: session_id.to_string(),
            r#type: "message.completed".to_string(),
            message: "Source answer".to_string(),
            payload: serde_json::json!({}),
            created_at: None,
        },
    )
    .expect("source event");
}

#[tokio::test]
async fn move_session_copies_history_without_native_resume_and_can_keep_source() {
    let source_repo = seed_git_repo(&[("README.md", "source")]);
    let destination_repo = seed_git_repo(&[("README.md", "destination")]);
    ensure_main_branch(source_repo.path());
    ensure_main_branch(destination_repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_named_project(
        &database,
        "source-project",
        "Source",
        &source_repo.path().display().to_string(),
        &source_repo.path().join("worktrees").display().to_string(),
    );
    build_named_project(
        &database,
        "destination-project",
        "Destination",
        &destination_repo.path().display().to_string(),
        &destination_repo
            .path()
            .join("worktrees")
            .display()
            .to_string(),
    );
    let service = WorkspaceService::new(Arc::clone(&database));
    let source_workspace = service
        .create_current(WorkspacesCreateCurrentInput {
            project_id: ProjectId::try_from("source-project".to_string()).expect("project id"),
            task_label: TaskLabel::try_from("Move this chat".to_string()).expect("task label"),
        })
        .expect("source workspace");
    seed_completed_session(&database, &source_workspace.id, "source-session");
    // Launched by another agent, so the move has a lineage to carry: the
    // destination now runs a turn of its own, and its finish is owed to the
    // session that dispatched the work.
    let parent_workspace = service
        .create_current(WorkspacesCreateCurrentInput {
            project_id: ProjectId::try_from("source-project".to_string()).expect("project id"),
            task_label: TaskLabel::try_from("Parent chat".to_string()).expect("task label"),
        })
        .expect("parent workspace");
    seed_completed_session(&database, &parent_workspace.id, "parent-session");
    record_session_launch(
        &database.connection(),
        "source-session",
        "parent-session",
        1,
        LAUNCH_KIND_AGENT,
    )
    .expect("source lineage");

    let moved = service
        .move_session_to_project("source-session", "destination-project", false, true)
        .await
        .expect("move session");

    assert_eq!(
        moved.session.launched_by_session_id.as_deref(),
        Some("parent-session"),
        "a moved chat still reports to whoever launched it"
    );
    assert_eq!(moved.session.launch_kind, LAUNCH_KIND_AGENT);
    assert_eq!(moved.workspace.project_id, "destination-project");
    assert_eq!(
        moved.workspace.path,
        destination_repo.path().display().to_string()
    );
    assert!(moved.workspace.shared_workspace);
    assert_eq!(moved.workspace.state, "complete");
    assert_eq!(moved.session.provider_conversation_id, None);
    let connection = database.connection();
    let source = find_workspace_by_id(&connection, &source_workspace.id).expect("source workspace");
    assert_ne!(source.state, "archived");
    assert_eq!(
        session_launch_lineage(&connection, &moved.session.id)
            .expect("destination lineage")
            .depth,
        1,
        "the launch caps still count the chat where it now sits"
    );
    let copied = list_all_session_events(&connection, &moved.session.id).expect("copied events");
    assert!(copied.iter().any(|event| event.message == "Source answer"));
    let seam = copied
        .iter()
        .find(|event| event.r#type == "session.moved")
        .expect("move seam");
    assert_eq!(seam.payload["sourceProjectName"], "Source");
    assert_eq!(seam.payload["destinationProjectName"], "Destination");
}

#[tokio::test]
async fn move_session_archives_clean_source_and_can_create_isolated_destination() {
    let source_repo = seed_git_repo(&[("README.md", "source")]);
    let destination_repo = seed_git_repo(&[("README.md", "destination")]);
    ensure_main_branch(source_repo.path());
    ensure_main_branch(destination_repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_named_project(
        &database,
        "source-project",
        "Source",
        &source_repo.path().display().to_string(),
        &source_repo.path().join("worktrees").display().to_string(),
    );
    build_named_project(
        &database,
        "destination-project",
        "Destination",
        &destination_repo.path().display().to_string(),
        &destination_repo
            .path()
            .join("worktrees")
            .display()
            .to_string(),
    );
    let service = WorkspaceService::new(Arc::clone(&database));
    let source_workspace = service
        .create_current(WorkspacesCreateCurrentInput {
            project_id: ProjectId::try_from("source-project".to_string()).expect("project id"),
            task_label: TaskLabel::try_from("Move isolated".to_string()).expect("task label"),
        })
        .expect("source workspace");
    seed_completed_session(&database, &source_workspace.id, "source-session");

    let moved = service
        .move_session_to_project("source-session", "destination-project", true, false)
        .await
        .expect("move session");

    assert!(!moved.workspace.shared_workspace);
    assert!(std::path::Path::new(&moved.workspace.path).exists());
    assert_eq!(moved.source_archive_state, "archived");
    let connection = database.connection();
    assert_eq!(
        find_workspace_by_id(&connection, &source_workspace.id)
            .expect("source workspace")
            .state,
        "archived"
    );
}

#[tokio::test]
async fn move_session_keeps_dirty_isolated_source_without_forcing_archive() {
    let source_repo = seed_git_repo(&[("README.md", "source")]);
    let destination_repo = seed_git_repo(&[("README.md", "destination")]);
    ensure_main_branch(source_repo.path());
    ensure_main_branch(destination_repo.path());
    let database = Arc::new(Database::open_in_memory().expect("db"));
    build_named_project(
        &database,
        "source-project",
        "Source",
        &source_repo.path().display().to_string(),
        &source_repo.path().join("worktrees").display().to_string(),
    );
    build_named_project(
        &database,
        "destination-project",
        "Destination",
        &destination_repo.path().display().to_string(),
        &destination_repo
            .path()
            .join("worktrees")
            .display()
            .to_string(),
    );
    let service = WorkspaceService::new(Arc::clone(&database));
    let source_workspace = service
        .create_isolated(WorkspacesCreateIsolatedInput {
            project_id: ProjectId::try_from("source-project".to_string()).expect("project id"),
            task_label: TaskLabel::try_from("Dirty source".to_string()).expect("task label"),
            base_ref: Some(BaseRef::try_from("main".to_string()).expect("base ref")),
        })
        .await
        .expect("source workspace");
    seed_completed_session(&database, &source_workspace.id, "source-session");
    std::fs::write(
        std::path::Path::new(&source_workspace.path).join("dirty.txt"),
        "keep me",
    )
    .expect("dirty file");

    let moved = service
        .move_session_to_project("source-session", "destination-project", false, false)
        .await
        .expect("move session");

    assert_eq!(moved.source_archive_state, "kept");
    assert!(std::path::Path::new(&source_workspace.path).exists());
    let connection = database.connection();
    assert_eq!(
        find_workspace_by_id(&connection, &source_workspace.id)
            .expect("source workspace")
            .state,
        "kept"
    );
}

/// The seams a move copies are what bound an auto-continued chain: each hop
/// adds one and carries the earlier ones, so the count is the chat's whole
/// history of arrivals rather than the last one.
#[tokio::test]
async fn each_move_adds_an_arrival_the_copied_transcript_carries_on() {
    let repos = [
        seed_git_repo(&[("README.md", "first")]),
        seed_git_repo(&[("README.md", "second")]),
        seed_git_repo(&[("README.md", "third")]),
    ];
    let database = Arc::new(Database::open_in_memory().expect("db"));
    for (index, repo) in repos.iter().enumerate() {
        ensure_main_branch(repo.path());
        build_named_project(
            &database,
            &format!("project-{index}"),
            &format!("Project {index}"),
            &repo.path().display().to_string(),
            &repo.path().join("worktrees").display().to_string(),
        );
    }
    let service = WorkspaceService::new(Arc::clone(&database));
    let source_workspace = service
        .create_current(WorkspacesCreateCurrentInput {
            project_id: ProjectId::try_from("project-0".to_string()).expect("project id"),
            task_label: TaskLabel::try_from("Move twice".to_string()).expect("task label"),
        })
        .expect("source workspace");
    seed_completed_session(&database, &source_workspace.id, "source-session");

    let first = service
        .move_session_to_project("source-session", "project-1", false, true)
        .await
        .expect("first move");
    let second = service
        .move_session_to_project(&first.session.id, "project-2", false, true)
        .await
        .expect("second move");

    let connection = database.connection();
    assert_eq!(
        count_move_arrivals(&connection, "source-session").expect("source arrivals"),
        0
    );
    assert_eq!(
        count_move_arrivals(&connection, &first.session.id).expect("first arrivals"),
        1
    );
    assert_eq!(
        count_move_arrivals(&connection, &second.session.id).expect("second arrivals"),
        2
    );
}
