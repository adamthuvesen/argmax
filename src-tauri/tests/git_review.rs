mod support;

use std::os::unix::fs::symlink;

use std::sync::Arc;

use argmax_lib::persistence::{
    database::Database,
    projects::{persist_project, PersistProjectInput, ProjectSettings},
    workspaces::{persist_workspace, PersistWorkspaceInput},
};
use argmax_lib::review::git_review::{
    list_changed_files, list_changed_files_at_path, load_diff_at_path, ReviewBaseline,
    ReviewComparison,
};
use argmax_lib::workspaces::WorkspaceTargetKind;
use support::git_repo::{run_git, seed_git_repo};

/// Persist a project + a workspace whose `path` is the repo itself, so the
/// database-backed review functions can be driven against a real git tree.
fn seed_project_and_workspace(
    repo_path: &str,
    default_branch: Option<&str>,
    current_branch: &str,
    base_ref: &str,
) -> Arc<Database> {
    let database = Arc::new(Database::open_in_memory().expect("db"));
    {
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "p-review".to_owned(),
                name: "review-test".to_owned(),
                repo_path: repo_path.to_owned(),
                current_branch: current_branch.to_owned(),
                default_branch: default_branch.map(str::to_owned),
                settings: ProjectSettings {
                    worktree_location: format!("{repo_path}/worktrees"),
                    setup_command: String::new(),
                    check_commands: vec![],
                },
            },
        )
        .expect("persist project");
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "ws-review".to_owned(),
                project_id: "p-review".to_owned(),
                task_label: "review".to_owned(),
                branch: current_branch.to_owned(),
                base_ref: base_ref.to_owned(),
                path: repo_path.to_owned(),
                state: "running".to_owned(),
                shared_workspace: false,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace");
    }
    database
}

#[tokio::test]
async fn lists_changed_files_and_loads_diffs() {
    let repo = seed_git_repo(&[
        ("src/index.ts", "export const ok = true;\n"),
        ("src/delete-me.ts", "export const remove = true;\n"),
    ]);
    std::fs::write(
        repo.path().join("src/index.ts"),
        "export const ok = false;\n",
    )
    .unwrap();
    std::fs::write(
        repo.path().join("src/new.ts"),
        "export const added = true;\n",
    )
    .unwrap();
    std::fs::write(
        repo.path().join("src/staged.ts"),
        "export const staged = true;\n",
    )
    .unwrap();
    run_git(repo.path(), &["add", "src/staged.ts"]);
    std::fs::remove_file(repo.path().join("src/delete-me.ts")).unwrap();

    let files = list_changed_files_at_path(repo.path(), ReviewBaseline::WorkingTree)
        .await
        .unwrap();
    let diff = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("src/index.ts"),
        ReviewBaseline::WorkingTree,
        None,
    )
    .await
    .unwrap();
    let staged_diff = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("src/staged.ts"),
        ReviewBaseline::WorkingTree,
        None,
    )
    .await
    .unwrap();
    let untracked_diff = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("src/new.ts"),
        ReviewBaseline::WorkingTree,
        None,
    )
    .await
    .unwrap();
    let deleted_diff = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("src/delete-me.ts"),
        ReviewBaseline::WorkingTree,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        files
            .iter()
            .map(|file| (&file.status, &file.path, file.additions, file.deletions))
            .collect::<Vec<_>>(),
        vec![
            (&"D".to_owned(), &"src/delete-me.ts".to_owned(), 0, 1),
            (&"M".to_owned(), &"src/index.ts".to_owned(), 1, 1),
            (&"A".to_owned(), &"src/staged.ts".to_owned(), 1, 0),
            (&"??".to_owned(), &"src/new.ts".to_owned(), 1, 0),
        ]
    );
    assert_eq!(diff.workspace_id, "workspace-1");
    assert_eq!(diff.file_path.as_deref(), Some("src/index.ts"));
    assert!(diff.content.contains("-export const ok = true;"));
    assert!(diff.content.contains("+export const ok = false;"));
    assert!(staged_diff.content.contains("+export const staged = true;"));
    assert!(untracked_diff.content.contains("--- /dev/null"));
    assert!(untracked_diff
        .content
        .contains("+export const added = true;"));
    assert!(deleted_diff
        .content
        .contains("-export const remove = true;"));
}

#[tokio::test]
async fn loads_diff_for_leading_dash_file_name() {
    let repo = seed_git_repo(&[("-notes.md", "before\n")]);
    std::fs::write(repo.path().join("-notes.md"), "after\n").unwrap();

    let files = list_changed_files_at_path(repo.path(), ReviewBaseline::WorkingTree)
        .await
        .unwrap();
    let diff = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("-notes.md"),
        ReviewBaseline::WorkingTree,
        None,
    )
    .await
    .unwrap();

    assert!(files.iter().any(|file| file.path == "-notes.md"));
    assert_eq!(diff.file_path.as_deref(), Some("-notes.md"));
    assert!(diff.content.contains("--- a/-notes.md"));
    assert!(diff.content.contains("+++ b/-notes.md"));
    assert!(diff.content.contains("-before"));
    assert!(diff.content.contains("+after"));
}

