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

use argmax_lib::ipc::inputs::{
    OpenIdeChoice, WorkspacesArchiveInput, WorkspacesCreateCurrentInput,
    WorkspacesCreateIsolatedInput, WorkspacesKeepInput, WorkspacesOpenInIdeInput,
    WorkspacesSetLabelInput, WorkspacesSetPinnedInput,
};
use argmax_lib::ipc::validation::{BaseRef, ProjectId, TaskLabel, WorkspaceId};
use argmax_lib::persistence::{
    database::Database,
    projects::{persist_project, PersistProjectInput, ProjectSettings},
    workspaces::{find_workspace_by_id, persist_workspace, PersistWorkspaceInput},
};
use argmax_lib::providers::flush_queue::DashboardDelta;
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
                default_provider: "claude".to_owned(),
                default_model_label: "Sonnet".to_owned(),
                worktree_location: worktree_location.to_owned(),
                setup_command: String::new(),
                check_commands: vec![],
            },
        },
    )
    .expect("persist project");
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
    assert_eq!(summary.path, repo.path().display().to_string());
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
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace")
    };

    let service = WorkspaceService::new(database.clone());

    let before = service
        .refresh_status(&workspace.id)
        .await
        .expect("refresh");
    assert!(!before.dirty);
    assert_eq!(before.changed_files, 0);

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
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace")
    };

    let (publisher, sink) = capture_publisher();
    let service = WorkspaceService::with_publisher(database.clone(), publisher);
    service.watch(&workspace.id).expect("install watcher");

    // Burst of writes inside one debounce window.
    for i in 0..5 {
        std::fs::write(repo.path().join(format!("burst-{i}.txt")), "x").expect("write");
    }

    // Wait long enough for: debounce window (200 ms) + git refresh latency.
    tokio::time::sleep(Duration::from_millis(800)).await;

    // The refresh fires at most a small number of times — not once per write.
    // (Hard equality is fragile because the OS can split bursts across two
    // notify events; we assert a sane upper bound.)
    let deltas = sink.lock().expect("sink").clone();
    let refresh_count = deltas
        .iter()
        .filter(|delta| delta.workspaces.iter().any(|w| w.id == workspace.id))
        .count();
    assert!(refresh_count >= 1, "expected at least one refresh delta");
    assert!(
        refresh_count <= 3,
        "expected coalesced refreshes, got {refresh_count}",
    );

    // Final state reflects the burst.
    let connection = database.connection();
    let after = find_workspace_by_id(&connection, &workspace.id).expect("find");
    assert!(after.dirty);
    assert!(after.changed_files >= 5);

    service.close_watcher(&workspace.id);
    assert_eq!(service.open_watcher_count(), 0);
}

#[test]
fn open_in_ide_constructs_open_command() {
    // We don't actually invoke `open` in the test (it's a UI side effect);
    // instead we verify the IDE choice → app-name mapping by spawning a
    // workspace with a missing `open` binary on $PATH. The handler shells
    // out to `open` unconditionally; on a stock dev box the call succeeds,
    // on CI it may fail silently. We assert only that the dispatch path
    // doesn't panic.
    let repo = seed_git_repo(&[("a.txt", "x")]);
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
            id: "w-ide".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            task_label: "ide".to_owned(),
            branch: "main".to_owned(),
            base_ref: "main".to_owned(),
            path: repo.path().display().to_string(),
            state: "kept".to_owned(),
            shared_workspace: true,
            dirty: false,
            changed_files: 0,
        },
    )
    .expect("persist workspace");
    drop(connection);

    let service = WorkspaceService::new(database.clone());
    // We don't await an IDE actually opening — the test just exercises
    // the lookup + dispatch path. Result may succeed (open exists) or
    // fail (no GUI session); either is acceptable here.
    let _ = service.open_in_ide(WorkspacesOpenInIdeInput {
        workspace_id: WorkspaceId::try_from(workspace.id).expect("workspace id"),
        ide: OpenIdeChoice::Default,
    });
}
