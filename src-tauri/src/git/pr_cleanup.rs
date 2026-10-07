// PR cleanup (docs/workspaces.md#pr-cleanup): after a PR merges, Argmax does
// the deterministic git cleanup itself, with no model turn. The `pr_cleanup`
// tool, the `prs:cleanup` IPC command, and a watch with `cleanupOnMerge` all
// call `cleanup_merged_pr`.
//
// Cleanup never archives, hides, or deletes the chat. The chat's checkout
// stays, and so does any branch a worktree has checked out.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::gh::service::{gh_working_directory, GhService};
use crate::git::exec::{
    reject_leading_dash, run_git_text, run_git_text_with_allowed_exit_codes, GIT_DEFAULT_TIMEOUT,
};
use crate::git::ops::{checkout_write_lock, resolve_project_remote};
use crate::persistence::database::Database;
use crate::persistence::sessions::find_session_by_id;
use crate::persistence::workspaces::find_workspace_by_id;
use crate::workspaces::orchestration::comparable_worktree_path;

/// `ls-remote`, `push`, and `pull` talk to the network.
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PrCleanupOutcome {
    /// Cleanup did this step.
    Done,
    /// Nothing to do: the branch was already gone, or the base already current.
    AlreadyDone,
    /// Not safe or not applicable, so cleanup left it alone.
    Skipped,
    /// A branch stays because a rule protects it.
    Kept,
    /// The remote branch moved past the merged head, so it stays.
    Diverged,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrCleanupStep {
    pub outcome: PrCleanupOutcome,
    /// The report line without its label, e.g. `origin/fix-parser deleted`.
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrCleanupReport {
    pub pr_number: i64,
    pub branch: String,
    pub base_branch: String,
    pub merged_head: String,
    pub merge_commit: Option<String>,
    pub remote: PrCleanupStep,
    pub base: PrCleanupStep,
    pub local: PrCleanupStep,
    /// The chat's checkout, which cleanup always keeps. `None` when it is not
    /// on disk, for example after the chat was archived.
    pub checkout_path: Option<String>,
    /// The plain-text report, one line per step.
    pub text: String,
}

/// Cleans up after a merged PR of this session's project. Refuses with
/// `PR_NOT_MERGED` unless GitHub reports the PR merged. A step that fails is
/// reported in its line; only a refusal returns `Err`.
pub async fn cleanup_merged_pr(
    database: &Arc<Database>,
    service: &GhService,
    session_id: &str,
    pr_number: i64,
) -> ArgmaxResult<PrCleanupReport> {
    let (cwd, chat_checkout) = {
        let connection = database.read_connection();
        let session = find_session_by_id(&connection, session_id)?;
        let workspace = find_workspace_by_id(&connection, &session.workspace_id)?;
        if workspace.project_id == crate::workspaces::SCRATCH_PROJECT_ID {
            return Err(ArgmaxError::service(
                "PROJECT_NOT_ALLOWED",
                "A side chat has no repository, so it has no pull request to clean up.",
            ));
        }
        let cwd = gh_working_directory(&connection, &workspace)?;
        let chat_checkout = (!workspace.path.is_empty() && Path::new(&workspace.path).is_dir())
            .then(|| PathBuf::from(&workspace.path));
        (cwd, chat_checkout)
    };
    if cwd.is_empty() {
        return Err(ArgmaxError::service(
            "WORKSPACE_NO_PATH",
            "This chat's workspace has no checkout on disk.",
        ));
    }

    // 1. Refresh the PR and record the merged head and merge commit.
    let view = service.view_pr_for_cleanup(&cwd, pr_number).await?;
    let state = view.state.as_deref().unwrap_or("UNKNOWN").to_uppercase();
    if state != "MERGED" {
        return Err(ArgmaxError::service(
            "PR_NOT_MERGED",
            format!(
                "PR #{pr_number} is {}. Cleanup runs only after it merges.",
                state.to_lowercase()
            ),
        ));
    }
    let required = |value: Option<String>, field: &str| {
        value.filter(|value| !value.is_empty()).ok_or_else(|| {
            ArgmaxError::service(
                "GH_INVALID_RESPONSE",
                format!("gh pr view did not return {field} for PR #{pr_number}"),
            )
        })
    };
    let merged_head = required(view.head_ref_oid, "headRefOid")?;
    let branch = required(view.head_ref_name, "headRefName")?;
    let base_branch = required(view.base_ref_name, "baseRefName")?;
    reject_leading_dash("branch", &branch)?;
    reject_leading_dash("base branch", &base_branch)?;
    let merge_commit = view
        .merge_commit
        .map(|commit| commit.oid)
        .filter(|oid| !oid.is_empty());
    let head_owner = view
        .head_repository_owner
        .map(|owner| owner.login)
        .filter(|login| !login.is_empty());
    let cwd = PathBuf::from(cwd);

    // 2. Remote branch.
    let remote = delete_remote_branch(&cwd, &branch, &merged_head, head_owner.as_deref()).await;

    let worktrees = list_worktrees(&cwd).await;
    let (base, local) = match &worktrees {
        Ok(worktrees) => (
            // 3. Base.
            fast_forward_base(database, worktrees, &base_branch, merge_commit.as_deref()).await,
            // 4. Local branch.
            delete_local_branch(
                &cwd,
                worktrees,
                &branch,
                &merged_head,
                chat_checkout.as_deref(),
            )
            .await,
        ),
        Err(error) => (
            step(
                PrCleanupOutcome::Failed,
                format!("{base_branch} not updated (could not list worktrees: {error})"),
            ),
            step(
                PrCleanupOutcome::Failed,
                format!("{branch} not checked (could not list worktrees: {error})"),
            ),
        ),
    };

    // 5. Prune stale remote-tracking refs.
    if let Err(error) = run_git_text(&cwd, ["remote", "prune", "origin"], GIT_NETWORK_TIMEOUT).await
    {
        tracing::warn!(pr_number, ?error, "pr_cleanup: git remote prune failed");
    }

    let checkout_path = chat_checkout.map(|path| path.display().to_string());
    let text = report_text(
        pr_number,
        merge_commit.as_deref(),
        &merged_head,
        [&remote, &base, &local],
        checkout_path.as_deref(),
    );
    Ok(PrCleanupReport {
        pr_number,
        branch,
        base_branch,
        merged_head,
        merge_commit,
        remote,
        base,
        local,
        checkout_path,
        text,
    })
}

fn step(outcome: PrCleanupOutcome, detail: String) -> PrCleanupStep {
    PrCleanupStep { outcome, detail }
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

fn report_text(
    pr_number: i64,
    merge_commit: Option<&str>,
    merged_head: &str,
    [remote, base, local]: [&PrCleanupStep; 3],
    checkout_path: Option<&str>,
) -> String {
    let merged = match merge_commit {
        Some(commit) => format!("merged as {} (head {})", short(commit), short(merged_head)),
        None => format!("merged (head {})", short(merged_head)),
    };
    let chat = match checkout_path {
        Some(path) => format!("kept, checkout {path} kept"),
        None => "kept (its checkout is not on disk)".to_string(),
    };
    format!(
        "PR #{pr_number} {merged}\nRemote: {}\nBase: {}\nLocal: {}\nChat: {chat}",
        remote.detail, base.detail, local.detail
    )
}

/// Deletes `origin/<branch>` only while it still points at the merged head.
/// The lease makes the check and the delete one atomic step on the remote.
async fn delete_remote_branch(
    cwd: &Path,
    branch: &str,
    merged_head: &str,
    head_owner: Option<&str>,
) -> PrCleanupStep {
    let label = format!("origin/{branch}");
    let Some(origin) = resolve_project_remote(cwd).await else {
        return step(
            PrCleanupOutcome::Skipped,
            format!("{label} skipped (origin is not a GitHub remote)"),
        );
    };
    match head_owner {
        Some(owner) if owner.eq_ignore_ascii_case(&origin.owner) => {}
        Some(owner) => {
            return step(
                PrCleanupOutcome::Skipped,
                format!("{label} skipped (fork PR from {owner})"),
            )
        }
        None => {
            return step(
                PrCleanupOutcome::Skipped,
                format!("{label} skipped (the head repository is unknown)"),
            )
        }
    }
    let remote_ref = format!("refs/heads/{branch}");
    match run_git_text(
        cwd,
        ["ls-remote", "--heads", "origin", remote_ref.as_str()],
        GIT_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(listing) if listing.trim().is_empty() => {
            return step(
                PrCleanupOutcome::AlreadyDone,
                format!("{label} already deleted"),
            )
        }
        Ok(_) => {}
        Err(error) => {
            return step(
                PrCleanupOutcome::Failed,
                format!("{label} not checked: {error}"),
            )
        }
    }
    let lease = format!("--force-with-lease={remote_ref}:{merged_head}");
    match run_git_text(
        cwd,
        [
            "push",
            lease.as_str(),
            "origin",
            "--delete",
            remote_ref.as_str(),
        ],
        GIT_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(_) => step(PrCleanupOutcome::Done, format!("{label} deleted")),
        Err(error) if error.to_string().contains("stale info") => step(
            PrCleanupOutcome::Diverged,
            format!(
                "{label} kept (it moved past the merged head {})",
                short(merged_head)
            ),
        ),
        Err(error) => step(
            PrCleanupOutcome::Failed,
            format!("{label} not deleted: {error}"),
        ),
    }
}

#[derive(Debug)]
struct Worktree {
    path: PathBuf,
    /// The branch it has checked out; `None` when detached.
    branch: Option<String>,
}

async fn list_worktrees(cwd: &Path) -> ArgmaxResult<Vec<Worktree>> {
    let stdout = run_git_text(
        cwd,
        ["worktree", "list", "--porcelain"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await?;
    let mut worktrees = Vec::new();
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            worktrees.push(Worktree {
                path: PathBuf::from(path),
                branch: None,
            });
        } else if let (Some(branch), Some(worktree)) = (
            line.strip_prefix("branch refs/heads/"),
            worktrees.last_mut(),
        ) {
            worktree.branch = Some(branch.to_string());
        }
    }
    Ok(worktrees)
}

/// The worktree that is rebasing or bisecting `local_ref`. `worktree list`
/// shows such a worktree as detached, and `update-ref -d` skips the guard
/// `git branch -d` has, so deleting the ref would strand the operation.
async fn branch_operation_owner<'a>(
    worktrees: &'a [Worktree],
    local_ref: &str,
) -> Option<&'a Path> {
    for worktree in worktrees
        .iter()
        .filter(|worktree| worktree.branch.is_none())
    {
        let Ok(git_dir) = run_git_text(
            &worktree.path,
            ["rev-parse", "--absolute-git-dir"],
            GIT_DEFAULT_TIMEOUT,
        )
        .await
        else {
            continue;
        };
        let git_dir = PathBuf::from(git_dir.trim());
        let head_names = ["rebase-merge/head-name", "rebase-apply/head-name"];
        for file in head_names {
            if let Ok(name) = tokio::fs::read_to_string(git_dir.join(file)).await {
                if name.trim() == local_ref {
                    return Some(&worktree.path);
                }
            }
        }
        // BISECT_START holds the branch name, without `refs/heads/`.
        if let Ok(start) = tokio::fs::read_to_string(git_dir.join("BISECT_START")).await {
            if local_ref.strip_prefix("refs/heads/") == Some(start.trim()) {
                return Some(&worktree.path);
            }
        }
    }
    None
}

fn same_checkout(left: &Path, right: &Path) -> bool {
    comparable_worktree_path(left) == comparable_worktree_path(right)
}

/// A turn is live in this checkout. A lookup error counts as busy, so cleanup
/// only skips the step.
fn checkout_is_busy(database: &Database, checkout: &Path) -> bool {
    let connection = database.read_connection();
    let paths: ArgmaxResult<Vec<String>> = (|| {
        let mut statement = connection
            .prepare(
                "SELECT DISTINCT w.path FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
                 WHERE s.state IN ('running', 'waiting', 'blocked') AND w.path != ''",
            )
            .map_err(crate::persistence::sqlite_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(crate::persistence::sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(crate::persistence::sqlite_error)?;
        Ok(rows)
    })();
    match paths {
        Ok(paths) => paths
            .iter()
            .any(|path| same_checkout(Path::new(path), checkout)),
        Err(error) => {
            tracing::warn!(?error, "pr_cleanup: busy-checkout lookup failed");
            true
        }
    }
}

/// Fast-forwards the base only in the worktree that has it checked out, and
/// only when that worktree is clean and no turn is running in it.
async fn fast_forward_base(
    database: &Database,
    worktrees: &[Worktree],
    base_branch: &str,
    merge_commit: Option<&str>,
) -> PrCleanupStep {
    let Some(worktree) = worktrees
        .iter()
        .find(|worktree| worktree.branch.as_deref() == Some(base_branch))
    else {
        return step(
            PrCleanupOutcome::Skipped,
            format!("{base_branch} skipped (no worktree has it checked out)"),
        );
    };
    let path = worktree.path.as_path();
    let shown = path.display();
    let lock = match checkout_write_lock(path).await {
        Ok(lock) => lock,
        Err(error) => {
            return step(
                PrCleanupOutcome::Failed,
                format!("{base_branch} not updated in {shown}: {error}"),
            )
        }
    };
    let _guard = lock.lock().await;
    // Checked under the lock: a turn marks its session running while it holds
    // this lock, so no turn can start between this check and the pull.
    if checkout_is_busy(database, path) {
        return step(
            PrCleanupOutcome::Skipped,
            format!("{base_branch} skipped (a turn is running in {shown})"),
        );
    }
    match run_git_text(
        path,
        ["status", "--porcelain", "--untracked-files=no"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(status) if status.trim().is_empty() => {}
        Ok(_) => {
            return step(
                PrCleanupOutcome::Skipped,
                format!("{base_branch} skipped ({shown} has uncommitted changes)"),
            )
        }
        Err(error) => {
            return step(
                PrCleanupOutcome::Failed,
                format!("{base_branch} not updated in {shown}: {error}"),
            )
        }
    }
    let before = rev_parse(path, "HEAD").await;
    if let Err(error) = run_git_text(
        path,
        ["pull", "--ff-only", "origin", base_branch],
        GIT_NETWORK_TIMEOUT,
    )
    .await
    {
        return step(
            PrCleanupOutcome::Failed,
            format!("{base_branch} not fast-forwarded in {shown}: {error}"),
        );
    }
    let moved = before != rev_parse(path, "HEAD").await;
    let mut detail = if moved {
        format!("{base_branch} fast-forwarded in {shown}")
    } else {
        format!("{base_branch} already current in {shown}")
    };
    if let Some(commit) = merge_commit {
        let contains = run_git_text_with_allowed_exit_codes(
            path,
            ["merge-base", "--is-ancestor", commit, "HEAD"],
            &[1],
            GIT_DEFAULT_TIMEOUT,
        )
        .await
        .is_ok_and(|exit| exit.exit_code == 0);
        if !contains {
            detail.push_str(&format!(
                ", but merge commit {} is not in it",
                short(commit)
            ));
        }
    }
    step(
        if moved {
            PrCleanupOutcome::Done
        } else {
            PrCleanupOutcome::AlreadyDone
        },
        detail,
    )
}

async fn rev_parse(path: &Path, rev: &str) -> Option<String> {
    run_git_text_with_allowed_exit_codes(
        path,
        ["rev-parse", "--verify", "--quiet", rev],
        &[1],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .map(|exit| exit.stdout.trim().to_string())
    .filter(|sha| !sha.is_empty())
}

/// Deletes the local branch only when no worktree has it checked out and its
/// tip is the merged head. `update-ref` compares the old value, so a commit
/// that lands between the check and the delete keeps the branch.
async fn delete_local_branch(
    cwd: &Path,
    worktrees: &[Worktree],
    branch: &str,
    merged_head: &str,
    chat_checkout: Option<&Path>,
) -> PrCleanupStep {
    let local_ref = format!("refs/heads/{branch}");
    let Some(tip) = rev_parse(cwd, &local_ref).await else {
        return step(
            PrCleanupOutcome::AlreadyDone,
            format!("{branch} not present"),
        );
    };
    if let Some(worktree) = worktrees
        .iter()
        .find(|worktree| worktree.branch.as_deref() == Some(branch))
    {
        let owner = if chat_checkout.is_some_and(|chat| same_checkout(chat, &worktree.path)) {
            "this chat's worktree".to_string()
        } else {
            worktree.path.display().to_string()
        };
        return step(
            PrCleanupOutcome::Kept,
            format!("{branch} kept (checked out by {owner})"),
        );
    }
    if let Some(worktree) = branch_operation_owner(worktrees, &local_ref).await {
        return step(
            PrCleanupOutcome::Kept,
            format!(
                "{branch} kept (a rebase or bisect is in progress in {})",
                worktree.display()
            ),
        );
    }
    if tip != merged_head {
        let has_later_commits = run_git_text_with_allowed_exit_codes(
            cwd,
            ["merge-base", "--is-ancestor", merged_head, tip.as_str()],
            &[1],
            GIT_DEFAULT_TIMEOUT,
        )
        .await
        .is_ok_and(|exit| exit.exit_code == 0);
        let reason = if has_later_commits {
            format!(
                "it has commits after the merged head {}",
                short(merged_head)
            )
        } else {
            format!(
                "its tip {} is not the merged head {}",
                short(&tip),
                short(merged_head)
            )
        };
        return step(PrCleanupOutcome::Kept, format!("{branch} kept ({reason})"));
    }
    if let Err(error) = run_git_text(
        cwd,
        ["update-ref", "-d", local_ref.as_str(), merged_head],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    {
        return step(
            PrCleanupOutcome::Failed,
            format!("{branch} not deleted: {error}"),
        );
    }
    // `branch -D` would also drop the branch's config. Exit 128 means there
    // was none.
    let section = format!("branch.{branch}");
    let _ = run_git_text_with_allowed_exit_codes(
        cwd,
        ["config", "--remove-section", section.as_str()],
        &[128],
        GIT_DEFAULT_TIMEOUT,
    )
    .await;
    step(PrCleanupOutcome::Done, format!("{branch} deleted"))
}

/// A real repository for cleanup tests: a bare `origin` reached through a
/// GitHub URL (`url.<bare>.insteadOf`), a main checkout on `main`, a chat
/// worktree, and `fix-parser` pushed and then squash-merged into `main` on
/// the remote only.
#[cfg(test)]
pub(crate) mod test_repo {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use tempfile::TempDir;

    use crate::git::exec::{run_git_text, GIT_DEFAULT_TIMEOUT};
    use crate::persistence::database::Database;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use crate::sessions::state::SessionState;
    use crate::util::gh_runner::GhRunner;

    pub const BRANCH: &str = "fix-parser";

    pub struct MergedRepo {
        pub _root: TempDir,
        pub main: PathBuf,
        pub chat: PathBuf,
        pub merged_head: String,
        pub merge_commit: String,
    }

    pub async fn git(dir: &Path, args: &[&str]) -> String {
        run_git_text(dir, args, GIT_DEFAULT_TIMEOUT)
            .await
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"))
            .trim()
            .to_string()
    }

    /// `chat_has_branch`: the chat's worktree has `fix-parser` checked out,
    /// as an isolated chat does. Otherwise it is detached.
    pub async fn merged_repo(chat_has_branch: bool) -> MergedRepo {
        let root = TempDir::new().expect("temp dir");
        let base = root.path().canonicalize().expect("canonical temp dir");
        let bare = base.join("remote.git");
        let main = base.join("repo");
        let chat = base.join("chat");
        std::fs::create_dir_all(&bare).expect("bare dir");
        std::fs::create_dir_all(&main).expect("main dir");
        git(&bare, &["init", "-q", "--bare", "-b", "main"]).await;
        git(&main, &["init", "-q", "-b", "main"]).await;
        git(&main, &["config", "user.email", "test@argmax.dev"]).await;
        git(&main, &["config", "user.name", "Argmax Test"]).await;
        git(&main, &["config", "commit.gpgsign", "false"]).await;
        let github = "https://github.com/acme/widgets.git";
        git(&main, &["remote", "add", "origin", github]).await;
        let rewrite = format!("url.{}.insteadOf", bare.display());
        git(&main, &["config", &rewrite, github]).await;
        std::fs::write(main.join("README.md"), "hello\n").expect("readme");
        git(&main, &["add", "README.md"]).await;
        git(&main, &["commit", "-q", "-m", "init"]).await;
        git(&main, &["push", "-q", "-u", "origin", "main"]).await;

        if chat_has_branch {
            git(
                &main,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    BRANCH,
                    chat.to_str().unwrap(),
                    "main",
                ],
            )
            .await;
        } else {
            git(&main, &["branch", BRANCH, "main"]).await;
            git(
                &main,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "--detach",
                    chat.to_str().unwrap(),
                    "main",
                ],
            )
            .await;
        }
        let tree = git(&main, &["rev-parse", "main^{tree}"]).await;
        let feature = git(
            &main,
            &["commit-tree", &tree, "-p", "main", "-m", "fix parser"],
        )
        .await;
        git(
            &main,
            &["update-ref", &format!("refs/heads/{BRANCH}"), &feature],
        )
        .await;
        if chat_has_branch {
            git(&chat, &["reset", "-q", "--hard", BRANCH]).await;
        }
        git(&main, &["push", "-q", "origin", BRANCH]).await;
        // GitHub's squash merge: a new commit on the remote's main.
        let squash = git(
            &main,
            &["commit-tree", &tree, "-p", "main", "-m", "Fix parser (#72)"],
        )
        .await;
        git(
            &main,
            &["push", "-q", "origin", &format!("{squash}:refs/heads/main")],
        )
        .await;
        MergedRepo {
            _root: root,
            main,
            chat,
            merged_head: feature,
            merge_commit: squash,
        }
    }

    /// Project `p1`, the chat's workspace `w1` at `chat`, and session `s1`.
    pub fn seed_chat(database: &Arc<Database>, repo: &MergedRepo) {
        let conn = database.connection();
        persist_project(
            &conn,
            &PersistProjectInput {
                id: "p1".to_string(),
                name: "widgets".to_string(),
                repo_path: repo.main.display().to_string(),
                default_branch: Some("main".to_string()),
                current_branch: "main".to_string(),
                settings: ProjectSettings {
                    merge_cleanup: Default::default(),
                    worktree_location: "sibling".to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("project");
        drop(conn);
        seed_session(database, "w1", "s1", &repo.chat, SessionState::Complete);
    }

    pub fn seed_session(
        database: &Arc<Database>,
        workspace_id: &str,
        session_id: &str,
        path: &Path,
        state: SessionState,
    ) {
        let conn = database.connection();
        persist_workspace(
            &conn,
            &PersistWorkspaceInput {
                id: workspace_id.to_string(),
                project_id: "p1".to_string(),
                task_label: workspace_id.to_string(),
                branch: BRANCH.to_string(),
                base_ref: "main".to_string(),
                path: path.display().to_string(),
                state: "created".to_string(),
                shared_workspace: false,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("workspace");
        persist_session(
            &conn,
            &PersistSessionInput {
                id: session_id.to_string(),
                workspace_id: workspace_id.to_string(),
                provider: "claude".to_string(),
                model_label: "Haiku 4.5".to_string(),
                model_id: "claude-haiku-4-5".to_string(),
                reasoning_effort: None,
                permission_mode: None,
                agent_mode: None,
                prompt: "land it".to_string(),
                state,
            },
        )
        .expect("session");
    }

    /// `gh pr view 72` for the merged PR, from `owner`'s repository.
    pub fn gh_view(repo: &MergedRepo, state: &str, owner: &str) -> GhRunner {
        let payload = serde_json::json!({
            "number": 72,
            "state": state,
            "url": "https://github.com/acme/widgets/pull/72",
            "headRefOid": repo.merged_head,
            "headRefName": BRANCH,
            "baseRefName": "main",
            "headRepositoryOwner": {"login": owner},
            "mergeCommit": {"oid": repo.merge_commit},
        })
        .to_string();
        Arc::new(move |_cwd, _args| {
            let payload = payload.clone();
            Box::pin(async move { Ok(payload) })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::test_repo::*;
    use super::*;
    use crate::sessions::state::SessionState;
    use tempfile::TempDir;

    struct Run {
        _data: TempDir,
        database: Arc<Database>,
    }

    fn database(repo: &MergedRepo) -> Run {
        let data = TempDir::new().expect("data dir");
        let database = Arc::new(Database::open(data.path().join("argmax.sqlite")).expect("db"));
        seed_chat(&database, repo);
        Run {
            _data: data,
            database,
        }
    }

    async fn cleanup(run: &Run, repo: &MergedRepo, owner: &str) -> PrCleanupReport {
        let service =
            GhService::with_runner(Arc::clone(&run.database), gh_view(repo, "MERGED", owner));
        cleanup_merged_pr(&run.database, &service, "s1", 72)
            .await
            .expect("cleanup")
    }

    async fn remote_has_branch(repo: &MergedRepo) -> bool {
        !git(&repo.main, &["ls-remote", "--heads", "origin", BRANCH])
            .await
            .is_empty()
    }

    async fn local_branch(repo: &MergedRepo) -> Option<String> {
        rev_parse(&repo.main, &format!("refs/heads/{BRANCH}")).await
    }

    #[tokio::test]
    async fn cleanup_deletes_the_merged_branch_and_fast_forwards_the_base() {
        let repo = merged_repo(false).await;
        let run = database(&repo);
        let report = cleanup(&run, &repo, "acme").await;

        assert_eq!(
            report.text,
            format!(
                "PR #72 merged as {} (head {})\nRemote: origin/fix-parser deleted\n\
Base: main fast-forwarded in {}\nLocal: fix-parser deleted\nChat: kept, checkout {} kept",
                &repo.merge_commit[..7],
                &repo.merged_head[..7],
                repo.main.display(),
                repo.chat.display()
            )
        );
        assert_eq!(report.remote.outcome, PrCleanupOutcome::Done);
        assert!(!remote_has_branch(&repo).await);
        assert_eq!(
            git(&repo.main, &["rev-parse", "HEAD"]).await,
            repo.merge_commit
        );
        assert_eq!(local_branch(&repo).await, None);
        assert!(repo.chat.is_dir(), "the chat's checkout stays");
    }

    #[tokio::test]
    async fn cleanup_reports_a_remote_branch_github_already_deleted() {
        let repo = merged_repo(false).await;
        git(&repo.main, &["push", "-q", "origin", "--delete", BRANCH]).await;
        let run = database(&repo);
        let report = cleanup(&run, &repo, "acme").await;
        assert_eq!(report.remote.outcome, PrCleanupOutcome::AlreadyDone);
        assert_eq!(report.remote.detail, "origin/fix-parser already deleted");
        assert_eq!(report.local.outcome, PrCleanupOutcome::Done);
    }

    #[tokio::test]
    async fn cleanup_keeps_a_remote_branch_that_moved_past_the_merged_head() {
        let repo = merged_repo(false).await;
        let tree = git(&repo.main, &["rev-parse", "main^{tree}"]).await;
        let later = git(
            &repo.main,
            &["commit-tree", &tree, "-p", &repo.merged_head, "-m", "late"],
        )
        .await;
        git(
            &repo.main,
            &[
                "push",
                "-q",
                "origin",
                &format!("{later}:refs/heads/{BRANCH}"),
            ],
        )
        .await;
        let run = database(&repo);
        let report = cleanup(&run, &repo, "acme").await;
        assert_eq!(
            report.remote.outcome,
            PrCleanupOutcome::Diverged,
            "{}",
            report.text
        );
        assert_eq!(
            report.remote.detail,
            format!(
                "origin/fix-parser kept (it moved past the merged head {})",
                &repo.merged_head[..7]
            )
        );
        assert!(remote_has_branch(&repo).await, "the lease kept it");
    }

    #[tokio::test]
    async fn cleanup_skips_a_dirty_base() {
        let repo = merged_repo(false).await;
        std::fs::write(repo.main.join("README.md"), "local edit\n").expect("edit");
        let before = git(&repo.main, &["rev-parse", "HEAD"]).await;
        let run = database(&repo);
        let report = cleanup(&run, &repo, "acme").await;
        assert_eq!(report.base.outcome, PrCleanupOutcome::Skipped);
        assert_eq!(
            report.base.detail,
            format!(
                "main skipped ({} has uncommitted changes)",
                repo.main.display()
            )
        );
        assert_eq!(git(&repo.main, &["rev-parse", "HEAD"]).await, before);
    }

    #[tokio::test]
    async fn cleanup_skips_a_base_where_a_turn_is_running() {
        let repo = merged_repo(false).await;
        let run = database(&repo);
        seed_session(
            &run.database,
            "w-main",
            "s-main",
            &repo.main,
            SessionState::Running,
        );
        let before = git(&repo.main, &["rev-parse", "HEAD"]).await;
        let report = cleanup(&run, &repo, "acme").await;
        assert_eq!(report.base.outcome, PrCleanupOutcome::Skipped);
        assert_eq!(
            report.base.detail,
            format!(
                "main skipped (a turn is running in {})",
                repo.main.display()
            )
        );
        assert_eq!(git(&repo.main, &["rev-parse", "HEAD"]).await, before);
    }

    #[tokio::test]
    async fn cleanup_keeps_the_branch_the_chats_worktree_has_checked_out() {
        let repo = merged_repo(true).await;
        let run = database(&repo);
        let report = cleanup(&run, &repo, "acme").await;
        assert_eq!(report.local.outcome, PrCleanupOutcome::Kept);
        assert_eq!(
            report.local.detail,
            "fix-parser kept (checked out by this chat's worktree)"
        );
        assert_eq!(
            local_branch(&repo).await.as_deref(),
            Some(repo.merged_head.as_str())
        );
        assert_eq!(report.remote.outcome, PrCleanupOutcome::Done);
        assert!(report.text.ends_with(&format!(
            "Chat: kept, checkout {} kept",
            repo.chat.display()
        )));
    }

    #[tokio::test]
    async fn cleanup_keeps_a_branch_that_a_worktree_is_rebasing() {
        let repo = merged_repo(true).await;
        // A rebase that stops on its exec step leaves the worktree detached,
        // with the branch ref still at the merged head until it finishes.
        let parent = format!("{}^", repo.merged_head);
        let stopped = run_git_text(
            &repo.chat,
            [
                "rebase",
                "--force-rebase",
                "--exec",
                "false",
                parent.as_str(),
            ],
            GIT_DEFAULT_TIMEOUT,
        )
        .await;
        assert!(stopped.is_err(), "the rebase should stop on its exec step");
        let run = database(&repo);
        let report = cleanup(&run, &repo, "acme").await;
        assert_eq!(report.local.outcome, PrCleanupOutcome::Kept);
        assert_eq!(
            report.local.detail,
            format!(
                "fix-parser kept (a rebase or bisect is in progress in {})",
                repo.chat.display()
            )
        );
        assert_eq!(
            local_branch(&repo).await.as_deref(),
            Some(repo.merged_head.as_str())
        );
        git(&repo.chat, &["rebase", "--abort"]).await;
    }

    #[tokio::test]
    async fn cleanup_leaves_a_fork_prs_remote_branch_alone() {
        let repo = merged_repo(false).await;
        let run = database(&repo);
        let report = cleanup(&run, &repo, "forker").await;
        assert_eq!(report.remote.outcome, PrCleanupOutcome::Skipped);
        assert_eq!(
            report.remote.detail,
            "origin/fix-parser skipped (fork PR from forker)"
        );
        assert!(remote_has_branch(&repo).await);
    }

    #[tokio::test]
    async fn cleanup_keeps_a_local_branch_with_a_later_commit() {
        let repo = merged_repo(false).await;
        let tree = git(&repo.main, &["rev-parse", "main^{tree}"]).await;
        let later = git(
            &repo.main,
            &["commit-tree", &tree, "-p", &repo.merged_head, "-m", "more"],
        )
        .await;
        git(
            &repo.main,
            &["update-ref", &format!("refs/heads/{BRANCH}"), &later],
        )
        .await;
        let run = database(&repo);
        let report = cleanup(&run, &repo, "acme").await;
        assert_eq!(report.local.outcome, PrCleanupOutcome::Kept);
        assert_eq!(
            report.local.detail,
            format!(
                "fix-parser kept (it has commits after the merged head {})",
                &repo.merged_head[..7]
            )
        );
        assert_eq!(local_branch(&repo).await, Some(later));
    }

    #[tokio::test]
    async fn cleanup_refuses_a_pr_that_has_not_merged() {
        let repo = merged_repo(false).await;
        let run = database(&repo);
        let service =
            GhService::with_runner(Arc::clone(&run.database), gh_view(&repo, "OPEN", "acme"));
        let error = cleanup_merged_pr(&run.database, &service, "s1", 72)
            .await
            .expect_err("open PR");
        assert!(
            matches!(&error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "PR_NOT_MERGED"),
            "{error}"
        );
        assert!(remote_has_branch(&repo).await, "nothing was touched");
    }
}