#[tokio::test]
async fn branch_mode_single_file_diff_renders_committed_rename() {
    // A rename committed on the branch is clean in the working tree, so the
    // single-file diff path can't learn the old path from `git status`. In
    // branch mode it must recover the rename from the branch-vs-base file list
    // (which carries `old_path`) and render one rename diff — matching the file
    // list — instead of an orphaned full add.
    let repo = seed_git_repo(&[("src/old-name.ts", "export const value = 1;\n")]);
    run_git(repo.path(), &["branch", "base"]);
    run_git(repo.path(), &["checkout", "-b", "feature"]);
    run_git(repo.path(), &["mv", "src/old-name.ts", "src/new-name.ts"]);
    run_git(repo.path(), &["commit", "-m", "rename"]);

    let files = list_changed_files_at_path(repo.path(), ReviewBaseline::Branch("base"))
        .await
        .unwrap();
    let renamed = files
        .iter()
        .find(|file| file.path == "src/new-name.ts")
        .expect("renamed file in branch-vs-base list");
    assert_eq!(renamed.old_path.as_deref(), Some("src/old-name.ts"));

    let diff = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("src/new-name.ts"),
        ReviewBaseline::Branch("base"),
        None,
    )
    .await
    .unwrap();

    assert!(
        diff.content.contains("rename from src/old-name.ts"),
        "expected a rename diff, got:\n{}",
        diff.content
    );
    assert!(diff.content.contains("rename to src/new-name.ts"));
}

#[tokio::test]
async fn skips_untracked_directories_without_crashing() {
    let repo = seed_git_repo(&[("src/index.ts", "export const ok = true;\n")]);
    std::fs::create_dir(repo.path().join("src/untracked-dir")).unwrap();
    std::fs::write(repo.path().join("src/untracked-dir/inside.txt"), "hi\n").unwrap();

    let files = list_changed_files_at_path(repo.path(), ReviewBaseline::WorkingTree)
        .await
        .unwrap();
    let diff = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("src/untracked-dir/"),
        ReviewBaseline::WorkingTree,
        None,
    )
    .await
    .unwrap();

    assert!(!files.iter().any(|file| file.path.ends_with('/')));
    assert_eq!(diff.content, "");
}

#[tokio::test]
async fn skips_oversized_untracked_file_content() {
    let repo = seed_git_repo(&[("src/index.ts", "export const ok = true;\n")]);
    std::fs::write(repo.path().join("src/huge.txt"), "x".repeat(1_048_577)).unwrap();

    let diff = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("src/huge.txt"),
        ReviewBaseline::WorkingTree,
        None,
    )
    .await
    .unwrap();

    assert!(diff.content.contains("untracked file not loaded"));
    assert!(diff.content.contains("file exceeds diff preview cap"));
    assert!(!diff.content.contains(&"x".repeat(1000)));
}

#[tokio::test]
async fn untracked_symlink_diff_shows_target_not_contents() {
    let repo = seed_git_repo(&[("src/index.ts", "export const ok = true;\n")]);
    let outside_path =
        std::env::temp_dir().join(format!("argmax-secret-{}.txt", std::process::id()));
    std::fs::write(&outside_path, "do not show me\n").unwrap();
    symlink(&outside_path, repo.path().join("src/link.txt")).unwrap();

    let diff = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("src/link.txt"),
        ReviewBaseline::WorkingTree,
        None,
    )
    .await
    .unwrap();

    assert!(diff.content.contains("new file mode 120000"));
    assert!(diff
        .content
        .contains(&format!("+{}", outside_path.display())));
    assert!(!diff.content.contains("do not show me"));
    let _ = std::fs::remove_file(outside_path);
}

/// The review panel's "expand unmodified lines" band asks for a wider `-U`, so
/// two hunks far enough apart at the default context must fuse into one when
/// the requested context spans the gap between them.
#[tokio::test]
async fn context_lines_widen_the_diff_until_hunks_merge() {
    let original: String = (1..=40).map(|n| format!("line {n}\n")).collect();
    let repo = seed_git_repo(&[("src/wide.ts", &original)]);
    // Edit line 1 and line 40: at git's default 3 lines of context these are
    // two separate hunks with 30-odd unchanged lines between them.
    let edited = original
        .replace("line 1\n", "LINE ONE\n")
        .replace("line 40\n", "LINE FORTY\n");
    std::fs::write(repo.path().join("src/wide.ts"), &edited).unwrap();

    let hunk_count = |content: &str| content.lines().filter(|l| l.starts_with("@@ ")).count();

    let default_context = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("src/wide.ts"),
        ReviewBaseline::WorkingTree,
        None,
    )
    .await
    .unwrap();
    assert_eq!(hunk_count(&default_context.content), 2);
    assert!(!default_context.content.contains(" line 20"));

    let wide_context = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("src/wide.ts"),
        ReviewBaseline::WorkingTree,
        Some(25),
    )
    .await
    .unwrap();
    assert_eq!(hunk_count(&wide_context.content), 1);
    // The previously hidden middle of the file is now context.
    assert!(wide_context.content.contains(" line 20"));
}

