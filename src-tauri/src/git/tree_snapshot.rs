//! Worktree snapshots as git tree objects, and diffs between two of them.
//!
//! Some providers report which files they wrote but never how: Codex's
//! `file_change` item carries a path and a kind and nothing else. Marking the
//! worktree at the start of a turn, then re-marking the paths a write touched,
//! turns those bare paths into a real diff without asking the provider for
//! anything.
//!
//! Everything here runs against a scratch `GIT_INDEX_FILE`, so the user's own
//! index and worktree are never touched. Blobs and trees land in the repo's
//! object database as unreferenced objects, which `git gc` collects.

use std::{path::Path, time::Duration};

use tempfile::tempdir;

use super::exec::{run_git_text_with_options, GitExecOptions};
use crate::error::{ArgmaxError, ArgmaxResult};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(60);

/// Snapshot the worktree as a tree object.
///
/// `base_tree` seeds the scratch index: pass the previous snapshot to re-mark
/// only `paths` and carry everything else over unchanged, or `None` to seed
/// from `HEAD`. `paths` are repo-relative; an empty list stages the whole
/// worktree, which on a large repo means hashing every file — prefer the paths
/// you care about.
///
/// Ignored paths are staged too (`--force`): the agent wrote them, so a stat
/// for them is as honest as any other. Paths that no longer exist on disk and
/// are absent from `base_tree` make git fail the whole pathspec, so callers
/// filter those out first.
pub async fn snapshot_worktree(
    repo_path: &Path,
    base_tree: Option<&str>,
    paths: &[String],
) -> ArgmaxResult<String> {
    let scratch = tempdir().map_err(|error| {
        ArgmaxError::service(
            "GIT_TEMP_INDEX_FAILED",
            format!("could not create temp git index: {error}"),
        )
    })?;
    let index = scratch.path().join("index");
    let options = || {
        let mut options = GitExecOptions::default().with_env("GIT_INDEX_FILE", index.as_os_str());
        options.timeout = SNAPSHOT_TIMEOUT;
        options
    };

    let seed = base_tree.unwrap_or("HEAD");
    // An unborn HEAD (a repo with no commits) has no tree to read; an empty
    // index plus a full `add` says the same thing there.
    let seeded = run_git_text_with_options(repo_path, ["read-tree", seed], options())
        .await
        .is_ok();
    if !seeded {
        if base_tree.is_some() {
            return Err(ArgmaxError::service(
                "GIT_SNAPSHOT_BASE_MISSING",
                format!("could not read tree {seed}"),
            ));
        }
        run_git_text_with_options(repo_path, ["read-tree", "--empty"], options()).await?;
    }

    let mut add = vec![
        "add".to_string(),
        "--all".to_string(),
        "--force".to_string(),
    ];
    if !seeded {
        // Unborn HEAD: there is no seed to carry paths over from, so the whole
        // worktree has to be staged for the mark to mean anything.
        run_git_text_with_options(repo_path, add, options()).await?;
    } else if !paths.is_empty() {
        add.push("--".to_string());
        add.extend(paths.iter().cloned());
        run_git_text_with_options(repo_path, add, options()).await?;
    }
    // An empty pathspec over a seeded index needs no scan at all: the index
    // already mirrors the seed tree, which keeps a no-op mark cheap on a big
    // repo.

    let tree = run_git_text_with_options(repo_path, ["write-tree"], options()).await?;
    let tree = tree.trim().to_string();
    if tree.is_empty() {
        return Err(ArgmaxError::service(
            "GIT_SNAPSHOT_EMPTY_TREE",
            "git write-tree returned no object id",
        ));
    }
    Ok(tree)
}

