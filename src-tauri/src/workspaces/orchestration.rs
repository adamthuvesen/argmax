// Workspace lifecycle service:
//   - `create_isolated` adds a fresh `git worktree` under the project's
//     configured worktree location; partial-worktree cleanup runs on
//     spawn failure so a half-registered worktree can't strand state.
//   - `create_current` records a workspace pointing at the project's
//     existing checkout (sharedWorkspace = true).
//   - `keep`, `archive`, `set_pinned` flip state bits.
//   - `archive` relocates isolated worktrees into app-owned recovery storage:
//     refreshes status, refuses to move dirty worktrees without
//     `force`, re-checks porcelain immediately before `worktree move`
//     to close the TOCTOU window, closes the fs watcher before move so
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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde_json::json;
use uuid::Uuid;

use super::lifecycle::{ArchiveOutcome, WorkspaceArchiveLease, WorkspaceLifecycle};
use super::watcher::WatcherRegistry;
use crate::approvals::service::ApprovalService;
use crate::checks::service::{CheckService, RunWorkspaceCheckInput};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::exec::{
    run_git_text, run_git_text_blocking, run_git_text_with_allowed_exit_codes, GIT_DEFAULT_TIMEOUT,
};
use crate::persistence::arcs::{get_arc, set_arc_coordinator_session};
use crate::persistence::database::Database;
use crate::persistence::events::{
    list_all_session_events, persist_copied_event, persist_timeline_event,
    PersistTimelineEventInput, TimelineEvent,
};
use crate::persistence::projects::{
    find_project_by_id, list_projects, persist_project, require_project, PersistProjectInput,
    ProjectSettings,
};
use crate::persistence::sessions::{
    find_session_by_id, persist_session, record_session_arc, record_session_launch,
    session_launch_lineage, set_session_resume_fork, update_session_provider_conversation_id,
    PersistSessionInput, SessionSummary,
};
use crate::persistence::workspaces::{
    clear_workspace_checkout_removed, find_workspace_by_id, mark_workspace_checkout_removed,
    mark_workspaces_viewed, persist_workspace, set_workspace_icon, set_workspace_label,
    set_workspace_label_auto, set_workspace_pinned, set_workspace_priority_added,
    set_workspace_priority_dismissed, set_workspace_snoozed_until, update_workspace_state,
    update_workspace_status, PersistWorkspaceInput, WorkspaceStatusInput, WorkspaceSummary,
    WorkspaceViewedObservation,
};
use crate::providers::cursor_acp::CursorAcpSessions;
use crate::providers::flush_queue::DashboardDelta;
use crate::providers::session_service::ProviderSessionService;
use crate::sessions::state::SessionState;
use crate::terminal::service::TerminalService;
use crate::util::sync::LockOrRecover;
use crate::util::workspace_paths::normalize;
use crate::workspaces::branch_names::{
    render_branch_step, BranchNameParts, BranchStep, DEFAULT_BRANCH_TEMPLATE,
};
use crate::workspaces::inputs::{
    OpenIdeChoice, ScratchWorkspaceKind, WorkspacesArchiveInput, WorkspacesAutotitleInput,
    WorkspacesCreateCurrentInput, WorkspacesCreateInCheckoutInput, WorkspacesCreateIsolatedInput,
    WorkspacesCreateScratchInput, WorkspacesKeepInput, WorkspacesMarkViewedInput,
    WorkspacesOpenInIdeInput, WorkspacesSetIconInput, WorkspacesSetLabelInput,
    WorkspacesSetPinnedInput, WorkspacesSetPriorityAddedInput, WorkspacesSetPriorityDismissedInput,
    WorkspacesSetSnoozedUntilInput,
};

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionForkResult {
    pub workspace: WorkspaceSummary,
    pub session: SessionSummary,
    pub fork: fork::ForkInfo,
}

pub mod fork;

/// A checkout a new chat can run in: one entry of the project's
/// `git worktree list` that has a branch checked out.
#[derive(Debug, Clone, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCheckout {
    pub branch: String,
    pub path: String,
    /// The project's own checkout, the first entry git lists.
    pub is_main: bool,
}

#[derive(Debug, Clone)]
pub struct SessionMoveResult {
    pub workspace: WorkspaceSummary,
    pub session: SessionSummary,
    pub source_archive_state: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceArchiveResult {
    pub workspace: WorkspaceSummary,
    pub recovery_path: Option<String>,
}

/// What an archive does with an isolated workspace's checkout once every
/// process in it has stopped.
enum ArchiveDisposition {
    /// Move the checkout into recovery storage. The chat goes to the
    /// Archived section.
    Retain,
    /// Delete the checkout, because its PR merged at `merged_head`. Only a
    /// checkout whose HEAD the merge already contains is removed. The chat
    /// stays in its sidebar section.
    RemoveMergedCheckout { merged_head: String },
}

impl std::ops::Deref for WorkspaceArchiveResult {
    type Target = WorkspaceSummary;

    fn deref(&self) -> &Self::Target {
        &self.workspace
    }
}

/// Another live workspace row pointing at the checkout an isolated workspace
/// owns. A multitask dispatched from a chat in a worktree is exactly this: it
/// shares the parent's checkout by design (ADR 0006) while keeping a row, a
/// session, and a watcher subscription of its own.
struct ColocatedWorkspace {
    id: String,
    task_label: String,
    /// A turn is still in flight in it.
    has_active_session: bool,
}

/// Where a moved session lands.
///
/// A workspace's `path` is write-once, so a session that needs to work in a
/// different directory gets a new workspace rather than having its own
/// retargeted — the same rule cross-project moves already follow.
#[derive(Debug, Clone)]
pub enum MoveDestination {
    /// Another registered project, on its shared checkout or a fresh worktree.
    Project { project_id: String, worktree: bool },
    /// An existing checkout of the *same* project: any directory `git worktree
    /// list` reports for it, including the main one. The row Argmax adds for it
    /// is always a shared checkout, so archiving the moved chat never deletes
    /// the tree. A checkout an isolated workspace already owns is refused —
    /// `git worktree list` reports those too, and that workspace's own archive
    /// would remove the directory out from under the moved chat.
    Checkout { path: String },
}

/// Trailing-edge coalescing window for fs.watch bursts (e.g. `npm install`).
pub(super) const WATCH_DEBOUNCE_MS: u64 = 200;
pub(super) const WATCH_MAX_DEBOUNCE_MS: u64 = 1_000;

/// Wall-clock cap for any git invocation made by this service. Matches
/// the TS default of "long enough for `worktree add` on big clones,
/// short enough that a hung shell-out doesn't strand the UI".
const GIT_TIMEOUT_MS: u64 = 60_000;

const WORKTREE_NAMES: &[&str] = &[
    "alder", "aspen", "birch", "cedar", "clover", "cypress", "elm", "fern", "fir", "grove",
    "hazel", "heather", "holly", "iris", "ivy", "juniper", "laurel", "linden", "maple", "meadow",
    "moss", "oak", "olive", "pine", "reed", "rowan", "sage", "spruce", "thyme", "violet", "willow",
    "yew",
];

/// `core.hooksPath` pointed where no hook can live, so `git worktree add` runs
/// only the checkout. `post_checkout_replay_command` runs the skipped hook.
const HOOKS_DISABLED: &str = "core.hooksPath=/dev/null";
/// What git passes a post-checkout hook as the previous HEAD of a new branch.
const NULL_SHA: &str = "0000000000000000000000000000000000000000";

/// Stable id of the hidden singleton project that owns every scratch
/// workspace (repo-less side chats and "More details" popups). Mirrored in
/// `src/shared/types.ts` (`SCRATCH_PROJECT_ID`) so the renderer can exclude it
/// from repo pickers and normal sidebar grouping.
pub const SCRATCH_PROJECT_ID: &str = "scratch-side-chats";
pub const ARCHIVE_RECOVERY_DIR: &str = "workspace-archive";
/// How long an archived worktree stays in recovery storage. An archive keeps
/// the whole checkout, ignored files and `node_modules` included, so a single
/// one can run to gigabytes, and a busy day archives dozens. Two days is long
/// enough to notice a workspace was archived too early; after that only the
/// checkout is removed, and the branch and its commits stay in the repository.
pub const ARCHIVE_RECOVERY_EXPIRY: Duration = Duration::from_secs(2 * 24 * 60 * 60);
/// `git worktree remove` deletes the checkout file by file, and an archive can
/// hold hundreds of thousands of them. A timeout only falls back to deleting
/// the directory directly, so it can be generous.
const ARCHIVE_EXPIRY_GIT_TIMEOUT: Duration = Duration::from_secs(5 * 60);

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
    cursor_acp: OnceLock<Arc<CursorAcpSessions>>,
    grok_acp: OnceLock<Arc<crate::providers::grok_acp::GrokAcpSessions>>,
    /// App-owned directory that holds one subdirectory per scratch workspace
    /// (repo-less side chats). `None` when the app data dir could not be
    /// resolved — `create_scratch` then fails with a clear error.
    scratch_root: Option<PathBuf>,
    /// App-owned directory where isolated worktrees remain available after
    /// archive, including their untracked and ignored files.
    archive_recovery_root: Option<PathBuf>,
}