#[tokio::test]
async fn rejects_paths_that_escape_repo() {
    let repo = seed_git_repo(&[("src/index.ts", "export const ok = true;\n")]);

    let err = load_diff_at_path(
        repo.path(),
        "workspace-1",
        Some("../escape.txt"),
        ReviewBaseline::WorkingTree,
        None,
    )
    .await
    .unwrap_err();
    let json = serde_json::to_value(&err).unwrap();

    assert_eq!(json["sub_code"], "WORKSPACE_PATH_INVALID");
}

#[tokio::test]
async fn branch_mode_falls_back_to_default_when_base_deleted() {
    // A worktree forked from `doomed`; that branch is later merged and pruned.
    // The stored base_ref now dangles. Branch-mode review must fall back to the
    // project default branch instead of failing with "not a valid object name".
    let repo = seed_git_repo(&[("src/index.ts", "export const value = 1;\n")]);
    run_git(repo.path(), &["branch", "-M", "main"]);
    run_git(repo.path(), &["branch", "doomed"]);
    run_git(repo.path(), &["checkout", "-b", "feature"]);
    std::fs::write(
        repo.path().join("src/index.ts"),
        "export const value = 2;\n",
    )
    .unwrap();
    run_git(repo.path(), &["commit", "-am", "feature change"]);
    // The base branch is gone; only main + feature remain.
    run_git(repo.path(), &["branch", "-D", "doomed"]);

    let database = seed_project_and_workspace(
        &repo.path().display().to_string(),
        Some("main"),
        "feature",
        "doomed",
    );

    let files = list_changed_files(
        &database,
        WorkspaceTargetKind::Workspace,
        "ws-review",
        ReviewComparison::Branch,
    )
    .await
    .expect("review should fall back to default branch, not error on dead base");

    assert_eq!(
        files
            .iter()
            .map(|file| (file.status.as_str(), file.path.as_str()))
            .collect::<Vec<_>>(),
        vec![("M", "src/index.ts")],
    );
}

#[tokio::test]
async fn branch_mode_falls_back_to_working_tree_when_base_and_default_gone() {
    // Both the workspace base_ref and the project default branch are missing.
    // Review degrades to working-tree mode (vs HEAD) so uncommitted work still
    // renders rather than erroring on the dead refs.
    let repo = seed_git_repo(&[("src/index.ts", "export const value = 1;\n")]);
    run_git(repo.path(), &["branch", "-M", "main"]);
    std::fs::write(
        repo.path().join("src/index.ts"),
        "export const value = 2;\n",
    )
    .unwrap();

    let database = seed_project_and_workspace(
        &repo.path().display().to_string(),
        Some("also-gone"),
        "main",
        "doomed",
    );

    let files = list_changed_files(
        &database,
        WorkspaceTargetKind::Workspace,
        "ws-review",
        ReviewComparison::Branch,
    )
    .await
    .expect("review should fall back to working tree when no ref resolves");

    assert_eq!(
        files
            .iter()
            .map(|file| (file.status.as_str(), file.path.as_str()))
            .collect::<Vec<_>>(),
        vec![("M", "src/index.ts")],
    );
}

