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
//     row and leave the checkout untouched: the state flips to "archived"
//     immediately and process teardown runs in the background, so the row
//     can never bounce back into the sidebar.
//   - `refresh_status` reads branch and dirty state with a single
//     `git status --porcelain --branch`, persists branch-change events.
//     `refresh_checkout` does the same for every workspace sharing one
//     checkout, from one git read.
//   - `open_in_ide` invokes `open -a <app> <path>` for the picked IDE.
//
// The fs watcher lives in `watcher.rs`. Watches are keyed by checkout path
// and shared by every workspace pointing at it; `watch` and `close_watcher`
// are this module's public surface and stay workspace-scoped.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use once_cell::sync::OnceCell;
use serde_json::json;
use uuid::Uuid;

use super::lifecycle::{ArchiveOutcome, WorkspaceArchiveLease, WorkspaceLifecycle};
use super::watcher::WatcherRegistry;
use crate::approvals::service::ApprovalService;
use crate::checks::service::{CheckService, RunWorkspaceCheckInput};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::exec::run_git_text;
use crate::ipc::inputs::{
    OpenIdeChoice, ScratchWorkspaceKind, WorkspacesArchiveInput, WorkspacesAutotitleInput,
    WorkspacesCreateCurrentInput, WorkspacesCreateIsolatedInput, WorkspacesCreateScratchInput,
    WorkspacesKeepInput, WorkspacesOpenInIdeInput, WorkspacesSetIconInput, WorkspacesSetLabelInput,
    WorkspacesSetPinnedInput, WorkspacesSetPriorityAddedInput, WorkspacesSetPriorityDismissedInput,
};
use crate::persistence::database::Database;
use crate::persistence::events::{
    list_all_session_events, persist_timeline_event, PersistTimelineEventInput, TimelineEvent,
};
use crate::persistence::projects::{
    find_project_by_id, list_projects, persist_project, require_project, PersistProjectInput,
    ProjectSettings,
};
use crate::persistence::sessions::{
    find_session_by_id, persist_session, record_session_launch, session_launch_lineage,
    set_session_resume_fork, update_session_provider_conversation_id, PersistSessionInput,
    SessionSummary,
};
use crate::persistence::workspaces::{
    find_workspace_by_id, persist_workspace, set_workspace_icon, set_workspace_label,
    set_workspace_label_auto, set_workspace_pinned, set_workspace_priority_added,
    set_workspace_priority_dismissed, update_workspace_state, update_workspace_status,
    PersistWorkspaceInput, WorkspaceStatusInput, WorkspaceSummary,
};
use crate::providers::cursor_acp::CursorAcpSessions;
use crate::providers::flush_queue::DashboardDelta;
use crate::providers::session_service::ProviderSessionService;
use crate::terminal::service::TerminalService;
use crate::util::sync::LockOrRecover;
use crate::util::workspace_paths::normalize;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionForkResult {
    pub workspace: WorkspaceSummary,
    pub session: SessionSummary,
}

#[derive(Debug, Clone)]
pub struct SessionMoveResult {
    pub workspace: WorkspaceSummary,
    pub session: SessionSummary,
    pub source_archive_state: String,
}

/// Trailing-edge coalescing window for fs.watch bursts (e.g. `npm install`).
pub(super) const WATCH_DEBOUNCE_MS: u64 = 200;
pub(super) const WATCH_MAX_DEBOUNCE_MS: u64 = 1_000;

/// Wall-clock cap for any git invocation made by this service. Matches
/// the TS default of "long enough for `worktree add` on big clones,
/// short enough that a hung shell-out doesn't strand the UI".
const GIT_TIMEOUT_MS: u64 = 60_000;

const BRANCH_SLUG_LEN: usize = 16;
const SLUG_MAX_LEN: usize = 42;

/// Stable id of the hidden singleton project that owns every scratch
/// workspace (repo-less side chats and "More details" popups). Mirrored in
/// `src/shared/types.ts` (`SCRATCH_PROJECT_ID`) so the renderer can exclude it
/// from repo pickers and normal sidebar grouping.
pub const SCRATCH_PROJECT_ID: &str = "scratch-side-chats";

/// 200 ms settle after `cancelChecks` fires so SIGTERM has time to land
/// before we recheck porcelain. See TS comment in `archiveWorkspace`.
const CANCEL_SETTLE_MS: u64 = 200;
const ARCHIVE_QUIESCE_TIMEOUT_MS: u64 = 5_000;

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
    pub(super) watchers: Mutex<WatcherRegistry>,
    lifecycle: Arc<WorkspaceLifecycle>,
    providers: Option<Arc<ProviderSessionService>>,
    checks: Option<Arc<CheckService>>,
    terminals: Option<Arc<TerminalService>>,
    approvals: Option<Arc<ApprovalService>>,
    /// Warm `cursor-agent acp` process pool, installed after construction (it
    /// is built alongside the provider launcher). Archive and project removal
    /// evict the entry for a checkout they are about to stop managing —
    /// nothing else drains the pool before `RunEvent::Exit`.
    cursor_acp: OnceCell<Arc<CursorAcpSessions>>,
    /// App-owned directory that holds one subdirectory per scratch workspace
    /// (repo-less side chats). `None` when the app data dir could not be
    /// resolved — `create_scratch` then fails with a clear error.
    scratch_root: Option<PathBuf>,
}

/// A workspace pointing at a checkout that already exists — the one the chat
/// that dispatched this work is using. Not an IPC input: it is built inside the
/// launch path, which is why the path is a plain string rather than a validated
/// newtype. Unlike `create_current` that path is not the project root, because a
/// chat in a worktree shares that worktree, not the repo.
pub struct WorkspacesCreateAlongsideInput {
    pub project_id: crate::ipc::validation::ProjectId,
    pub task_label: crate::ipc::validation::TaskLabel,
    pub path: String,
    pub branch: String,
    pub base_ref: String,
}

