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

use std::{
    collections::HashMap,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use tempfile::tempdir;
use tokio::fs as async_fs;

use super::exec::{run_git_text_with_options, GitExecOptions};
use crate::error::{ArgmaxError, ArgmaxResult};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(60);
const INDEX_CAPTURE_ATTEMPTS: usize = 3;

enum IndexCaptureAttempt {
    Complete,
    Retry(ArgmaxError),
}

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
    let scratch = scratch_index_dir()?;
    let index = scratch.path().join("index");

    let seed = base_tree.unwrap_or("HEAD");
    // An unborn HEAD (a repo with no commits) has no tree to read; an empty
    // index plus a full `add` says the same thing there.
    let seeded = run_git_text_with_options(repo_path, ["read-tree", seed], scratch_options(&index))
        .await
        .is_ok();
    if !seeded {
        if base_tree.is_some() {
            return Err(ArgmaxError::service(
                "GIT_SNAPSHOT_BASE_MISSING",
                format!("could not read tree {seed}"),
            ));
        }
        run_git_text_with_options(repo_path, ["read-tree", "--empty"], scratch_options(&index))
            .await?;
    }

    let mut add = vec![
        "add".to_string(),
        "--all".to_string(),
        "--force".to_string(),
    ];
    if !seeded {
        // Unborn HEAD: there is no seed to carry paths over from, so the whole
        // worktree has to be staged for the mark to mean anything.
        run_git_text_with_options(repo_path, add, scratch_options(&index)).await?;
    } else if !paths.is_empty() {
        add.push("--".to_string());
        add.extend(paths.iter().cloned());
        run_git_text_with_options(repo_path, add, scratch_options(&index)).await?;
    }
    // An empty pathspec over a seeded index needs no scan at all: the index
    // already mirrors the seed tree, which keeps a no-op mark cheap on a big
    // repo.

    tree_from_index(repo_path, scratch_options(&index)).await
}

/// Snapshot the complete visible worktree without adding ignored files.
///
/// Checkpoints use this rather than [`snapshot_worktree`]: an ignored build
/// artifact is deliberately outside a checkpoint and must never be removed by
/// a later rewind. The returned tree is self-contained and can be pinned by a
/// ref without touching the user's real index.
pub async fn snapshot_visible_worktree(repo_path: &Path) -> ArgmaxResult<String> {
    let capture = stage_visible_worktree(repo_path).await?;
    drop_force_staged_ignored(repo_path, capture.index.as_path()).await?;
    tree_from_index(repo_path, scratch_options(&capture.index)).await
}

/// A tree object standing for the worktree's current content, for use as a
/// fingerprint rather than as something to restore.
///
/// [`snapshot_visible_worktree`] minus the one rule that costs a git process to
/// enforce: a force-staged ignored file is in here and out of a checkpoint.
/// Nothing restores this tree, so that distinction buys a fingerprint nothing,
/// and the review panel pays for it twice per file click.
pub async fn fingerprint_worktree(repo_path: &Path) -> ArgmaxResult<String> {
    let capture = stage_visible_worktree(repo_path).await?;
    tree_from_index(repo_path, scratch_options(&capture.index)).await
}

/// Stage the whole visible worktree into a scratch index.
///
/// The seed is the checkout's own index, the only one carrying stat data: `add`
/// then re-hashes the files whose stat moved rather than every tracked file in
/// the repo, which is ~70 ms against ~230 ms on this repo.
async fn stage_visible_worktree(repo_path: &Path) -> ArgmaxResult<CapturedIndex> {
    let capture = capture_index(repo_path).await?;
    let index = capture.index.as_path();

    if !capture.seeded_from_real {
        // No index file to copy, so fall back to HEAD: a file that is tracked
        // but also ignored would otherwise be dropped by the `add` below.
        let _ = run_git_text_with_options(repo_path, ["read-tree", "HEAD"], scratch_options(index))
            .await;
    }
    // `--all` captures tracked deletions and eligible untracked files.  Do not
    // pass `--force`: ignored files belong to the caller, not the checkpoint.
    run_git_text_with_options(repo_path, ["add", "--all"], scratch_options(index)).await?;
    Ok(capture)
}