#[tokio::test]
async fn branch_mode_skips_head_equivalent_base_ref() {
    // Shared-checkout sessions used to persist the current branch as base_ref.
    // merge-base(feature, HEAD) is empty on a clean tree. Review must skip that
    // and compare against the project default instead.
    let repo = seed_git_repo(&[("src/index.ts", "export const value = 1;\n")]);
    run_git(repo.path(), &["branch", "-M", "main"]);
    run_git(repo.path(), &["checkout", "-b", "feature"]);
    std::fs::write(
        repo.path().join("src/index.ts"),
        "export const value = 2;\n",
    )
    .unwrap();
    run_git(repo.path(), &["commit", "-am", "feature change"]);

    let database = seed_project_and_workspace(
        &repo.path().display().to_string(),
        Some("main"),
        "feature",
        "feature",
    );
    let repo_path = repo.path().display().to_string();

    let branch_files = list_changed_files(
        &database,
        WorkspaceTargetKind::Workspace,
        "ws-review",
        ReviewComparison::Branch,
    )
    .await
    .expect("branch review should skip HEAD-equivalent base_ref");
    assert_eq!(
        branch_files
            .iter()
            .map(|file| (file.status.as_str(), file.path.as_str()))
            .collect::<Vec<_>>(),
        vec![("M", "src/index.ts")],
    );

    let committed_files = list_changed_files(
        &database,
        WorkspaceTargetKind::Workspace,
        "ws-review",
        ReviewComparison::Committed,
    )
    .await
    .expect("committed review should skip HEAD-equivalent base_ref");
    assert_eq!(
        committed_files
            .iter()
            .map(|file| (file.status.as_str(), file.path.as_str()))
            .collect::<Vec<_>>(),
        vec![("M", "src/index.ts")],
    );

    let working_files = list_changed_files(
        &database,
        WorkspaceTargetKind::Workspace,
        "ws-review",
        ReviewComparison::WorkingTree,
    )
    .await
    .expect("working-tree review");
    assert!(working_files.is_empty(), "working tree is clean");

    // Same trap on the launcher: default_branch recorded as the topic branch.
    let project_db = seed_project_and_workspace(&repo_path, Some("feature"), "feature", "feature");
    let project_files = list_changed_files(
        &project_db,
        WorkspaceTargetKind::Project,
        "p-review",
        ReviewComparison::Branch,
    )
    .await
    .expect("project review should fall through to main");
    assert_eq!(
        project_files
            .iter()
            .map(|file| (file.status.as_str(), file.path.as_str()))
            .collect::<Vec<_>>(),
        vec![("M", "src/index.ts")],
    );
}

#[tokio::test]
async fn branch_mode_prefers_origin_default_over_stale_local_main() {
    // Local main stayed at the pre-rebase commit. origin/main moved on and
    // the feature branch was rebased onto it. Review must use origin/main,
    // not the stale local ref, or already-landed upstream files show up as
    // this branch's work.
    let repo = seed_git_repo(&[("src/index.ts", "export const value = 1;\n")]);
    run_git(repo.path(), &["branch", "-M", "main"]);
    run_git(repo.path(), &["checkout", "-b", "upstream"]);
    std::fs::write(repo.path().join("upstream.txt"), "landed on main\n").unwrap();
    run_git(repo.path(), &["add", "upstream.txt"]);
    run_git(repo.path(), &["commit", "-m", "upstream change"]);
    run_git(
        repo.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    run_git(repo.path(), &["checkout", "main"]);
    run_git(repo.path(), &["checkout", "-b", "feature", "origin/main"]);
    std::fs::write(
        repo.path().join("src/index.ts"),
        "export const value = 2;\n",
    )
    .unwrap();
    run_git(repo.path(), &["commit", "-am", "feature change"]);

    let database = seed_project_and_workspace(
        &repo.path().display().to_string(),
        Some("main"),
        "feature",
        "main",
    );

    let files = list_changed_files(
        &database,
        WorkspaceTargetKind::Workspace,
        "ws-review",
        ReviewComparison::Branch,
    )
    .await
    .expect("review should compare against origin/main");
    assert_eq!(
        files
            .iter()
            .map(|file| (file.status.as_str(), file.path.as_str()))
            .collect::<Vec<_>>(),
        vec![("M", "src/index.ts")],
        "stale local main must not pull upstream.txt into the review",
    );
}

#[tokio::test]
async fn branch_mode_skips_origin_default_without_common_ancestor() {
    let repo = seed_git_repo(&[("src/index.ts", "export const value = 1;\n")]);
    run_git(repo.path(), &["branch", "-M", "main"]);
    run_git(repo.path(), &["checkout", "-b", "feature"]);
    std::fs::write(
        repo.path().join("src/index.ts"),
        "export const value = 2;\n",
    )
    .unwrap();
    run_git(repo.path(), &["commit", "-am", "feature change"]);
    run_git(repo.path(), &["checkout", "--orphan", "unrelated"]);
    std::fs::write(repo.path().join("other.txt"), "unrelated history\n").unwrap();
    run_git(repo.path(), &["add", "other.txt"]);
    run_git(repo.path(), &["commit", "-m", "unrelated"]);
    run_git(
        repo.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    run_git(repo.path(), &["checkout", "feature"]);

    let database = seed_project_and_workspace(
        &repo.path().display().to_string(),
        Some("main"),
        "feature",
        "main",
    );

    let files = list_changed_files(
        &database,
        WorkspaceTargetKind::Workspace,
        "ws-review",
        ReviewComparison::Branch,
    )
    .await
    .expect("review should fall back to local main when origin/main is unrelated");
    assert_eq!(
        files
            .iter()
            .map(|file| (file.status.as_str(), file.path.as_str()))
            .collect::<Vec<_>>(),
        vec![("M", "src/index.ts")],
    );
}