impl WorkspaceService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Self::with_publisher(database, |_| {})
    }

    pub fn with_publisher<F>(database: Arc<Database>, publisher: F) -> Arc<Self>
    where
        F: Fn(DashboardDelta) + Send + Sync + 'static,
    {
        Self::with_services(
            database,
            publisher,
            WorkspaceLifecycle::new(),
            None,
            None,
            None,
            None,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_services<F>(
        database: Arc<Database>,
        publisher: F,
        lifecycle: Arc<WorkspaceLifecycle>,
        providers: Option<Arc<ProviderSessionService>>,
        checks: Option<Arc<CheckService>>,
        terminals: Option<Arc<TerminalService>>,
        approvals: Option<Arc<ApprovalService>>,
        scratch_root: Option<PathBuf>,
    ) -> Arc<Self>
    where
        F: Fn(DashboardDelta) + Send + Sync + 'static,
    {
        Arc::new(Self {
            database,
            publish_delta: Arc::new(publisher),
            watchers: Mutex::new(WatcherRegistry::default()),
            lifecycle,
            providers,
            checks,
            terminals,
            approvals,
            cursor_acp: OnceCell::new(),
            scratch_root,
        })
    }

    /// Install the warm Cursor ACP pool so archive and project removal can
    /// evict its per-workspace processes. Wired at boot after the pool is
    /// built; without it eviction is a no-op and the pool only drains at exit.
    pub fn set_cursor_acp(&self, pool: Arc<CursorAcpSessions>) {
        if self.cursor_acp.set(pool).is_err() {
            tracing::warn!("cursor ACP pool was already installed on the workspace service");
        }
    }

    /// Kill the warm `cursor-agent acp` process pinned to `path`, if any.
    /// Called where Argmax stops managing that checkout: the child otherwise
    /// keeps running — on a removed worktree, with its cwd on a deleted
    /// inode — until the app exits.
    async fn evict_cursor_acp(&self, path: &str) {
        if let Some(pool) = self.cursor_acp.get() {
            pool.evict(Path::new(path)).await;
        }
    }

    pub fn lifecycle(&self) -> Arc<WorkspaceLifecycle> {
        Arc::clone(&self.lifecycle)
    }

    pub fn start_open_watchers(self: &Arc<Self>) -> ArgmaxResult<usize> {
        let workspaces = {
            let connection = self.database.connection();
            crate::persistence::workspaces::list_workspaces(&connection, None, 500)?
        };
        let mut started = 0;
        for workspace in workspaces {
            if matches!(
                workspace.state.as_str(),
                "created"
                    | "running"
                    | "waiting"
                    | "blocked"
                    | "complete"
                    | "failed"
                    | "cancelled"
                    | "kept"
                    | "archiving"
                    | "archive-failed"
            ) {
                match self.watch(&workspace.id) {
                    Ok(()) => started += 1,
                    Err(error) => {
                        if matches!(
                            &error,
                            ArgmaxError::ServiceError { sub_code, .. }
                                if sub_code == "WATCHER_PATH_MISSING"
                        ) {
                            tracing::debug!(
                                workspace_id = %workspace.id,
                                ?error,
                                "skipping watcher restore for missing checkout"
                            );
                        } else {
                            tracing::warn!(
                                workspace_id = %workspace.id,
                                ?error,
                                "failed to restore workspace watcher"
                            );
                        }
                    }
                }
            }
        }
        Ok(started)
    }

    /// Reconcile an interrupted archive from durable evidence without
    /// repeating a destructive worktree removal. An isolated worktree is
    /// archived only when both its path and Git registration are gone.
    pub fn recover_interrupted_archives(self: &Arc<Self>) -> ArgmaxResult<usize> {
        let workspaces = {
            let connection = self.database.connection();
            crate::persistence::workspaces::list_workspaces(&connection, None, 500)?
        };
        let mut recovered = 0;
        for workspace in workspaces {
            if workspace.state == "archiving" {
                // A shared-checkout archive has no destructive step, so an
                // interrupted one can always complete: honor the archive.
                let next_state = if workspace.shared_workspace {
                    "archived"
                } else if Path::new(&workspace.path).exists() {
                    "archive-failed"
                } else {
                    let registration = {
                        let connection = self.database.connection();
                        require_project(&connection, &workspace.project_id).and_then(|project| {
                            isolated_worktree_is_registered(
                                Path::new(&project.repo_path),
                                Path::new(&workspace.path),
                            )
                        })
                    };
                    match registration {
                        Ok(false) => "archived",
                        Ok(true) => "archive-failed",
                        Err(error) => {
                            tracing::warn!(
                                workspace_id = %workspace.id,
                                ?error,
                                "could not prove interrupted worktree removal completed"
                            );
                            "archive-failed"
                        }
                    }
                };
                let recovered_workspace = {
                    let connection = self.database.connection();
                    update_workspace_state(&connection, &workspace.id, next_state)?
                };
                self.publish(DashboardDelta {
                    workspaces: vec![recovered_workspace],
                    ..DashboardDelta::default()
                });
                if let Some(approvals) = self.approvals.as_ref() {
                    approvals.cancel_workspace_pending(&workspace.id)?;
                }
                if next_state == "archived" {
                    self.close_watcher(&workspace.id);
                }
                recovered += 1;
            }
        }
        Ok(recovered)
    }

    /// Workspaces currently watched. Several sharing one checkout cost a
    /// single OS watch between them — see `watched_checkout_count`.
    pub fn open_watcher_count(&self) -> usize {
        self.watchers
            .lock_or_recover("watchers")
            .subscription_count()
    }

    /// Distinct OS-level filesystem watches held across all workspaces.
    pub fn watched_checkout_count(&self) -> usize {
        self.watchers.lock_or_recover("watchers").checkout_count()
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
            discard_worktree(Path::new(&project.repo_path), &worktree_path, &branch).await;
            return Err(invalid_workspace(
                format!("Could not create worktree for {branch}. {error}"),
                "Choose another base ref or branch name and retry.",
            ));
        }

        // Block scope, not drop(): the async Send analysis must see the
        // non-Send connection guard end before the setup-command await below.
        let persisted = (|| {
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
                    kind: "git".to_string(),
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
        })();
        // The worktree and branch exist but nothing references them: with no
        // row, archive can never reach either. Undo the git side rather than
        // leave the checkout orphaned.
        let workspace = match persisted {
            Ok(workspace) => workspace,
            Err(error) => {
                discard_worktree(Path::new(&project.repo_path), &worktree_path, &branch).await;
                return Err(error);
            }
        };
        if let Err(error) = self.watch(&workspace.id) {
            tracing::warn!(workspace_id = %workspace.id, ?error, "workspace watcher failed to start");
        }
        self.run_setup_command(&workspace.id, &project.settings.setup_command)
            .await;
        Ok(workspace)
    }

    /// Run the project's setup command in a freshly created worktree, before
    /// the caller launches an agent into it (dependencies install once per
    /// worktree). Runs through CheckService so the command gets the standard
    /// risk gate, timeout, output capture, and a persisted check row the
    /// review surface can show. Failure never blocks the workspace — the
    /// agent can usually repair a broken setup itself — so this only warns.
    async fn run_setup_command(self: &Arc<Self>, workspace_id: &str, setup_command: &str) {
        let command = setup_command.trim();
        if command.is_empty() {
            return;
        }
        let Some(checks) = self.checks.as_ref() else {
            tracing::warn!(
                workspace_id,
                command,
                "setup command configured but check service is unavailable"
            );
            return;
        };
        let run = checks
            .run_workspace_check(
                RunWorkspaceCheckInput {
                    workspace_id: workspace_id.to_string(),
                    command: command.to_string(),
                    timeout_ms: None,
                },
                None,
            )
            .await;
        match run {
            Ok(run) if run.status == "passed" => {}
            Ok(run) => tracing::warn!(
                workspace_id,
                command,
                status = %run.status,
                "setup command did not pass"
            ),
            Err(error) => {
                tracing::warn!(workspace_id, command, ?error, "setup command could not run")
            }
        }
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
                // Review compares against this, not HEAD. Using the current
                // branch made All on branch and Committed empty on a clean
                // shared checkout.
                base_ref: project
                    .default_branch
                    .clone()
                    .unwrap_or_else(|| project.current_branch.clone()),
                path: project.repo_path.clone(),
                state: "created".to_string(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )?;
        self.publish(DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace.clone()],
            ..DashboardDelta::default()
        });
        drop(connection);
        if let Err(error) = self.watch(&workspace.id) {
            tracing::warn!(workspace_id = %workspace.id, ?error, "workspace watcher failed to start");
        }
        Ok(workspace)
    }

    /// A workspace in a checkout that already exists: the one the chat that
    /// dispatched this work runs in. `create_current` always resolves the
    /// project's own root, which is the wrong tree whenever the dispatching
    /// chat is itself in a worktree — the work then landed on another branch
    /// while both agents were told they were sharing a checkout.
    pub fn create_alongside(
        self: &Arc<Self>,
        input: WorkspacesCreateAlongsideInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let project = require_project(&connection, input.project_id.as_str())?;
        let workspace = persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                task_label: input.task_label.as_str().to_string(),
                branch: input.branch,
                base_ref: input.base_ref,
                path: input.path,
                state: "created".to_string(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )?;
        self.publish(DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace.clone()],
            ..DashboardDelta::default()
        });
        drop(connection);
        if let Err(error) = self.watch(&workspace.id) {
            tracing::warn!(workspace_id = %workspace.id, ?error, "workspace watcher failed to start");
        }
        Ok(workspace)
    }

    /// The workspace that hosts one imported session (see `crate::sync`).
    /// Same shape as `create_current`, but the delta waits: the session row is
    /// created next, and shipping both together stops the sidebar from
    /// flashing an empty workspace.
    pub fn create_current_for_import(
        self: &Arc<Self>,
        project_id: &str,
        task_label: &str,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let project = require_project(&connection, project_id)?;
        let workspace = persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                task_label: task_label.to_string(),
                branch: project.current_branch.clone(),
                base_ref: project
                    .default_branch
                    .clone()
                    .unwrap_or_else(|| project.current_branch.clone()),
                path: project.repo_path.clone(),
                state: "complete".to_string(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )?;
        Ok(workspace)
    }

    /// Ship a freshly imported session and its workspace as one delta, then
    /// start watching the checkout like any other row.
    pub fn publish_imported(
        self: &Arc<Self>,
        workspace: WorkspaceSummary,
        session: SessionSummary,
    ) {
        self.publish(DashboardDelta {
            workspaces: vec![workspace.clone()],
            sessions: vec![session],
            ..DashboardDelta::default()
        });
        if let Err(error) = self.watch(&workspace.id) {
            tracing::warn!(workspace_id = %workspace.id, ?error, "workspace watcher failed to start");
        }
    }

    pub fn publish_session(&self, session: SessionSummary) {
        self.publish(DashboardDelta {
            sessions: vec![session],
            ..DashboardDelta::default()
        });
    }

    /// Push workspace rows the renderer already knows, so a PR marker that
    /// landed in SQLite shows up on the sidebar without waiting for a poller
    /// tick or a filesystem watcher.
    pub fn publish_workspaces(&self, workspaces: Vec<WorkspaceSummary>) {
        self.publish(DashboardDelta {
            workspaces,
            ..DashboardDelta::default()
        });
    }

    /// A session whose transcript grew outside the app (session sync's
    /// `extend`): the fresh events ride the delta so an open conversation view
    /// shows the external continuation without a reopen-and-backfill.
    pub fn publish_session_with_events(&self, session: SessionSummary, events: Vec<TimelineEvent>) {
        self.publish(DashboardDelta {
            sessions: vec![session],
            events,
            ..DashboardDelta::default()
        });
    }

    /// Tell the renderer to drop pruned imports. Deletion already happened in
    /// SQLite; this is the only signal the delta protocol has for "gone".
    pub fn remove_imported(&self, workspace_ids: &[String], session_ids: &[String]) {
        if workspace_ids.is_empty() && session_ids.is_empty() {
            return;
        }
        for workspace_id in workspace_ids {
            self.close_watcher(workspace_id);
        }
        self.publish(DashboardDelta {
            removed_session_ids: session_ids.to_vec(),
            removed_workspace_ids: workspace_ids.to_vec(),
            ..DashboardDelta::default()
        });
    }

    /// Fork a finished session: a new sidebar workspace at the same checkout
    /// whose session carries a copy of the transcript and the source's
    /// provider conversation id, flagged so its first resumed turn diverges
    /// (`--fork-session`) instead of appending to the original conversation.
    ///
    /// Not for Cursor: its CLI/ACP has no fork-on-resume, so two sessions
    /// sharing one conversation id would write into the same provider
    /// session. Claude diverges via `--fork-session`, Codex via `exec fork`,
    /// OpenCode via `run --fork`. The fork always points at the source
    /// workspace's directory as a shared checkout — archiving the fork never
    /// tears down a worktree it does not own.
    pub fn fork_session(self: &Arc<Self>, session_id: &str) -> ArgmaxResult<SessionForkResult> {
        let connection = self.database.connection();
        let source_session = find_session_by_id(&connection, session_id)?;
        if source_session.provider == "cursor" {
            return Err(invalid_workspace(
                "Cursor chats can't be forked: cursor-agent has no way to fork a resumed conversation.",
                "Fork a Claude, Codex, or OpenCode chat instead.",
            ));
        }
        if matches!(source_session.state.as_str(), "running" | "waiting") {
            return Err(invalid_workspace(
                "This chat is still working; forking mid-turn would copy a partial transcript.",
                "Wait for the turn to finish, then fork.",
            ));
        }
        let source_workspace = find_workspace_by_id(&connection, &source_session.workspace_id)?;
        // One transaction for the whole fork. The transcript copy is a row per
        // event, and `events` carries an FTS5 insert trigger, so committing
        // each one separately blocked the app's single connection for the
        // length of the history — and a mid-copy failure left the workspace and
        // session rows standing with a truncated transcript.
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let workspace = persist_workspace(
            &transaction,
            &PersistWorkspaceInput {
                id: Uuid::new_v4().to_string(),
                project_id: source_workspace.project_id.clone(),
                task_label: format!("{} (fork)", source_workspace.task_label),
                branch: source_workspace.branch.clone(),
                base_ref: source_workspace.base_ref.clone(),
                path: source_workspace.path.clone(),
                state: "complete".to_string(),
                shared_workspace: true,
                kind: source_workspace.kind.clone(),
                dirty: source_workspace.dirty,
                changed_files: source_workspace.changed_files,
            },
        )?;
        let session = persist_session(
            &transaction,
            &PersistSessionInput {
                id: Uuid::new_v4().to_string(),
                workspace_id: workspace.id.clone(),
                provider: source_session.provider.clone(),
                model_label: source_session.model_label.clone(),
                model_id: source_session.model_id.clone(),
                reasoning_effort: source_session.reasoning_effort.clone(),
                permission_mode: Some(source_session.permission_mode.clone()),
                agent_mode: source_session.agent_mode.clone(),
                prompt: source_session.prompt.clone(),
                state: "complete".to_string(),
                attention: "normal".to_string(),
            },
        )?;
        // Order matters: setting the conversation id clears resume_fork, so
        // the flag goes on afterwards.
        let session = match source_session.provider_conversation_id.as_deref() {
            Some(conversation_id) => {
                let session = update_session_provider_conversation_id(
                    &transaction,
                    &session.id,
                    conversation_id,
                )?;
                set_session_resume_fork(&transaction, &session.id)?;
                session
            }
            // No conversation to resume yet (nothing ever ran): the fork is
            // just a transcript copy that starts fresh on its first message.
            None => session,
        };
        // Copy the transcript so the fork opens with the full history. Raw
        // provider output and usage stay with the original — they describe
        // work the fork did not perform.
        for event in list_all_session_events(&transaction, session_id)? {
            persist_timeline_event(
                &transaction,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: session.id.clone(),
                    r#type: event.r#type,
                    message: event.message,
                    payload: event.payload,
                    created_at: Some(event.created_at),
                },
            )?;
        }
        transaction
            .commit()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        self.publish(DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace.clone()],
            sessions: vec![session.clone()],
            ..DashboardDelta::default()
        });
        drop(connection);
        if let Err(error) = self.watch(&workspace.id) {
            tracing::warn!(workspace_id = %workspace.id, ?error, "workspace watcher failed to start");
        }
        Ok(SessionForkResult { workspace, session })
    }

    pub async fn move_session_to_project(
        self: &Arc<Self>,
        source_session_id: &str,
        destination_project_id: &str,
        worktree: bool,
        keep_source: bool,
    ) -> ArgmaxResult<SessionMoveResult> {
        let (source_session, source_workspace, source_project, destination_project) = {
            let connection = self.database.connection();
            let source_session = find_session_by_id(&connection, source_session_id)?;
            if matches!(
                source_session.state.as_str(),
                "running" | "waiting" | "blocked"
            ) {
                return Err(invalid_workspace(
                    "This chat is still working. Moving now would copy a partial transcript.",
                    "Wait for the turn to settle, then retry.",
                ));
            }
            let source_workspace = find_workspace_by_id(&connection, &source_session.workspace_id)?;
            if source_workspace.project_id == destination_project_id {
                return Err(invalid_workspace(
                    "The destination must be a different project.",
                    "Choose another registered project.",
                ));
            }
            let source_project = require_project(&connection, &source_workspace.project_id)?;
            let destination_project = require_project(&connection, destination_project_id)?;
            (
                source_session,
                source_workspace,
                source_project,
                destination_project,
            )
        };

        let project_id =
            crate::ipc::validation::ProjectId::try_from(destination_project.id.clone())
                .map_err(ArgmaxError::invalid)?;
        let task_label =
            crate::ipc::validation::TaskLabel::try_from(source_workspace.task_label.clone())
                .map_err(ArgmaxError::invalid)?;
        let destination_workspace = if worktree {
            let base_ref = crate::ipc::validation::BaseRef::try_from(
                destination_project.current_branch.clone(),
            )
            .map_err(ArgmaxError::invalid)?;
            self.create_isolated(WorkspacesCreateIsolatedInput {
                project_id,
                task_label,
                base_ref: Some(base_ref),
            })
            .await?
        } else {
            self.create_current(WorkspacesCreateCurrentInput {
                project_id,
                task_label,
            })?
        };

        let copied = (|| -> ArgmaxResult<(WorkspaceSummary, SessionSummary, TimelineEvent)> {
            let mut connection = self.database.connection();
            let transaction = connection
                .transaction()
                .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
            let destination_session = persist_session(
                &transaction,
                &PersistSessionInput {
                    id: Uuid::new_v4().to_string(),
                    workspace_id: destination_workspace.id.clone(),
                    provider: source_session.provider.clone(),
                    model_label: source_session.model_label.clone(),
                    model_id: source_session.model_id.clone(),
                    reasoning_effort: source_session.reasoning_effort.clone(),
                    permission_mode: Some(source_session.permission_mode.clone()),
                    agent_mode: source_session.agent_mode.clone(),
                    prompt: source_session.prompt.clone(),
                    state: "complete".to_string(),
                    attention: "normal".to_string(),
                },
            )?;
            // A move relocates the same work, so its lineage travels with it:
            // whoever dispatched this chat is still owed the finish notice, and
            // the launch caps still have to count it where it now sits. The row
            // is re-read because the update lands after the insert.
            let destination_session = match source_session.launched_by_session_id.as_deref() {
                Some(launched_by) => {
                    record_session_launch(
                        &transaction,
                        &destination_session.id,
                        launched_by,
                        session_launch_lineage(&transaction, source_session_id)?.depth,
                        &source_session.launch_kind,
                    )?;
                    find_session_by_id(&transaction, &destination_session.id)?
                }
                None => destination_session,
            };
            for event in list_all_session_events(&transaction, source_session_id)? {
                persist_timeline_event(
                    &transaction,
                    &PersistTimelineEventInput {
                        id: Uuid::new_v4().to_string(),
                        session_id: destination_session.id.clone(),
                        r#type: event.r#type,
                        message: event.message,
                        payload: event.payload,
                        created_at: Some(event.created_at),
                    },
                )?;
            }
            let seam = persist_timeline_event(
                &transaction,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: destination_session.id.clone(),
                    r#type: "session.moved".to_string(),
                    message: format!(
                        "Moved from {} to {}.",
                        source_project.name, destination_project.name
                    ),
                    payload: json!({
                        "direction": "destination",
                        "sourceSessionId": source_session.id,
                        "sourceWorkspaceId": source_workspace.id,
                        "sourceProjectId": source_project.id,
                        "sourceProjectName": source_project.name,
                        "destinationSessionId": destination_session.id,
                        "destinationWorkspaceId": destination_workspace.id,
                        "destinationProjectId": destination_project.id,
                        "destinationProjectName": destination_project.name,
                        "destinationPath": destination_workspace.path,
                        "checkoutMode": if worktree { "worktree" } else { "shared" },
                        "sourceArchiveRequested": !keep_source,
                    }),
                    created_at: None,
                },
            )?;
            let destination_workspace =
                update_workspace_state(&transaction, &destination_workspace.id, "complete")?;
            transaction
                .commit()
                .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
            Ok((destination_workspace, destination_session, seam))
        })();
        let (destination_workspace, destination_session, destination_seam) = match copied {
            Ok(copied) => copied,
            Err(error) => {
                let cleanup = self
                    .archive(WorkspacesArchiveInput {
                        workspace_id: crate::ipc::validation::WorkspaceId::try_from(
                            destination_workspace.id.clone(),
                        )
                        .map_err(ArgmaxError::invalid)?,
                        force: Some(true),
                    })
                    .await;
                if let Err(cleanup) = cleanup {
                    // The caller only ever sees the copy failure, so without
                    // this an orphaned worktree and branch leave no trace.
                    tracing::warn!(
                        ?cleanup,
                        workspace_id = %destination_workspace.id,
                        "could not tear down the half-built move destination"
                    );
                }
                return Err(error);
            }
        };

        {
            let connection = self.database.connection();
            self.publish(DashboardDelta {
                projects: list_projects(&connection)?,
                workspaces: vec![destination_workspace.clone()],
                sessions: vec![destination_session.clone()],
                events: vec![destination_seam],
                ..DashboardDelta::default()
            });
        }

        let (source_archive_state, archive_error) = if keep_source {
            (source_workspace.state.clone(), None)
        } else {
            match self
                .archive(WorkspacesArchiveInput {
                    workspace_id: crate::ipc::validation::WorkspaceId::try_from(
                        source_workspace.id.clone(),
                    )
                    .map_err(ArgmaxError::invalid)?,
                    force: Some(false),
                })
                .await
            {
                Ok(workspace) => (workspace.state, None),
                Err(error) => ("error".to_string(), Some(error.to_string())),
            }
        };

        // Past this point the move is committed: the destination is built and
        // the source archived. A failure recording the source-side seam must
        // not surface as "could not move this session" — the move happened.
        let source_note = (|| -> ArgmaxResult<_> {
            let connection = self.database.connection();
            let source_session = find_session_by_id(&connection, source_session_id)?;
            let source_event = persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: source_session_id.to_string(),
                    r#type: "session.moved".to_string(),
                    message: format!("Moved to {}.", destination_project.name),
                    payload: json!({
                        "direction": "source",
                        "sourceSessionId": source_session_id,
                        "sourceWorkspaceId": source_workspace.id,
                        "sourceProjectId": source_project.id,
                        "sourceProjectName": source_project.name,
                        "destinationSessionId": destination_session.id,
                        "destinationWorkspaceId": destination_workspace.id,
                        "destinationProjectId": destination_project.id,
                        "destinationProjectName": destination_project.name,
                        "destinationPath": destination_workspace.path,
                        "checkoutMode": if worktree { "worktree" } else { "shared" },
                        "sourceArchiveState": source_archive_state,
                        "archiveError": archive_error,
                    }),
                    created_at: None,
                },
            )?;
            Ok((source_session, source_event))
        })();
        match source_note {
            Ok((source_session, source_event)) => {
                self.publish_session_with_events(source_session, vec![source_event]);
            }
            Err(error) => tracing::warn!(
                ?error,
                session_id = source_session_id,
                "session moved, but the source-side seam could not be recorded"
            ),
        }

        Ok(SessionMoveResult {
            workspace: destination_workspace,
            session: destination_session,
            source_archive_state,
        })
    }

    pub fn record_session_move_failure(
        &self,
        source_session_id: &str,
        error: &ArgmaxError,
    ) -> ArgmaxResult<()> {
        let (session, event) = {
            let connection = self.database.connection();
            let session = find_session_by_id(&connection, source_session_id)?;
            let event = persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: source_session_id.to_string(),
                    r#type: "error".to_string(),
                    message: format!("Could not move this chat: {error}"),
                    payload: json!({ "operation": "session.move" }),
                    created_at: None,
                },
            )?;
            (session, event)
        };
        self.publish_session_with_events(session, vec![event]);
        Ok(())
    }

    /// Create a repo-less scratch workspace: an app-owned directory under
    /// `scratch_root`, initialized as a minimal git repo (one empty commit on
    /// `main`) because provider CLIs assume a checkout — Codex outright
    /// refuses to run outside one. Owned by the hidden singleton
    /// `SCRATCH_PROJECT_ID` project. `shared_workspace: true` deliberately
    /// routes archive through the state-flip-only path: there is no worktree
    /// registration to tear down, and the directory is cheap to keep.
    pub async fn create_scratch(
        self: &Arc<Self>,
        input: WorkspacesCreateScratchInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let kind = input.kind.unwrap_or(ScratchWorkspaceKind::Scratch).as_str();
        let Some(scratch_root) = self.scratch_root.clone() else {
            return Err(invalid_workspace(
                "Scratch workspaces are unavailable: the app data directory could not be resolved.",
                "Restart the app and retry.",
            ));
        };
        let workspace_id = Uuid::new_v4().to_string();
        let workspace_path = scratch_root.join(&workspace_id);
        tokio::fs::create_dir_all(&workspace_path)
            .await
            .map_err(|error| {
                invalid_workspace(
                    format!(
                        "Could not create scratch directory {}: {error}",
                        workspace_path.display()
                    ),
                    "Check disk space and app data permissions, then retry.",
                )
            })?;
        let init = async {
            run_git_text(
                &workspace_path,
                &["init", "--initial-branch", "main"],
                Duration::from_millis(GIT_TIMEOUT_MS),
            )
            .await?;
            // Explicit identity and no signing: the empty commit must succeed
            // on machines without a global git identity and must never block
            // on a GPG prompt.
            run_git_text(
                &workspace_path,
                &[
                    "-c",
                    "user.name=Argmax",
                    "-c",
                    "user.email=argmax@localhost",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--allow-empty",
                    "--no-verify",
                    "-m",
                    "Argmax scratch workspace",
                ],
                Duration::from_millis(GIT_TIMEOUT_MS),
            )
            .await
        };
        if let Err(error) = init.await {
            let _ = tokio::fs::remove_dir_all(&workspace_path).await;
            return Err(invalid_workspace(
                format!("Could not initialize scratch workspace. {error}"),
                "Verify git is installed and retry.",
            ));
        }

        // Any failure past this point leaves an initialized directory behind;
        // remove it so `side-chats/` never accumulates dirs with no row.
        let persisted = (|| {
            let connection = self.database.connection();
            ensure_scratch_project(&connection, &scratch_root)?;
            let workspace = persist_workspace(
                &connection,
                &PersistWorkspaceInput {
                    id: workspace_id,
                    project_id: SCRATCH_PROJECT_ID.to_string(),
                    task_label: input.task_label.as_str().to_string(),
                    branch: "main".to_string(),
                    base_ref: "main".to_string(),
                    path: workspace_path.display().to_string(),
                    state: "created".to_string(),
                    shared_workspace: true,
                    kind: kind.to_string(),
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
        })();
        let workspace = match persisted {
            Ok(workspace) => workspace,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&workspace_path).await;
                return Err(error);
            }
        };
        if let Err(error) = self.watch(&workspace.id) {
            tracing::warn!(workspace_id = %workspace.id, ?error, "workspace watcher failed to start");
        }
        Ok(workspace)
    }

    pub fn keep(self: &Arc<Self>, input: WorkspacesKeepInput) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let current = find_workspace_by_id(&connection, input.workspace_id.as_str())?;
        if current.state == "archiving" {
            return Err(ArgmaxError::service(
                "WORKSPACE_ARCHIVING",
                "Workspace archive is in progress; keep cannot change its lifecycle state.",
            ));
        }
        let workspace = update_workspace_state(&connection, input.workspace_id.as_str(), "kept")?;
        if current.state == "archive-failed" {
            self.lifecycle.reopen(&current.id);
        }
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

        let prior = {
            let connection = self.database.connection();
            find_workspace_by_id(&connection, &workspace_id)?
        };
        if prior.state == "archived" {
            return Ok(prior);
        }
        let lease = self.lifecycle.begin_archive(&workspace_id)?;
        if prior.shared_workspace {
            return self.archive_shared(workspace_id, lease);
        }
        let archiving = {
            let connection = self.database.connection();
            update_workspace_state(&connection, &workspace_id, "archiving")?
        };
        self.publish(DashboardDelta {
            workspaces: vec![archiving],
            ..DashboardDelta::default()
        });
        if !self
            .lifecycle
            .wait_for_admissions(
                &workspace_id,
                Duration::from_millis(ARCHIVE_QUIESCE_TIMEOUT_MS),
            )
            .await
        {
            self.restore_archive_state(&prior)?;
            lease.finish(if prior.state == "archive-failed" {
                ArchiveOutcome::Failed
            } else {
                ArchiveOutcome::Reopened
            });
            return Err(ArgmaxError::service(
                "WORKSPACE_ADMISSION_TIMEOUT",
                "Timed out waiting for a process admission to finish before archive.",
            ));
        }

        let workspace = match self.refresh_status(&workspace_id).await {
            Ok(workspace) => workspace,
            Err(error) => {
                self.restore_archive_state(&prior)?;
                lease.finish(if prior.state == "archive-failed" {
                    ArchiveOutcome::Failed
                } else {
                    ArchiveOutcome::Reopened
                });
                return Err(error);
            }
        };

        let project = {
            let connection = self.database.connection();
            match require_project(&connection, &workspace.project_id) {
                Ok(project) => project,
                Err(error) => {
                    self.restore_archive_state(&prior)?;
                    lease.finish(if prior.state == "archive-failed" {
                        ArchiveOutcome::Failed
                    } else {
                        ArchiveOutcome::Reopened
                    });
                    return Err(error);
                }
            }
        };

        if workspace.dirty && !force {
            let kept = {
                let connection = self.database.connection();
                update_workspace_state(&connection, &workspace_id, "kept")?
            };
            self.publish(DashboardDelta {
                workspaces: vec![kept.clone()],
                ..DashboardDelta::default()
            });
            lease.finish(ArchiveOutcome::Reopened);
            return Ok(kept);
        }

        let timeout = Duration::from_millis(ARCHIVE_QUIESCE_TIMEOUT_MS);
        // Cancel every process-owning subsystem at once. Each future carries
        // its own wall-clock bound and error code, so a hang names the
        // subsystem that caused it instead of collapsing into one generic
        // quiescence timeout. Each service owns its cancellation job, so
        // cancelling this coordinator's wait cannot strand a child after
        // archive-failed.
        let provider_future = async {
            if let Some(providers) = self.providers.as_ref() {
                match tokio::time::timeout(timeout, providers.terminate_workspace(&workspace_id))
                    .await
                {
                    Ok(result) => result,
                    Err(_) => Err(ArgmaxError::service(
                        "WORKSPACE_PROVIDER_TIMEOUT",
                        "Timed out waiting for agent chats to terminate.",
                    )),
                }
            } else {
                Ok(())
            }
        };
        let check_future = async {
            if let Some(checks) = self.checks.as_ref() {
                if checks
                    .cancel_workspace_checks_and_wait(&workspace_id, timeout)
                    .await
                {
                    Ok(())
                } else {
                    Err(ArgmaxError::service(
                        "WORKSPACE_CHECK_TIMEOUT",
                        "Timed out waiting for workspace checks to terminate.",
                    ))
                }
            } else {
                Ok(())
            }
        };
        let terminal_future = async {
            if let Some(terminals) = self.terminals.as_ref() {
                if terminals.terminate_workspace(&workspace_id, timeout).await {
                    Ok(())
                } else {
                    Err(ArgmaxError::service(
                        "WORKSPACE_TERMINAL_TIMEOUT",
                        "Timed out waiting for workspace terminals to terminate.",
                    ))
                }
            } else {
                Ok(())
            }
        };
        let quiescence = tokio::time::timeout(timeout, async {
            tokio::join!(provider_future, check_future, terminal_future)
        })
        .await;
        let (provider_result, check_result, terminal_result) = match quiescence {
            Ok(results) => results,
            Err(_) => {
                if let Err(mark_error) = self.mark_archive_failed(&workspace_id) {
                    tracing::error!(?mark_error, workspace_id = %workspace_id, "failed to persist archive-failed state");
                }
                lease.finish(ArchiveOutcome::Failed);
                return Err(ArgmaxError::service(
                    "WORKSPACE_QUIESCE_TIMEOUT",
                    "Timed out waiting for workspace processes to terminate.",
                ));
            }
        };
        if let Err(error) = provider_result {
            if let Err(mark_error) = self.mark_archive_failed(&workspace_id) {
                tracing::error!(?mark_error, workspace_id = %workspace_id, "failed to persist archive-failed state");
            }
            lease.finish(ArchiveOutcome::Failed);
            return Err(error);
        }
        if let Err(error) = check_result {
            if let Err(mark_error) = self.mark_archive_failed(&workspace_id) {
                tracing::error!(?mark_error, workspace_id = %workspace_id, "failed to persist archive-failed state");
            }
            lease.finish(ArchiveOutcome::Failed);
            return Err(error);
        }
        if let Err(error) = terminal_result {
            if let Err(mark_error) = self.mark_archive_failed(&workspace_id) {
                tracing::error!(?mark_error, workspace_id = %workspace_id, "failed to persist archive-failed state");
            }
            lease.finish(ArchiveOutcome::Failed);
            return Err(error);
        }
        if let Some(approvals) = self.approvals.as_ref() {
            if let Err(error) = approvals.cancel_workspace_pending(&workspace_id) {
                if let Err(mark_error) = self.mark_archive_failed(&workspace_id) {
                    tracing::error!(?mark_error, workspace_id = %workspace_id, "failed to persist archive-failed state");
                }
                lease.finish(ArchiveOutcome::Failed);
                return Err(error);
            }
        }
        tokio::time::sleep(Duration::from_millis(CANCEL_SETTLE_MS)).await;
        // No more status refreshes can be useful once quiescence has completed.
        // Close the OS watcher before the final git read and worktree removal.
        self.close_watcher(&workspace_id);
        // The warm ACP process holds this worktree as its cwd, and the pool is
        // keyed by path, so it must go before `worktree remove --force`.
        self.evict_cursor_acp(&workspace.path).await;

        if !force && !workspace.shared_workspace {
            let recheck = match run_git_text(
                Path::new(&workspace.path),
                &["status", "--porcelain"],
                Duration::from_millis(GIT_TIMEOUT_MS),
            )
            .await
            {
                Ok(output) => output,
                Err(error) => {
                    if let Err(mark_error) = self.mark_archive_failed(&workspace_id) {
                        tracing::error!(?mark_error, workspace_id = %workspace_id, "failed to persist archive-failed state");
                    }
                    lease.finish(ArchiveOutcome::Failed);
                    return Err(ArgmaxError::service(
                        "WORKSPACE_STATUS_FAILED",
                        error.to_string(),
                    ));
                }
            };
            if !recheck.trim().is_empty() {
                let kept = {
                    let connection = self.database.connection();
                    update_workspace_state(&connection, &workspace_id, "kept")?
                };
                self.publish(DashboardDelta {
                    workspaces: vec![kept.clone()],
                    ..DashboardDelta::default()
                });
                if let Err(error) = super::watcher::watch_during_archive(self, &workspace_id) {
                    tracing::warn!(workspace_id = %workspace_id, ?error, "failed to restore watcher after dirty archive refusal");
                }
                lease.finish(ArchiveOutcome::Reopened);
                return Ok(kept);
            }
        }

        if !workspace.shared_workspace {
            let remove_args: Vec<&str> = if force {
                vec!["worktree", "remove", "--force", workspace.path.as_str()]
            } else {
                vec!["worktree", "remove", workspace.path.as_str()]
            };
            if let Err(error) = run_git_text(
                Path::new(&project.repo_path),
                &remove_args,
                Duration::from_millis(GIT_TIMEOUT_MS),
            )
            .await
            {
                if let Err(mark_error) = self.mark_archive_failed(&workspace_id) {
                    tracing::error!(?mark_error, workspace_id = %workspace_id, "failed to persist archive-failed state");
                }
                lease.finish(ArchiveOutcome::Failed);
                return Err(invalid_workspace(
                    format!("Could not archive worktree. {error}"),
                    "Review the worktree and retry archive.",
                ));
            }
        }

        let archived = {
            let connection = self.database.connection();
            match update_workspace_state(&connection, &workspace_id, "archived") {
                Ok(workspace) => workspace,
                Err(error) => {
                    drop(connection);
                    if let Err(mark_error) = self.mark_archive_failed(&workspace_id) {
                        tracing::error!(?mark_error, workspace_id = %workspace_id, "failed to persist archive-failed state");
                    }
                    lease.finish(ArchiveOutcome::Failed);
                    return Err(error);
                }
            }
        };
        self.publish(DashboardDelta {
            workspaces: vec![archived.clone()],
            ..DashboardDelta::default()
        });
        lease.finish(ArchiveOutcome::Archived);
        Ok(archived)
    }

    /// Archive a shared-checkout workspace. Nothing destructive follows the
    /// state flip — no worktree removal, no branch change — so the row is
    /// hidden immediately and process teardown runs in the background. A
    /// teardown failure is logged rather than resurrecting the row: the
    /// user's intent (hide this card) has already been honored durably.
    fn archive_shared(
        self: &Arc<Self>,
        workspace_id: String,
        lease: WorkspaceArchiveLease,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let archived = {
            let connection = self.database.connection();
            update_workspace_state(&connection, &workspace_id, "archived")?
        };
        self.publish(DashboardDelta {
            workspaces: vec![archived.clone()],
            ..DashboardDelta::default()
        });
        self.close_watcher(&workspace_id);
        // Archived closes admissions for good; new processes can no longer
        // attach while the background teardown drains the existing ones.
        lease.finish(ArchiveOutcome::Archived);
        // Popup workspaces are discard-on-close: their app-owned scratch dir
        // holds no user data and would otherwise accumulate one dir per
        // "More details" popup. Confined to the scratch root as a guard
        // against ever deleting a user path.
        let popup_dir_to_remove = (archived.kind == "popup")
            .then(|| PathBuf::from(&archived.path))
            .filter(|path| {
                self.scratch_root
                    .as_ref()
                    .is_some_and(|root| path.starts_with(root))
            });
        let acp_path_to_evict = (archived.kind != "git").then(|| archived.path.clone());
        let service = Arc::clone(self);
        tokio::spawn(async move {
            service.teardown_workspace_processes(&workspace_id).await;
            // Scratch and popup rows carry `shared_workspace = true` over an
            // app-owned per-chat directory, so their pool entry is theirs
            // alone. A real shared checkout is left warm: sibling workspaces
            // on the same directory may still be running a turn on it.
            if let Some(path) = acp_path_to_evict {
                service.evict_cursor_acp(&path).await;
            }
            if let Some(path) = popup_dir_to_remove {
                if let Err(error) = tokio::fs::remove_dir_all(&path).await {
                    tracing::warn!(
                        ?error,
                        path = %path.display(),
                        "popup archive: scratch dir removal failed"
                    );
                }
            }
        });
        Ok(archived)
    }

    /// Best-effort drain of every process-owning subsystem for an
    /// already-archived shared workspace. Failures are logged per subsystem;
    /// there is no state to roll back.
    async fn teardown_workspace_processes(self: &Arc<Self>, workspace_id: &str) {
        let timeout = Duration::from_millis(ARCHIVE_QUIESCE_TIMEOUT_MS);
        if !self
            .lifecycle
            .wait_for_admissions(workspace_id, timeout)
            .await
        {
            tracing::warn!(
                workspace_id,
                "shared archive: admission wait timed out before teardown"
            );
        }
        if let Some(providers) = self.providers.as_ref() {
            match tokio::time::timeout(timeout, providers.terminate_workspace(workspace_id)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(
                        ?error,
                        workspace_id,
                        "shared archive: agent session teardown failed"
                    );
                }
                Err(_) => {
                    tracing::warn!(
                        workspace_id,
                        "shared archive: agent session teardown timed out"
                    );
                }
            }
        }
        if let Some(checks) = self.checks.as_ref() {
            if !checks
                .cancel_workspace_checks_and_wait(workspace_id, timeout)
                .await
            {
                tracing::warn!(workspace_id, "shared archive: check teardown timed out");
            }
        }
        if let Some(terminals) = self.terminals.as_ref() {
            if !terminals.terminate_workspace(workspace_id, timeout).await {
                tracing::warn!(workspace_id, "shared archive: terminal teardown timed out");
            }
        }
        if let Some(approvals) = self.approvals.as_ref() {
            if let Err(error) = approvals.cancel_workspace_pending(workspace_id) {
                tracing::warn!(
                    ?error,
                    workspace_id,
                    "shared archive: approval cancel failed"
                );
            }
        }
    }

    /// Drain every process-owning subsystem for all of a project's workspaces.
    /// `projects:remove` cascades workspaces and sessions out of SQLite, and
    /// each subsystem resolves its victims from those rows, so this has to run
    /// before the delete or the running agents become unreachable — still
    /// editing the checkout with no UI left to stop them.
    pub(crate) async fn teardown_project(self: &Arc<Self>, project_id: &str) {
        let workspaces = {
            let connection = self.database.connection();
            project_workspaces_to_tear_down(&connection, project_id)
        };
        let workspaces = match workspaces {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(
                    ?error,
                    project_id,
                    "project removal: could not list workspaces to tear down"
                );
                return;
            }
        };
        for (workspace_id, path) in workspaces {
            self.teardown_workspace_processes(&workspace_id).await;
            self.close_watcher(&workspace_id);
            // Every workspace on this project is going away, the shared
            // checkout included, so no warm process on any of these paths has
            // a session left to serve.
            self.evict_cursor_acp(&path).await;
        }
    }

    fn restore_archive_state(self: &Arc<Self>, prior: &WorkspaceSummary) -> ArgmaxResult<()> {
        let connection = self.database.connection();
        let restored = update_workspace_state(&connection, &prior.id, &prior.state)?;
        self.publish(DashboardDelta {
            workspaces: vec![restored.clone()],
            ..DashboardDelta::default()
        });
        drop(connection);
        if Path::new(&restored.path).exists() {
            if let Err(error) = super::watcher::watch_during_archive(self, &prior.id) {
                tracing::warn!(workspace_id = %prior.id, ?error, "failed to restore workspace watcher after archive failure");
            }
        } else {
            self.close_watcher(&prior.id);
        }
        Ok(())
    }

    fn mark_archive_failed(self: &Arc<Self>, workspace_id: &str) -> ArgmaxResult<()> {
        let connection = self.database.connection();
        let failed = update_workspace_state(&connection, workspace_id, "archive-failed")?;
        self.publish(DashboardDelta {
            workspaces: vec![failed.clone()],
            ..DashboardDelta::default()
        });
        drop(connection);
        if Path::new(&failed.path).exists() {
            if let Err(error) = super::watcher::watch_during_archive(self, workspace_id) {
                tracing::warn!(workspace_id = %workspace_id, ?error, "failed to restore watcher after archive failure");
            }
        } else {
            self.close_watcher(workspace_id);
        }
        Ok(())
    }

    pub async fn refresh_status(
        self: &Arc<Self>,
        workspace_id: &str,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let workspace = {
            let connection = self.database.connection();
            find_workspace_by_id(&connection, workspace_id)?
        };
        let status = read_checkout_status(Path::new(&workspace.path)).await;
        let unchanged = workspace.clone();
        match self.persist_checkout_status(workspace, status.as_ref())? {
            Some(summary) => {
                self.publish(DashboardDelta {
                    workspaces: vec![summary.clone()],
                    ..DashboardDelta::default()
                });
                Ok(summary)
            }
            None => Ok(unchanged),
        }
    }

    /// Refresh every workspace pointing at one checkout from a single git read.
    ///
    /// Sessions created on the current checkout all share one path, so a repo
    /// with N open workspaces used to run N status reads against byte-identical
    /// state on every filesystem event. The read belongs to the path; only the
    /// persist/publish step is per workspace.
    ///
    /// Returns how many workspace rows were still present, so a caller can
    /// retire a watcher whose subjects have all been deleted.
    pub async fn refresh_checkout(
        self: &Arc<Self>,
        path: &Path,
        workspace_ids: &[String],
    ) -> usize {
        let status = read_checkout_status(path).await;
        let mut refreshed = 0;
        let mut changed = Vec::new();
        for workspace_id in workspace_ids {
            let workspace = {
                let connection = self.database.connection();
                find_workspace_by_id(&connection, workspace_id)
            };
            let Ok(workspace) = workspace else {
                continue;
            };
            refreshed += 1;
            match self.persist_checkout_status(workspace, status.as_ref()) {
                Ok(Some(summary)) => changed.push(summary),
                Ok(None) => {}
                Err(error) => {
                    tracing::debug!(%workspace_id, ?error, "watcher: status apply failed")
                }
            }
        }
        // Every workspace on a shared checkout flips together, so publish them
        // as one delta rather than waking the renderer once per subscriber.
        if !changed.is_empty() {
            self.publish(DashboardDelta {
                workspaces: changed,
                ..DashboardDelta::default()
            });
        }
        refreshed
    }

    /// Persist one workspace's status, returning the new summary only when the
    /// visible status actually moved. Publishing is left to the caller so a
    /// shared checkout can batch its subscribers into one delta.
    ///
    /// `status` is `None` when the git read failed (transient lock,
    /// partially-removed worktree, ENOENT during teardown); the prior values
    /// stay authoritative rather than reporting a dirty workspace as clean.
    fn persist_checkout_status(
        self: &Arc<Self>,
        workspace: WorkspaceSummary,
        status: Option<&CheckoutStatus>,
    ) -> ArgmaxResult<Option<WorkspaceSummary>> {
        let workspace_id = workspace.id.clone();
        let workspace_id = workspace_id.as_str();
        let (branch, changed_files, dirty) = match status {
            // A detached HEAD reports no branch name; keep the cached one.
            Some(status) => (
                status
                    .branch
                    .clone()
                    .unwrap_or_else(|| workspace.branch.clone()),
                status.changed_files,
                status.dirty,
            ),
            None => (
                workspace.branch.clone(),
                workspace.changed_files,
                workspace.dirty,
            ),
        };

        // Filesystem churn is a status observation, not user or agent
        // activity. Avoid touching SQLite or publishing a dashboard delta
        // when the visible status is unchanged. This keeps watcher refreshes
        // from reordering and repainting every sidebar row during a build.
        if branch == workspace.branch
            && dirty == workspace.dirty
            && changed_files == workspace.changed_files
        {
            return Ok(None);
        }

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
        Ok(Some(summary))
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

    pub async fn autotitle(self: &Arc<Self>, input: WorkspacesAutotitleInput) -> ArgmaxResult<()> {
        let Some(task_label) = crate::providers::one_shot::generate_title(
            input.provider,
            input.model_id.as_str(),
            input.prompt.as_str(),
        )
        .await
        else {
            return Ok(());
        };

        let connection = self.database.connection();
        if let Some(workspace) =
            set_workspace_label_auto(&connection, input.workspace_id.as_str(), &task_label)?
        {
            self.publish(DashboardDelta {
                workspaces: vec![workspace],
                ..DashboardDelta::default()
            });
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

    pub fn set_priority_added(
        self: &Arc<Self>,
        input: WorkspacesSetPriorityAddedInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let workspace =
            set_workspace_priority_added(&connection, input.workspace_id.as_str(), input.added)?;
        self.publish(DashboardDelta {
            workspaces: vec![workspace.clone()],
            ..DashboardDelta::default()
        });
        Ok(workspace)
    }

    pub fn set_priority_dismissed(
        self: &Arc<Self>,
        input: WorkspacesSetPriorityDismissedInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let workspace = set_workspace_priority_dismissed(
            &connection,
            input.workspace_id.as_str(),
            input.dismissed,
        )?;
        self.publish(DashboardDelta {
            workspaces: vec![workspace.clone()],
            ..DashboardDelta::default()
        });
        Ok(workspace)
    }

    pub fn set_label(
        self: &Arc<Self>,
        input: WorkspacesSetLabelInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let workspace = set_workspace_label(
            &connection,
            input.workspace_id.as_str(),
            input.task_label.as_str(),
        )?;
        self.publish(DashboardDelta {
            workspaces: vec![workspace.clone()],
            ..DashboardDelta::default()
        });
        Ok(workspace)
    }

    pub fn set_icon(
        self: &Arc<Self>,
        input: WorkspacesSetIconInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let workspace = set_workspace_icon(
            &connection,
            input.workspace_id.as_str(),
            input.icon.as_ref().map(|token| token.as_str()),
            input.icon_color.as_ref().map(|token| token.as_str()),
        )?;
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

/// Branch and dirty state for one checkout, from a single git invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CheckoutStatus {
    /// `None` on a detached HEAD, where there is no branch name to report and
    /// the caller keeps whatever it had cached.
    pub branch: Option<String>,
    pub changed_files: i64,
    pub dirty: bool,
}

/// Read a checkout's branch and dirty state.
///
/// `git status --porcelain --branch` carries both, replacing the former
/// `branch --show-current` + `status --porcelain` pair: same information, half
/// the process spawns. `None` means the read failed and callers should keep
/// their cached values.
async fn read_checkout_status(path: &Path) -> Option<CheckoutStatus> {
    match run_git_text(
        path,
        &["status", "--porcelain", "--branch"],
        Duration::from_millis(GIT_TIMEOUT_MS),
    )
    .await
    {
        Ok(output) => Some(parse_checkout_status(&output)),
        Err(error) => {
            tracing::debug!(
                path = %path.display(),
                %error,
                "checkout status read failed; preserving prior branch/dirty state"
            );
            None
        }
    }
}

fn parse_checkout_status(output: &str) -> CheckoutStatus {
    // With `--branch`, git emits the `## ` header as the first line. Only the
    // first line is treated as the header so a pathological filename can't be
    // mistaken for one — and, more importantly, so the header is never counted
    // as a changed file.
    let mut lines = output.lines().peekable();
    let branch = match lines.peek().and_then(|line| line.strip_prefix("## ")) {
        Some(header) => {
            let branch = parse_branch_header(header);
            lines.next();
            branch
        }
        None => None,
    };
    let changed_files = lines.filter(|line| !line.trim().is_empty()).count() as i64;
    CheckoutStatus {
        branch,
        changed_files,
        dirty: changed_files > 0,
    }
}

fn parse_branch_header(header: &str) -> Option<String> {
    // Detached HEAD — no branch to report.
    if header.starts_with("HEAD (no branch)") {
        return None;
    }
    // Before the first commit git prefixes the name instead of omitting it.
    let header = header
        .strip_prefix("No commits yet on ")
        .unwrap_or(header)
        .trim();
    // `main...origin/main [ahead 1, behind 2]` — the local name is everything
    // before the upstream separator. Refs can contain neither ".." nor spaces,
    // so neither split can cut into a branch name.
    let name = header
        .split("...")
        .next()
        .unwrap_or(header)
        .split_whitespace()
        .next()
        .unwrap_or("");
    (!name.is_empty()).then(|| name.to_owned())
}

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

fn project_workspaces_to_tear_down(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> rusqlite::Result<Vec<(String, String)>> {
    let mut statement =
        connection.prepare_cached("SELECT id, path FROM workspaces WHERE project_id = ?")?;
    let rows = statement.query_map([project_id], |row| {
        Ok((row.get::<_, String>("id")?, row.get::<_, String>("path")?))
    })?;
    rows.collect()
}

/// Upsert the hidden singleton project that owns scratch workspaces. Keyed by
/// the stable `SCRATCH_PROJECT_ID` so the renderer can filter it out of repo
/// pickers; `repo_path` is the scratch root, which satisfies the schema's
/// NOT NULL UNIQUE without pointing at a user repository.
fn ensure_scratch_project(
    connection: &rusqlite::Connection,
    scratch_root: &Path,
) -> ArgmaxResult<()> {
    if find_project_by_id(connection, SCRATCH_PROJECT_ID)?.is_some() {
        return Ok(());
    }
    persist_project(
        connection,
        &PersistProjectInput {
            id: SCRATCH_PROJECT_ID.to_string(),
            name: "Side chats".to_string(),
            repo_path: scratch_root.display().to_string(),
            current_branch: "main".to_string(),
            default_branch: Some("main".to_string()),
            settings: ProjectSettings {
                worktree_location: scratch_root.display().to_string(),
                setup_command: String::new(),
                check_commands: Vec::new(),
            },
        },
    )?;
    Ok(())
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

fn isolated_worktree_is_registered(repo_path: &Path, worktree_path: &Path) -> ArgmaxResult<bool> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|error| {
            invalid_workspace(
                format!("Could not inspect git worktrees: {error}"),
                "Verify the project repository and retry archive.",
            )
        })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(invalid_workspace(
            format!("Could not inspect git worktrees: {}", detail.trim()),
            "Verify the project repository and retry archive.",
        ));
    }

    let target = comparable_worktree_path(worktree_path)
        .to_string_lossy()
        .into_owned();
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(|path| {
            comparable_worktree_path(Path::new(path))
                .to_string_lossy()
                .into_owned()
        })
        .any(|path| path == target))
}

fn comparable_worktree_path(path: &Path) -> PathBuf {
    let normalized = normalize(path);
    if let Ok(canonical) = normalized.canonicalize() {
        return canonical;
    }

    // Git canonicalizes the repository path even when the worktree itself is
    // already gone. Resolve the nearest existing ancestor and append the
    // missing components so `/var` and `/private/var` compare equally on
    // macOS.
    let mut probe = normalized.clone();
    let mut missing = Vec::new();
    while !probe.exists() {
        let Some(name) = probe.file_name() else {
            return normalized;
        };
        missing.push(name.to_os_string());
        probe.pop();
    }
    let Ok(mut canonical) = probe.canonicalize() else {
        return normalized;
    };
    for component in missing.iter().rev() {
        canonical.push(component);
    }
    canonical
}

/// Undo a `git worktree add -b` that must not survive: deregister the
/// worktree, delete its directory, and drop the branch it created. Every step
/// is best-effort — this only ever runs on an error path, where a second
/// failure has nothing left to report to.
async fn discard_worktree(repo_path: &Path, worktree_path: &Path, branch: &str) {
    let _ = run_git_text(
        repo_path,
        &[
            "worktree",
            "remove",
            "--force",
            &worktree_path.display().to_string(),
        ],
        Duration::from_millis(GIT_TIMEOUT_MS),
    )
    .await;
    let _ = tokio::fs::remove_dir_all(worktree_path).await;
    // After the worktree is gone the branch is unreferenced; without this it
    // stays behind and collides with the next workspace on the same label.
    let _ = run_git_text(
        repo_path,
        &["branch", "-D", branch],
        Duration::from_millis(GIT_TIMEOUT_MS),
    )
    .await;
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

    // A create that dies after `git worktree add` must leave nothing behind:
    // with no workspace row, archive can never reach the worktree, and a
    // surviving branch collides with the next attempt at the same task label.
    #[tokio::test]
    async fn discarding_a_worktree_removes_its_directory_and_branch() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo dir");
        let git = |cwd: PathBuf, args: Vec<&str>| {
            let out = std::process::Command::new("git")
                .args(&args)
                .current_dir(&cwd)
                .output()
                .expect("git");
            assert!(out.status.success(), "git {args:?} failed");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        git(repo.clone(), vec!["init", "-q", "."]);
        git(repo.clone(), vec!["config", "user.email", "t@example.com"]);
        git(repo.clone(), vec!["config", "user.name", "t"]);
        std::fs::write(repo.join("f.txt"), "x\n").expect("write");
        git(repo.clone(), vec!["add", "-A"]);
        git(repo.clone(), vec!["commit", "-qm", "base"]);

        let worktree = dir.path().join("wt");
        let worktree_arg = worktree.display().to_string();
        git(
            repo.clone(),
            vec![
                "worktree",
                "add",
                "-b",
                "argmax/doomed",
                &worktree_arg,
                "HEAD",
            ],
        );
        assert!(worktree.exists());

        discard_worktree(&repo, &worktree, "argmax/doomed").await;

        assert!(!worktree.exists(), "worktree directory should be gone");
        let listed = git(repo.clone(), vec!["worktree", "list"]);
        assert!(
            !listed.contains(&worktree_arg),
            "worktree still registered: {listed}"
        );
        let branches = git(repo.clone(), vec!["branch", "--list", "argmax/doomed"]);
        assert!(branches.trim().is_empty(), "branch survived: {branches}");
    }

    #[test]
    fn branch_header_yields_the_local_branch_name() {
        assert_eq!(parse_branch_header("main"), Some("main".to_owned()));
        assert_eq!(
            parse_branch_header("main...origin/main"),
            Some("main".to_owned())
        );
        assert_eq!(
            parse_branch_header("feat/x...origin/feat/x [ahead 1, behind 2]"),
            Some("feat/x".to_owned())
        );
        assert_eq!(
            parse_branch_header("No commits yet on main"),
            Some("main".to_owned())
        );
    }

    #[test]
    fn detached_head_reports_no_branch() {
        assert_eq!(parse_branch_header("HEAD (no branch)"), None);
    }

    #[test]
    fn the_branch_header_is_not_counted_as_a_changed_file() {
        let status = parse_checkout_status("## main...origin/main\n M src/a.rs\n?? b.txt\n");
        assert_eq!(status.branch, Some("main".to_owned()));
        assert_eq!(status.changed_files, 2);
        assert!(status.dirty);
    }

    #[test]
    fn a_clean_checkout_reports_no_changes() {
        let status = parse_checkout_status("## main...origin/main\n");
        assert_eq!(status.branch, Some("main".to_owned()));
        assert_eq!(status.changed_files, 0);
        assert!(!status.dirty);
    }

    #[test]
    fn a_filename_starting_with_hashes_still_counts() {
        // Only the first line is the header, so a `## ...` path can't shadow it
        // or vanish from the count.
        let status = parse_checkout_status("## main\n?? ## odd name.txt\n");
        assert_eq!(status.branch, Some("main".to_owned()));
        assert_eq!(status.changed_files, 1);
    }

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