/// Remove index entries an ignore rule covers and `HEAD` does not have.
///
/// These are the one place the index seed disagrees with a `HEAD` one: staging
/// an ignored file with `add --force` makes it tracked, so `add` keeps it, while
/// a snapshot seeded from `HEAD` never saw it. Ignored paths are the caller's,
/// and a rewind must not restore or remove one, so the `HEAD` answer is the
/// right one. The listing is empty in every ordinary checkout.
async fn drop_force_staged_ignored(repo_path: &Path, index: &Path) -> ArgmaxResult<()> {
    let ignored = run_git_text_with_options(
        repo_path,
        [
            "ls-files",
            "--cached",
            "--ignored",
            "--exclude-standard",
            "-z",
        ],
        scratch_options(index),
    )
    .await?;
    let ignored = split_nul(&ignored);
    if ignored.is_empty() {
        return Ok(());
    }

    // An ignored path that HEAD already tracks belongs in the snapshot: both
    // seeds carry it, and dropping it would delete it on a rewind.
    let in_head = match head_exists(repo_path).await {
        true => {
            let mut args = vec![
                "ls-tree".to_owned(),
                "--name-only".to_owned(),
                "-z".to_owned(),
                "HEAD".to_owned(),
                "--".to_owned(),
            ];
            args.extend(ignored.iter().cloned());
            split_nul(&run_git_text_with_options(repo_path, args, snapshot_options()).await?)
        }
        false => Vec::new(),
    };

    let mut args = vec![
        "rm".to_owned(),
        "--cached".to_owned(),
        "--quiet".to_owned(),
        "--".to_owned(),
    ];
    args.extend(
        ignored
            .into_iter()
            .filter(|path| !in_head.contains(path))
            .collect::<Vec<_>>(),
    );
    if args.len() == 4 {
        return Ok(());
    }
    run_git_text_with_options(repo_path, args, scratch_options(index)).await?;
    Ok(())
}

/// Return the tree represented by the user's current index without changing
/// it. `git write-tree` rejects unresolved index entries, which is precisely
/// the state checkpointing must refuse.
pub async fn index_tree(repo_path: &Path) -> ArgmaxResult<String> {
    let capture = capture_index(repo_path).await?;
    tree_from_index(repo_path, scratch_options(&capture.index)).await
}

/// A copy of the checkout's index in a scratch directory, safe for git commands
/// that write to `GIT_INDEX_FILE`. `seeded_from_real` is false when the checkout
/// has no index file yet, in which case the scratch index has been read empty.
struct CapturedIndex {
    // Dropping the directory deletes the index, so it outlives the path.
    _scratch: tempfile::TempDir,
    index: PathBuf,
    seeded_from_real: bool,
}

/// Copy the checkout's index into a scratch index, retrying while the copy
/// catches the real index mid-write.
async fn capture_index(repo_path: &Path) -> ArgmaxResult<CapturedIndex> {
    let mut real_index = resolve_index_path(repo_path).await?;

    let mut last_retry = None;
    for attempt in 0..INDEX_CAPTURE_ATTEMPTS {
        let scratch = scratch_index_dir()?;
        let scratch_index = scratch.path().join("index");

        match async_fs::copy(&real_index, &scratch_index).await {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {
                // Either the checkout has no index yet, or the remembered path
                // is stale — a moved checkout, a repaired worktree. Re-resolve
                // once before believing the index is simply absent.
                if attempt == 0 {
                    forget_index_path(repo_path);
                    let resolved = resolve_index_path(repo_path).await?;
                    if resolved != real_index {
                        real_index = resolved;
                        continue;
                    }
                }
                run_git_text_with_options(
                    repo_path,
                    ["read-tree", "--empty"],
                    scratch_options(&scratch_index),
                )
                .await?;
                return Ok(CapturedIndex {
                    _scratch: scratch,
                    index: scratch_index,
                    seeded_from_real: false,
                });
            }
            Err(error) => return Err(index_io_error("copy", &real_index, error)),
        }

        // Without a split index the copy is self-contained, which is every
        // ordinary checkout. Skipping the probe there is what keeps a capture
        // to one file copy: the review panel makes four of them per file click.
        if !has_shared_index(&real_index).await {
            return Ok(CapturedIndex {
                _scratch: scratch,
                index: scratch_index,
                seeded_from_real: true,
            });
        }

        match finish_index_capture(repo_path, &real_index, scratch.path(), &scratch_index).await? {
            IndexCaptureAttempt::Complete => {
                return Ok(CapturedIndex {
                    _scratch: scratch,
                    index: scratch_index,
                    seeded_from_real: true,
                })
            }
            IndexCaptureAttempt::Retry(error) => last_retry = Some(error),
        }
    }

    let reason = last_retry.expect("every incomplete capture records its failure");
    Err(ArgmaxError::service(
        "GIT_TEMP_INDEX_UNSTABLE",
        format!(
            "could not capture a stable git index after {INDEX_CAPTURE_ATTEMPTS} attempts: {reason}"
        ),
    ))
}

