mod support;

use std::os::unix::fs::symlink;

use argmax_lib::review::git_review::{list_changed_files_at_path, load_diff_at_path};
use support::git_repo::{run_git, seed_git_repo};

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

    let files = list_changed_files_at_path(repo.path(), None).await.unwrap();
    let diff = load_diff_at_path(repo.path(), "workspace-1", Some("src/index.ts"), None)
        .await
        .unwrap();
    let staged_diff = load_diff_at_path(repo.path(), "workspace-1", Some("src/staged.ts"), None)
        .await
        .unwrap();
    let untracked_diff = load_diff_at_path(repo.path(), "workspace-1", Some("src/new.ts"), None)
        .await
        .unwrap();
    let deleted_diff = load_diff_at_path(repo.path(), "workspace-1", Some("src/delete-me.ts"), None)
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
async fn branch_mode_single_file_diff_renders_committed_rename() {
    // A rename committed on the branch is clean in the working tree, so the
    // single-file diff path can't learn the old path from `git status`. In
    // branch mode it must recover the rename from the branch-vs-base file list
    // (which carries `old_path`) and render one rename diff — matching the file
    // list — instead of an orphaned full add.
    let repo = seed_git_repo(&[("src/old-name.ts", "export const value = 1;\n")]);
    run_git(repo.path(), &["branch", "base"]);
    run_git(repo.path(), &["checkout", "-b", "feature"]);
    run_git(
        repo.path(),
        &["mv", "src/old-name.ts", "src/new-name.ts"],
    );
    run_git(repo.path(), &["commit", "-m", "rename"]);

    let files = list_changed_files_at_path(repo.path(), Some("base"))
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
        Some("base"),
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

    let files = list_changed_files_at_path(repo.path(), None).await.unwrap();
    let diff = load_diff_at_path(repo.path(), "workspace-1", Some("src/untracked-dir/"), None)
        .await
        .unwrap();

    assert!(!files.iter().any(|file| file.path.ends_with('/')));
    assert_eq!(diff.content, "");
}

#[tokio::test]
async fn skips_oversized_untracked_file_content() {
    let repo = seed_git_repo(&[("src/index.ts", "export const ok = true;\n")]);
    std::fs::write(repo.path().join("src/huge.txt"), "x".repeat(1_048_577)).unwrap();

    let diff = load_diff_at_path(repo.path(), "workspace-1", Some("src/huge.txt"), None)
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

    let diff = load_diff_at_path(repo.path(), "workspace-1", Some("src/link.txt"), None)
        .await
        .unwrap();

    assert!(diff.content.contains("new file mode 120000"));
    assert!(diff
        .content
        .contains(&format!("+{}", outside_path.display())));
    assert!(!diff.content.contains("do not show me"));
    let _ = std::fs::remove_file(outside_path);
}

#[tokio::test]
async fn rejects_paths_that_escape_repo() {
    let repo = seed_git_repo(&[("src/index.ts", "export const ok = true;\n")]);

    let err = load_diff_at_path(repo.path(), "workspace-1", Some("../escape.txt"), None)
        .await
        .unwrap_err();
    let json = serde_json::to_value(&err).unwrap();

    assert_eq!(json["sub_code"], "WORKSPACE_PATH_INVALID");
}