/// A workspace pointing at a checkout that already exists — the one the chat
/// that dispatched this work is using. Not an IPC input: it is built inside the
/// launch path, which is why the path is a plain string rather than a validated
/// newtype. Unlike `create_current` that path is not the project root, because a
/// chat in a worktree shares that worktree, not the repo.
pub struct WorkspacesCreateAlongsideInput {
    pub project_id: crate::application::validation::ProjectId,
    pub task_label: crate::application::validation::TaskLabel,
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
        archive_recovery_root: Option<PathBuf>,
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
            cursor_acp: OnceLock::new(),
            grok_acp: OnceLock::new(),
            scratch_root,
            archive_recovery_root,
        })
    }

    /// Install the warm Cursor ACP pool so archive and project removal can
    /// evict its per-workspace processes. Wired at boot after the pool is
    /// built; without it eviction is a no-op and the pool only drains at exit.
    pub fn set_grok_acp(&self, pool: Arc<crate::providers::grok_acp::GrokAcpSessions>) {
        if self.grok_acp.set(pool).is_err() {
            tracing::warn!("Grok ACP pool already set");
        }
    }

    pub fn set_cursor_acp(&self, pool: Arc<CursorAcpSessions>) {
        if self.cursor_acp.set(pool).is_err() {
            tracing::warn!("cursor ACP pool was already installed on the workspace service");
        }
    }

    /// Kill the warm `cursor-agent acp` process pinned to `path`, if any.
    /// Called where Argmax stops managing that checkout: the child otherwise
    /// keeps running — on a removed worktree, with its cwd on a deleted
    /// inode — until the app exits.
    async fn evict_provider_acp(&self, path: &str) {
        if let Some(pool) = self.grok_acp.get() {
            pool.evict(std::path::Path::new(path)).await;
        }
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
                if !workspace.shared_workspace
                    && workspace.kind == "git"
                    && !Path::new(&workspace.path).exists()
                {
                    // Archive recovery already validated this retained path.
                    // A rejected recovery must not be reclassified as a
                    // deleted checkout just because the old path is gone.
                    if self
                        .archive_recovery_path(&workspace.id)
                        .is_some_and(|path| path.exists())
                    {
                        continue;
                    }
                    let registration = {
                        let connection = self.database.connection();
                        require_project(&connection, &workspace.project_id).and_then(|project| {
                            worktree_is_registered_blocking(
                                Path::new(&project.repo_path),
                                Path::new(&workspace.path),
                            )
                        })
                    };
                    if matches!(registration, Ok(false)) {
                        let connection = self.database.connection();
                        if let Ok(archived) =
                            update_workspace_state(&connection, &workspace.id, "archived")
                        {
                            self.publish(DashboardDelta {
                                workspaces: vec![archived],
                                ..DashboardDelta::default()
                            });
                            tracing::info!(
                                workspace_id = %workspace.id,
                                path = %workspace.path,
                                "reconciled missing isolated worktree as archived"
                            );
                            continue;
                        }
                    }
                }
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

    /// Reconcile an interrupted archive, repairing Git's registration when
    /// the process stopped after moving files but before updating metadata.
    pub fn recover_interrupted_archives(self: &Arc<Self>) -> ArgmaxResult<usize> {
        let workspaces = {
            let connection = self.database.connection();
            crate::persistence::workspaces::list_workspaces(&connection, None, 500)?
        };
        let mut recovered = 0;
        for workspace in workspaces {
            if workspace.state == "archiving"
                || (workspace.state == "archive-failed" && !Path::new(&workspace.path).exists())
            {
                // A shared-checkout archive has no destructive step, so an
                // interrupted one can always complete: honor the archive.
                let next_state = if workspace.shared_workspace {
                    "archived"
                } else if Path::new(&workspace.path).exists() {
                    "archive-failed"
                } else if let Some(recovery) = self
                    .archive_recovery_path(&workspace.id)
                    .filter(|path| path.exists())
                {
                    let project = {
                        let connection = self.database.connection();
                        require_project(&connection, &workspace.project_id)?
                    };
                    match repair_archived_worktree(
                        Path::new(&project.repo_path),
                        &recovery,
                        &workspace.branch,
                    ) {
                        Ok(()) => "archived",
                        Err(error) => {
                            tracing::warn!(workspace_id = %workspace.id, ?error, "archived files retained but Git recovery failed");
                            "archive-failed"
                        }
                    }
                } else {
                    let registration = {
                        let connection = self.database.connection();
                        require_project(&connection, &workspace.project_id).and_then(|project| {
                            worktree_is_registered_blocking(
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
                if next_state != workspace.state {
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
        }
        Ok(recovered)
    }

    /// Remove the recovery checkouts of workspaces archived before
    /// `archived_before`. Only a directory whose workspace row is `archived`,
    /// or that no row owns any more, is eligible: an archive still under way,
    /// a failed one, and a kept workspace are never touched. Age comes from the
    /// row's `updated_at`, which the archive stamps, and from the directory and
    /// `.git` mtimes only when no row is left to ask. The branch and its
    /// commits stay.
    ///
    /// Blocking: it runs git and deletes whole checkouts, so callers put it on
    /// the blocking pool. Each failure is logged and skipped.
    pub fn expire_archive_recoveries(&self, archived_before: SystemTime) -> usize {
        let Some(root) = self.archive_recovery_root.as_ref() else {
            return 0;
        };
        let entries = match std::fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return 0,
            Err(error) => {
                tracing::warn!(root = %root.display(), ?error, "could not list archive recovery storage");
                return 0;
            }
        };
        let mut removed = 0;
        for entry in entries.flatten() {
            // Archive only ever creates directories here. Anything else, a
            // symlink above all, is not ours to delete.
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let checkout = entry.path();
            let Some(workspace_id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let owner = match self.archive_recovery_owner(&workspace_id) {
                Ok(owner) => owner,
                Err(error) => {
                    tracing::warn!(
                        workspace_id,
                        ?error,
                        "could not read the owner of an archived worktree; kept"
                    );
                    continue;
                }
            };
            let archived_at = match &owner {
                Some(owner) if owner.state != "archived" => continue,
                Some(owner) => chrono::DateTime::parse_from_rfc3339(&owner.updated_at)
                    .ok()
                    .map(SystemTime::from),
                // A moved checkout keeps its old directory mtime, but
                // `git worktree move` rewrites its `.git` file, so the later of
                // the two is when the archive happened.
                None => [checkout.clone(), checkout.join(".git")]
                    .iter()
                    .filter_map(|path| {
                        std::fs::metadata(path)
                            .and_then(|meta| meta.modified())
                            .ok()
                    })
                    .max(),
            };
            let Some(archived_at) = archived_at else {
                tracing::warn!(
                    workspace_id,
                    "could not tell when a worktree was archived; kept"
                );
                continue;
            };
            if archived_at >= archived_before {
                continue;
            }
            let repo_path = owner
                .and_then(|owner| owner.repo_path)
                .map(PathBuf::from)
                .filter(|path| path.exists())
                .or_else(|| worktree_common_dir(&checkout));
            match remove_archived_checkout(&checkout, repo_path.as_deref()) {
                Ok(()) => {
                    removed += 1;
                    tracing::info!(workspace_id, path = %checkout.display(), "removed expired archived worktree");
                }
                Err(error) => {
                    tracing::warn!(workspace_id, path = %checkout.display(), ?error, "could not remove expired archived worktree");
                }
            }
        }
        removed
    }

    fn archive_recovery_owner(
        &self,
        workspace_id: &str,
    ) -> ArgmaxResult<Option<ArchiveRecoveryOwner>> {
        use rusqlite::OptionalExtension;
        let connection = self.database.read_connection();
        connection
            .query_row(
                "SELECT workspaces.state, workspaces.updated_at, projects.repo_path \
                 FROM workspaces LEFT JOIN projects ON projects.id = workspaces.project_id \
                 WHERE workspaces.id = ?",
                [workspace_id],
                |row| {
                    Ok(ArchiveRecoveryOwner {
                        state: row.get(0)?,
                        updated_at: row.get(1)?,
                        repo_path: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(crate::persistence::sqlite_error)
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

    pub async fn create_isolated(
        self: &Arc<Self>,
        input: WorkspacesCreateIsolatedInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let (project, global_branch_template) = {
            let connection = self.database.connection();
            (
                require_project(&connection, input.project_id.as_str())?,
                crate::persistence::app_settings::branch_template(&connection),
            )
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

        let task_label = input.task_label.as_str();
        // Naming stays local so chat startup never waits for title generation.
        let name_id = Uuid::new_v4();
        let name = WORKTREE_NAMES[usize::from(name_id.as_bytes()[15]) % WORKTREE_NAMES.len()];
        // The project's template wins over the app-wide one, which wins over
        // the built-in `argmax/{word}-{id}`. Rendering is local; see
        // `branch_names`.
        let branch_template = project
            .branch_template
            .clone()
            .or(global_branch_template)
            .unwrap_or_else(|| DEFAULT_BRANCH_TEMPLATE.to_string());
        let name_parts = BranchNameParts::new(
            task_label,
            name,
            &name_id.simple().to_string()[..8],
            &chrono::Utc::now().format("%Y%m%d").to_string(),
        );
        // The base ref's validity has nothing to do with the branch name, and
        // the name is claimed atomically below, so there is no probe to run.
        assert_valid_ref(&project.repo_path, &base_ref).await?;

        let worktree_location = project.settings.worktree_location.clone();
        if !Path::new(&worktree_location).is_absolute() {
            return Err(invalid_workspace(
                format!("Worktree location must be absolute: {worktree_location}"),
                "Choose an absolute worktree location in project settings.",
            ));
        }
        tokio::fs::create_dir_all(&worktree_location)
            .await
            .map_err(|e| {
                invalid_workspace(
                    format!("Could not create worktree location {worktree_location}: {e}"),
                    "Check the project's worktree location setting.",
                )
            })?;
        // The configured root is the boundary, including for external roots.
        // Resolve it once, then append our generated single-component name.
        let worktree_root = tokio::fs::canonicalize(&worktree_location)
            .await
            .map_err(|error| {
                invalid_workspace(
                    format!("Could not resolve worktree location {worktree_location}: {error}"),
                    "Confirm the configured worktree location is accessible.",
                )
            })?;

        // Claim a free name. A template without `{id}` can render a name that
        // is taken (two chats with one label, even at the same moment), so each
        // candidate is claimed atomically and only what this call created is
        // ever removed:
        //   1. `create_dir` makes the worktree directory, and fails if anything
        //      is there. The branch with `/` replaced by `-` is the directory
        //      name, so `a/b-c` and `a-b/c` share one and the second one loses.
        //   2. `git branch` creates the branch ref under git's own lock, and
        //      fails if the name is taken or a parent or child ref blocks it.
        //   3. `git worktree add` then checks out the branch we own into the
        //      directory we own.
        // A loser at step 1 or 2 undoes nothing but its own empty directory and
        // tries the next name: `-2`, `-3`, …, then the name plus the launch's
        // random id, then the built-in `argmax/` name. A parent/child conflict
        // (an existing branch `adam/fix` blocks every `adam/fix/…`) skips
        // straight to that last name, because no suffix leaves the prefix.
        // The claim and the add are one group under the registry lock: a launch
        // that has claimed a branch must not have its `worktree add` overlap
        // another launch's. The directory claim in the loop is a plain
        // filesystem call and needs no lock.
        let registry_guard = lock_worktree_registry(Path::new(&project.repo_path)).await;
        let steps = BranchStep::all();
        let mut next_step = 0;
        let mut last_conflict = String::new();
        let (branch, worktree_path, branch_oid) = loop {
            let Some(step) = steps.get(next_step).copied() else {
                return Err(invalid_workspace(
                    format!("Could not find a free branch name. {last_conflict}"),
                    "Change the branch template in Settings, or retry.",
                ));
            };
            next_step += 1;
            let branch = render_branch_step(&branch_template, &name_parts, step);
            let candidate = worktree_root.join(branch.replace('/', "-"));
            match tokio::fs::create_dir(&candidate).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    last_conflict = format!("{} already exists.", candidate.display());
                    continue;
                }
                Err(error) => {
                    return Err(invalid_workspace(
                        format!("Could not create worktree destination: {error}"),
                        "Confirm the configured worktree location is accessible.",
                    ))
                }
            }
            match claim_branch(&project.repo_path, &branch, &base_ref).await {
                Ok(oid) => break (branch, candidate, oid),
                Err(failure) => {
                    // Ours and empty: `remove_dir` refuses anything else.
                    let _ = tokio::fs::remove_dir(&candidate).await;
                    match failure {
                        BranchClaimFailure::Taken(reason) => last_conflict = reason,
                        BranchClaimFailure::BlockedPrefix(reason) => {
                            last_conflict = reason;
                            next_step = next_step.max(steps.len() - 1);
                        }
                        BranchClaimFailure::Other(reason) => {
                            return Err(invalid_workspace(
                                format!("Could not create worktree for {branch}. {reason}"),
                                "Choose another base ref or branch name and retry.",
                            ))
                        }
                    }
                }
            }
        };

        // Only the checkout runs here. The repository's post-checkout hook is
        // replayed by `finish_worktree_in_background` once the row exists:
        // one that clones `node_modules` held this call, and with it the chat
        // opening, for as long as the copy took.
        let add_result = run_git_text(
            Path::new(&project.repo_path),
            &[
                "-c",
                HOOKS_DISABLED,
                "worktree",
                "add",
                &worktree_path.display().to_string(),
                &branch,
            ],
            Duration::from_millis(GIT_TIMEOUT_MS),
        )
        .await;
        // Released before any cleanup, which takes the same lock itself, and
        // before the row, the watcher and the background hook replay.
        drop(registry_guard);

        if let Err(error) = add_result {
            // The directory and the branch are both ours, so undoing them is
            // safe: nothing else can have been given either. This is the only
            // cleanup in the launch that runs after a git failure.
            discard_worktree(
                Path::new(&project.repo_path),
                &worktree_path,
                &branch,
                Some(branch_oid.as_str()),
            )
            .await;
            return Err(invalid_workspace(
                format!("Could not create worktree for {branch}. {error}"),
                "Choose another base ref or branch name and retry.",
            ));
        }

        // Block scope, not drop(): the async Send analysis must see the
        // non-Send connection guard end before the discard await below.
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
                discard_worktree(
                    Path::new(&project.repo_path),
                    &worktree_path,
                    &branch,
                    Some(branch_oid.as_str()),
                )
                .await;
                return Err(error);
            }
        };
        if let Err(error) = self.watch(&workspace.id) {
            tracing::warn!(workspace_id = %workspace.id, ?error, "workspace watcher failed to start");
        }
        self.finish_worktree_in_background(
            workspace.id.clone(),
            worktree_path,
            project.settings.setup_command.clone(),
        );
        Ok(workspace)
    }

    /// What a fresh worktree needs beyond the checkout: the repository's
    /// `post-checkout` hook, then the project's setup command. Both run after
    /// the caller has its workspace back, so the chat opens as soon as the
    /// files are there and dependency installs land in the checks lane while
    /// the agent reads. Failure never fails the workspace — the agent can
    /// usually repair a broken setup itself — so each only warns.
    fn finish_worktree_in_background(
        self: &Arc<Self>,
        workspace_id: String,
        worktree_path: PathBuf,
        setup_command: String,
    ) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            service
                .replay_post_checkout_hook(&workspace_id, &worktree_path)
                .await;
            service
                .run_setup_command(&workspace_id, &setup_command)
                .await;
        });
    }

    /// Run the hook `git worktree add` skipped, with the arguments git gives
    /// it for a new-branch checkout. A repository without one runs nothing
    /// and grows no check row.
    async fn replay_post_checkout_hook(&self, workspace_id: &str, worktree_path: &Path) {
        let Some(command) = post_checkout_replay_command(worktree_path).await else {
            return;
        };
        self.run_worktree_setup_check(workspace_id, &command, "post-checkout hook")
            .await;
    }

    async fn run_setup_command(&self, workspace_id: &str, setup_command: &str) {
        let command = setup_command.trim();
        if command.is_empty() {
            return;
        }
        self.run_worktree_setup_check(workspace_id, command, "setup command")
            .await;
    }

    /// Runs through CheckService so the command gets the standard risk gate,
    /// timeout, output capture, and a persisted check row the review surface
    /// can show.
    async fn run_worktree_setup_check(&self, workspace_id: &str, command: &str, what: &str) {
        let Some(checks) = self.checks.as_ref() else {
            tracing::warn!(
                workspace_id,
                command,
                "{what} configured but check service is unavailable"
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
                "{what} did not pass"
            ),
            Err(error) => {
                tracing::warn!(workspace_id, command, ?error, "{what} could not run")
            }
        }
    }

    pub fn create_current(
        self: &Arc<Self>,
        input: WorkspacesCreateCurrentInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let project = {
            let connection = self.database.connection();
            require_project(&connection, input.project_id.as_str())?
        };
        self.create_alongside(WorkspacesCreateAlongsideInput {
            project_id: input.project_id,
            task_label: input.task_label,
            path: project.repo_path,
            branch: project.current_branch.clone(),
            // Review compares against this, not HEAD. Using the current
            // branch made All on branch and Committed empty on a clean
            // shared checkout.
            base_ref: project.default_branch.unwrap_or(project.current_branch),
        })
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

    /// The checkouts of a project that a new chat may run in, each with the
    /// branch checked out there. A launcher uses this to say which branches are
    /// already checked out, so picking one runs the chat in that checkout
    /// instead of asking git to check the branch out a second time.
    ///
    /// Left out: a detached or bare entry (no branch to record), one git marks
    /// prunable or whose directory is gone, and anything that is being or has
    /// been archived into recovery storage, because that directory is about to
    /// be deleted.
    pub async fn list_checkouts(&self, project_id: &str) -> ArgmaxResult<Vec<ProjectCheckout>> {
        let repo_path = {
            let connection = self.database.read_connection();
            require_project(&connection, project_id)?.repo_path
        };
        let stdout = run_git_text(
            Path::new(&repo_path),
            ["worktree", "list", "--porcelain"],
            Duration::from_millis(GIT_TIMEOUT_MS),
        )
        .await
        .map_err(|error| {
            invalid_workspace(
                format!("Could not inspect git worktrees: {error}"),
                "Verify the project repository and retry.",
            )
        })?;
        let retired = self.retired_checkout_paths()?;
        Ok(parse_worktree_checkouts(&stdout)
            .into_iter()
            .filter(|checkout| checkout_is_attachable(checkout, &retired))
            .map(|checkout| ProjectCheckout {
                branch: checkout.branch.unwrap_or_default(),
                path: checkout.path,
                is_main: checkout.is_main,
            })
            .collect())
    }

    /// A workspace in an existing checkout of the project, for a launcher that
    /// picked a branch another worktree has checked out. The same validation an
    /// agent's `session_launch` path gets: the directory must be one `git
    /// worktree list` reports, and it must still be on the branch the person
    /// picked. A checkout that has moved on is refused, never retargeted.
    pub async fn create_in_checkout(
        self: &Arc<Self>,
        input: WorkspacesCreateInCheckoutInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        // The checkout's owner may start archiving while this launch validates
        // and inserts. Archive closes admission, drains the admissions already
        // held, and only then looks for rows sharing the tree. Holding an
        // admission on the owner from before the first look until the row exists
        // makes one of two things true: the archive began first and this is
        // refused, or this row exists before the archive scans for it and goes
        // down with the owner.
        let _owner_admission = match self.checkout_owner_id(Path::new(input.path.as_str()))? {
            Some(owner_id) => Some(self.lifecycle.admit(&owner_id)?),
            None => None,
        };
        let project = {
            let connection = self.database.read_connection();
            require_project(&connection, input.project_id.as_str())?
        };
        let (path, branch) =
            resolve_registered_checkout(&project.repo_path, input.path.as_str()).await?;
        if branch != input.branch.as_str() {
            return Err(ArgmaxError::service(
                "CHECKOUT_BRANCH_CHANGED",
                format!(
                    "{path} is on '{branch}', not '{}'. Pick the branch again.",
                    input.branch.as_str()
                ),
            ));
        }
        if self
            .retired_checkout_paths()?
            .iter()
            .any(|retired| comparable_worktree_path(Path::new(&path)).starts_with(retired))
        {
            return Err(invalid_workspace(
                format!("{path} is being archived."),
                "Pick another checkout.",
            ));
        }
        self.create_alongside(WorkspacesCreateAlongsideInput {
            project_id: input.project_id,
            task_label: input.task_label,
            path,
            branch,
            // Review compares against this, the same as `create_current`.
            base_ref: project.default_branch.unwrap_or(project.current_branch),
        })
    }

    /// The workspace that owns the tree at `path`: the live row that is not a
    /// shared one, since only it is licensed to move or remove the checkout.
    /// Paths compare the way `git worktree list` output does.
    fn checkout_owner_id(&self, path: &Path) -> ArgmaxResult<Option<String>> {
        let target = comparable_worktree_path(path);
        let connection = self.database.read_connection();
        let mut statement = connection
            .prepare_cached(
                "SELECT id, path FROM workspaces
                 WHERE shared_workspace = 0 AND state != 'archived'",
            )
            .map_err(crate::persistence::sqlite_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(crate::persistence::sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(crate::persistence::sqlite_error)?;
        Ok(rows
            .into_iter()
            .find(|(_, owner_path)| comparable_worktree_path(Path::new(owner_path)) == target)
            .map(|(id, _)| id))
    }

    /// Directories a new chat must not attach to: archive recovery storage, and
    /// the checkout of any row that owns its tree and is mid-archive or failed to
    /// archive. A shared row owns nothing, so its archive removes no checkout and
    /// must not hide a live one. A failed read is an error, not "nothing retired": attaching to a tree that
    /// is about to be deleted is worse than refusing the launch.
    fn retired_checkout_paths(&self) -> ArgmaxResult<Vec<PathBuf>> {
        let mut retired: Vec<PathBuf> = self
            .archive_recovery_root
            .iter()
            .map(|root| comparable_worktree_path(root))
            .collect();
        let connection = self.database.read_connection();
        let mut statement = connection
            .prepare_cached(
                "SELECT path FROM workspaces
                 WHERE state IN ('archiving', 'archive-failed') AND shared_workspace = 0",
            )
            .map_err(crate::persistence::sqlite_error)?;
        let paths = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(crate::persistence::sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(crate::persistence::sqlite_error)?;
        retired.extend(
            paths
                .iter()
                .map(|path| comparable_worktree_path(Path::new(path))),
        );
        Ok(retired)
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

    /// Tell the renderer to drop deleted chats. Deletion already happened in
    /// SQLite; this is the only signal the delta protocol has for "gone".
    pub fn remove_sessions(&self, workspace_ids: &[String], session_ids: &[String]) {
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

    pub fn begin_chat_cleanup(
        &self,
        workspace_id: &str,
    ) -> ArgmaxResult<Option<WorkspaceArchiveLease>> {
        self.lifecycle.begin_cleanup(workspace_id)
    }

    pub async fn wait_for_chat_cleanup_admissions(
        &self,
        workspace_id: &str,
        bound: Duration,
    ) -> bool {
        self.lifecycle
            .wait_for_admissions(workspace_id, bound)
            .await
    }

    pub fn chat_cleanup_has_live_process(&self, workspace_id: &str) -> bool {
        self.terminals
            .as_ref()
            .is_some_and(|service| service.has_live_workspace_terminal(workspace_id))
            || self
                .checks
                .as_ref()
                .is_some_and(|service| service.has_running_workspace_check(workspace_id))
    }

    /// The task label of a live isolated workspace whose worktree is `path`, if
    /// there is one. Paths are compared the way `git worktree list` output is,
    /// so a symlinked or non-canonical spelling still matches.
    fn isolated_workspace_at(&self, path: &str) -> ArgmaxResult<Option<String>> {
        let target = comparable_worktree_path(Path::new(path));
        let connection = self.database.connection();
        let mut statement = connection
            .prepare_cached(
                "SELECT task_label, path FROM workspaces \
                 WHERE shared_workspace = 0 AND state != 'archived'",
            )
            .map_err(crate::persistence::sqlite_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>("task_label")?,
                    row.get::<_, String>("path")?,
                ))
            })
            .map_err(crate::persistence::sqlite_error)?;
        for row in rows {
            let (task_label, workspace_path) = row.map_err(crate::persistence::sqlite_error)?;
            if comparable_worktree_path(Path::new(&workspace_path)) == target {
                return Ok(Some(task_label));
            }
        }
        Ok(None)
    }

    pub async fn move_session(
        self: &Arc<Self>,
        source_session_id: &str,
        destination: MoveDestination,
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
            let source_project = require_project(&connection, &source_workspace.project_id)?;
            // A checkout move stays inside the project it started in; only a
            // project move has a second project to look up, and only it has to
            // be somewhere else.
            let destination_project = match &destination {
                MoveDestination::Project { project_id, .. } => {
                    if &source_workspace.project_id == project_id {
                        return Err(invalid_workspace(
                            "The destination must be a different project.",
                            "Choose another registered project.",
                        ));
                    }
                    require_project(&connection, project_id)?
                }
                MoveDestination::Checkout { .. } => source_project.clone(),
            };
            (
                source_session,
                source_workspace,
                source_project,
                destination_project,
            )
        };

        let project_id =
            crate::application::validation::ProjectId::try_from(destination_project.id.clone())
                .map_err(ArgmaxError::invalid)?;
        let task_label = crate::application::validation::TaskLabel::try_from(
            source_workspace.task_label.clone(),
        )
        .map_err(ArgmaxError::invalid)?;
        let destination_workspace = match &destination {
            MoveDestination::Project { worktree: true, .. } => {
                let base_ref = crate::application::validation::BaseRef::try_from(
                    destination_project.current_branch.clone(),
                )
                .map_err(ArgmaxError::invalid)?;
                self.create_isolated(WorkspacesCreateIsolatedInput {
                    project_id,
                    task_label,
                    base_ref: Some(base_ref),
                })
                .await?
            }
            MoveDestination::Project {
                worktree: false, ..
            } => self.create_current(WorkspacesCreateCurrentInput {
                project_id,
                task_label,
            })?,
            MoveDestination::Checkout { path } => {
                let (path, branch) =
                    attached_checkout(&destination_project.repo_path, &source_workspace, path)
                        .await?;
                // `git worktree list` reports the worktrees Argmax minted as
                // well as the user's own. Attaching to one Argmax owns would
                // leave two rows on it, and the owning row's archive removes
                // the directory — it is the only row licensed to, and it does
                // not look for company.
                if let Some(owner) = self.isolated_workspace_at(&path)? {
                    return Err(invalid_workspace(
                        format!(
                            "{path} is the worktree of another workspace ({}).",
                            owner
                        ),
                        "Move into a checkout Argmax does not own, or archive that workspace first.",
                    ));
                }
                self.create_alongside(WorkspacesCreateAlongsideInput {
                    project_id,
                    task_label,
                    path,
                    branch,
                    base_ref: destination_project
                        .default_branch
                        .clone()
                        .unwrap_or_else(|| destination_project.current_branch.clone()),
                })?
            }
        };

        // Whether the destination picks the provider conversation up or starts
        // cold there. Only a checkout move carries it: that is the same work
        // continuing in another worktree of the same repository, where losing
        // the conversation is the regression. A cross-project move keeps the
        // long-standing cold start — its transcript describes a different
        // repository. Provider-dependent on top of that, because resume has to
        // follow the new directory and be able to fork; see
        // `ProviderLaunchDefinition::move_carries_conversation`. An unknown
        // provider string starts cold, which is the safe direction.
        let carried_conversation = source_session
            .provider_conversation_id
            .clone()
            .filter(|_| matches!(destination, MoveDestination::Checkout { .. }))
            .filter(|_| {
                crate::providers::runtime::parse_provider(&source_session.provider)
                    .map(|provider| {
                        crate::providers::adapters::get_provider_definition(provider)
                            .move_carries_conversation
                    })
                    .unwrap_or(false)
            });
        let checkout_mode = match &destination {
            MoveDestination::Project { worktree: true, .. } => "worktree",
            MoveDestination::Project {
                worktree: false, ..
            } => "shared",
            MoveDestination::Checkout { .. } => "attached",
        };
        // A cross-project move is named by where it landed; a checkout move
        // stays in one project, so the project name would say nothing.
        let destination_label = match &destination {
            MoveDestination::Project { .. } => destination_project.name.clone(),
            MoveDestination::Checkout { .. } => format!(
                "{} on {}",
                Path::new(&destination_workspace.path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| destination_workspace.path.clone()),
                destination_workspace.branch
            ),
        };

        let copied =
            (|| -> ArgmaxResult<(WorkspaceSummary, SessionSummary, TimelineEvent, bool)> {
                let mut connection = self.database.connection();
                let transaction = connection
                    .transaction()
                    .map_err(crate::persistence::sqlite_error)?;
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
                        state: SessionState::Complete,
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
                // Carry the provider conversation where the provider supports it,
                // as a fork: the source row keeps the original, so resuming the
                // same id from both would interleave two chats into one CLI
                // conversation. Order matters — setting the id clears resume_fork,
                // so the flag goes on afterwards.
                let destination_session = match carried_conversation.as_deref() {
                    Some(conversation_id) => {
                        let session = update_session_provider_conversation_id(
                            &transaction,
                            &destination_session.id,
                            conversation_id,
                        )?;
                        set_session_resume_fork(&transaction, &session.id)?;
                        session
                    }
                    None => destination_session,
                };
                // A move is the same work continuing in a new checkout, so Arc
                // membership travels with it. When the source was the Arc's
                // current coordinator, the Arc is repointed at the destination
                // too — otherwise the coordinator's chat would vanish from the
                // Arc the moment its checkout moves.
                let (destination_session, coordinator_repointed) =
                    match source_session.arc_id.as_deref() {
                        Some(arc_id) => {
                            record_session_arc(&transaction, &destination_session.id, arc_id)?;
                            let arc = get_arc(&transaction, arc_id)?;
                            let repointed =
                                arc.coordinator_session_id.as_deref() == Some(source_session_id);
                            if repointed {
                                set_arc_coordinator_session(
                                    &transaction,
                                    arc_id,
                                    Some(&destination_session.id),
                                )?;
                            }
                            (
                                find_session_by_id(&transaction, &destination_session.id)?,
                                repointed,
                            )
                        }
                        None => (destination_session, false),
                    };
                let mut copied_ids = Vec::new();
                for event in list_all_session_events(&transaction, source_session_id)? {
                    let copy_id = Uuid::new_v4().to_string();
                    copied_ids.push((event.id.clone(), copy_id.clone()));
                    persist_copied_event(
                        &transaction,
                        &PersistTimelineEventInput {
                            id: copy_id,
                            session_id: destination_session.id.clone(),
                            r#type: event.r#type,
                            message: event.message,
                            payload: event.payload,
                            created_at: Some(event.created_at),
                        },
                        &event.id,
                    )?;
                }
                // A moved fork stays a fork.
                fork::carry_lineage_on_move(
                    &transaction,
                    source_session_id,
                    &destination_session.id,
                    &copied_ids,
                )?;
                let seam = persist_timeline_event(
                    &transaction,
                    &PersistTimelineEventInput {
                        id: Uuid::new_v4().to_string(),
                        session_id: destination_session.id.clone(),
                        r#type: "session.moved".to_string(),
                        message: match &destination {
                            MoveDestination::Project { .. } => format!(
                                "Moved from {} to {}.",
                                source_project.name, destination_label
                            ),
                            MoveDestination::Checkout { .. } => {
                                format!("Moved to {destination_label}.")
                            }
                        },
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
                            "checkoutMode": checkout_mode,
                            "conversationCarried": carried_conversation.is_some(),
                            "sourceArchiveRequested": !keep_source,
                        }),
                        created_at: None,
                    },
                )?;
                let destination_workspace =
                    update_workspace_state(&transaction, &destination_workspace.id, "complete")?;
                transaction
                    .commit()
                    .map_err(crate::persistence::sqlite_error)?;
                Ok((
                    destination_workspace,
                    destination_session,
                    seam,
                    coordinator_repointed,
                ))
            })();
        let (destination_workspace, destination_session, destination_seam, coordinator_repointed) =
            match copied {
                Ok(copied) => copied,
                Err(error) => {
                    let cleanup = self
                        .archive(WorkspacesArchiveInput {
                            workspace_id: crate::application::validation::WorkspaceId::try_from(
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
                // The Arc's coordinator pointer lives outside this delta's
                // typed fields, so a repoint needs the durable-metadata
                // reload rather than a merge the renderer can apply itself.
                dashboard_changed: coordinator_repointed,
                ..DashboardDelta::default()
            });
        }

        let (source_archive_state, archive_error) = if keep_source {
            (source_workspace.state.clone(), None)
        } else {
            match self
                .archive(WorkspacesArchiveInput {
                    workspace_id: crate::application::validation::WorkspaceId::try_from(
                        source_workspace.id.clone(),
                    )
                    .map_err(ArgmaxError::invalid)?,
                    force: Some(false),
                })
                .await
            {
                Ok(result) => (result.workspace.state, None),
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
                    message: format!("Moved to {destination_label}."),
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
                        "checkoutMode": checkout_mode,
                        "conversationCarried": carried_conversation.is_some(),
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
    ) -> ArgmaxResult<WorkspaceArchiveResult> {
        self.archive_with(
            input.workspace_id.as_str().to_string(),
            input.force.unwrap_or(false),
            ArchiveDisposition::Retain,
        )
        .await
    }

    /// Ends an isolated workspace whose PR merged at `merged_head` and
    /// deletes its checkout, keeping the chat in its sidebar section. Never
    /// forced: a checkout with uncommitted changes, or with a HEAD the merge
    /// does not contain, returns to `kept` with its files in place. The
    /// branch is left to PR cleanup.
    pub async fn remove_merged_checkout(
        self: &Arc<Self>,
        workspace_id: &str,
        merged_head: &str,
    ) -> ArgmaxResult<WorkspaceArchiveResult> {
        self.archive_with(
            workspace_id.to_string(),
            false,
            ArchiveDisposition::RemoveMergedCheckout {
                merged_head: merged_head.to_string(),
            },
        )
        .await
    }

    async fn archive_with(
        self: &Arc<Self>,
        workspace_id: String,
        force: bool,
        disposition: ArchiveDisposition,
    ) -> ArgmaxResult<WorkspaceArchiveResult> {
        let prior = {
            let connection = self.database.connection();
            find_workspace_by_id(&connection, &workspace_id)?
        };
        if prior.state == "archived" {
            // Archiving a merged chat whose checkout is already gone only
            // moves it from its sidebar section to the Archived section.
            let workspace = if prior.checkout_removed_at.is_some()
                && matches!(disposition, ArchiveDisposition::Retain)
            {
                let workspace = {
                    let connection = self.database.connection();
                    clear_workspace_checkout_removed(&connection, &workspace_id)?
                };
                self.publish(DashboardDelta {
                    workspaces: vec![workspace.clone()],
                    ..DashboardDelta::default()
                });
                workspace
            } else {
                prior
            };
            return Ok(WorkspaceArchiveResult {
                recovery_path: self.existing_archive_recovery_path(&workspace),
                workspace,
            });
        }
        if prior.shared_workspace
            && matches!(disposition, ArchiveDisposition::RemoveMergedCheckout { .. })
        {
            return Err(ArgmaxError::service(
                "WORKSPACE_SHARED_CHECKOUT",
                "A shared checkout is not Argmax's to remove.",
            ));
        }
        let recovery_path = if prior.shared_workspace {
            None
        } else {
            Some(self.archive_recovery_path(&workspace_id).ok_or_else(|| {
                ArgmaxError::service(
                    "WORKSPACE_RECOVERY_UNAVAILABLE",
                    "Could not resolve the archive recovery directory; the worktree was left in place.",
                )
            })?)
        };
        let lease = self.lifecycle.begin_archive(&workspace_id)?;
        if prior.shared_workspace {
            return self.archive_shared(workspace_id, lease);
        }
        let recovery_path = recovery_path.expect("isolated workspaces have a recovery path");
        let archiving = {
            let connection = self.database.connection();
            update_workspace_state(&connection, &workspace_id, "archiving")?
        };
        self.publish(DashboardDelta {
            workspaces: vec![archiving],
            ..DashboardDelta::default()
        });
        if recovery_path.exists() && !Path::new(&prior.path).exists() {
            let project = {
                let connection = self.database.connection();
                require_project(&connection, &prior.project_id)?
            };
            let repair_path = recovery_path.clone();
            let branch = prior.branch.clone();
            let repaired = tokio::task::spawn_blocking(move || {
                repair_archived_worktree(Path::new(&project.repo_path), &repair_path, &branch)
            })
            .await
            .map_err(|error| ArgmaxError::service("ARCHIVE_RECOVERY_FAILED", error.to_string()))
            .and_then(|result| result);
            if let Err(error) = repaired {
                self.mark_archive_failed(&workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(error);
            }
            let archived = {
                let connection = self.database.connection();
                match update_workspace_state(&connection, &workspace_id, "archived") {
                    Ok(workspace) => workspace,
                    Err(error) => {
                        drop(connection);
                        self.mark_archive_failed(&workspace_id);
                        lease.finish(ArchiveOutcome::Failed);
                        return Err(error);
                    }
                }
            };
            self.publish(DashboardDelta {
                workspaces: vec![archived.clone()],
                ..DashboardDelta::default()
            });
            self.close_watcher(&workspace_id);
            lease.finish(ArchiveOutcome::Archived);
            return Ok(WorkspaceArchiveResult {
                workspace: archived,
                recovery_path: Some(recovery_path.display().to_string()),
            });
        }
        if !self
            .lifecycle
            .wait_for_admissions(
                &workspace_id,
                Duration::from_millis(ARCHIVE_QUIESCE_TIMEOUT_MS),
            )
            .await
        {
            self.abandon_archive(&prior, lease)?;
            return Err(ArgmaxError::service(
                "WORKSPACE_ADMISSION_TIMEOUT",
                "Timed out waiting for a process admission to finish before archive.",
            ));
        }

        let workspace = match self.refresh_status(&workspace_id).await {
            Ok(workspace) => workspace,
            Err(error) => {
                self.abandon_archive(&prior, lease)?;
                return Err(error);
            }
        };

        if workspace.state == "archived" {
            lease.finish(ArchiveOutcome::Archived);
            return Ok(WorkspaceArchiveResult {
                recovery_path: self.existing_archive_recovery_path(&workspace),
                workspace,
            });
        }

        let project = {
            let connection = self.database.connection();
            match require_project(&connection, &workspace.project_id) {
                Ok(project) => project,
                Err(error) => {
                    self.abandon_archive(&prior, lease)?;
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
            return Ok(WorkspaceArchiveResult {
                workspace: kept,
                recovery_path: None,
            });
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
                self.mark_archive_failed(&workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(ArgmaxError::service(
                    "WORKSPACE_QUIESCE_TIMEOUT",
                    "Timed out waiting for workspace processes to terminate.",
                ));
            }
        };
        for result in [provider_result, check_result, terminal_result] {
            if let Err(error) = result {
                self.mark_archive_failed(&workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(error);
            }
        }
        if let Some(approvals) = self.approvals.as_ref() {
            if let Err(error) = approvals.cancel_workspace_pending(&workspace_id) {
                self.mark_archive_failed(&workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(error);
            }
        }
        tokio::time::sleep(Duration::from_millis(CANCEL_SETTLE_MS)).await;
        // No more status refreshes can be useful once quiescence has completed.
        // Close the OS watcher before the final git read and worktree move.
        self.close_watcher(&workspace_id);
        // The warm ACP process holds this worktree as its cwd, and the pool is
        // keyed by path, so it must go before `worktree move`.
        self.evict_provider_acp(&workspace.path).await;

        if !force && !workspace.shared_workspace {
            let path = Path::new(&workspace.path);
            if path.exists() {
                let recheck = match run_git_text(
                    path,
                    &["status", "--porcelain"],
                    Duration::from_millis(GIT_TIMEOUT_MS),
                )
                .await
                {
                    Ok(output) => output,
                    Err(error) => {
                        self.mark_archive_failed(&workspace_id);
                        lease.finish(ArchiveOutcome::Failed);
                        return Err(ArgmaxError::service(
                            "WORKSPACE_STATUS_FAILED",
                            error.to_string(),
                        ));
                    }
                };
                if !recheck.trim().is_empty() {
                    return self.keep_after_declined_archive(&workspace_id, lease);
                }
            }
        }

        // A chat dispatched from this worktree keeps a workspace row of its own
        // on this very path — a multitask shares the checkout it was launched
        // from (ADR 0006). `move_session` refuses to add a second row to a
        // worktree Argmax owns for the reason that bites here: only the owning
        // row is licensed to move the tree, and a row left behind would point
        // at nothing, never reclassify (both reconcile branches are gated on
        // `!shared_workspace`), and keep its watcher and its agent alive over
        // the archive location. So the co-located rows go down with this one,
        // or the archive is refused while one of them is still working.
        let colocated = match self.colocated_workspaces(&workspace_id, &workspace.path) {
            Ok(rows) => rows,
            Err(error) => {
                self.mark_archive_failed(&workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(error);
            }
        };
        if !force {
            if let Some(busy) = colocated.iter().find(|row| row.has_active_session) {
                self.abandon_archive(&prior, lease)?;
                return Err(ArgmaxError::service(
                    "WORKSPACE_COLOCATED_ACTIVE",
                    format!(
                        "{} is still working in this checkout; archiving would move the worktree out from under it.",
                        busy.task_label
                    ),
                ));
            }
        }
        for row in colocated {
            let colocated_lease = match self.lifecycle.begin_archive(&row.id) {
                Ok(lease) => lease,
                // Its own archive is already under way, so it is not being left
                // behind and a second lease would only fight it.
                Err(error) => {
                    tracing::warn!(?error, workspace_id = %row.id, "co-located workspace is already archiving");
                    continue;
                }
            };
            if let Err(error) = self.archive_shared(row.id.clone(), colocated_lease) {
                // Moving the tree with this row still open is the stranding
                // this branch exists to prevent, so the owner's archive fails
                // instead.
                self.mark_archive_failed(&workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(error);
            }
        }

        let active_path = Path::new(&workspace.path);
        if let ArchiveDisposition::RemoveMergedCheckout { merged_head } = &disposition {
            return self
                .finish_merged_checkout_removal(&workspace, &project.repo_path, merged_head, lease)
                .await;
        }
        if active_path.exists() {
            if recovery_path.exists() {
                self.mark_archive_failed(&workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(ArgmaxError::service(
                    "WORKSPACE_RECOVERY_EXISTS",
                    format!(
                        "Archive recovery already exists at {}; the active worktree was left in place.",
                        recovery_path.display()
                    ),
                ));
            }
            if let Some(parent) = recovery_path.parent() {
                if let Err(error) = tokio::fs::create_dir_all(parent).await {
                    self.mark_archive_failed(&workspace_id);
                    lease.finish(ArchiveOutcome::Failed);
                    return Err(ArgmaxError::service(
                        "WORKSPACE_RECOVERY_CREATE_FAILED",
                        error.to_string(),
                    ));
                }
            }
            let recovery_text = recovery_path.to_string_lossy().to_string();
            let move_result = {
                // The move rewrites the same registry a concurrent launch reads.
                let _registry = lock_worktree_registry(Path::new(&project.repo_path)).await;
                run_git_text(
                    Path::new(&project.repo_path),
                    &[
                        "worktree",
                        "move",
                        workspace.path.as_str(),
                        recovery_text.as_str(),
                    ],
                    Duration::from_millis(GIT_TIMEOUT_MS),
                )
                .await
            };
            if let Err(error) = move_result {
                self.mark_archive_failed(&workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(invalid_workspace(
                    format!("Could not retain worktree for recovery. {error}"),
                    "Review the worktree and retry archive.",
                ));
            }
        } else if !recovery_path.exists() {
            // Only Git's own word that the worktree is gone completes an
            // archive whose directory has already vanished. A failed
            // `git worktree list` proves nothing either way, so it fails the
            // archive rather than passing as "removed" — the same rule startup
            // recovery follows when it cannot prove a removal completed.
            let registration =
                worktree_is_registered(project.repo_path.clone(), active_path.to_path_buf()).await;
            if !matches!(registration, Ok(false)) {
                self.mark_archive_failed(&workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(registration.err().unwrap_or_else(|| {
                    ArgmaxError::service(
                        "WORKSPACE_ARCHIVE_INCOMPLETE",
                        "The worktree path is missing but Git still registers it; the archive was not completed.",
                    )
                }));
            }
        }

        let archived = {
            let connection = self.database.connection();
            match update_workspace_state(&connection, &workspace_id, "archived") {
                Ok(workspace) => workspace,
                Err(error) => {
                    drop(connection);
                    self.mark_archive_failed(&workspace_id);
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
        Ok(WorkspaceArchiveResult {
            recovery_path: recovery_path
                .exists()
                .then(|| recovery_path.display().to_string()),
            workspace: archived,
        })
    }

    /// The last step of `remove_merged_checkout`, after every process in the
    /// checkout has stopped and its tree was found clean: delete the checkout
    /// and mark the row. A HEAD the merge does not contain means work after
    /// the merge, so that checkout is kept instead.
    async fn finish_merged_checkout_removal(
        self: &Arc<Self>,
        workspace: &WorkspaceSummary,
        repo_path: &str,
        merged_head: &str,
        lease: WorkspaceArchiveLease,
    ) -> ArgmaxResult<WorkspaceArchiveResult> {
        let workspace_id = workspace.id.as_str();
        let checkout = Path::new(&workspace.path);
        if checkout.exists() {
            // GitHub's merged head is missing locally when the branch moved
            // on GitHub ("Update branch", a suggestion committed there).
            // Fetch it; if that fails, the check below keeps the checkout.
            let present = run_git_text_with_allowed_exit_codes(
                checkout,
                ["cat-file", "-e", &format!("{merged_head}^{{commit}}")],
                &[1, 128],
                Duration::from_millis(GIT_TIMEOUT_MS),
            )
            .await
            .is_ok_and(|exit| exit.exit_code == 0);
            if !present {
                if let Err(error) = run_git_text(
                    checkout,
                    ["fetch", "origin", merged_head],
                    GIT_DEFAULT_TIMEOUT,
                )
                .await
                {
                    tracing::info!(
                        workspace_id,
                        merged_head,
                        ?error,
                        "merge cleanup: could not fetch the merged head"
                    );
                }
            }
            // Exit 128: the merged head is still unknown here, so whether the
            // merge contains HEAD cannot be proven.
            let contained = run_git_text_with_allowed_exit_codes(
                checkout,
                ["merge-base", "--is-ancestor", "HEAD", merged_head],
                &[1, 128],
                Duration::from_millis(GIT_TIMEOUT_MS),
            )
            .await;
            match contained {
                Ok(exit) if exit.exit_code == 0 => {}
                Ok(_) => {
                    tracing::info!(
                        workspace_id,
                        merged_head,
                        "merge cleanup: kept the checkout, its HEAD is not in the merged PR"
                    );
                    return self.keep_after_declined_archive(workspace_id, lease);
                }
                Err(error) => {
                    self.mark_archive_failed(workspace_id);
                    lease.finish(ArchiveOutcome::Failed);
                    return Err(error);
                }
            }
            // No `--force`: Git refuses a tree with changes the status read
            // above missed, which keeps the files instead of losing them.
            let removed = {
                let _registry = lock_worktree_registry(Path::new(repo_path)).await;
                run_git_text(
                    Path::new(repo_path),
                    &["worktree", "remove", workspace.path.as_str()],
                    Duration::from_millis(GIT_TIMEOUT_MS),
                )
                .await
            };
            if let Err(error) = removed {
                self.mark_archive_failed(workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(invalid_workspace(
                    format!("Could not remove the merged worktree. {error}"),
                    "Review the worktree and archive the chat by hand.",
                ));
            }
        } else {
            // Same rule as archive: only Git's word that the worktree is gone
            // completes a removal whose directory has already vanished.
            let registration =
                worktree_is_registered(repo_path.to_string(), checkout.to_path_buf()).await;
            if !matches!(registration, Ok(false)) {
                self.mark_archive_failed(workspace_id);
                lease.finish(ArchiveOutcome::Failed);
                return Err(registration.err().unwrap_or_else(|| {
                    ArgmaxError::service(
                        "WORKSPACE_ARCHIVE_INCOMPLETE",
                        "The worktree path is missing but Git still registers it; the removal was not completed.",
                    )
                }));
            }
        }
        let removed = {
            let connection = self.database.connection();
            match mark_workspace_checkout_removed(&connection, workspace_id) {
                Ok(workspace) => workspace,
                Err(error) => {
                    drop(connection);
                    self.mark_archive_failed(workspace_id);
                    lease.finish(ArchiveOutcome::Failed);
                    return Err(error);
                }
            }
        };
        self.publish(DashboardDelta {
            workspaces: vec![removed.clone()],
            ..DashboardDelta::default()
        });
        lease.finish(ArchiveOutcome::Archived);
        Ok(WorkspaceArchiveResult {
            workspace: removed,
            recovery_path: None,
        })
    }

    /// Returns a workspace whose drained checkout an archive declined to
    /// touch to `kept`, with its watcher back.
    fn keep_after_declined_archive(
        self: &Arc<Self>,
        workspace_id: &str,
        lease: WorkspaceArchiveLease,
    ) -> ArgmaxResult<WorkspaceArchiveResult> {
        let kept = {
            let connection = self.database.connection();
            update_workspace_state(&connection, workspace_id, "kept")?
        };
        self.publish(DashboardDelta {
            workspaces: vec![kept.clone()],
            ..DashboardDelta::default()
        });
        if let Err(error) = super::watcher::watch_during_archive(self, workspace_id) {
            tracing::warn!(
                workspace_id,
                ?error,
                "failed to restore watcher after a declined archive"
            );
        }
        lease.finish(ArchiveOutcome::Reopened);
        Ok(WorkspaceArchiveResult {
            workspace: kept,
            recovery_path: None,
        })
    }

    fn archive_recovery_path(&self, workspace_id: &str) -> Option<PathBuf> {
        self.archive_recovery_root
            .as_ref()
            .map(|root| root.join(workspace_id))
    }

    fn existing_archive_recovery_path(&self, workspace: &WorkspaceSummary) -> Option<String> {
        if workspace.shared_workspace {
            return None;
        }
        self.archive_recovery_path(&workspace.id)
            .filter(|path| path.exists())
            .map(|path| path.display().to_string())
    }

    /// The live workspace rows other than `workspace_id` whose checkout is
    /// `path`, with whether each still has a turn in flight. Paths are compared
    /// the way `git worktree list` output is, so a symlinked or non-canonical
    /// spelling still matches.
    fn colocated_workspaces(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> ArgmaxResult<Vec<ColocatedWorkspace>> {
        let sqlite = crate::persistence::sqlite_error;
        let target = comparable_worktree_path(Path::new(path));
        let connection = self.database.connection();
        let mut statement = connection
            .prepare_cached(
                "SELECT id, task_label, path FROM workspaces \
                 WHERE id != ? AND state != 'archived'",
            )
            .map_err(sqlite)?;
        let rows = statement
            .query_map([workspace_id], |row| {
                Ok((
                    row.get::<_, String>("id")?,
                    row.get::<_, String>("task_label")?,
                    row.get::<_, String>("path")?,
                ))
            })
            .map_err(sqlite)?;
        let mut matched = Vec::new();
        for row in rows {
            let (id, task_label, workspace_path) = row.map_err(sqlite)?;
            if comparable_worktree_path(Path::new(&workspace_path)) == target {
                matched.push((id, task_label));
            }
        }
        let mut sessions = connection
            .prepare_cached("SELECT state FROM sessions WHERE workspace_id = ?")
            .map_err(sqlite)?;
        let mut colocated = Vec::new();
        for (id, task_label) in matched {
            let states = sessions
                .query_map([&id], |row| row.get::<_, String>("state"))
                .map_err(sqlite)?;
            let mut has_active_session = false;
            for state in states {
                let state = state.map_err(sqlite)?;
                if SessionState::from_wire(&state).is_some_and(SessionState::is_active) {
                    has_active_session = true;
                    break;
                }
            }
            colocated.push(ColocatedWorkspace {
                id,
                task_label,
                has_active_session,
            });
        }
        Ok(colocated)
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
    ) -> ArgmaxResult<WorkspaceArchiveResult> {
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
                service.evict_provider_acp(&path).await;
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
        Ok(WorkspaceArchiveResult {
            workspace: archived,
            recovery_path: None,
        })
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
            self.evict_provider_acp(&path).await;
        }
    }

    /// Give up on an archive that never touched the tree: put the row back the
    /// way it was and hand the lifecycle slot back.
    fn abandon_archive(
        self: &Arc<Self>,
        prior: &WorkspaceSummary,
        lease: WorkspaceArchiveLease,
    ) -> ArgmaxResult<()> {
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
        lease.finish(if prior.state == "archive-failed" {
            ArchiveOutcome::Failed
        } else {
            ArchiveOutcome::Reopened
        });
        Ok(())
    }

    /// Park the row in `archive-failed`. The archive has already failed by the
    /// time this runs, so a failure to record that is logged, not propagated.
    fn mark_archive_failed(self: &Arc<Self>, workspace_id: &str) {
        let connection = self.database.connection();
        let failed = match update_workspace_state(&connection, workspace_id, "archive-failed") {
            Ok(failed) => failed,
            Err(error) => {
                tracing::error!(
                    ?error,
                    workspace_id,
                    "failed to persist archive-failed state"
                );
                return;
            }
        };
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
    }

    pub async fn refresh_status(
        self: &Arc<Self>,
        workspace_id: &str,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let workspace = {
            let connection = self.database.connection();
            find_workspace_by_id(&connection, workspace_id)?
        };
        if workspace.state == "archived" {
            return Ok(workspace);
        }
        if !workspace.shared_workspace && workspace.kind == "git" {
            let path = Path::new(&workspace.path);
            if !path.exists() {
                let project = {
                    let connection = self.database.connection();
                    require_project(&connection, &workspace.project_id)
                };
                let registration = match project {
                    Ok(project) => {
                        worktree_is_registered(project.repo_path, path.to_path_buf()).await
                    }
                    Err(error) => Err(error),
                };
                if matches!(registration, Ok(false)) {
                    let connection = self.database.connection();
                    let archived = update_workspace_state(&connection, workspace_id, "archived")?;
                    self.publish(DashboardDelta {
                        workspaces: vec![archived.clone()],
                        ..DashboardDelta::default()
                    });
                    self.close_watcher(workspace_id);
                    return Ok(archived);
                }
            }
        }
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
        let path_exists = path.exists();
        let status = if path_exists {
            read_checkout_status(path).await
        } else {
            None
        };
        let mut refreshed = 0;
        let mut changed = Vec::new();
        for workspace_id in workspace_ids {
            let workspace = {
                let connection = self.database.connection();
                find_workspace_by_id(&connection, workspace_id)
            };
            let workspace = match workspace {
                Ok(workspace) => workspace,
                // The row is gone (project removal, a sync prune). Its
                // subscription has no subject left, so retire it here rather
                // than waking this loop for a workspace nobody can see.
                Err(ArgmaxError::RecordNotFound { .. }) => {
                    self.close_watcher(workspace_id);
                    continue;
                }
                Err(error) => {
                    tracing::debug!(%workspace_id, ?error, "watcher: workspace lookup failed");
                    continue;
                }
            };
            refreshed += 1;
            if !path_exists
                && !workspace.shared_workspace
                && workspace.kind == "git"
                && workspace.state != "archived"
            {
                let project = {
                    let connection = self.database.connection();
                    require_project(&connection, &workspace.project_id)
                };
                let registration = match project {
                    Ok(project) => {
                        worktree_is_registered(project.repo_path, PathBuf::from(&workspace.path))
                            .await
                    }
                    Err(error) => Err(error),
                };
                if matches!(registration, Ok(false)) {
                    let connection = self.database.connection();
                    if let Ok(archived) =
                        update_workspace_state(&connection, workspace_id, "archived")
                    {
                        self.close_watcher(workspace_id);
                        changed.push(archived);
                        continue;
                    }
                }
            }
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

    pub fn mark_viewed(
        self: &Arc<Self>,
        input: WorkspacesMarkViewedInput,
    ) -> ArgmaxResult<Vec<WorkspaceSummary>> {
        const MAX_BATCH_SIZE: usize = 100;
        if input.workspaces.len() > MAX_BATCH_SIZE {
            return Err(ArgmaxError::invalid(crate::error::InvalidInputIssue::at(
                vec!["workspaces".to_owned()],
                "WORKSPACE_VIEW_BATCH_TOO_LARGE",
                format!("at most {MAX_BATCH_SIZE} workspaces may be marked viewed at once"),
            )));
        }

        let now = chrono::Utc::now();
        let observations = input
            .workspaces
            .into_iter()
            .enumerate()
            .map(|(index, observation)| {
                let parsed =
                    chrono::DateTime::parse_from_rfc3339(&observation.observed_activity_at)
                        .map_err(|_| {
                            ArgmaxError::invalid(crate::error::InvalidInputIssue::at(
                                vec![
                                    "workspaces".to_owned(),
                                    index.to_string(),
                                    "observedActivityAt".to_owned(),
                                ],
                                "TIMESTAMP_INVALID",
                                "observed activity timestamp must be RFC 3339",
                            ))
                        })?;
                if parsed > now {
                    return Err(ArgmaxError::invalid(crate::error::InvalidInputIssue::at(
                        vec![
                            "workspaces".to_owned(),
                            index.to_string(),
                            "observedActivityAt".to_owned(),
                        ],
                        "TIMESTAMP_FUTURE",
                        "observed activity timestamp must not be in the future",
                    )));
                }
                Ok(WorkspaceViewedObservation {
                    workspace_id: observation.workspace_id.to_string(),
                    observed_activity_at: parsed
                        .with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                })
            })
            .collect::<ArgmaxResult<Vec<_>>>()?;

        let connection = self.database.connection();
        let changed = mark_workspaces_viewed(&connection, &observations)?;
        if !changed.is_empty() {
            self.publish(DashboardDelta {
                workspaces: changed.clone(),
                ..DashboardDelta::default()
            });
        }
        Ok(changed)
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

    pub fn set_snoozed_until(
        self: &Arc<Self>,
        input: WorkspacesSetSnoozedUntilInput,
    ) -> ArgmaxResult<WorkspaceSummary> {
        let connection = self.database.connection();
        let workspace = set_workspace_snoozed_until(
            &connection,
            input.workspace_id.as_str(),
            input.until.as_deref(),
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

    pub fn watch(self: &Arc<Self>, workspace_id: &str) -> ArgmaxResult<()> {
        super::watcher::watch(self, workspace_id)
    }

    pub fn close_watcher(&self, workspace_id: &str) {
        super::watcher::close_watcher(self, workspace_id)
    }

    fn latest_session_id_for_workspace(&self, workspace_id: &str) -> ArgmaxResult<Option<String>> {
        use rusqlite::OptionalExtension;
        let connection = self.database.connection();
        connection
            .prepare_cached(
                "SELECT id FROM sessions WHERE workspace_id = ? ORDER BY last_activity_at DESC, id DESC LIMIT 1",
            )
            .and_then(|mut statement| statement.query_row([workspace_id], |row| row.get(0)).optional())
            .map_err(crate::persistence::sqlite_error)
    }

    pub(super) fn publish(&self, delta: DashboardDelta) {
        if !delta.is_empty() {
            (self.publish_delta)(delta);
        }
    }
}

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
    if !path.exists() {
        return None;
    }
    match run_git_text(
        path,
        &["status", "--porcelain", "--untracked-files=all", "--branch"],
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
            name: "Chat".to_string(),
            repo_path: scratch_root.display().to_string(),
            current_branch: "main".to_string(),
            default_branch: Some("main".to_string()),
            settings: ProjectSettings {
                merge_cleanup: Default::default(),
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

/// Resolve a checkout an agent named, or say why it cannot be used.
///
/// Returns the canonical path and the branch checked out there. The path has to
/// be a working tree `git worktree list` reports for the project's repository:
/// that is what turns "a checkout of this project" into a claim Argmax can
/// check, rather than trusting any directory an agent happens to name. The
/// project's main checkout is listed too.
pub(crate) async fn resolve_registered_checkout(
    repo_path: &str,
    requested: &str,
) -> ArgmaxResult<(String, String)> {
    let requested = requested.trim();
    let path = Path::new(requested);
    if !path.is_absolute() {
        return Err(invalid_workspace(
            format!("Checkout path '{requested}' is not absolute."),
            "Pass the absolute path of a worktree of this project.",
        ));
    }
    let path = path.canonicalize().map_err(|error| {
        invalid_workspace(
            format!("No directory at {requested}: {error}"),
            "Check the path and retry.",
        )
    })?;
    if !path.is_dir() {
        return Err(invalid_workspace(
            format!("{} is not a directory.", path.display()),
            "Pass the root directory of a worktree.",
        ));
    }
    if !worktree_is_registered(repo_path.to_string(), path.clone()).await? {
        return Err(invalid_workspace(
            format!("{} is not a worktree of this project.", path.display()),
            "Run `git worktree list` in the project to see the checkouts a chat can use.",
        ));
    }
    let branch = run_git_text(
        &path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        Duration::from_millis(GIT_TIMEOUT_MS),
    )
    .await
    .map_err(|error| {
        invalid_workspace(
            format!("Could not read the branch at {}: {error}", path.display()),
            "Check the checkout and retry.",
        )
    })?;
    let branch = branch.trim();
    // A workspace records the branch it sits on, and a detached HEAD has no
    // name to record.
    if branch.is_empty() || branch == "HEAD" {
        return Err(invalid_workspace(
            format!("{} has a detached HEAD.", path.display()),
            "Check out a branch there first.",
        ));
    }
    Ok((path.to_string_lossy().into_owned(), branch.to_string()))
}

/// Resolve the checkout a session asked to move into, or say why it cannot.
async fn attached_checkout(
    repo_path: &str,
    source_workspace: &WorkspaceSummary,
    requested: &str,
) -> ArgmaxResult<(String, String)> {
    let (path, branch) = resolve_registered_checkout(repo_path, requested).await?;
    if comparable_worktree_path(Path::new(&path))
        == comparable_worktree_path(Path::new(&source_workspace.path))
    {
        return Err(invalid_workspace(
            "This chat is already working in that checkout.",
            "Name a different worktree, or skip the move.",
        ));
    }
    Ok((path, branch))
}

/// Re-register a retained worktree with its repository before an archive is
/// retried: it must be a linked worktree of `repo_path`, still on `branch`, and
/// `git worktree repair` must leave it listed. Anything else is refused with
/// the files left intact.
fn repair_archived_worktree(
    repo_path: &Path,
    recovery_path: &Path,
    branch: &str,
) -> ArgmaxResult<()> {
    if !recovery_path.join(".git").is_file() {
        return Err(ArgmaxError::service(
            "ARCHIVE_RECOVERY_INVALID",
            "Retained directory is not a linked Git worktree. Its files were left intact.",
        ));
    }
    let common = |path: &Path| -> ArgmaxResult<PathBuf> {
        let output =
            run_git_text_blocking(path, ["rev-parse", "--git-common-dir"], GIT_DEFAULT_TIMEOUT)?;
        Ok(comparable_worktree_path(&path.join(output.trim())))
    };
    if common(repo_path)? != common(recovery_path)? {
        return Err(ArgmaxError::service(
            "ARCHIVE_RECOVERY_INVALID",
            "Retained worktree belongs to a different repository. Its files were left intact.",
        ));
    }
    let retained_branch = run_git_text_blocking(
        recovery_path,
        ["symbolic-ref", "--short", "HEAD"],
        GIT_DEFAULT_TIMEOUT,
    )?;
    if retained_branch.trim() != branch {
        return Err(ArgmaxError::service("ARCHIVE_RECOVERY_INVALID", "Retained worktree is on a different branch. Inspect its files before retrying archive."));
    }
    {
        let _registry = lock_worktree_registry_blocking(repo_path);
        run_git_text_blocking(
            repo_path,
            ["worktree", "repair", &recovery_path.to_string_lossy()],
            GIT_DEFAULT_TIMEOUT,
        )?;
    }
    if !worktree_is_registered_blocking(repo_path, recovery_path)? {
        return Err(ArgmaxError::service(
            "ARCHIVE_RECOVERY_INVALID",
            "Git could not register the retained worktree. Its files were left intact.",
        ));
    }
    Ok(())
}

/// The workspace row an archive recovery directory belongs to, as far as expiry
/// needs it.
struct ArchiveRecoveryOwner {
    state: String,
    updated_at: String,
    repo_path: Option<String>,
}

/// The shared Git directory of a linked worktree, which `git worktree` commands
/// accept in place of the repository when its project row is gone. `None` for
/// anything that is not a linked worktree, so git is never asked about a
/// repository that merely encloses the directory.
fn worktree_common_dir(checkout: &Path) -> Option<PathBuf> {
    if !checkout.join(".git").is_file() {
        return None;
    }
    run_git_text_blocking(
        checkout,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        GIT_DEFAULT_TIMEOUT,
    )
    .ok()
    .map(|output| PathBuf::from(output.trim()))
    .filter(|path| path.exists())
}

/// Delete an archived checkout without leaving Git a registration that points
/// at nothing: `git worktree remove` when the repository is reachable, and a
/// plain delete followed by `git worktree prune` when that fails. Branches are
/// never touched.
fn remove_archived_checkout(checkout: &Path, repo_path: Option<&Path>) -> ArgmaxResult<()> {
    if let Some(repo_path) = repo_path {
        let checkout_arg = checkout.to_string_lossy();
        let removed = {
            let _registry = lock_worktree_registry_blocking(repo_path);
            run_git_text_blocking(
                repo_path,
                ["worktree", "remove", "--force", checkout_arg.as_ref()],
                ARCHIVE_EXPIRY_GIT_TIMEOUT,
            )
        };
        match removed {
            Ok(_) if !checkout.exists() => return Ok(()),
            Ok(_) => {}
            Err(error) => tracing::warn!(
                path = %checkout.display(),
                ?error,
                "git could not remove the expired worktree; deleting its directory"
            ),
        }
    }
    std::fs::remove_dir_all(checkout)
        .map_err(|error| ArgmaxError::service("ARCHIVE_EXPIRY_REMOVE_FAILED", error.to_string()))?;
    if let Some(repo_path) = repo_path {
        let pruned = {
            let _registry = lock_worktree_registry_blocking(repo_path);
            run_git_text_blocking(repo_path, ["worktree", "prune"], GIT_DEFAULT_TIMEOUT)
        };
        if let Err(error) = pruned {
            tracing::warn!(repo = %repo_path.display(), ?error, "git worktree prune failed after removing an expired archive");
        }
    }
    Ok(())
}

/// `worktree_is_registered_blocking` off the caller's thread, for the async
/// bodies: `git worktree list` can hold the thread for as long as
/// `GIT_DEFAULT_TIMEOUT`, which is far too long to park a runtime worker.
async fn worktree_is_registered(repo_path: String, worktree_path: PathBuf) -> ArgmaxResult<bool> {
    tokio::task::spawn_blocking(move || {
        worktree_is_registered_blocking(Path::new(&repo_path), &worktree_path)
    })
    .await
    .map_err(|error| ArgmaxError::service("WORKTREE_LIST_JOIN", error.to_string()))?
}

/// One entry of `git worktree list --porcelain`.
struct ListedCheckout {
    path: String,
    /// `None` for a detached HEAD or a bare repository.
    branch: Option<String>,
    prunable: bool,
    is_main: bool,
}

/// Entries are blank-line separated blocks of `key value` lines. Git lists the
/// repository's own checkout first.
fn parse_worktree_checkouts(stdout: &str) -> Vec<ListedCheckout> {
    stdout
        .split("\n\n")
        .filter_map(|block| {
            let mut path = None;
            let mut branch = None;
            let mut prunable = false;
            let mut bare = false;
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("worktree ") {
                    path = Some(value.to_string());
                } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
                    branch = Some(value.to_string());
                } else if line == "bare" {
                    bare = true;
                } else if line == "prunable" || line.starts_with("prunable ") {
                    prunable = true;
                }
            }
            Some(ListedCheckout {
                path: path?,
                branch: if bare { None } else { branch },
                prunable,
                is_main: false,
            })
        })
        .enumerate()
        .map(|(index, mut checkout)| {
            checkout.is_main = index == 0;
            checkout
        })
        .collect()
}

fn checkout_is_attachable(checkout: &ListedCheckout, retired: &[PathBuf]) -> bool {
    if checkout.branch.is_none() || checkout.prunable || !Path::new(&checkout.path).is_dir() {
        return false;
    }
    let path = comparable_worktree_path(Path::new(&checkout.path));
    !retired.iter().any(|retired| path.starts_with(retired))
}

/// Whether `git worktree list` in `repo_path` reports `worktree_path`. True for
/// the repository's main checkout as well as its added worktrees.
fn worktree_is_registered_blocking(repo_path: &Path, worktree_path: &Path) -> ArgmaxResult<bool> {
    // Startup recovery runs before any runtime is available to await on.
    let stdout = run_git_text_blocking(
        repo_path,
        ["worktree", "list", "--porcelain"],
        GIT_DEFAULT_TIMEOUT,
    )
    .map_err(|error| {
        invalid_workspace(
            format!("Could not inspect git worktrees: {error}"),
            "Verify the project repository and retry archive.",
        )
    })?;

    let target = comparable_worktree_path(worktree_path)
        .to_string_lossy()
        .into_owned();
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

pub(crate) fn comparable_worktree_path(path: &Path) -> PathBuf {
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

// `git worktree add`, `remove`, `move`, `repair` and `prune` all read or
// rewrite the repository's `.git/worktrees/` registry, and git does not lock it
// against itself: an `add` that scans the registry while another `add` is
// mid-write fails with "failed to read .git/worktrees/<name>/commondir". The
// name claim in `create_isolated` makes concurrent launches pick distinct
// names, but it cannot stop two git processes from overlapping, so every
// Argmax call that writes the registry takes one lock per repository, keyed by
// the canonical git common dir. The main checkout and every linked checkout of
// a repository, and every spelling of their paths, share one registry and so
// one lock.
//
// It is a leaf lock: it is held for the git subprocess (and, in
// `create_isolated`, for the branch claim that precedes the add) and nothing
// else is acquired while it is held, so it cannot take part in a cycle. The
// background hook replay and setup command run after the launch has released
// it. Another process running git on the same repository is not covered; there
// the failing call reports its error and cleans up only what it created.
static WORKTREE_REGISTRY_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

type RegistryGuard = tokio::sync::OwnedMutexGuard<()>;

/// The canonical git common dir for `repo_path`, from `git rev-parse
/// --git-common-dir` (relative to `repo_path` when git prints it that way). A
/// repository git cannot be asked about is keyed by its canonical path.
fn worktree_registry_key(repo_path: &Path, common_dir: Option<&str>) -> PathBuf {
    let candidate = match common_dir.map(str::trim).filter(|dir| !dir.is_empty()) {
        Some(dir) => repo_path.join(dir),
        None => repo_path.to_path_buf(),
    };
    std::fs::canonicalize(&candidate).unwrap_or(candidate)
}

fn registry_lock_for(key: PathBuf) -> Arc<tokio::sync::Mutex<()>> {
    Arc::clone(
        WORKTREE_REGISTRY_LOCKS
            .lock_or_recover("worktree registry locks")
            .entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
    )
}

async fn lock_worktree_registry(repo_path: &Path) -> RegistryGuard {
    let common_dir = run_git_text(
        repo_path,
        ["rev-parse", "--git-common-dir"],
        Duration::from_millis(GIT_TIMEOUT_MS),
    )
    .await
    .ok();
    let key = worktree_registry_key(repo_path, common_dir.as_deref());
    registry_lock_for(key).lock_owned().await
}

/// For the synchronous writers (startup recovery, the expiry sweep). The wait
/// runs on a plain thread because `blocking_lock` panics on a runtime thread,
/// and these callers may be on either kind.
fn lock_worktree_registry_blocking(repo_path: &Path) -> RegistryGuard {
    let common_dir = run_git_text_blocking(
        repo_path,
        ["rev-parse", "--git-common-dir"],
        GIT_DEFAULT_TIMEOUT,
    )
    .ok();
    let lock = registry_lock_for(worktree_registry_key(repo_path, common_dir.as_deref()));
    std::thread::scope(|scope| {
        scope
            .spawn(|| lock.clone().blocking_lock_owned())
            .join()
            .expect("worktree registry lock thread panicked")
    })
}

/// Undo a `git worktree add -b` that must not survive: deregister the
/// worktree, delete its directory, and drop the branch it created. Every step
/// is best-effort — this only ever runs on an error path, where a second
/// failure has nothing left to report to.
/// Removes a worktree directory and its branch. Call it only for resources the
/// caller created: it deletes without asking. With `branch_oid` the branch is
/// deleted only while it still points there, so a branch someone has moved on
/// since survives; without it the branch is deleted unconditionally.
async fn discard_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    branch: &str,
    branch_oid: Option<&str>,
) {
    {
        let _registry = lock_worktree_registry(repo_path).await;
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
    }
    let _ = tokio::fs::remove_dir_all(worktree_path).await;
    // After the worktree is gone the branch is unreferenced; without this it
    // stays behind and collides with the next workspace on the same label.
    let reference = format!("refs/heads/{branch}");
    let _ = match branch_oid {
        Some(oid) => {
            run_git_text(
                repo_path,
                &["update-ref", "-d", &reference, oid],
                Duration::from_millis(GIT_TIMEOUT_MS),
            )
            .await
        }
        None => {
            run_git_text(
                repo_path,
                &["branch", "-D", branch],
                Duration::from_millis(GIT_TIMEOUT_MS),
            )
            .await
        }
    };
}

/// Why a branch could not be claimed.
enum BranchClaimFailure {
    /// The name is taken, or git was holding its lock. The next suffix may work.
    Taken(String),
    /// An existing branch is a path prefix of this one, or the reverse. No
    /// suffix on this prefix can help.
    BlockedPrefix(String),
    /// Anything else, such as a base ref that does not resolve.
    Other(String),
}

/// Reads git's "cannot lock ref 'refs/heads/NEW': 'refs/heads/OTHER' exists;
/// cannot create 'refs/heads/NEW'" and says whether OTHER is a parent of
/// `branch`. When the message cannot be read, assume the worse case, a parent:
/// the launch then leaves the template's prefix instead of trying more suffixes.
fn blocker_is_our_parent(message: &str, branch: &str) -> bool {
    let quoted: Vec<&str> = message.split('\'').skip(1).step_by(2).collect();
    match quoted
        .get(1)
        .and_then(|other| other.strip_prefix("refs/heads/"))
    {
        Some(other) => branch.starts_with(&format!("{other}/")),
        None => true,
    }
}

/// Creates `branch` at `base_ref` and returns the commit it points at. Git
/// creates a ref under its own lock and refuses an existing one, so of two
/// launches racing for a name exactly one succeeds. That makes success proof of
/// ownership. The commit is kept so a later cleanup can delete the branch only
/// while it still points there.
async fn claim_branch(
    repo_path: &str,
    branch: &str,
    base_ref: &str,
) -> Result<String, BranchClaimFailure> {
    let timeout = Duration::from_millis(GIT_TIMEOUT_MS);
    if let Err(error) =
        run_git_text(Path::new(repo_path), &["branch", branch, base_ref], timeout).await
    {
        let reason = error.to_string();
        let lower = reason.to_ascii_lowercase();
        return Err(if lower.contains("exists; cannot create") {
            if blocker_is_our_parent(&reason, branch) {
                BranchClaimFailure::BlockedPrefix(reason)
            } else {
                // An existing branch `adam/fix/x` blocks a new `adam/fix`, but
                // `adam/fix-2` is a different ref, so the next suffix can work.
                BranchClaimFailure::Taken(reason)
            }
        } else if lower.contains("already exists")
            || lower.contains("file exists")
            || lower.contains("cannot lock ref")
        {
            BranchClaimFailure::Taken(reason)
        } else {
            BranchClaimFailure::Other(reason)
        });
    }
    run_git_text(
        Path::new(repo_path),
        &["rev-parse", &format!("refs/heads/{branch}")],
        timeout,
    )
    .await
    .map(|oid| oid.trim().to_string())
    .map_err(|error| BranchClaimFailure::Other(error.to_string()))
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

/// The `git hook run` invocation that replays a repository's `post-checkout`
/// hook in a fresh worktree, or `None` when it has none. `--git-path hooks`
/// honours `core.hooksPath`, and `git hook run` gives the hook the cwd and
/// environment git itself would.
async fn post_checkout_replay_command(worktree_path: &Path) -> Option<String> {
    let timeout = Duration::from_millis(GIT_TIMEOUT_MS);
    let hooks_dir = run_git_text(worktree_path, ["rev-parse", "--git-path", "hooks"], timeout)
        .await
        .ok()?;
    let hook = worktree_path.join(hooks_dir.trim()).join("post-checkout");
    if !is_executable_file(&hook) {
        return None;
    }
    let head = run_git_text(worktree_path, ["rev-parse", "HEAD"], timeout)
        .await
        .ok()?;
    Some(format!(
        "git hook run post-checkout -- {NULL_SHA} {} 1",
        head.trim()
    ))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = true;
    metadata.is_file() && executable
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
        async fn git(cwd: &Path, args: &[&str]) -> String {
            run_git_text(cwd, args, GIT_DEFAULT_TIMEOUT)
                .await
                .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"))
        }
        git(&repo, &["init", "-q", "."]).await;
        git(&repo, &["config", "user.email", "t@example.com"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        std::fs::write(repo.join("f.txt"), "x\n").expect("write");
        git(&repo, &["add", "-A"]).await;
        git(&repo, &["commit", "-qm", "base"]).await;

        let worktree = dir.path().join("wt");
        let worktree_arg = worktree.display().to_string();
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "argmax/doomed",
                &worktree_arg,
                "HEAD",
            ],
        )
        .await;
        assert!(worktree.exists());

        discard_worktree(&repo, &worktree, "argmax/doomed", None).await;

        assert!(!worktree.exists(), "worktree directory should be gone");
        let listed = git(&repo, &["worktree", "list"]).await;
        assert!(
            !listed.contains(&worktree_arg),
            "worktree still registered: {listed}"
        );
        let branches = git(&repo, &["branch", "--list", "argmax/doomed"]).await;
        assert!(branches.trim().is_empty(), "branch survived: {branches}");
    }

    // Every checkout and every spelling of a repository's path must share one
    // registry lock, and the blocking and async writers must exclude each other.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_worktree_registry_lock_is_shared_across_checkouts_spellings_and_sync_callers() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo dir");
        async fn git(cwd: &Path, args: &[&str]) -> String {
            run_git_text(cwd, args, GIT_DEFAULT_TIMEOUT)
                .await
                .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"))
        }
        git(&repo, &["init", "-q", "."]).await;
        git(&repo, &["config", "user.email", "t@example.com"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        std::fs::write(repo.join("f.txt"), "x\n").expect("write");
        git(&repo, &["add", "-A"]).await;
        git(&repo, &["commit", "-qm", "base"]).await;
        let linked = dir.path().join("linked");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "other",
                &linked.display().to_string(),
            ],
        )
        .await;
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&repo, &alias).expect("symlink");

        let key = |path: &Path| {
            let common =
                run_git_text_blocking(path, ["rev-parse", "--git-common-dir"], GIT_DEFAULT_TIMEOUT)
                    .ok();
            worktree_registry_key(path, common.as_deref())
        };
        assert_eq!(
            key(&repo),
            key(&linked),
            "a linked checkout shares the main one's registry"
        );
        assert_eq!(
            key(&repo),
            key(&alias),
            "a symlinked spelling shares it too"
        );

        // A synchronous holder (called here from an async worker, which is the
        // case `blocking_lock` would panic on) excludes the async path.
        let held = lock_worktree_registry_blocking(&repo);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let waiting = tokio::spawn({
            let linked = linked.clone();
            async move {
                let _guard = lock_worktree_registry(&linked).await;
                let _ = entered_tx.send(());
            }
        });
        let mut entered_rx = entered_rx;
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut entered_rx)
                .await
                .is_err(),
            "the async writer must wait for the synchronous one"
        );
        drop(held);
        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .expect("async writer proceeds once the lock is released")
            .expect("entered");
        waiting.await.expect("waiter");
    }

    // The other direction: an async holder (the `create_isolated` shape) must
    // keep a `spawn_blocking` writer, such as the expiry sweep, waiting.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_async_registry_holder_blocks_a_spawn_blocking_writer_until_release() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo dir");
        run_git_text(&repo, &["init", "-q", "."], GIT_DEFAULT_TIMEOUT)
            .await
            .expect("git init");

        let held = lock_worktree_registry(&repo).await;
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let waiter = tokio::task::spawn_blocking({
            let repo = repo.clone();
            move || {
                let _guard = lock_worktree_registry_blocking(&repo);
                let _ = entered_tx.send(());
            }
        });
        let mut entered_rx = entered_rx;
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut entered_rx)
                .await
                .is_err(),
            "the blocking writer must wait for the async holder"
        );
        drop(held);
        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .expect("blocking writer proceeds once the lock is released")
            .expect("entered");
        waiter.await.expect("waiter");
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
}
