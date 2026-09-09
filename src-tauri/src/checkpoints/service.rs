//! Durable, provider-independent workspace checkpoints and safe files-only rewind.
//!
//! A checkpoint pins two trees: the visible working tree (tracked files plus
//! non-ignored untracked files) and the real index. Rewind only materializes
//! those trees. It never moves HEAD, changes branches, or touches ignored
//! files. There is intentionally no claim that filesystem replacement is
//! atomic: each rewind is journaled and creates a recovery checkpoint first.

use std::{
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tempfile::tempdir;
use uuid::Uuid;

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    git::{
        exec::{run_git_text, run_git_text_with_options, GitExecOptions},
        ops::checkout_write_lock,
        tree_snapshot::{index_tree, snapshot_visible_worktree},
    },
    persistence::{
        checkpoints::{
            find_checkpoint, finish_rewind, list_checkpoints, mark_interrupted_rewinds,
            persist_checkpoint, start_rewind, Checkpoint, PersistCheckpointInput,
        },
        sessions::find_session_by_id,
        time::now_iso,
        workspaces::find_workspace_by_id,
        Database,
    },
};

const GIT_TIMEOUT: Duration = Duration::from_secs(60);

pub struct CheckpointService {
    database: Arc<Database>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CreateCheckpointInput {
    pub workspace_id: String,
    pub session_id: Option<String>,
    pub label: String,
    pub turn_boundary: Option<String>,
    pub provider_conversation_id: Option<String>,
    pub recovery_of: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RewindFilesInput {
    pub workspace_id: String,
    pub checkpoint_id: String,
    pub expected_fingerprint: CheckoutFingerprint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutFingerprint {
    pub head_sha: String,
    pub branch: String,
    pub worktree_tree: String,
    pub index_tree: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RewindPreview {
    pub checkpoint: Checkpoint,
    pub current_fingerprint: CheckoutFingerprint,
    pub changed_paths: Vec<String>,
    pub deleted_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RewindFilesResult {
    pub checkpoint: Checkpoint,
    pub recovery_checkpoint: Checkpoint,
    pub restored_paths: Vec<String>,
}

impl CheckpointService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Arc::new(Self { database })
    }

    pub async fn create_checkpoint(
        &self,
        input: CreateCheckpointInput,
    ) -> ArgmaxResult<Checkpoint> {
        let workspace_path = self.workspace_path(&input.workspace_id)?;
        let lock = checkout_write_lock(&workspace_path).await?;
        let _guard = lock.lock().await;
        crate::git::ops::ensure_checkout_idle(&self.database, &workspace_path, None)?;
        self.capture_locked(input, &workspace_path).await
    }

    pub(crate) async fn create_before_turn_checkpoint(
        &self,
        input: CreateCheckpointInput,
    ) -> ArgmaxResult<Checkpoint> {
        let workspace_path = self.workspace_path(&input.workspace_id)?;
        let lock = checkout_write_lock(&workspace_path).await?;
        let _guard = lock.lock().await;
        crate::git::ops::ensure_checkout_idle(
            &self.database,
            &workspace_path,
            input.session_id.as_deref(),
        )?;
        self.capture_locked(input, &workspace_path).await
    }

    pub async fn create_recovery_checkpoint(
        &self,
        workspace_id: String,
        session_id: Option<String>,
        label: String,
    ) -> ArgmaxResult<Checkpoint> {
        self.create_checkpoint(CreateCheckpointInput {
            workspace_id,
            session_id,
            label,
            turn_boundary: None,
            provider_conversation_id: None,
            recovery_of: None,
        })
        .await
    }

    pub fn list(&self, workspace_id: &str, limit: usize) -> ArgmaxResult<Vec<Checkpoint>> {
        list_checkpoints(&self.database.read_connection(), workspace_id, limit)
    }

    pub fn recover_interrupted_rewinds(&self) -> ArgmaxResult<usize> {
        mark_interrupted_rewinds(&self.database.connection())
    }

    pub async fn preview_rewind(
        &self,
        workspace_id: &str,
        checkpoint_id: &str,
    ) -> ArgmaxResult<RewindPreview> {
        let checkpoint = self.checkpoint_for_workspace(workspace_id, checkpoint_id)?;
        let workspace_path = self.workspace_path(workspace_id)?;
        let lock = checkout_write_lock(&workspace_path).await?;
        let _guard = lock.lock().await;
        self.ensure_checkout_supported(&workspace_path).await?;
        let current_fingerprint = checkout_fingerprint(&workspace_path).await?;
        let (mut changed_paths, deleted_paths) = tree_changes(
            &workspace_path,
            &checkpoint.worktree_tree,
            &current_fingerprint.worktree_tree,
        )
        .await?;
        let (index_paths, removed_index_paths) = tree_changes(
            &workspace_path,
            &checkpoint.index_tree,
            &current_fingerprint.index_tree,
        )
        .await?;
        changed_paths.extend(index_paths);
        changed_paths.extend(removed_index_paths);
        changed_paths.sort();
        changed_paths.dedup();
        Ok(RewindPreview {
            checkpoint,
            current_fingerprint,
            changed_paths,
            deleted_paths,
        })
    }

    pub async fn rewind_files(&self, input: RewindFilesInput) -> ArgmaxResult<RewindFilesResult> {
        let checkpoint =
            self.checkpoint_for_workspace(&input.workspace_id, &input.checkpoint_id)?;
        let workspace_path = self.workspace_path(&input.workspace_id)?;
        let lock = checkout_write_lock(&workspace_path).await?;
        let _guard = lock.lock().await;
        self.ensure_no_active_writers(&workspace_path)?;
        crate::git::ops::ensure_checkout_idle(&self.database, &workspace_path, None)?;
        self.ensure_checkout_supported(&workspace_path).await?;

        let current = checkout_fingerprint(&workspace_path).await?;
        if current != input.expected_fingerprint {
            return Err(ArgmaxError::service(
                "CHECKPOINT_REWIND_STALE_PREVIEW",
                "The checkout changed since this rewind was previewed. Preview it again before restoring files.",
            ));
        }
        if checkpoint.head_sha.is_empty()
            || checkpoint.head_sha != current.head_sha
            || checkpoint.branch != current.branch
        {
            return Err(ArgmaxError::service(
                "CHECKPOINT_REWIND_REVISION_CHANGED",
                "The checkpoint was made on a different HEAD or branch. Files-only rewind never crosses revisions.",
            ));
        }
        let (restored_paths, deleted_paths) = tree_changes(
            &workspace_path,
            &checkpoint.worktree_tree,
            &current.worktree_tree,
        )
        .await?;

        let recovery_checkpoint = self
            .capture_locked(
                CreateCheckpointInput {
                    workspace_id: input.workspace_id.clone(),
                    session_id: None,
                    label: format!("Recovery before rewind to {}", checkpoint.label),
                    turn_boundary: None,
                    provider_conversation_id: None,
                    recovery_of: Some(checkpoint.id.clone()),
                },
                &workspace_path,
            )
            .await?;
        let rewind_id = Uuid::new_v4().to_string();
        {
            let connection = self.database.connection();
            start_rewind(
                &connection,
                &rewind_id,
                &checkpoint.id,
                &recovery_checkpoint.id,
                &input.workspace_id,
            )?;
        }

        let restore_result =
            materialize_tree(&workspace_path, &checkpoint.worktree_tree, &deleted_paths).await;
        let restore_result = match restore_result {
            Ok(()) => restore_index(&workspace_path, &checkpoint.index_tree).await,
            Err(error) => Err(error),
        };
        match restore_result {
            Ok(()) => {
                let connection = self.database.connection();
                finish_rewind(&connection, &rewind_id, None)?;
                Ok(RewindFilesResult {
                    checkpoint,
                    recovery_checkpoint,
                    restored_paths,
                })
            }
            Err(error) => {
                let failure = error.to_string();
                let connection = self.database.connection();
                // Preserve the original restore error even if journaling it
                // fails: the recovery checkpoint still tells the user what to
                // restore, while a false success would be much worse.
                if let Err(journal_error) = finish_rewind(&connection, &rewind_id, Some(&failure)) {
                    tracing::error!(%journal_error, rewind_id, "could not mark failed checkpoint rewind");
                }
                Err(error)
            }
        }
    }

    fn workspace_path(&self, workspace_id: &str) -> ArgmaxResult<PathBuf> {
        let connection = self.database.read_connection();
        let workspace = find_workspace_by_id(&connection, workspace_id)?;
        if workspace.kind != "git" || workspace.path.is_empty() {
            return Err(ArgmaxError::service(
                "CHECKPOINT_WORKSPACE_UNSUPPORTED",
                "Checkpoints require a workspace backed by a Git checkout.",
            ));
        }
        Ok(PathBuf::from(workspace.path))
    }

    fn checkpoint_for_workspace(
        &self,
        workspace_id: &str,
        checkpoint_id: &str,
    ) -> ArgmaxResult<Checkpoint> {
        let checkpoint = find_checkpoint(&self.database.read_connection(), checkpoint_id)?;
        if checkpoint.workspace_id != workspace_id {
            return Err(ArgmaxError::service(
                "CHECKPOINT_WORKSPACE_MISMATCH",
                "The checkpoint belongs to a different workspace.",
            ));
        }
        Ok(checkpoint)
    }

    async fn capture_locked(
        &self,
        input: CreateCheckpointInput,
        workspace_path: &Path,
    ) -> ArgmaxResult<Checkpoint> {
        self.ensure_checkout_supported(workspace_path).await?;
        let head_sha = git_text(workspace_path, ["rev-parse", "--verify", "HEAD"]).await?;
        let branch = git_text(
            workspace_path,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
        )
        .await?;
        let index_tree = index_tree(workspace_path).await?;
        let worktree_tree = snapshot_visible_worktree(workspace_path).await?;
        let untracked_paths = untracked_paths(workspace_path).await?;
        let provider_conversation_id = self.session_conversation_for_checkpoint(&input)?;
        let checkpoint = Checkpoint {
            id: Uuid::new_v4().to_string(),
            workspace_id: input.workspace_id,
            session_id: input.session_id,
            label: input.label,
            branch,
            head_sha,
            worktree_tree,
            index_tree,
            untracked_paths,
            turn_boundary: input.turn_boundary,
            provider_conversation_id,
            recovery_of: input.recovery_of,
            created_at: now_iso(),
        };
        pin_checkpoint_trees(workspace_path, &checkpoint).await?;
        let connection = self.database.connection();
        persist_checkpoint(&connection, &PersistCheckpointInput { checkpoint })
    }

    fn session_conversation_for_checkpoint(
        &self,
        input: &CreateCheckpointInput,
    ) -> ArgmaxResult<Option<String>> {
        let Some(session_id) = input.session_id.as_deref() else {
            return Ok(None);
        };
        let connection = self.database.read_connection();
        let session = find_session_by_id(&connection, session_id)?;
        if session.workspace_id != input.workspace_id {
            return Err(ArgmaxError::service(
                "CHECKPOINT_SESSION_WORKSPACE_MISMATCH",
                "The session does not belong to this workspace.",
            ));
        }
        // Provider identity is a durable session property. A renderer-supplied
        // value could identify a different native conversation after a clear.
        Ok(session.provider_conversation_id)
    }

    async fn ensure_checkout_supported(&self, workspace_path: &Path) -> ArgmaxResult<()> {
        let porcelain = git_text(workspace_path, ["status", "--porcelain=v2", "-z"]).await?;
        if porcelain.split('\0').any(|entry| entry.starts_with("u ")) {
            return Err(ArgmaxError::service(
                "CHECKPOINT_UNMERGED_INDEX",
                "Checkpoints cannot capture or restore an unresolved merge index.",
            ));
        }
        let stage = git_text(workspace_path, ["ls-files", "--stage", "-z"]).await?;
        if stage.split('\0').any(|entry| entry.starts_with("160000 ")) {
            return Err(ArgmaxError::service(
                "CHECKPOINT_SUBMODULE_UNSUPPORTED",
                "Checkpoints do not support checkouts containing submodules.",
            ));
        }
        Ok(())
    }

    fn ensure_no_active_writers(&self, workspace_path: &Path) -> ArgmaxResult<()> {
        let canonical = std::fs::canonicalize(workspace_path).map_err(|error| {
            ArgmaxError::service(
                "GIT_WORKSPACE_PATH_INVALID",
                format!("could not resolve workspace checkout: {error}"),
            )
        })?;
        let connection = self.database.read_connection();
        let mut statement = connection.prepare_cached(
            "SELECT w.path FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.state IN ('running', 'waiting', 'blocked')",
        ).map_err(crate::persistence::sqlite_error)?;
        let paths = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(crate::persistence::sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(crate::persistence::sqlite_error)?;
        if paths
            .iter()
            .any(|path| std::fs::canonicalize(path).ok().as_ref() == Some(&canonical))
        {
            return Err(ArgmaxError::service(
                "CHECKPOINT_ACTIVE_WRITERS",
                "Pause every active session using this checkout before rewinding files.",
            ));
        }
        Ok(())
    }
}

async fn git_text<I, S>(workspace_path: &Path, args: I) -> ArgmaxResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    Ok(run_git_text(workspace_path, args, GIT_TIMEOUT)
        .await?
        .trim()
        .to_string())
}

async fn untracked_paths(workspace_path: &Path) -> ArgmaxResult<Vec<String>> {
    let raw = run_git_text(
        workspace_path,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        GIT_TIMEOUT,
    )
    .await?;
    let paths = raw
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    validate_relative_paths(&paths)?;
    Ok(paths)
}

async fn checkout_fingerprint(workspace_path: &Path) -> ArgmaxResult<CheckoutFingerprint> {
    Ok(CheckoutFingerprint {
        head_sha: git_text(workspace_path, ["rev-parse", "--verify", "HEAD"]).await?,
        branch: git_text(
            workspace_path,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
        )
        .await?,
        worktree_tree: snapshot_visible_worktree(workspace_path).await?,
        index_tree: index_tree(workspace_path).await?,
    })
}

async fn pin_checkpoint_trees(workspace_path: &Path, checkpoint: &Checkpoint) -> ArgmaxResult<()> {
    for (kind, tree) in [
        ("worktree", &checkpoint.worktree_tree),
        ("index", &checkpoint.index_tree),
    ] {
        let reference = format!("refs/argmax/checkpoints/{}/{kind}", checkpoint.id);
        run_git_text(
            workspace_path,
            ["update-ref", reference.as_str(), tree.as_str()],
            GIT_TIMEOUT,
        )
        .await?;
    }
    Ok(())
}

async fn tree_changes(
    workspace_path: &Path,
    target_tree: &str,
    current_tree: &str,
) -> ArgmaxResult<(Vec<String>, Vec<String>)> {
    let raw = run_git_text(
        workspace_path,
        [
            "diff",
            "--name-status",
            "--no-renames",
            "-z",
            target_tree,
            current_tree,
        ],
        GIT_TIMEOUT,
    )
    .await?;
    let mut changed = Vec::new();
    let mut deleted = Vec::new();
    let mut fields = raw.split('\0').filter(|field| !field.is_empty());
    while let Some(status) = fields.next() {
        let path = fields.next().ok_or_else(|| {
            ArgmaxError::service(
                "CHECKPOINT_DIFF_MALFORMED",
                "git returned a pathless tree diff",
            )
        })?;
        validate_relative_paths(&[path.to_string()])?;
        if status == "A" {
            deleted.push(path.to_string());
        } else {
            changed.push(path.to_string());
        }
    }
    Ok((changed, deleted))
}

async fn materialize_tree(
    workspace_path: &Path,
    target_tree: &str,
    delete_paths: &[String],
) -> ArgmaxResult<()> {
    validate_relative_paths(delete_paths)?;
    let targets = git_text(
        workspace_path,
        ["ls-tree", "-r", "--name-only", "-z", target_tree],
    )
    .await?;
    let target_paths = targets
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    validate_relative_paths(&target_paths)?;
    let ignored = git_text(
        workspace_path,
        [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
        ],
    )
    .await?;
    for ignored_path in ignored.split('\0').filter(|path| !path.is_empty()) {
        let ignored_path = Path::new(ignored_path);
        if target_paths.iter().chain(delete_paths).any(|path| {
            let affected = Path::new(path);
            ignored_path.starts_with(affected) || affected.starts_with(ignored_path)
        }) {
            return Err(ArgmaxError::service(
                "CHECKPOINT_IGNORED_PATH_CONFLICT",
                format!("Rewind would overwrite ignored content at {}. Move it out of the checkout before restoring.", ignored_path.display()),
            ));
        }
    }
    let scratch = tempdir().map_err(|error| {
        ArgmaxError::service(
            "GIT_TEMP_INDEX_FAILED",
            format!("could not create temp git index: {error}"),
        )
    })?;
    let index = scratch.path().join("index");
    let options = || GitExecOptions::default().with_env("GIT_INDEX_FILE", index.as_os_str());
    run_git_text_with_options(workspace_path, ["read-tree", target_tree], options()).await?;
    for relative in delete_paths {
        let path = workspace_path.join(relative);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() => std::fs::remove_dir(&path),
            Ok(_) => std::fs::remove_file(&path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => Err(error),
        }
        .map_err(|error| {
            ArgmaxError::service(
                "CHECKPOINT_RESTORE_DELETE_FAILED",
                format!("could not remove {}: {error}", path.display()),
            )
        })?;
    }
    run_git_text_with_options(
        workspace_path,
        ["checkout-index", "--all", "--force"],
        options(),
    )
    .await?;
    Ok(())
}

async fn restore_index(workspace_path: &Path, target_tree: &str) -> ArgmaxResult<()> {
    git_text(workspace_path, ["read-tree", target_tree]).await?;
    Ok(())
}

fn validate_relative_paths(paths: &[String]) -> ArgmaxResult<()> {
    for raw in paths {
        let path = Path::new(raw);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(ArgmaxError::service(
                "CHECKPOINT_PATH_ESCAPE",
                format!("checkpoint path escapes its checkout: {raw}"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::persistence::{
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        sessions::{persist_session, PersistSessionInput},
        workspaces::{persist_workspace, PersistWorkspaceInput},
        Database,
    };
    use crate::sessions::state::SessionState;

    async fn git(path: &Path, args: &[&str]) {
        run_git_text(path, args, GIT_TIMEOUT)
            .await
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"));
    }

    async fn service_with_workspace() -> (tempfile::TempDir, Arc<CheckpointService>) {
        let repo = tempfile::tempdir().expect("temp repo");
        let path = repo.path();
        git(path, &["init", "--initial-branch=main"]).await;
        git(path, &["config", "user.email", "test@example.com"]).await;
        git(path, &["config", "user.name", "Test User"]).await;
        fs::write(path.join("tracked.txt"), "base\n").expect("tracked");
        fs::write(path.join("staged.txt"), "base\n").expect("staged");
        git(path, &["add", "-A"]).await;
        git(path, &["commit", "-m", "base"]).await;

        let database = Arc::new(Database::open_in_memory().expect("database"));
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project".into(),
                name: "project".into(),
                repo_path: path.display().to_string(),
                current_branch: "main".into(),
                default_branch: Some("main".into()),
                settings: ProjectSettings {
                    worktree_location: String::new(),
                    setup_command: String::new(),
                    check_commands: vec![],
                    archive_on_merge: false,
                },
            },
        )
        .expect("project");
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "workspace".into(),
                project_id: "project".into(),
                task_label: "task".into(),
                branch: "main".into(),
                base_ref: "main".into(),
                path: path.display().to_string(),
                state: "created".into(),
                shared_workspace: false,
                kind: "git".into(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("workspace");
        drop(connection);
        (repo, CheckpointService::new(database))
    }

    #[tokio::test]
    async fn rewind_restores_staged_unstaged_untracked_and_deleted_files() {
        let (repo, service) = service_with_workspace().await;
        let path = repo.path();
        fs::write(path.join("staged.txt"), "staged checkpoint\n").expect("stage edit");
        git(path, &["add", "staged.txt"]).await;
        fs::write(path.join("tracked.txt"), "unstaged checkpoint\n").expect("unstaged edit");
        fs::write(path.join("new.txt"), "checkpoint untracked\n").expect("untracked");
        let checkpoint = service
            .create_checkpoint(CreateCheckpointInput {
                workspace_id: "workspace".into(),
                session_id: None,
                label: "before".into(),
                turn_boundary: None,
                provider_conversation_id: None,
                recovery_of: None,
            })
            .await
            .expect("checkpoint");
        assert!(checkpoint.untracked_paths.contains(&"new.txt".to_string()));
        assert!(!git_text(
            path,
            [
                "show-ref",
                "--verify",
                &format!("refs/argmax/checkpoints/{}/worktree", checkpoint.id)
            ]
        )
        .await
        .expect("pinned ref")
        .is_empty());

        fs::remove_file(path.join("tracked.txt")).expect("delete tracked");
        fs::write(path.join("staged.txt"), "later\n").expect("later stage");
        git(path, &["add", "staged.txt"]).await;
        fs::remove_file(path.join("new.txt")).expect("delete untracked");
        fs::write(path.join("later.txt"), "later untracked\n").expect("later untracked");
        let preview = service
            .preview_rewind("workspace", &checkpoint.id)
            .await
            .expect("preview");
        service
            .rewind_files(RewindFilesInput {
                workspace_id: "workspace".into(),
                checkpoint_id: checkpoint.id,
                expected_fingerprint: preview.current_fingerprint,
            })
            .await
            .expect("rewind");
        assert_eq!(
            fs::read_to_string(path.join("tracked.txt")).unwrap(),
            "unstaged checkpoint\n"
        );
        assert_eq!(
            fs::read_to_string(path.join("new.txt")).unwrap(),
            "checkpoint untracked\n"
        );
        assert!(!path.join("later.txt").exists());
        assert!(git_text(path, ["diff", "--cached", "--", "staged.txt"])
            .await
            .expect("staged diff")
            .contains("staged checkpoint"));
    }

    #[tokio::test]
    async fn rewind_preview_includes_index_only_changes() {
        let (repo, service) = service_with_workspace().await;
        let path = repo.path();
        fs::write(path.join("staged.txt"), "checkpoint contents\n").unwrap();
        git(path, &["add", "staged.txt"]).await;
        let checkpoint = service
            .create_recovery_checkpoint("workspace".into(), None, "staged".into())
            .await
            .unwrap();
        git(path, &["restore", "--staged", "staged.txt"]).await;
        let preview = service
            .preview_rewind("workspace", &checkpoint.id)
            .await
            .unwrap();
        assert_eq!(preview.changed_paths, vec!["staged.txt"]);
        assert_eq!(
            preview.current_fingerprint.worktree_tree,
            checkpoint.worktree_tree
        );
        assert_ne!(
            preview.current_fingerprint.index_tree,
            checkpoint.index_tree
        );
    }

    #[tokio::test]
    async fn provider_launch_observes_a_durable_before_turn_checkpoint() {
        use crate::providers::{
            runtime::{BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeHandle},
            ProviderLaunchInput,
        };
        struct CheckpointObservingLauncher {
            database: Arc<Database>,
            observed: tokio::sync::Notify,
        }
        impl ProviderProcessLauncher for CheckpointObservingLauncher {
            fn launch<'a>(
                &'a self,
                input: ProviderLaunchInput,
                _: EventCallback,
            ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
                Box::pin(async move {
                    let rows = list_checkpoints(&self.database.read_connection(), "workspace", 10)?;
                    assert_eq!(rows.len(), 1);
                    assert_eq!(
                        rows[0].session_id.as_deref(),
                        Some(input.session_id.as_str())
                    );
                    assert_eq!(rows[0].label, "Before turn");
                    assert!(!rows[0].worktree_tree.is_empty());
                    self.observed.notify_one();
                    Err(ArgmaxError::service(
                        "TEST_LAUNCH_FINISHED",
                        "Checkpoint observed",
                    ))
                })
            }
        }
        let (_repo, checkpoints) = service_with_workspace().await;
        let launcher = Arc::new(CheckpointObservingLauncher {
            database: Arc::clone(&checkpoints.database),
            observed: tokio::sync::Notify::new(),
        });
        let providers = crate::providers::session_service::ProviderSessionService::with_launcher(
            Arc::clone(&checkpoints.database),
            launcher.clone(),
            |_| {},
        );
        providers.set_checkpoint_service(checkpoints);
        providers
            .launch(
                serde_json::from_value(serde_json::json!({
                    "workspaceId": "workspace", "provider": "codex", "prompt": "Test capture order",
                    "modelLabel": "Test", "modelId": "test", "cols": 80, "rows": 24
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), launcher.observed.notified())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rewind_rejects_a_stale_preview() {
        let (repo, service) = service_with_workspace().await;
        let checkpoint = service
            .create_recovery_checkpoint("workspace".into(), None, "before".into())
            .await
            .expect("checkpoint");
        let preview = service
            .preview_rewind("workspace", &checkpoint.id)
            .await
            .expect("preview");
        fs::write(repo.path().join("tracked.txt"), "changed after preview\n").expect("edit");
        let error = service
            .rewind_files(RewindFilesInput {
                workspace_id: "workspace".into(),
                checkpoint_id: checkpoint.id,
                expected_fingerprint: preview.current_fingerprint,
            })
            .await
            .expect_err("stale preview");
        assert!(error
            .to_string()
            .contains("changed since this rewind was previewed"));
    }

    #[tokio::test]
    async fn review_hunks_preserve_partial_index_and_expanded_context() {
        use crate::review::git_review::{
            load_diff_at_path, revert_unstaged_hunk, update_hunk_index, ReviewBaseline,
        };
        use crate::workspaces::WorkspaceTargetKind;
        let (repo, service) = service_with_workspace().await;
        let path = repo.path();
        let original = (1..=40)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        fs::write(path.join("tracked.txt"), &original).unwrap();
        git(path, &["add", "tracked.txt"]).await;
        git(path, &["commit", "-m", "numbered lines"]).await;
        let modified = original
            .replace("line 5\n", "edited 5\n")
            .replace("line 25\n", "edited 25\n");
        fs::write(path.join("tracked.txt"), &modified).unwrap();
        let expanded = load_diff_at_path(
            path,
            "workspace",
            Some("tracked.txt"),
            ReviewBaseline::WorkingTree,
            Some(20),
        )
        .await
        .unwrap();
        assert_eq!(
            expanded
                .content
                .lines()
                .filter(|line| line.starts_with("@@"))
                .count(),
            1
        );
        update_hunk_index(
            &service.database,
            WorkspaceTargetKind::Workspace,
            "workspace",
            "tracked.txt",
            &expanded.revision,
            0,
            Some(20),
            true,
        )
        .await
        .unwrap();
        assert!(git_text(path, ["diff", "--", "tracked.txt"])
            .await
            .unwrap()
            .is_empty());
        git(path, &["restore", "--staged", "tracked.txt"]).await;
        fs::write(path.join("tracked.txt"), format!("inserted\n{original}")).unwrap();
        git(path, &["add", "tracked.txt"]).await;
        fs::write(
            path.join("tracked.txt"),
            format!(
                "inserted\n{}",
                original.replace("line 25\n", "unstaged edit\n")
            ),
        )
        .unwrap();
        git(path, &["config", "diff.context", "20"]).await;
        let partial = load_diff_at_path(
            path,
            "workspace",
            Some("tracked.txt"),
            ReviewBaseline::WorkingTree,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            partial
                .content
                .lines()
                .filter(|line| line.starts_with("@@"))
                .count(),
            2
        );
        let mixed_error = update_hunk_index(
            &service.database,
            WorkspaceTargetKind::Workspace,
            "workspace",
            "tracked.txt",
            &partial.revision,
            0,
            None,
            false,
        )
        .await
        .expect_err("combined staged and unstaged patches are not index actions");
        assert!(mixed_error.to_string().contains("both staged and unstaged"));
        revert_unstaged_hunk(
            &service.database,
            "workspace",
            "tracked.txt",
            &partial.revision,
            1,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(path.join("tracked.txt")).unwrap(),
            format!("inserted\n{original}")
        );
        assert!(git_text(path, ["diff", "--cached"])
            .await
            .unwrap()
            .contains("+inserted"));
    }

    #[tokio::test]
    async fn review_rejects_untracked_placeholder_hunks_and_stale_untracked_files() {
        use crate::review::git_review::{
            load_diff_at_path, update_file_index, update_hunk_index, ReviewBaseline,
        };
        use crate::workspaces::WorkspaceTargetKind;
        let (repo, service) = service_with_workspace().await;
        let path = repo.path();
        fs::write(path.join("large.bin"), vec![0_u8; 1_049_600]).unwrap();
        let preview = load_diff_at_path(
            path,
            "workspace",
            Some("large.bin"),
            ReviewBaseline::WorkingTree,
            None,
        )
        .await
        .unwrap();
        assert!(update_hunk_index(
            &service.database,
            WorkspaceTargetKind::Workspace,
            "workspace",
            "large.bin",
            &preview.revision,
            0,
            None,
            true
        )
        .await
        .is_err());
        assert!(git_text(path, ["diff", "--cached"])
            .await
            .unwrap()
            .is_empty());
        fs::write(path.join("large.bin"), "new contents").unwrap();
        assert!(update_file_index(
            &service.database,
            WorkspaceTargetKind::Workspace,
            "workspace",
            "large.bin",
            &preview.revision,
            true
        )
        .await
        .is_err());
        let current = load_diff_at_path(
            path,
            "workspace",
            Some("large.bin"),
            ReviewBaseline::WorkingTree,
            None,
        )
        .await
        .unwrap();
        update_file_index(
            &service.database,
            WorkspaceTargetKind::Workspace,
            "workspace",
            "large.bin",
            &current.revision,
            true,
        )
        .await
        .unwrap();
        assert_eq!(
            git_text(path, ["show", ":large.bin"]).await.unwrap(),
            "new contents"
        );
    }

    #[tokio::test]
    async fn review_unstages_both_sides_of_a_rename() {
        use crate::review::git_review::{load_diff_at_path, update_file_index, ReviewBaseline};
        use crate::workspaces::WorkspaceTargetKind;
        let (repo, service) = service_with_workspace().await;
        let path = repo.path();
        git(path, &["mv", "tracked.txt", "renamed.txt"]).await;
        let preview = load_diff_at_path(
            path,
            "workspace",
            Some("renamed.txt"),
            ReviewBaseline::WorkingTree,
            None,
        )
        .await
        .unwrap();
        update_file_index(
            &service.database,
            WorkspaceTargetKind::Workspace,
            "workspace",
            "renamed.txt",
            &preview.revision,
            false,
        )
        .await
        .unwrap();
        assert!(git_text(path, ["diff", "--cached"])
            .await
            .unwrap()
            .is_empty());
        assert!(path.join("renamed.txt").exists());
    }

    #[tokio::test]
    async fn rewind_preserves_ignored_files_inside_a_directory_collision() {
        let (repo, service) = service_with_workspace().await;
        let path = repo.path();
        let checkpoint = service
            .create_recovery_checkpoint("workspace".into(), None, "before".into())
            .await
            .unwrap();
        fs::remove_file(path.join("tracked.txt")).unwrap();
        fs::create_dir(path.join("tracked.txt")).unwrap();
        fs::write(
            path.join("tracked.txt/cache.bin"),
            "irreplaceable ignored content",
        )
        .unwrap();
        fs::write(path.join(".git/info/exclude"), "tracked.txt/cache.bin\n").unwrap();
        let preview = service
            .preview_rewind("workspace", &checkpoint.id)
            .await
            .unwrap();
        let error = service
            .rewind_files(RewindFilesInput {
                workspace_id: "workspace".into(),
                checkpoint_id: checkpoint.id,
                expected_fingerprint: preview.current_fingerprint,
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("ignored content"));
        assert_eq!(
            fs::read_to_string(path.join("tracked.txt/cache.bin")).unwrap(),
            "irreplaceable ignored content"
        );
    }

    #[tokio::test]
    async fn rewind_restores_a_directory_over_a_later_file() {
        let (repo, service) = service_with_workspace().await;
        let path = repo.path();
        fs::create_dir(path.join("node")).unwrap();
        fs::write(path.join("node/file"), "checkpoint child").unwrap();
        let checkpoint = service
            .create_recovery_checkpoint("workspace".into(), None, "directory".into())
            .await
            .unwrap();
        fs::remove_file(path.join("node/file")).unwrap();
        fs::remove_dir(path.join("node")).unwrap();
        fs::write(path.join("node"), "later file").unwrap();
        let preview = service
            .preview_rewind("workspace", &checkpoint.id)
            .await
            .unwrap();
        service
            .rewind_files(RewindFilesInput {
                workspace_id: "workspace".into(),
                checkpoint_id: checkpoint.id,
                expected_fingerprint: preview.current_fingerprint,
            })
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(path.join("node/file")).unwrap(),
            "checkpoint child"
        );
    }

    #[tokio::test]
    async fn rewind_rejects_a_checkpoint_from_another_head() {
        let (repo, service) = service_with_workspace().await;
        let checkpoint = service
            .create_recovery_checkpoint("workspace".into(), None, "before".into())
            .await
            .expect("checkpoint");
        fs::write(repo.path().join("tracked.txt"), "new committed head\n").expect("edit");
        git(repo.path(), &["add", "tracked.txt"]).await;
        git(repo.path(), &["commit", "-m", "new head"]).await;
        let preview = service
            .preview_rewind("workspace", &checkpoint.id)
            .await
            .expect("preview");
        let error = service
            .rewind_files(RewindFilesInput {
                workspace_id: "workspace".into(),
                checkpoint_id: checkpoint.id,
                expected_fingerprint: preview.current_fingerprint,
            })
            .await
            .expect_err("different revision");
        assert!(error.to_string().contains("different HEAD or branch"));
    }

    #[tokio::test]
    async fn rewind_rejects_an_active_session_sharing_the_checkout() {
        let (_repo, service) = service_with_workspace().await;
        let checkpoint = service
            .create_recovery_checkpoint("workspace".into(), None, "before".into())
            .await
            .expect("checkpoint");
        let preview = service
            .preview_rewind("workspace", &checkpoint.id)
            .await
            .expect("preview");
        {
            let connection = service.database.connection();
            persist_session(
                &connection,
                &PersistSessionInput {
                    id: "writer".into(),
                    workspace_id: "workspace".into(),
                    provider: "codex".into(),
                    model_label: "test".into(),
                    model_id: "test".into(),
                    reasoning_effort: None,
                    permission_mode: None,
                    agent_mode: None,
                    prompt: String::new(),
                    state: SessionState::Running,
                },
            )
            .expect("active session");
        }
        let error = service
            .rewind_files(RewindFilesInput {
                workspace_id: "workspace".into(),
                checkpoint_id: checkpoint.id,
                expected_fingerprint: preview.current_fingerprint,
            })
            .await
            .expect_err("active writer");
        assert!(error.to_string().contains("Pause every active session"));
    }

    #[test]
    fn rejects_paths_escaping_a_checkout() {
        let error = validate_relative_paths(&["../outside".to_string()]).expect_err("escape");
        assert!(error.to_string().contains("escapes its checkout"));
    }
}