/// Repo-relative paths that differ from `HEAD` right now: tracked changes plus
/// untracked files. Renames are reported as their two sides (`--no-renames`)
/// so a snapshot taken from this list drops the old path.
pub async fn dirty_paths(repo_path: &Path) -> ArgmaxResult<Vec<String>> {
    let tracked = run_git_text_with_options(
        repo_path,
        ["diff", "--no-renames", "--name-only", "-z", "HEAD"],
        snapshot_options(),
    )
    .await
    .unwrap_or_default();
    let untracked = run_git_text_with_options(
        repo_path,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        snapshot_options(),
    )
    .await?;
    let mut paths = split_nul(&tracked);
    paths.extend(split_nul(&untracked));
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// The unified diff of one path between two tree objects, capped at
/// `max_bytes`. An empty string means the path did not change; `None` means the
/// diff was too large to carry, which reads as "no stat" downstream rather than
/// as a wrong one.
pub async fn diff_path_between_trees(
    repo_path: &Path,
    before: &str,
    after: &str,
    path: &str,
    max_bytes: usize,
) -> ArgmaxResult<Option<String>> {
    let diff = run_git_text_with_options(
        repo_path,
        [
            "diff",
            "--no-color",
            "--no-renames",
            "-U3",
            before,
            after,
            "--",
            path,
        ],
        snapshot_options(),
    )
    .await?;
    if diff.len() > max_bytes {
        return Ok(None);
    }
    Ok(Some(diff))
}

fn snapshot_options() -> GitExecOptions {
    GitExecOptions {
        timeout: SNAPSHOT_TIMEOUT,
        ..GitExecOptions::default()
    }
}

fn split_nul(raw: &str) -> Vec<String> {
    raw.split('\0')
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    async fn git(repo: &Path, args: &[&str]) -> String {
        run_git_text_with_options(repo, args, snapshot_options())
            .await
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"))
    }

    async fn repo_with_commit() -> TempDir {
        let dir = TempDir::new().expect("temp dir");
        let path = dir.path();
        git(path, &["init", "--initial-branch=main"]).await;
        git(path, &["config", "user.email", "test@example.com"]).await;
        git(path, &["config", "user.name", "Test"]).await;
        fs::write(path.join("kept.txt"), "one\ntwo\nthree\n").expect("write");
        git(path, &["add", "-A"]).await;
        git(path, &["commit", "-m", "init"]).await;
        dir
    }

    #[tokio::test]
    async fn snapshot_then_edit_diffs_only_the_edited_lines() {
        let repo = repo_with_commit().await;
        let path = repo.path();
        let before = snapshot_worktree(path, None, &dirty_paths(path).await.unwrap())
            .await
            .expect("baseline");

        fs::write(path.join("kept.txt"), "one\ntwo CHANGED\nthree\nfour\n").expect("write");
        let after = snapshot_worktree(path, Some(&before), &["kept.txt".to_string()])
            .await
            .expect("after");

        let diff = diff_path_between_trees(path, &before, &after, "kept.txt", 64 * 1024)
            .await
            .expect("diff")
            .expect("within cap");
        let additions = diff
            .lines()
            .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
            .count();
        let deletions = diff
            .lines()
            .filter(|line| line.starts_with('-') && !line.starts_with("---"))
            .count();
        assert_eq!((additions, deletions), (2, 1), "diff was:\n{diff}");
    }

    #[tokio::test]
    async fn baseline_carries_uncommitted_work_so_it_is_not_counted_as_the_turn() {
        let repo = repo_with_commit().await;
        let path = repo.path();
        // The user's own edit, made before the turn started.
        fs::write(path.join("kept.txt"), "one\ntwo\nthree\nmine\n").expect("write");
        let before = snapshot_worktree(path, None, &dirty_paths(path).await.unwrap())
            .await
            .expect("baseline");

        let after = snapshot_worktree(path, Some(&before), &["kept.txt".to_string()])
            .await
            .expect("after");
        let diff = diff_path_between_trees(path, &before, &after, "kept.txt", 64 * 1024)
            .await
            .expect("diff")
            .expect("within cap");
        assert_eq!(diff, "", "an untouched file must produce no diff");
    }

    #[tokio::test]
    async fn a_created_file_is_all_additions_even_when_ignored() {
        let repo = repo_with_commit().await;
        let path = repo.path();
        fs::write(path.join(".gitignore"), "out/\n").expect("write");
        let before = snapshot_worktree(path, None, &dirty_paths(path).await.unwrap())
            .await
            .expect("baseline");

        fs::create_dir(path.join("out")).expect("mkdir");
        fs::write(path.join("out/new.txt"), "alpha\nbeta\n").expect("write");
        let after = snapshot_worktree(path, Some(&before), &["out/new.txt".to_string()])
            .await
            .expect("after");

        let diff = diff_path_between_trees(path, &before, &after, "out/new.txt", 64 * 1024)
            .await
            .expect("diff")
            .expect("within cap");
        assert!(diff.contains("+alpha"), "diff was:\n{diff}");
        assert!(diff.contains("+beta"), "diff was:\n{diff}");
    }

    #[tokio::test]
    async fn an_oversized_diff_reports_nothing_rather_than_a_guess() {
        let repo = repo_with_commit().await;
        let path = repo.path();
        let before = snapshot_worktree(path, None, &dirty_paths(path).await.unwrap())
            .await
            .expect("baseline");

        fs::write(path.join("kept.txt"), "x\n".repeat(5_000)).expect("write");
        let after = snapshot_worktree(path, Some(&before), &["kept.txt".to_string()])
            .await
            .expect("after");

        let diff = diff_path_between_trees(path, &before, &after, "kept.txt", 512)
            .await
            .expect("diff");
        assert!(diff.is_none());
    }

    #[tokio::test]
    async fn snapshot_fails_loudly_when_the_base_tree_is_gone() {
        let repo = repo_with_commit().await;
        let error = snapshot_worktree(
            repo.path(),
            Some("0000000000000000000000000000000000000000"),
            &["kept.txt".to_string()],
        )
        .await
        .expect_err("missing base tree");
        assert!(error.to_string().contains("could not read tree"));
    }
}
