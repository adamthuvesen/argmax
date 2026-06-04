// Workspace lifecycle service:
//   - `create_isolated` adds a fresh `git worktree` under the project's
//     configured worktree location; partial-worktree cleanup runs on
//     spawn failure so a half-registered worktree can't strand state.
//   - `create_current` records a workspace pointing at the project's
//     existing checkout (sharedWorkspace = true).
//   - `keep`, `archive`, `set_pinned` flip state bits.
//   - `archive` is the one with real teeth for isolated worktrees:
//     refreshes status, refuses to remove dirty worktrees without
//     `force`, re-checks porcelain immediately before `worktree remove`
//     to close the TOCTOU window, closes the fs watcher before remove so
//     teardown doesn't ENOENT-spam. Shared workspaces only archive the app
//     row and leave the checkout untouched.
//   - `refresh_status` reads `git branch --show-current` and
//     `git status --porcelain`, persists branch-change events.
//   - `open_in_ide` invokes `open -a <app> <path>` for the picked IDE.
//
// The fs watcher lives in `watcher.rs` and is owned per-workspace by
// this service; `watch`, `close_watcher`, and
// `close_watchers_for_workspaces` are this module's public surface.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use uuid::Uuid;

use super::watcher::WatcherEntry;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::exec::run_git_text;
use crate::ipc::inputs::{
    OpenIdeChoice, WorkspacesArchiveInput, WorkspacesCreateCurrentInput,
    WorkspacesCreateIsolatedInput, WorkspacesKeepInput, WorkspacesOpenInIdeInput,
    WorkspacesSetPinnedInput,
};
use crate::persistence::database::Database;
use crate::persistence::events::{persist_timeline_event, PersistTimelineEventInput};
use crate::persistence::projects::{list_projects, require_project};
use crate::persistence::workspaces::{
    find_workspace_by_id, persist_workspace, set_workspace_pinned, update_workspace_state,
    update_workspace_status, PersistWorkspaceInput, WorkspaceStatusInput, WorkspaceSummary,
};
use crate::providers::flush_queue::DashboardDelta;
use crate::util::workspace_paths::normalize;

/// Trailing-edge coalescing window for fs.watch bursts (e.g. `npm install`).
pub(super) const WATCH_DEBOUNCE_MS: u64 = 200;

/// Wall-clock cap for any git invocation made by this service. Matches
/// the TS default of "long enough for `worktree add` on big clones,
/// short enough that a hung shell-out doesn't strand the UI".
const GIT_TIMEOUT_MS: u64 = 60_000;

const BRANCH_SLUG_LEN: usize = 16;
const SLUG_MAX_LEN: usize = 42;

/// 200 ms settle after `cancelChecks` fires so SIGTERM has time to land
/// before we recheck porcelain. See TS comment in `archiveWorkspace`.
const CANCEL_SETTLE_MS: u64 = 200;

/// Callback shape that lets the renderer (or tests) observe the
/// dashboard deltas this service publishes. Same shape as the provider
/// session service's publisher.
pub type DeltaPublisher = Arc<dyn Fn(DashboardDelta) + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceServiceError {
    #[error("{message}")]
    Invalid {
        message: String,
        recoverable_action: String,
    },
}

impl From<WorkspaceServiceError> for ArgmaxError {
    fn from(err: WorkspaceServiceError) -> Self {
        match err {
            WorkspaceServiceError::Invalid { message, .. } => {
                ArgmaxError::service("WORKSPACE_INVALID", message)
            }
        }
    }
}

pub struct WorkspaceService {
    database: Arc<Database>,
    publish_delta: DeltaPublisher,
    pub(super) watchers: Mutex<HashMap<String, WatcherEntry>>,
}

