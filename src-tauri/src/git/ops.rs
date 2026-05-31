// GitOpsService owns the operations the renderer's git dropdown drives:
// stage+commit-all, push (with first-time `-u origin <branch>` upgrade),
// create-and-checkout-branch, and the view-or-create PR flow.

use std::{future::Future, path::Path, pin::Pin, sync::Arc, time::Duration};

use regex::Regex;
use serde::Serialize;
use specta::Type;
use tempfile::tempdir;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::exec::{run_git_buffer_with_options, run_git_text, GitExecOptions};
use crate::persistence::database::Database;
use crate::persistence::gh::{list_gh_pr_for_session, GhPrRecord};
use crate::persistence::projects::get_project_remote;
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
        // (audit-2026-05-17 M13)
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

        let existing = {
            let conn = self.database.connection();
            list_gh_pr_for_session(&conn, &session.id)?
        };
        if let Some(top) = most_recent(&existing) {
            let remote = {
                let conn = self.database.connection();
                get_project_remote(&conn, &workspace.project_id)?
            };
            if let Some(remote) = remote {
                return Ok(GitViewOrCreatePrResult::Opened {
                    url: format!(
                        "https://github.com/{}/{}/pull/{}",
                        remote.owner, remote.name, top.pr_number
                    ),
                    pr_number: top.pr_number,
                });
            }
        }

        let stdout = (self.gh_runner)(
            workspace.path.clone(),
            vec!["pr".into(), "create".into(), "--fill".into()],
        )
        .await?;
        let url = extract_pr_url(&stdout).ok_or_else(|| {
            ArgmaxError::service(
                "GH_PR_URL_MISSING",
                format!(
                    "gh pr create did not return a PR URL: {}",
                    stdout.chars().take(256).collect::<String>()
                ),
            )
        })?;

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
            url,
            pr_number: created.map(|row| row.pr_number),
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

async fn run_git_text_with_options<I, S>(
    workspace_path: &Path,
    args: I,
    options: GitExecOptions,
) -> ArgmaxResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let bytes = run_git_buffer_with_options(workspace_path, args, options).await?;
    String::from_utf8(bytes).map_err(|error| {
        ArgmaxError::service(
            "GIT_STDOUT_NOT_UTF8",
            format!("git stdout was not valid UTF-8: {error}"),
        )
    })
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
fn extract_pr_url(stdout: &str) -> Option<String> {
    let re = Regex::new(r"https://github\.com/[^\s/]+/[^\s/]+/pull/\d+\S*").ok()?;
    re.find(stdout).map(|m| m.as_str().trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::gh::GhPrRecord;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use std::path::Path;
    use std::process::Command as StdCommand;
    use std::sync::Mutex;
    use tempfile::TempDir;

    fn run_git(repo: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .args(["-C", repo.to_str().unwrap()])
            .args(args)
            .status()
            .expect("git invoke failed");
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_repo(dir: &Path) {
        run_git(dir, &["init", "-q", "-b", "main"]);
        run_git(dir, &["config", "user.email", "test@argmax.dev"]);
        run_git(dir, &["config", "user.name", "Argmax Test"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        run_git(dir, &["add", "README.md"]);
        run_git(dir, &["commit", "-q", "-m", "init"]);
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
                    default_provider: "claude".to_string(),
                    default_model_label: "Claude Haiku 4.5".to_string(),
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
                model_label: "Claude Haiku 4.5".to_string(),
                model_id: "claude-haiku-4-5".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "open a pr".to_string(),
                state: "complete".to_string(),
                attention: "normal".to_string(),
            },
        )
        .expect("session");
        "s1".to_string()
    }

    #[tokio::test]
    async fn commit_all_stages_and_commits_dirty_files() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path());
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
        init_repo(repo.path());
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
        init_repo(repo.path());
        std::fs::write(repo.path().join("README.md"), "staged edit\n").unwrap();
        run_git(repo.path(), &["add", "README.md"]);
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

        let committed = StdCommand::new("git")
            .args(["-C", repo.path().to_str().unwrap()])
            .args(["show", "--name-only", "--format=", "HEAD"])
            .output()
            .expect("git show");
        let committed = String::from_utf8_lossy(&committed.stdout);
        assert!(committed.lines().any(|line| line == "notes.txt"));
        assert!(!committed.lines().any(|line| line == "README.md"));

        let cached = StdCommand::new("git")
            .args(["-C", repo.path().to_str().unwrap()])
            .args(["diff", "--cached", "--name-only"])
            .output()
            .expect("git diff --cached");
        assert_eq!(String::from_utf8_lossy(&cached.stdout).trim(), "README.md");
    }

    #[tokio::test]
    async fn create_branch_checks_out_new_branch() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path());

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
        let current = StdCommand::new("git")
            .args(["-C", repo.path().to_str().unwrap()])
            .args(["branch", "--show-current"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&current.stdout).trim(),
            "feature/new"
        );
    }

    #[tokio::test]
    async fn push_sends_current_branch_to_fixture_remote() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path());
        let remote = TempDir::new().unwrap();
        run_git(remote.path(), &["init", "-q", "--bare"]);
        run_git(
            repo.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        run_git(repo.path(), &["config", "push.default", "upstream"]);
        run_git(repo.path(), &["config", "push.autoSetupRemote", "false"]);

        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());

        let service = GitOpsService::new(database);
        let result = service
            .push(GitPushInput { workspace_id })
            .await
            .expect("push succeeds");

        assert_eq!(result.branch, "main");
        let remote_head = StdCommand::new("git")
            .args(["--git-dir", remote.path().to_str().unwrap()])
            .args(["rev-parse", "refs/heads/main"])
            .output()
            .expect("rev-parse remote head");
        assert!(remote_head.status.success());
        assert_eq!(
            String::from_utf8_lossy(&remote_head.stdout).trim().len(),
            40
        );
    }

    #[tokio::test]
    async fn view_or_create_pr_shells_to_gh_and_uses_refresh_result() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path());
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
}
