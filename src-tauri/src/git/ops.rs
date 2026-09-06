// GitOpsService owns the operations the renderer's git dropdown drives:
// stage+commit-all, push (with first-time `-u origin <branch>` upgrade),
// create-and-checkout-branch, and the view-or-create PR flow.

use std::{future::Future, path::Path, pin::Pin, sync::Arc, time::Duration};

use regex::Regex;
use serde::Serialize;
use specta::Type;
use tempfile::tempdir;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::exec::{run_git_text, run_git_text_with_options, GitExecOptions};
use crate::persistence::database::Database;
use crate::persistence::gh::{
    latest_pr_for_branch, latest_pr_for_workspace, list_gh_pr_for_session, GhPrRecord,
};
use crate::persistence::projects::{get_project_remote, update_project_remote, ProjectRemote};
use crate::persistence::sessions::find_session_by_id;
use crate::persistence::workspaces::find_workspace_by_id;
use crate::util::gh_runner::{default_gh_runner, GhRunner};

const GIT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq)]
pub struct GitCommitInput {
    pub workspace_id: String,
    pub message: String,
    pub selected_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub commit_sha: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitPushInput {
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    pub branch: String,
    pub upstream_set: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitCreateBranchInput {
    pub workspace_id: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCreateBranchResult {
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitViewOrCreatePrInput {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum GitViewOrCreatePrResult {
    Opened {
        #[serde(rename = "url")]
        url: String,
        #[serde(rename = "prNumber")]
        pr_number: i64,
    },
    Created {
        #[serde(rename = "url")]
        url: String,
        #[serde(rename = "prNumber")]
        pr_number: Option<i64>,
    },
}

/// Refresh hook: after `gh pr create` succeeds, the gh poller / service
/// re-reads PR rows for the session so the next dropdown press hits the
/// cache. Returns the refreshed rows so we can pick the matching PR.
pub type RefreshPrFn = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = ArgmaxResult<Vec<GhPrRecord>>> + Send>>
        + Send
        + Sync,
>;

pub struct GitOpsService {
    database: Arc<Database>,
    gh_runner: GhRunner,
    refresh_pr: Option<RefreshPrFn>,
}

impl GitOpsService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Arc::new(Self {
            database,
            gh_runner: default_gh_runner(),
            refresh_pr: None,
        })
    }

    pub fn with_runners(
        database: Arc<Database>,
        gh_runner: GhRunner,
        refresh_pr: Option<RefreshPrFn>,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            gh_runner,
            refresh_pr,
        })
    }

    pub async fn commit_all(&self, input: GitCommitInput) -> ArgmaxResult<GitCommitResult> {
        let workspace = {
            let conn = self.database.connection();
            find_workspace_by_id(&conn, &input.workspace_id)?
        };
        if workspace.path.is_empty() {
            return Err(ArgmaxError::service(
                "WORKSPACE_NO_PATH",
                "Workspace has no path on disk yet.",
            ));
        }
        let message = input.message.trim();
        let selected: Vec<&str> = input
            .selected_files
            .iter()
            .map(|path| path.as_str())
            .filter(|path| !path.trim().is_empty())
            .collect();
        // `git commit -m -- msg` is not valid syntax; reject leading `-`
        // so a message that looks like a flag never reaches git.
        if message.starts_with('-') {
            return Err(ArgmaxError::service(
                "GIT_COMMIT_MESSAGE_LEADING_DASH",
                "Commit message cannot start with '-'",
            ));
        }
        if selected.is_empty() {
            run_git_text(&workspace.path, ["add", "-A"], GIT_TIMEOUT).await?;
            run_git_text(&workspace.path, ["commit", "-m", message], GIT_TIMEOUT).await?;
        } else {
            commit_selected_files(Path::new(&workspace.path), &selected, message).await?;
        }
        let sha = run_git_text(&workspace.path, ["rev-parse", "HEAD"], GIT_TIMEOUT).await?;
        let branch = run_git_text(&workspace.path, ["branch", "--show-current"], GIT_TIMEOUT)
            .await?
            .trim()
            .to_string();
        Ok(GitCommitResult {
            commit_sha: sha.trim().to_string(),
            branch: if branch.is_empty() {
                workspace.branch
            } else {
                branch
            },
        })
    }

    pub async fn push(&self, input: GitPushInput) -> ArgmaxResult<GitPushResult> {
        let workspace = {
            let conn = self.database.connection();
            find_workspace_by_id(&conn, &input.workspace_id)?
        };
        if workspace.path.is_empty() {
            return Err(ArgmaxError::service(
                "WORKSPACE_NO_PATH",
                "Workspace has no path on disk yet.",
            ));
        }
        let branch = run_git_text(&workspace.path, ["branch", "--show-current"], GIT_TIMEOUT)
            .await?
            .trim()
            .to_string();
        let branch = if branch.is_empty() {
            workspace.branch.clone()
        } else {
            branch
        };

        match run_git_text(&workspace.path, ["push"], GIT_TIMEOUT).await {
            Ok(_) => Ok(GitPushResult {
                branch,
                upstream_set: false,
            }),
            Err(error) if is_missing_upstream_error(&error) => {
                // First push for this branch — set upstream so subsequent
                // pushes don't need -u. Branch name is schema-validated.
                run_git_text(
                    &workspace.path,
                    ["push", "-u", "origin", branch.as_str()],
                    GIT_TIMEOUT,
                )
                .await?;
                Ok(GitPushResult {
                    branch,
                    upstream_set: true,
                })
            }
            Err(error) => Err(error),
        }
    }

    pub async fn create_branch(
        &self,
        input: GitCreateBranchInput,
    ) -> ArgmaxResult<GitCreateBranchResult> {
        let workspace = {
            let conn = self.database.connection();
            find_workspace_by_id(&conn, &input.workspace_id)?
        };
        if workspace.path.is_empty() {
            return Err(ArgmaxError::service(
                "WORKSPACE_NO_PATH",
                "Workspace has no path on disk yet.",
            ));
        }
        run_git_text(
            &workspace.path,
            ["checkout", "-b", input.branch.as_str()],
            GIT_TIMEOUT,
        )
        .await?;
        Ok(GitCreateBranchResult {
            branch: input.branch,
        })
    }

    pub async fn view_or_create_pr(
        &self,
        input: GitViewOrCreatePrInput,
    ) -> ArgmaxResult<GitViewOrCreatePrResult> {
        let (session, workspace) = {
            let conn = self.database.connection();
            let session = find_session_by_id(&conn, &input.session_id)?;
            let workspace = find_workspace_by_id(&conn, &session.workspace_id)?;
            (session, workspace)
        };
        if workspace.path.is_empty() {
            return Err(ArgmaxError::service(
                "WORKSPACE_NO_PATH",
                "Workspace has no path on disk yet.",
            ));
        }

        // Resolved by branch, matching what `gh pr create` would do in this
        // checkout. Keying off this session's own rows would miss a PR opened
        // from another session on the same branch and fall through to a create
        // that `gh` then rejects — and, on a workspace whose checkout has since
        // moved, would open a stale PR from the branch it used to be on.
        let existing = {
            let conn = self.database.connection();
            latest_pr_for_branch(&conn, &workspace.project_id, &workspace.branch)?.or_else(|| {
                latest_pr_for_workspace(
                    &conn,
                    &workspace.id,
                    &workspace.project_id,
                    &workspace.branch,
                )
                .ok()
                .flatten()
            })
        };
        let known_pr_number = existing
            .as_ref()
            .map(|top| top.pr_number)
            .or(workspace.pr_number);

        if let Some(pr_number) = known_pr_number {
            // First check if the project already has its remote owner and name recorded.
            let remote = {
                let conn = self.database.connection();
                get_project_remote(&conn, &workspace.project_id)?
            };
            if let Some(remote) = remote {
                return Ok(GitViewOrCreatePrResult::Opened {
                    url: format!(
                        "https://github.com/{}/{}/pull/{}",
                        remote.owner, remote.name, pr_number
                    ),
                    pr_number,
                });
            }

            // Discover the remote from the git workspace if not yet recorded in SQLite.
            if let Some(remote) = resolve_project_remote(Path::new(&workspace.path)).await {
                let conn = self.database.connection();
                let _ = update_project_remote(&conn, &workspace.project_id, Some(&remote));
                return Ok(GitViewOrCreatePrResult::Opened {
                    url: format!(
                        "https://github.com/{}/{}/pull/{}",
                        remote.owner, remote.name, pr_number
                    ),
                    pr_number,
                });
            }

            // If git remote inspection failed, query gh for the PR URL directly.
            let view_output = (self.gh_runner)(
                workspace.path.clone(),
                vec![
                    "pr".into(),
                    "view".into(),
                    pr_number.to_string(),
                    "--json".into(),
                    "url".into(),
                ],
            )
            .await;
            if let Ok(stdout) = view_output {
                if let Some(url) = extract_pr_url(&stdout) {
                    if let Some(remote) = extract_github_remote_from_url(&url) {
                        let conn = self.database.connection();
                        let _ = update_project_remote(&conn, &workspace.project_id, Some(&remote));
                    }
                    return Ok(GitViewOrCreatePrResult::Opened { url, pr_number });
                }
            }

            // A PR is known to exist, so we must never fall through to `gh pr create`.
            return Err(ArgmaxError::service(
                "GH_PR_URL_FAILED",
                format!("Pull request #{pr_number} exists, but could not resolve its GitHub URL."),
            ));
        }

        let create_result = (self.gh_runner)(
            workspace.path.clone(),
            vec!["pr".into(), "create".into(), "--fill".into()],
        )
        .await;

        let stdout = match create_result {
            Ok(stdout) => stdout,
            Err(error) => {
                let error_text = error.to_string();
                if let Some(existing_url) = extract_pr_url(&error_text) {
                    if let Some(pr_number) = extract_pr_number(&existing_url) {
                        if let Some(remote) = extract_github_remote_from_url(&existing_url) {
                            let conn = self.database.connection();
                            let _ =
                                update_project_remote(&conn, &workspace.project_id, Some(&remote));
                        }
                        if let Some(refresh) = self.refresh_pr.as_ref() {
                            let _ = refresh(session.id.clone()).await;
                        }
                        return Ok(GitViewOrCreatePrResult::Opened {
                            url: existing_url,
                            pr_number,
                        });
                    }
                }
                return Err(error);
            }
        };

        let url = extract_pr_url(&stdout).ok_or_else(|| {
            ArgmaxError::service(
                "GH_PR_URL_MISSING",
                format!(
                    "gh pr create did not return a PR URL: {}",
                    stdout.chars().take(256).collect::<String>()
                ),
            )
        })?;

        if let Some(remote) = extract_github_remote_from_url(&url) {
            let conn = self.database.connection();
            let _ = update_project_remote(&conn, &workspace.project_id, Some(&remote));
        }

        let refreshed = if let Some(refresh) = self.refresh_pr.as_ref() {
            refresh(session.id.clone()).await?
        } else {
            // No refresh hook wired yet — fall back to whatever is in the
            // DB (will likely be empty until 8.1 lands).
            let conn = self.database.connection();
            list_gh_pr_for_session(&conn, &session.id)?
        };
        let created = refreshed
            .iter()
            .find(|row| url_matches_pr(&url, row.pr_number))
            .or_else(|| most_recent(&refreshed));
        Ok(GitViewOrCreatePrResult::Created {
            url: url.clone(),
            pr_number: created
                .map(|row| row.pr_number)
                .or_else(|| extract_pr_number(&url)),
        })
    }
}

async fn commit_selected_files(
    workspace_path: &Path,
    selected: &[&str],
    message: &str,
) -> ArgmaxResult<()> {
    let temp_dir = tempdir().map_err(|error| {
        ArgmaxError::service(
            "GIT_TEMP_INDEX_FAILED",
            format!("could not create temp git index: {error}"),
        )
    })?;
    let temp_index = temp_dir.path().join("index");
    let opts = || {
        let mut options =
            GitExecOptions::default().with_env("GIT_INDEX_FILE", temp_index.as_os_str());
        options.timeout = GIT_TIMEOUT;
        options
    };

    run_git_text_with_options(workspace_path, ["read-tree", "HEAD"], opts()).await?;
    let mut add_args: Vec<&str> = vec!["add", "--"];
    add_args.extend_from_slice(selected);
    run_git_text_with_options(workspace_path, add_args, opts()).await?;
    run_git_text_with_options(workspace_path, ["commit", "-m", message], opts()).await?;

    let mut reset_args: Vec<&str> = vec!["reset", "-q", "--"];
    reset_args.extend_from_slice(selected);
    run_git_text(workspace_path, reset_args, GIT_TIMEOUT)
        .await
        .map(|_| ())
}

fn is_missing_upstream_error(error: &ArgmaxError) -> bool {
    let message = error.to_string().to_lowercase();
    message.contains("no upstream branch")
        || message.contains("set-upstream")
        || message.contains("has no upstream")
}

fn most_recent(rows: &[GhPrRecord]) -> Option<&GhPrRecord> {
    rows.iter().max_by(|a, b| a.updated_at.cmp(&b.updated_at))
}

fn url_matches_pr(url: &str, pr_number: i64) -> bool {
    // Mirrors the TS regex `/pull/${prNumber}(?:[/?#]|$)`.
    let pattern = format!(r"/pull/{pr_number}([/?#]|$)");
    Regex::new(&pattern)
        .map(|re| re.is_match(url))
        .unwrap_or(false)
}

/// gh prints the new PR URL on its own line as the last meaningful line
/// of stdout. Anchor to `https://github.com/` so a hijacked gh binary
/// can't print a malicious URL that downstream code would open.
pub fn extract_pr_url(stdout: &str) -> Option<String> {
    let re = Regex::new(r"https://github\.com/[^\s/]+/[^\s/]+/pull/\d+\S*").ok()?;
    re.find(stdout).map(|m| {
        m.as_str()
            .trim()
            .trim_end_matches(['.', ')', '"', '\''])
            .to_string()
    })
}

/// Extracts the PR number from a GitHub PR URL (e.g. `https://github.com/o/r/pull/42`).
pub fn extract_pr_number(url: &str) -> Option<i64> {
    let re = Regex::new(r"/pull/(\d+)(?:[/?#]|$)").ok()?;
    let captures = re.captures(url)?;
    captures.get(1)?.as_str().parse::<i64>().ok()
}

/// Parses owner and repository name from a GitHub remote URL.
/// Supports SSH (`git@github.com:owner/repo.git`), HTTPS (`https://github.com/owner/repo.git`),
/// and other git variants.
pub fn parse_github_remote(url: &str) -> Option<ProjectRemote> {
    let trimmed = url.trim();
    let without_scheme = trimmed.strip_prefix("ssh://").unwrap_or(trimmed);
    let after_host = without_scheme
        .strip_prefix("git@github.com:")
        .or_else(|| without_scheme.strip_prefix("git@github.com/"))
        .or_else(|| without_scheme.strip_prefix("https://github.com/"))
        .or_else(|| without_scheme.strip_prefix("http://github.com/"))
        .or_else(|| without_scheme.strip_prefix("git://github.com/"))?;
    let without_git = after_host.strip_suffix(".git").unwrap_or(after_host);
    let mut parts = without_git.split('/');
    let owner = parts.next()?.trim();
    let name = parts.next()?.trim();
    if owner.is_empty() || name.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(ProjectRemote {
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

/// Extracts owner and repo from a canonical GitHub URL (e.g. `https://github.com/owner/repo/pull/123`).
pub fn extract_github_remote_from_url(url: &str) -> Option<ProjectRemote> {
    let trimmed = url.trim();
    let path = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))?;
    let mut parts = path.split('/');
    let owner = parts.next()?.trim();
    let name = parts.next()?.trim();
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(ProjectRemote {
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

/// Discovers the project remote from the workspace's git origin configuration.
pub async fn resolve_project_remote(workspace_path: &Path) -> Option<ProjectRemote> {
    if let Ok(output) = run_git_text(
        workspace_path,
        ["config", "--get", "remote.origin.url"],
        Duration::from_secs(5),
    )
    .await
    {
        if let Some(remote) = parse_github_remote(&output) {
            return Some(remote);
        }
    }
    if let Ok(output) = run_git_text(
        workspace_path,
        ["remote", "get-url", "origin"],
        Duration::from_secs(5),
    )
    .await
    {
        if let Some(remote) = parse_github_remote(&output) {
            return Some(remote);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::gh::GhPrRecord;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use crate::sessions::state::SessionState;
    use std::path::Path;
    use std::sync::Mutex;
    use tempfile::TempDir;

    async fn run_git(repo: &Path, args: &[&str]) -> String {
        run_git_text(repo, args, GIT_TIMEOUT)
            .await
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"))
    }

    async fn init_repo(dir: &Path) {
        run_git(dir, &["init", "-q", "-b", "main"]).await;
        run_git(dir, &["config", "user.email", "test@argmax.dev"]).await;
        run_git(dir, &["config", "user.name", "Argmax Test"]).await;
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        run_git(dir, &["add", "README.md"]).await;
        run_git(dir, &["commit", "-q", "-m", "init"]).await;
    }

    fn fixture_workspace(database: &Arc<Database>, repo_path: &Path) -> String {
        let conn = database.connection();
        persist_project(
            &conn,
            &PersistProjectInput {
                id: "p1".to_string(),
                name: "fixture".to_string(),
                repo_path: repo_path.to_string_lossy().into_owned(),
                default_branch: Some("main".to_string()),
                current_branch: "main".to_string(),
                settings: ProjectSettings {
                    worktree_location: repo_path.join(".worktrees").to_string_lossy().into_owned(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("project");
        persist_workspace(
            &conn,
            &PersistWorkspaceInput {
                id: "w1".to_string(),
                project_id: "p1".to_string(),
                task_label: "ops-test".to_string(),
                branch: "main".to_string(),
                base_ref: "main".to_string(),
                path: repo_path.to_string_lossy().into_owned(),
                state: "created".to_string(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: true,
                changed_files: 1,
            },
        )
        .expect("workspace");
        "w1".to_string()
    }

    fn fixture_session(database: &Arc<Database>, workspace_id: &str) -> String {
        let conn = database.connection();
        persist_session(
            &conn,
            &PersistSessionInput {
                id: "s1".to_string(),
                workspace_id: workspace_id.to_string(),
                provider: "claude".to_string(),
                model_label: "Haiku 4.5".to_string(),
                model_id: "claude-haiku-4-5".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "open a pr".to_string(),
                state: SessionState::Complete,
            },
        )
        .expect("session");
        "s1".to_string()
    }

    #[tokio::test]
    async fn commit_all_stages_and_commits_dirty_files() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        std::fs::write(repo.path().join("notes.txt"), "scratch\n").unwrap();

        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());

        let service = GitOpsService::new(database);
        let result = service
            .commit_all(GitCommitInput {
                workspace_id,
                message: "add notes".to_string(),
                selected_files: Vec::new(),
            })
            .await
            .expect("commit succeeds");
        assert_eq!(result.branch, "main");
        assert_eq!(result.commit_sha.len(), 40);
    }

    #[tokio::test]
    async fn commit_all_rejects_leading_dash_message() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        std::fs::write(repo.path().join("notes.txt"), "scratch\n").unwrap();

        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());

        let service = GitOpsService::new(database);
        let err = service
            .commit_all(GitCommitInput {
                workspace_id,
                message: "-rm-rf".to_string(),
                selected_files: Vec::new(),
            })
            .await
            .expect_err("leading-dash rejected");
        assert!(err.to_string().contains("'-'"));
    }

    #[tokio::test]
    async fn selected_file_commit_leaves_unrelated_staged_changes_staged() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        std::fs::write(repo.path().join("README.md"), "staged edit\n").unwrap();
        run_git(repo.path(), &["add", "README.md"]).await;
        std::fs::write(repo.path().join("notes.txt"), "selected\n").unwrap();

        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());

        let service = GitOpsService::new(database);
        service
            .commit_all(GitCommitInput {
                workspace_id,
                message: "add selected notes".to_string(),
                selected_files: vec!["notes.txt".to_string()],
            })
            .await
            .expect("commit succeeds");

        let committed = run_git(repo.path(), &["show", "--name-only", "--format=", "HEAD"]).await;
        assert!(committed.lines().any(|line| line == "notes.txt"));
        assert!(!committed.lines().any(|line| line == "README.md"));

        let cached = run_git(repo.path(), &["diff", "--cached", "--name-only"]).await;
        assert_eq!(cached.trim(), "README.md");
    }

    #[tokio::test]
    async fn create_branch_checks_out_new_branch() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;

        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());

        let service = GitOpsService::new(database);
        service
            .create_branch(GitCreateBranchInput {
                workspace_id,
                branch: "feature/new".to_string(),
            })
            .await
            .expect("branch created");
        let current = run_git(repo.path(), &["branch", "--show-current"]).await;
        assert_eq!(current.trim(), "feature/new");
    }

    #[tokio::test]
    async fn push_sends_current_branch_to_fixture_remote() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let remote = TempDir::new().unwrap();
        run_git(remote.path(), &["init", "-q", "--bare"]).await;
        run_git(
            repo.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        )
        .await;
        run_git(repo.path(), &["config", "push.default", "upstream"]).await;
        run_git(repo.path(), &["config", "push.autoSetupRemote", "false"]).await;

        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());

        let service = GitOpsService::new(database);
        let result = service
            .push(GitPushInput { workspace_id })
            .await
            .expect("push succeeds");

        assert_eq!(result.branch, "main");
        let remote_head = run_git(remote.path(), &["rev-parse", "refs/heads/main"]).await;
        assert_eq!(remote_head.trim().len(), 40);
    }

    #[tokio::test]
    async fn view_or_create_pr_shells_to_gh_and_uses_refresh_result() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let session_id = fixture_session(&database, &workspace_id);

        let calls = Arc::new(Mutex::new(Vec::<(String, Vec<String>)>::new()));
        let runner: GhRunner = Arc::new({
            let calls = Arc::clone(&calls);
            move |cwd, args| {
                calls.lock().expect("calls").push((cwd, args));
                Box::pin(async { Ok("https://github.com/example/repo/pull/42\n".to_string()) })
            }
        });
        let refresh: RefreshPrFn = Arc::new(|session_id| {
            Box::pin(async move {
                Ok(vec![GhPrRecord {
                    session_id,
                    pr_number: 42,
                    head_sha: "abc123".to_string(),
                    last_seen_check_state: "pending".to_string(),
                    updated_at: "2026-05-24T12:00:00.000Z".to_string(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: None,
                }])
            })
        });

        let service = GitOpsService::with_runners(database, runner, Some(refresh));
        let result = service
            .view_or_create_pr(GitViewOrCreatePrInput { session_id })
            .await
            .expect("pr created");

        assert_eq!(
            result,
            GitViewOrCreatePrResult::Created {
                url: "https://github.com/example/repo/pull/42".to_string(),
                pr_number: Some(42),
            }
        );
        let calls = calls.lock().expect("calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, repo.path().to_string_lossy());
        assert_eq!(calls[0].1, vec!["pr", "create", "--fill"]);
    }

    #[tokio::test]
    async fn view_or_create_pr_handles_already_existing_pr_error_gracefully() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let session_id = fixture_session(&database, &workspace_id);

        let runner: GhRunner = Arc::new(|_cwd, _args| {
            Box::pin(async {
                Err(ArgmaxError::service(
                    "GH_NON_ZERO_EXIT",
                    "gh failed: a pull request for branch \"feat\" into branch \"main\" already exists:\nhttps://github.com/example/repo/pull/42\n".to_string(),
                ))
            })
        });
        let refresh: RefreshPrFn = Arc::new(|session_id| {
            Box::pin(async move {
                Ok(vec![GhPrRecord {
                    session_id,
                    pr_number: 42,
                    head_sha: "abc123".to_string(),
                    last_seen_check_state: "pending".to_string(),
                    updated_at: "2026-05-24T12:00:00.000Z".to_string(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: None,
                }])
            })
        });

        let service = GitOpsService::with_runners(database, runner, Some(refresh));
        let result = service
            .view_or_create_pr(GitViewOrCreatePrInput { session_id })
            .await
            .expect("pr opened");

        assert_eq!(
            result,
            GitViewOrCreatePrResult::Opened {
                url: "https://github.com/example/repo/pull/42".to_string(),
                pr_number: 42,
            }
        );
    }

    #[test]
    fn extract_pr_url_picks_first_github_url() {
        let stdout = "noise\nhttps://github.com/example/repo/pull/42\nmore\n";
        assert_eq!(
            extract_pr_url(stdout).as_deref(),
            Some("https://github.com/example/repo/pull/42")
        );
    }

    #[test]
    fn extract_pr_url_rejects_non_github() {
        let stdout = "https://evil.example.com/pull/1\n";
        assert!(extract_pr_url(stdout).is_none());
    }

    #[test]
    fn url_matches_pr_anchors_pr_number() {
        assert!(url_matches_pr("https://github.com/o/r/pull/42", 42));
        assert!(url_matches_pr("https://github.com/o/r/pull/42/files", 42));
        assert!(!url_matches_pr("https://github.com/o/r/pull/420", 42));
    }

    #[test]
    fn missing_upstream_error_detection() {
        let err = ArgmaxError::service(
            "GIT_NON_ZERO_EXIT",
            "fatal: The current branch foo has no upstream branch.",
        );
        assert!(is_missing_upstream_error(&err));
        let other = ArgmaxError::service("GIT_NON_ZERO_EXIT", "fatal: not a git repository");
        assert!(!is_missing_upstream_error(&other));
    }

    #[test]
    fn parse_github_remote_handles_various_formats() {
        let ssh = parse_github_remote("git@github.com:menti/argmax.git").unwrap();
        assert_eq!(ssh.owner, "menti");
        assert_eq!(ssh.name, "argmax");

        let ssh_no_git = parse_github_remote("git@github.com:menti/argmax").unwrap();
        assert_eq!(ssh_no_git.owner, "menti");
        assert_eq!(ssh_no_git.name, "argmax");

        let https = parse_github_remote("https://github.com/menti/argmax.git").unwrap();
        assert_eq!(https.owner, "menti");
        assert_eq!(https.name, "argmax");

        let https_no_git = parse_github_remote("https://github.com/menti/argmax").unwrap();
        assert_eq!(https_no_git.owner, "menti");
        assert_eq!(https_no_git.name, "argmax");

        let non_github = parse_github_remote("git@gitlab.com:menti/argmax.git");
        assert!(non_github.is_none());
    }

    #[test]
    fn extract_github_remote_from_pr_url() {
        let remote =
            extract_github_remote_from_url("https://github.com/menti/argmax/pull/42").unwrap();
        assert_eq!(remote.owner, "menti");
        assert_eq!(remote.name, "argmax");

        let non_github = extract_github_remote_from_url("https://gitlab.com/menti/argmax/pull/42");
        assert!(non_github.is_none());
    }

    #[test]
    fn extract_pr_number_from_url() {
        assert_eq!(
            extract_pr_number("https://github.com/menti/argmax/pull/42"),
            Some(42)
        );
        assert_eq!(
            extract_pr_number("https://github.com/menti/argmax/pull/42/files"),
            Some(42)
        );
        assert_eq!(extract_pr_number("https://github.com/menti/argmax"), None);
    }

    #[tokio::test]
    async fn view_or_create_pr_opens_existing_pr_when_pr_already_recorded() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let session_id = fixture_session(&database, &workspace_id);

        {
            let conn = database.connection();
            crate::persistence::projects::update_project_remote(
                &conn,
                "p1",
                Some(&crate::persistence::projects::ProjectRemote {
                    owner: "example".to_string(),
                    name: "repo".to_string(),
                }),
            )
            .unwrap();
            crate::persistence::gh::upsert_gh_pr(
                &conn,
                &crate::persistence::gh::GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 99,
                    head_sha: "head123".to_string(),
                    last_seen_check_state: "success".to_string(),
                    updated_at: "2026-05-24T12:00:00.000Z".to_string(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: Some("main".to_string()),
                },
            )
            .unwrap();
        }

        let calls = Arc::new(Mutex::new(Vec::<(String, Vec<String>)>::new()));
        let runner: GhRunner = Arc::new({
            let calls = Arc::clone(&calls);
            move |cwd, args| {
                calls.lock().expect("calls").push((cwd, args));
                Box::pin(async { Ok(String::new()) })
            }
        });

        let service = GitOpsService::with_runners(database, runner, None);
        let result = service
            .view_or_create_pr(GitViewOrCreatePrInput { session_id })
            .await
            .expect("pr opened");

        assert_eq!(
            result,
            GitViewOrCreatePrResult::Opened {
                url: "https://github.com/example/repo/pull/99".to_string(),
                pr_number: 99,
            }
        );
        let calls = calls.lock().expect("calls");
        assert_eq!(calls.len(), 0);
    }

    #[tokio::test]
    async fn view_or_create_pr_falls_back_to_opened_on_already_exists_error() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let session_id = fixture_session(&database, &workspace_id);

        let calls = Arc::new(Mutex::new(Vec::<(String, Vec<String>)>::new()));
        let runner: GhRunner = Arc::new({
            let calls = Arc::clone(&calls);
            move |cwd, args| {
                calls.lock().expect("calls").push((cwd, args));
                Box::pin(async {
                    Err(ArgmaxError::service(
                        "GH_NON_ZERO_EXIT",
                        "a pull request for branch \"main\" into branch \"main\" already exists:\nhttps://github.com/example/repo/pull/123\n",
                    ))
                })
            }
        });

        let refresh_called = Arc::new(Mutex::new(false));
        let refresh: RefreshPrFn = Arc::new({
            let refresh_called = Arc::clone(&refresh_called);
            move |_| {
                let refresh_called = Arc::clone(&refresh_called);
                Box::pin(async move {
                    *refresh_called.lock().unwrap() = true;
                    Ok(vec![])
                })
            }
        });

        let service = GitOpsService::with_runners(database.clone(), runner, Some(refresh));
        let result = service
            .view_or_create_pr(GitViewOrCreatePrInput { session_id })
            .await
            .expect("opened from error");

        assert_eq!(
            result,
            GitViewOrCreatePrResult::Opened {
                url: "https://github.com/example/repo/pull/123".to_string(),
                pr_number: 123,
            }
        );
        assert!(*refresh_called.lock().unwrap());
        let conn = database.connection();
        let remote = crate::persistence::projects::get_project_remote(&conn, "p1").unwrap();
        assert_eq!(
            remote,
            Some(crate::persistence::projects::ProjectRemote {
                owner: "example".to_string(),
                name: "repo".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn view_or_create_pr_resolves_remote_from_git_config_if_missing_in_db() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        run_git(
            repo.path(),
            &["remote", "add", "origin", "git@github.com:menti/argmax.git"],
        )
        .await;

        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let session_id = fixture_session(&database, &workspace_id);

        {
            let conn = database.connection();
            crate::persistence::gh::upsert_gh_pr(
                &conn,
                &crate::persistence::gh::GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 77,
                    head_sha: "head456".to_string(),
                    last_seen_check_state: "success".to_string(),
                    updated_at: "2026-05-24T12:00:00.000Z".to_string(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: Some("main".to_string()),
                },
            )
            .unwrap();
        }

        let calls = Arc::new(Mutex::new(Vec::<(String, Vec<String>)>::new()));
        let runner: GhRunner = Arc::new({
            let calls = Arc::clone(&calls);
            move |cwd, args| {
                calls.lock().expect("calls").push((cwd, args));
                Box::pin(async { Ok(String::new()) })
            }
        });

        let service = GitOpsService::with_runners(database.clone(), runner, None);
        let result = service
            .view_or_create_pr(GitViewOrCreatePrInput { session_id })
            .await
            .expect("pr opened");

        assert_eq!(
            result,
            GitViewOrCreatePrResult::Opened {
                url: "https://github.com/menti/argmax/pull/77".to_string(),
                pr_number: 77,
            }
        );
        let calls = calls.lock().expect("calls");
        assert_eq!(calls.len(), 0);
        let conn = database.connection();
        let remote = crate::persistence::projects::get_project_remote(&conn, "p1").unwrap();
        assert_eq!(
            remote,
            Some(crate::persistence::projects::ProjectRemote {
                owner: "menti".to_string(),
                name: "argmax".to_string(),
            })
        );
    }
}