impl WorkspaceService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Self::with_publisher(database, |_| {})
    }

    pub fn with_publisher<F>(database: Arc<Database>, publisher: F) -> Arc<Self>
    where
        F: Fn(DashboardDelta) + Send + Sync + 'static,
    {
        Arc::new(Self {
            database,
            publish_delta: Arc::new(publisher),
            watchers: Mutex::new(HashMap::new()),
        })
    }

    pub fn open_watcher_count(&self) -> usize {
        self.watchers.lock().expect("watchers poisoned").len()
    }

    pub(super) fn database(&self) -> &Arc<Database> {
        &self.database
    }

    // ----- lifecycle -----------------------------------------------------

    pub async fn create_isolated(
        self: &Arc<Self>,
        input: WorkspacesCreateIsolatedInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let project = {
            let connection = self.database.connection();
            require_project(&connection, input.project_id.as_str())?
        };
        let base_ref = input
            .base_ref
            .as_ref()
            .map(|value| value.as_str().to_string())
            .or_else(|| project.default_branch.clone())
            .unwrap_or_else(|| project.current_branch.clone());

        if base_ref.starts_with('-') {
            return Err(invalid_workspace(
                format!("Invalid base ref {base_ref}: cannot start with '-'"),
                "Choose a valid base ref and retry.",
            ));
        }
        assert_valid_ref(&project.repo_path, &base_ref).await?;

        let task_label = input.task_label.as_str();
        let slug = slugify(task_label);
        let suffix = Uuid::new_v4().simple().to_string();
        let suffix = &suffix[..BRANCH_SLUG_LEN];
        let branch = format!("argmax/{slug}-{suffix}");

        let worktree_location = project.settings.worktree_location.clone();
        let worktree_path = PathBuf::from(&worktree_location).join(branch.replace('/', "-"));

        // String-only containment check before mkdir — a bad persisted
        // setting (e.g. `/tmp/argmax-oops`) must not side-effect a directory
        // on disk that the post-mkdir realpath check then rejects.
        assert_worktree_location_contained(
            Path::new(&project.repo_path),
            Path::new(&worktree_location),
            false,
        )?;
        tokio::fs::create_dir_all(&worktree_location)
            .await
            .map_err(|e| {
                invalid_workspace(
                    format!("Could not create worktree location {worktree_location}: {e}"),
                    "Check the project's worktree location setting.",
                )
            })?;
        assert_worktree_location_contained(
            Path::new(&project.repo_path),
            Path::new(&worktree_location),
            true,
        )?;

        // Pre-flight branch-collision check so the error names what to retry.
        if branch_exists(&project.repo_path, &branch).await? {
            return Err(invalid_workspace(
                format!("Branch {branch} already exists"),
                "Retry with a different task label.",
            ));
        }

        let add_result = run_git_text(
            Path::new(&project.repo_path),
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &worktree_path.display().to_string(),
                &base_ref,
            ],
            Duration::from_millis(GIT_TIMEOUT_MS),
        )
        .await;

        if let Err(error) = add_result {
            // Cleanup partial worktree registration so a future archive can
            // reach it. See TS comment for the failure modes this guards
            // against (disk full, ref races, lock contention).
            let _ = run_git_text(
                Path::new(&project.repo_path),
                &[
                    "worktree",
                    "remove",
                    "--force",
                    &worktree_path.display().to_string(),
                ],
                Duration::from_millis(GIT_TIMEOUT_MS),
            )
            .await;
            let _ = tokio::fs::remove_dir_all(&worktree_path).await;
            return Err(invalid_workspace(
                format!("Could not create worktree for {branch}. {error}"),
                "Choose another base ref or branch name and retry.",
            ));
        }

        let connection = self.database.connection();
        let workspace = persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                task_label: task_label.to_string(),
                branch: branch.clone(),
                base_ref: base_ref.clone(),
                path: worktree_path.display().to_string(),
                state: "created".to_string(),
                shared_workspace: false,
                dirty: false,
                changed_files: 0,
            },
        )?;
        self.publish(DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace.clone()],
            ..DashboardDelta::default()
        });
        Ok(workspace)
    }

    pub fn create_current(
        self: &Arc<Self>,
        input: WorkspacesCreateCurrentInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let project = require_project(&connection, input.project_id.as_str())?;
        let workspace = persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                task_label: input.task_label.as_str().to_string(),
                branch: project.current_branch.clone(),
                base_ref: project.current_branch.clone(),
                path: project.repo_path.clone(),
                state: "created".to_string(),
                shared_workspace: true,
                dirty: false,
                changed_files: 0,
            },
        )?;
        self.publish(DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace.clone()],
            ..DashboardDelta::default()
        });
        Ok(workspace)
    }

    pub fn keep(self: &Arc<Self>, input: WorkspacesKeepInput) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let workspace = update_workspace_state(&connection, input.workspace_id.as_str(), "kept")?;
        self.publish(DashboardDelta {
            workspaces: vec![workspace.clone()],
            ..DashboardDelta::default()
        });
        Ok(workspace)
    }

    pub async fn archive(
        self: &Arc<Self>,
        input: WorkspacesArchiveInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let workspace_id = input.workspace_id.as_str().to_string();
        let force = input.force.unwrap_or(false);

        let workspace = self.refresh_status(&workspace_id).await?;

        let project = {
            let connection = self.database.connection();
            require_project(&connection, &workspace.project_id)?
        };

        if !workspace.shared_workspace {
            if workspace.dirty && !force {
                self.close_watcher(&workspace_id);
                let kept = {
                    let connection = self.database.connection();
                    update_workspace_state(&connection, &workspace_id, "kept")?
                };
                self.publish(DashboardDelta {
                    workspaces: vec![kept.clone()],
                    ..DashboardDelta::default()
                });
                return Ok(kept);
            }

            // Cancel hook is the caller's responsibility (CheckService isn't
            // in scope for Lane A). After cancel, settle briefly so SIGTERM
            // has time to land before we recheck porcelain.
            tokio::time::sleep(Duration::from_millis(CANCEL_SETTLE_MS)).await;

            if !force {
                let recheck = run_git_text(
                    Path::new(&workspace.path),
                    &["status", "--porcelain"],
                    Duration::from_millis(GIT_TIMEOUT_MS),
                )
                .await
                .map_err(|e| ArgmaxError::service("WORKSPACE_STATUS_FAILED", e.to_string()))?;
                if !recheck.trim().is_empty() {
                    self.close_watcher(&workspace_id);
                    let kept = {
                        let connection = self.database.connection();
                        update_workspace_state(&connection, &workspace_id, "kept")?
                    };
                    self.publish(DashboardDelta {
                        workspaces: vec![kept.clone()],
                        ..DashboardDelta::default()
                    });
                    return Ok(kept);
                }
            }

            let remove_args: Vec<&str> = if force {
                vec!["worktree", "remove", "--force", workspace.path.as_str()]
            } else {
                vec!["worktree", "remove", workspace.path.as_str()]
            };
            run_git_text(
                Path::new(&project.repo_path),
                &remove_args,
                Duration::from_millis(GIT_TIMEOUT_MS),
            )
            .await
            .map_err(|e| {
                invalid_workspace(
                    format!("Could not archive worktree. {e}"),
                    "Review the worktree and retry archive.",
                )
            })?;
        }

        let archived = {
            let connection = self.database.connection();
            update_workspace_state(&connection, &workspace_id, "archived")?
        };
        // Tear the watcher down only after git + DB have committed the archive,
        // so a failed worktree removal leaves a still-watched, recoverable
        // workspace rather than a limbo one with no watcher and no archived row.
        self.close_watcher(&workspace_id);
        self.publish(DashboardDelta {
            workspaces: vec![archived.clone()],
            ..DashboardDelta::default()
        });
        Ok(archived)
    }

    pub async fn refresh_status(
        self: &Arc<Self>,
        workspace_id: &str,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let workspace = {
            let connection = self.database.connection();
            find_workspace_by_id(&connection, workspace_id)?
        };

        let branch = match run_git_text(
            Path::new(&workspace.path),
            &["branch", "--show-current"],
            Duration::from_millis(GIT_TIMEOUT_MS),
        )
        .await
        {
            // Empty output is a valid detached-HEAD state, not a failure —
            // keep the cached branch in that case.
            Ok(output) if output.trim().is_empty() => workspace.branch.clone(),
            Ok(output) => output.trim().to_string(),
            Err(error) => {
                // Don't silently fall back to "": surface the failure and keep
                // the cached branch (mirrors the porcelain handling below).
                tracing::debug!(
                    workspace_id = %workspace_id,
                    ?error,
                    "branch detection failed; keeping cached branch"
                );
                workspace.branch.clone()
            }
        };

        // If `git status` fails (transient lock, partially-removed
        // worktree, ENOENT during teardown), the prior dirty/changed
        // values stay authoritative. Falling back to "" would mark a
        // genuinely dirty workspace as clean and the dashboard delta
        // would silently misrepresent reality.
        let porcelain_result = run_git_text(
            Path::new(&workspace.path),
            &["status", "--porcelain"],
            Duration::from_millis(GIT_TIMEOUT_MS),
        )
        .await;
        let (changed_files, dirty) = match porcelain_result {
            Ok(porcelain) => {
                let count = porcelain
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .count() as i64;
                (count, count > 0)
            }
            Err(error) => {
                tracing::debug!(
                    workspace_id,
                    error = %error,
                    "refresh_status: git status failed; preserving prior dirty/changed_files",
                );
                (workspace.changed_files, workspace.dirty)
            }
        };

        if branch != workspace.branch {
            if let Some(session_id) = self.latest_session_id_for_workspace(workspace_id)? {
                let connection = self.database.connection();
                let _ = persist_timeline_event(
                    &connection,
                    &PersistTimelineEventInput {
                        id: Uuid::new_v4().to_string(),
                        session_id,
                        r#type: "file.changed".to_string(),
                        message: format!("Branch changed from {} to {branch}", workspace.branch),
                        payload: json!({
                            "kind": "branch-changed",
                            "workspaceId": workspace_id,
                            "previousBranch": workspace.branch,
                            "currentBranch": branch,
                        }),
                        created_at: None,
                    },
                );
            }
        }

        let summary = {
            let connection = self.database.connection();
            update_workspace_status(
                &connection,
                workspace_id,
                &WorkspaceStatusInput {
                    branch,
                    dirty,
                    changed_files,
                    last_activity_at: None,
                },
            )?
        };
        self.publish(DashboardDelta {
            workspaces: vec![summary.clone()],
            ..DashboardDelta::default()
        });
        Ok(summary)
    }

    pub fn open_in_ide(self: &Arc<Self>, input: WorkspacesOpenInIdeInput) -> ArgmaxResult<()> {
        let workspace = {
            let connection = self.database.connection();
            find_workspace_by_id(&connection, input.workspace_id.as_str())?
        };
        let mut command = Command::new("open");
        match input.ide {
            OpenIdeChoice::Default => {
                command.arg(&workspace.path);
            }
            choice => {
                command.args(["-a", ide_app_name(choice), &workspace.path]);
            }
        }
        let status = command
            .status()
            .map_err(|e| ArgmaxError::service("OPEN_IDE_FAILED", e.to_string()))?;
        if !status.success() {
            return Err(ArgmaxError::service(
                "OPEN_IDE_FAILED",
                format!("`open` exited with status {status}"),
            ));
        }
        Ok(())
    }

    pub fn set_pinned(
        self: &Arc<Self>,
        input: WorkspacesSetPinnedInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let workspace =
            set_workspace_pinned(&connection, input.workspace_id.as_str(), input.pinned)?;
        self.publish(DashboardDelta {
            workspaces: vec![workspace.clone()],
            ..DashboardDelta::default()
        });
        Ok(workspace)
    }

    // ----- watcher control (impls live in `watcher.rs`) ------------------

    pub fn watch(self: &Arc<Self>, workspace_id: &str) -> ArgmaxResult<()> {
        super::watcher::watch(self, workspace_id)
    }

    pub fn close_watcher(&self, workspace_id: &str) {
        super::watcher::close_watcher(self, workspace_id)
    }

    pub fn close_watchers_for_workspaces(&self, workspace_ids: &[String]) {
        for id in workspace_ids {
            self.close_watcher(id);
        }
    }

    // ----- helpers -------------------------------------------------------

    fn latest_session_id_for_workspace(&self, workspace_id: &str) -> ArgmaxResult<Option<String>> {
        let connection = self.database.connection();
        let mut stmt = connection
            .prepare(
                "SELECT id FROM sessions WHERE workspace_id = ? ORDER BY last_activity_at DESC, id DESC LIMIT 1",
            )
            .map_err(|e| ArgmaxError::service("SQLITE", e.to_string()))?;
        let mut rows = stmt
            .query([workspace_id])
            .map_err(|e| ArgmaxError::service("SQLITE", e.to_string()))?;
        if let Some(row) = rows
            .next()
            .map_err(|e| ArgmaxError::service("SQLITE", e.to_string()))?
        {
            let id: String = row
                .get(0)
                .map_err(|e| ArgmaxError::service("SQLITE", e.to_string()))?;
            Ok(Some(id))
        } else {
            Ok(None)
        }
    }

    pub(super) fn publish(&self, delta: DashboardDelta) {
        if !delta.is_empty() {
            (self.publish_delta)(delta);
        }
    }
}