/// Does this checkout keep part of its index in a shared file?
///
/// `git rev-parse --shared-index-path` answers this, but it is a git process
/// and the answer is no in every checkout that has never run
/// `update-index --split-index`. The companion always sits beside the index as
/// `sharedindex.<sha>`, so a directory read settles it.
async fn has_shared_index(real_index: &Path) -> bool {
    let Some(git_dir) = real_index.parent() else {
        return false;
    };
    let Ok(mut entries) = async_fs::read_dir(git_dir).await else {
        // Unreadable means unknown, and the probe is the safe answer.
        return true;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("sharedindex.")
        {
            return true;
        }
    }
    false
}

/// Where this checkout keeps its index.
///
/// Resolving it is a git process, and the answer holds for as long as the
/// checkout is where it was, so each checkout is asked once. A path that stops
/// resolving to a file is dropped and asked again — see [`capture_index`].
async fn resolve_index_path(repo_path: &Path) -> ArgmaxResult<PathBuf> {
    if let Some(cached) = index_paths()
        .lock()
        .expect("index path cache")
        .get(repo_path)
    {
        return Ok(cached.clone());
    }

    let resolved = run_git_text_with_options(
        repo_path,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        snapshot_options(),
    )
    .await?;
    let real_index = PathBuf::from(resolved.trim());
    if real_index.as_os_str().is_empty() {
        return Err(ArgmaxError::service(
            "GIT_TEMP_INDEX_FAILED",
            "git did not resolve the checkout index path",
        ));
    }

    index_paths()
        .lock()
        .expect("index path cache")
        .insert(repo_path.to_path_buf(), real_index.clone());
    Ok(real_index)
}

fn forget_index_path(repo_path: &Path) {
    index_paths()
        .lock()
        .expect("index path cache")
        .remove(repo_path);
}

fn index_paths() -> &'static Mutex<HashMap<PathBuf, PathBuf>> {
    static INDEX_PATHS: OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();
    INDEX_PATHS.get_or_init(Mutex::default)
}

async fn finish_index_capture(
    repo_path: &Path,
    real_index: &Path,
    scratch_dir: &Path,
    scratch_index: &Path,
) -> ArgmaxResult<IndexCaptureAttempt> {
    // Resolve the companion through the copied index. Querying the live index
    // here can pair an old main index with a newly rotated shared index.
    let resolved_shared_index = match run_git_text_with_options(
        repo_path,
        ["rev-parse", "--path-format=absolute", "--shared-index-path"],
        scratch_options(scratch_index),
    )
    .await
    {
        Ok(path) => path,
        Err(error) => {
            if index_file_changed(real_index, scratch_index).await? {
                return Ok(IndexCaptureAttempt::Retry(error));
            }
            return Err(error);
        }
    };

    if !resolved_shared_index.trim().is_empty() {
        let shared_index = PathBuf::from(resolved_shared_index.trim());
        let file_name = shared_index.file_name().ok_or_else(|| {
            ArgmaxError::service(
                "GIT_TEMP_INDEX_FAILED",
                format!(
                    "git resolved a shared index path without a file name: {}",
                    shared_index.display()
                ),
            )
        })?;
        if let Err(error) = async_fs::copy(&shared_index, scratch_dir.join(file_name)).await {
            if error.kind() == ErrorKind::NotFound {
                return Ok(IndexCaptureAttempt::Retry(index_io_error(
                    "copy",
                    &shared_index,
                    error,
                )));
            }
            return Err(index_io_error("copy", &shared_index, error));
        }
    }

    Ok(IndexCaptureAttempt::Complete)
}

async fn index_file_changed(real_index: &Path, scratch_index: &Path) -> ArgmaxResult<bool> {
    let copied = async_fs::read(scratch_index)
        .await
        .map_err(|error| index_io_error("read", scratch_index, error))?;
    match async_fs::read(real_index).await {
        Ok(current) => Ok(current != copied),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(true),
        Err(error) => Err(index_io_error("read", real_index, error)),
    }
}