// ----- free functions ---------------------------------------------------

fn ide_app_name(choice: OpenIdeChoice) -> &'static str {
    match choice {
        OpenIdeChoice::Vscode => "Visual Studio Code",
        OpenIdeChoice::Cursor => "Cursor",
        OpenIdeChoice::Windsurf => "Windsurf",
        OpenIdeChoice::Zed => "Zed",
        OpenIdeChoice::Terminal => "Terminal",
        OpenIdeChoice::Iterm => "iTerm",
        OpenIdeChoice::Default => "", // handled inline; never reached here
    }
}

fn invalid_workspace(
    message: impl Into<String>,
    recoverable_action: impl Into<String>,
) -> ArgmaxError {
    WorkspaceServiceError::Invalid {
        message: message.into(),
        recoverable_action: recoverable_action.into(),
    }
    .into()
}

async fn branch_exists(repo_path: &str, branch: &str) -> ArgmaxResult<bool> {
    let res = run_git_text(
        Path::new(repo_path),
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
        Duration::from_millis(GIT_TIMEOUT_MS),
    )
    .await;
    Ok(res.is_ok())
}

async fn assert_valid_ref(repo_path: &str, reference: &str) -> ArgmaxResult<()> {
    // `--allow-onelevel` lets short branch names like "main" pass. We do
    // not call `--branch` because that does DWIM expansion (e.g. `@{-1}`).
    let res = run_git_text(
        Path::new(repo_path),
        &["check-ref-format", "--allow-onelevel", reference],
        Duration::from_millis(GIT_TIMEOUT_MS),
    )
    .await;
    if res.is_err() {
        return Err(invalid_workspace(
            format!("Invalid git ref {reference}"),
            "Pick a base ref that conforms to git's ref-format rules.",
        ));
    }
    // A well-formed name is not enough: the ref must actually resolve so the
    // worktree can fork from it. Catches stale base branches (e.g. one that was
    // merged and pruned) before they produce a confusing worktree-add failure.
    if !ref_resolves(repo_path, reference).await {
        return Err(invalid_workspace(
            format!("Base ref {reference} does not exist in this repository"),
            "Pick a base branch that still exists and retry.",
        ));
    }
    Ok(())
}