fn index_io_error(verb: &str, source: &Path, error: std::io::Error) -> ArgmaxError {
    ArgmaxError::service(
        "GIT_TEMP_INDEX_FAILED",
        format!("could not {verb} git index {}: {error}", source.display()),
    )
}

async fn tree_from_index(repo_path: &Path, options: GitExecOptions) -> ArgmaxResult<String> {
    let tree = run_git_text_with_options(repo_path, ["write-tree"], options).await?;
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
    // An unborn HEAD has no commit to diff against, which is not a failure.
    // Any other error must surface: passing it off as "nothing is dirty" would
    // leave the baseline missing the user's own uncommitted work, and the
    // turn's first measured diff would then bill that work to the agent.
    let tracked = match run_git_text_with_options(
        repo_path,
        ["diff", "--no-renames", "--name-only", "-z", "HEAD"],
        snapshot_options(),
    )
    .await
    {
        Ok(tracked) => tracked,
        Err(error) => {
            if head_exists(repo_path).await {
                return Err(error);
            }
            String::new()
        }
    };
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

/// Whether `HEAD` resolves to a commit. A fresh repo with no commits has an
/// unborn HEAD, which several git plumbing commands report as an error.
async fn head_exists(repo_path: &Path) -> bool {
    run_git_text_with_options(
        repo_path,
        ["rev-parse", "--verify", "--quiet", "HEAD"],
        snapshot_options(),
    )
    .await
    .is_ok()
}

/// A throwaway directory to hold a scratch `GIT_INDEX_FILE`.
fn scratch_index_dir() -> ArgmaxResult<tempfile::TempDir> {
    tempdir().map_err(|error| {
        ArgmaxError::service(
            "GIT_TEMP_INDEX_FAILED",
            format!("could not create temp git index: {error}"),
        )
    })
}

/// Snapshot options pointed at a scratch index, so git never touches the
/// checkout's own.
fn scratch_options(index: &Path) -> GitExecOptions {
    let mut options = GitExecOptions::default().with_env("GIT_INDEX_FILE", index.as_os_str());
    options.timeout = SNAPSHOT_TIMEOUT;
    options
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
    use std::{fs, time::SystemTime};
    use tempfile::TempDir;

    async fn git(repo: &Path, args: &[&str]) -> String {
        run_git_text_with_options(repo, args, snapshot_options())
            .await
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"))
    }

    async fn git_with_index(repo: &Path, index: &Path, args: &[&str]) -> String {
        run_git_text_with_options(repo, args, scratch_options(index))
            .await
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"))
    }

    /// Initialize a repository with one commit at `path`, which the caller owns.
    async fn repo_at(path: &Path) -> PathBuf {
        git(path, &["init", "--initial-branch=main"]).await;
        git(path, &["config", "user.email", "test@example.com"]).await;
        git(path, &["config", "user.name", "Test"]).await;
        fs::write(path.join("kept.txt"), "one\ntwo\nthree\n").expect("write");
        git(path, &["add", "-A"]).await;
        git(path, &["commit", "-m", "init"]).await;
        path.to_path_buf()
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

    /// The snapshot seeds its scratch index from the checkout's own index for
    /// the stat data. The tree it writes has to be the one a `HEAD` seed would
    /// have written, dirty state and all.
    #[tokio::test]
    async fn the_snapshot_tree_does_not_depend_on_the_seed() {
        let repo = repo_with_commit().await;
        let path = repo.path();
        fs::write(path.join(".gitignore"), "out/\n").expect("write ignore");
        fs::create_dir(path.join("out")).expect("mkdir");
        fs::write(path.join("out/artifact.bin"), "built\n").expect("write ignored");
        fs::write(path.join("out/forced.bin"), "forced\n").expect("write forced");
        git(path, &["add", "--force", "out/forced.bin"]).await;
        fs::write(path.join("staged.txt"), "staged\n").expect("write staged");
        git(path, &["add", "staged.txt"]).await;
        fs::write(path.join("staged.txt"), "staged then edited\n").expect("edit staged");
        fs::write(path.join("kept.txt"), "one\ntwo CHANGED\nthree\n").expect("edit tracked");
        fs::write(path.join("untracked.txt"), "new\n").expect("write untracked");
        git(path, &["rm", "--cached", "--quiet", "kept.txt"]).await;

        let scratch = scratch_index_dir().expect("scratch");
        let reference = scratch.path().join("index");
        git_with_index(path, &reference, &["read-tree", "HEAD"]).await;
        git_with_index(path, &reference, &["add", "--all"]).await;
        let from_head = git_with_index(path, &reference, &["write-tree"]).await;

        let snapshot = snapshot_visible_worktree(path).await.expect("snapshot");
        assert_eq!(snapshot, from_head.trim());
        assert!(
            !git(path, &["ls-tree", "-r", "--name-only", &snapshot])
                .await
                .contains("out/"),
            "a force-staged ignored file stays the caller's, so a rewind cannot touch it"
        );
        // The fingerprint skips that rule, and only that rule.
        let fingerprint = fingerprint_worktree(path).await.expect("fingerprint");
        assert_ne!(fingerprint, snapshot);
        assert!(git(path, &["ls-tree", "-r", "--name-only", &fingerprint])
            .await
            .contains("out/forced.bin"));
    }

    /// An ignored path that HEAD already tracks is not force-staged state: both
    /// seeds carry it, and dropping it would delete it on a rewind.
    #[tokio::test]
    async fn an_ignored_file_that_head_tracks_stays_in_the_snapshot() {
        let repo = repo_with_commit().await;
        let path = repo.path();
        fs::write(path.join("built.log"), "one\n").expect("write");
        git(path, &["add", "built.log"]).await;
        fs::write(path.join(".gitignore"), "built.log\n").expect("write ignore");
        git(path, &["add", ".gitignore"]).await;
        git(path, &["commit", "-m", "track an ignored file"]).await;
        fs::write(path.join("built.log"), "one\ntwo\n").expect("edit");

        let snapshot = snapshot_visible_worktree(path).await.expect("snapshot");
        assert!(git(path, &["ls-tree", "-r", "--name-only", &snapshot])
            .await
            .contains("built.log"));
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

    #[tokio::test]
    async fn index_tree_treats_a_missing_index_as_empty() {
        let repo = TempDir::new().expect("temp dir");
        git(repo.path(), &["init", "--initial-branch=main"]).await;
        let resolved = git(
            repo.path(),
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .await;
        assert!(!Path::new(resolved.trim()).exists());

        let empty_file = repo.path().join("empty-tree");
        fs::write(&empty_file, "").expect("write empty tree source");
        let expected = git(
            repo.path(),
            &["hash-object", "-t", "tree", empty_file.to_str().unwrap()],
        )
        .await;

        assert_eq!(index_tree(repo.path()).await.unwrap(), expected.trim());
    }

    /// The index path is remembered per checkout to save a git process. A linked
    /// worktree keeps its index under the main repository, so moving that
    /// repository moves the index while the worktree stays where it was. The
    /// remembered path has to be asked again rather than read as "this checkout
    /// has no index", which would fingerprint an empty tree.
    #[tokio::test]
    async fn a_remembered_index_path_is_re_resolved_when_the_git_dir_moves() {
        let home = TempDir::new().expect("home dir");
        let origin = home.path().join("origin");
        fs::create_dir(&origin).expect("mkdir origin");
        let repo = repo_at(&origin).await;
        let linked = TempDir::new().expect("linked worktree dir");
        let linked_path = linked.path().to_str().expect("utf-8 path");
        git(&repo, &["worktree", "add", "-b", "linked", linked_path]).await;
        fs::write(linked.path().join("kept.txt"), "linked\n").expect("write");
        git(linked.path(), &["add", "kept.txt"]).await;

        let staged = index_tree(linked.path())
            .await
            .expect("first capture remembers the path");
        let remembered = PathBuf::from(
            git(
                linked.path(),
                &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            )
            .await
            .trim(),
        );

        let moved = home.path().join("moved");
        fs::rename(&repo, &moved).expect("move the main repository");
        git(&moved, &["worktree", "repair", linked_path]).await;
        git(linked.path(), &["worktree", "repair"]).await;
        assert!(!remembered.exists(), "the remembered index path is gone");

        assert_eq!(
            index_tree(linked.path())
                .await
                .expect("re-resolved capture"),
            staged,
            "a moved git dir must be re-resolved, not read as a missing index"
        );
    }

    #[tokio::test]
    async fn index_tree_surfaces_other_index_copy_failures() {
        let repo = TempDir::new().expect("temp dir");
        git(repo.path(), &["init", "--initial-branch=main"]).await;
        let resolved = git(
            repo.path(),
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .await;
        fs::create_dir(resolved.trim()).expect("replace absent index with directory");

        let error = index_tree(repo.path())
            .await
            .expect_err("index copy failure");
        assert!(
            error.to_string().contains("could not copy git index"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn index_tree_reads_a_split_index_in_a_linked_worktree() {
        let repo = repo_with_commit().await;
        let linked = TempDir::new().expect("linked worktree dir");
        let linked_path = linked.path().to_str().expect("utf-8 path");
        git(
            repo.path(),
            &["worktree", "add", "-b", "linked", linked_path],
        )
        .await;
        git(linked.path(), &["update-index", "--split-index"]).await;
        fs::write(linked.path().join("kept.txt"), "linked staged\n").expect("write");
        git(linked.path(), &["add", "kept.txt"]).await;

        let real_index = git(
            linked.path(),
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .await;
        let shared_index = git(
            linked.path(),
            &["rev-parse", "--path-format=absolute", "--shared-index-path"],
        )
        .await;
        assert!(Path::new(real_index.trim()).exists());
        assert!(Path::new(shared_index.trim()).exists());
        assert!(
            real_index.contains(".git/worktrees/"),
            "linked index was {real_index}"
        );
        assert!(
            shared_index.contains(".git/worktrees/"),
            "linked shared index was {shared_index}"
        );

        let expected = git(linked.path(), &["write-tree"]).await;
        assert_eq!(index_tree(linked.path()).await.unwrap(), expected.trim());
    }

    #[tokio::test]
    async fn index_tree_recaptures_when_a_split_index_companion_expires() {
        let repo = repo_with_commit().await;
        let path = repo.path();
        fs::write(path.join("other.txt"), "other\n").expect("write second baseline file");
        git(path, &["add", "other.txt"]).await;
        git(path, &["commit", "-m", "second baseline file"]).await;
        git(path, &["config", "splitIndex.sharedIndexExpire", "now"]).await;
        git(path, &["update-index", "--split-index"]).await;
        let real_index = PathBuf::from(
            git(
                path,
                &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            )
            .await
            .trim(),
        );
        fs::write(path.join("kept.txt"), "second staged generation\n").expect("write");
        git(path, &["add", "kept.txt"]).await;
        let first_shared_index = PathBuf::from(
            git(
                path,
                &["rev-parse", "--path-format=absolute", "--shared-index-path"],
            )
            .await
            .trim(),
        );
        let scratch = TempDir::new().expect("scratch index dir");
        let scratch_index = scratch.path().join("index");
        fs::copy(&real_index, &scratch_index).expect("copy first index generation");

        fs::File::options()
            .write(true)
            .open(&first_shared_index)
            .expect("open first shared index")
            .set_times(fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
            .expect("age first shared index");
        git(path, &["update-index", "--split-index"]).await;
        let second_shared_index = PathBuf::from(
            git(
                path,
                &["rev-parse", "--path-format=absolute", "--shared-index-path"],
            )
            .await
            .trim(),
        );
        assert_ne!(first_shared_index, second_shared_index);
        assert!(!first_shared_index.exists());

        let attempt = finish_index_capture(path, &real_index, scratch.path(), &scratch_index)
            .await
            .expect("classify expired generation");
        assert!(matches!(attempt, IndexCaptureAttempt::Retry(_)));

        let expected = git(path, &["write-tree"]).await;
        assert_eq!(index_tree(path).await.unwrap(), expected.trim());
    }

    #[tokio::test]
    async fn index_tree_refuses_unmerged_entries() {
        let repo = repo_with_commit().await;
        let path = repo.path();
        git(path, &["checkout", "-b", "other"]).await;
        fs::write(path.join("kept.txt"), "other\n").expect("write other");
        git(path, &["commit", "-am", "other"]).await;
        git(path, &["checkout", "main"]).await;
        fs::write(path.join("kept.txt"), "main\n").expect("write main");
        git(path, &["commit", "-am", "main"]).await;
        run_git_text_with_options(path, ["merge", "other"], snapshot_options())
            .await
            .expect_err("merge conflict");

        let error = index_tree(path).await.expect_err("unmerged index");
        assert!(
            error.to_string().contains("unmerged"),
            "unexpected error: {error}"
        );
    }
}