/// True when `reference` resolves to a commit we can fork a worktree from
/// (local/remote branch, tag, or sha) — not merely a well-formed name.
async fn ref_resolves(repo_path: &str, reference: &str) -> bool {
    run_git_text(
        Path::new(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{reference}^{{commit}}"),
        ],
        Duration::from_millis(GIT_TIMEOUT_MS),
    )
    .await
    .is_ok()
}

fn assert_worktree_location_contained(
    repo_path: &Path,
    worktree_location: &Path,
    use_realpath: bool,
) -> ArgmaxResult<()> {
    if !worktree_location.is_absolute() {
        return Err(invalid_workspace(
            format!(
                "worktreeLocation must be absolute, got {}",
                worktree_location.display()
            ),
            "Configure project.worktreeLocation to an absolute path inside the repo.",
        ));
    }
    let (repo_norm, worktree_norm) = if use_realpath {
        let repo = repo_path.canonicalize().map_err(|e| {
            invalid_workspace(
                format!("Could not resolve repoPath {}: {e}", repo_path.display()),
                "Confirm the project's repoPath exists.",
            )
        })?;
        let worktree = worktree_location.canonicalize().map_err(|e| {
            invalid_workspace(
                format!(
                    "Could not resolve worktreeLocation {}: {e}",
                    worktree_location.display()
                ),
                "Confirm the worktree location exists.",
            )
        })?;
        (repo, worktree)
    } else {
        (normalize(repo_path), normalize(worktree_location))
    };
    if worktree_norm == repo_norm || worktree_norm.starts_with(&repo_norm) {
        Ok(())
    } else {
        Err(invalid_workspace(
            format!(
                "worktreeLocation {} must be inside repoPath {}",
                worktree_norm.display(),
                repo_norm.display()
            ),
            "Choose a worktree location inside the project's repo and retry.",
        ))
    }
}

fn slugify(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut prev_dash = false;
    for ch in value.chars() {
        let lowered = ch.to_ascii_lowercase();
        let allowed = lowered.is_ascii_alphanumeric();
        if allowed {
            out.push(lowered);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let sliced: String = trimmed.chars().take(SLUG_MAX_LEN).collect();
    if sliced.is_empty() {
        "task".to_string()
    } else {
        sliced
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_collapses_runs_and_lowercases() {
        assert_eq!(slugify("Hello World!!"), "hello-world");
        assert_eq!(slugify("   "), "task");
        assert_eq!(slugify("__leading-trailing__"), "leading-trailing");
    }

    #[test]
    fn slugify_caps_at_42_chars() {
        let long = "a".repeat(100);
        let slug = slugify(&long);
        assert_eq!(slug.len(), SLUG_MAX_LEN);
    }

    #[test]
    fn normalize_drops_dot_and_dotdot_components() {
        assert_eq!(
            normalize(Path::new("/repo/./a/b/../c")),
            PathBuf::from("/repo/a/c"),
        );
    }
}
