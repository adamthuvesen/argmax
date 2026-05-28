// CheckpointService — snapshots the worktree's pending diff to disk so the
// user can rewind to a known-good state without disturbing the git index.
//
// Mirrors `src/main/review/checkpointService.ts`:
//   1. read-tree HEAD into a temporary index (`GIT_INDEX_FILE`)
//   2. `add -A -- .` against that scratch index
//   3. `diff --binary --cached HEAD` against that scratch index
//   4. write the patch under `${data_dir}/checkpoints/<id>.patch`
//   5. persist a `checkpoints` row pointing at the patch + captured ref
//
// The scratch index keeps the real worktree index untouched. Patch size is
// capped at 32 MiB — a multi-MB lockfile or vendored bundle change can blow
// past that, and silently persisting hundreds of MB per checkpoint is worse
// than refusing.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use tempfile::tempdir;
use uuid::Uuid;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::exec::{run_git_buffer_with_options, run_git_text, GitExecOptions};
use crate::persistence::checks::{persist_checkpoint, Checkpoint, PersistCheckpointInput};
use crate::persistence::database::Database;
use crate::persistence::workspaces::find_workspace_by_id;

/// Max bytes a single checkpoint diff may occupy on disk. A multi-MB
/// lockfile or vendored bundle blowing past this means the worktree is
/// churning binary content the user almost certainly didn't intend.
pub const MAX_CHECKPOINT_DIFF_BYTES: usize = 32 * 1024 * 1024;

const GIT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct CreateCheckpointInput {
    pub workspace_id: String,
    pub label: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CheckpointError {
    #[error("checkpoint diff is {byte_length} bytes, exceeds {cap} byte cap")]
    TooLarge { byte_length: usize, cap: usize },
}

impl From<CheckpointError> for ArgmaxError {
    fn from(err: CheckpointError) -> Self {
        match err {
            CheckpointError::TooLarge { byte_length, cap } => ArgmaxError::service(
                "CHECKPOINT_TOO_LARGE",
                format!("checkpoint diff is {byte_length} bytes, exceeds {cap} byte cap"),
            ),
        }
    }
}

pub struct CheckpointService {
    database: Arc<Database>,
    checkpoint_dir: PathBuf,
}

impl CheckpointService {
    pub fn from_data_dir(database: Arc<Database>, data_dir: impl AsRef<Path>) -> Arc<Self> {
        Self::with_checkpoint_dir(database, data_dir.as_ref().join("checkpoints"))
    }

    pub fn with_checkpoint_dir(
        database: Arc<Database>,
        checkpoint_dir: impl AsRef<Path>,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            checkpoint_dir: checkpoint_dir.as_ref().to_path_buf(),
        })
    }

    pub fn checkpoint_dir(&self) -> &Path {
        &self.checkpoint_dir
    }

    pub async fn create_checkpoint(
        &self,
        input: CreateCheckpointInput,
    ) -> ArgmaxResult<Checkpoint> {
        let workspace = {
            let connection = self.database.connection();
            find_workspace_by_id(&connection, &input.workspace_id)?
        };
        let id = Uuid::new_v4().to_string();
        let workspace_path = PathBuf::from(&workspace.path);

        // Independent reads — fan out so the slow binary diff doesn't gate
        // the metadata calls.
        let branch_raw_fut = run_git_text(
            workspace_path.clone(),
            ["branch", "--show-current"],
            GIT_TIMEOUT,
        );
        let git_ref_raw_fut =
            run_git_text(workspace_path.clone(), ["rev-parse", "HEAD"], GIT_TIMEOUT);
        let diff_fut = build_checkpoint_diff(&workspace_path);
        let (branch_raw, git_ref_raw, diff) =
            tokio::try_join!(branch_raw_fut, git_ref_raw_fut, diff_fut)?;

        if diff.len() > MAX_CHECKPOINT_DIFF_BYTES {
            return Err(CheckpointError::TooLarge {
                byte_length: diff.len(),
                cap: MAX_CHECKPOINT_DIFF_BYTES,
            }
            .into());
        }
        let branch = {
            let trimmed = branch_raw.trim();
            if trimmed.is_empty() {
                workspace.branch.clone()
            } else {
                trimmed.to_string()
            }
        };
        let git_ref = {
            let trimmed = git_ref_raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        };
        let patch_path = self.checkpoint_dir.join(format!("{id}.patch"));

        tokio::fs::create_dir_all(&self.checkpoint_dir)
            .await
            .map_err(|error| {
                ArgmaxError::service(
                    "CHECKPOINT_WRITE_FAILED",
                    format!("could not create checkpoint directory: {error}"),
                )
            })?;
        tokio::fs::write(&patch_path, &diff)
            .await
            .map_err(|error| {
                ArgmaxError::service(
                    "CHECKPOINT_WRITE_FAILED",
                    format!("could not write checkpoint patch: {error}"),
                )
            })?;

        let connection = self.database.connection();
        persist_checkpoint(
            &connection,
            &PersistCheckpointInput {
                id,
                workspace_id: workspace.id,
                label: input.label,
                branch,
                git_ref,
                patch_path: Some(patch_path.to_string_lossy().into_owned()),
                created_at: None,
            },
        )
    }
}

async fn build_checkpoint_diff(workspace_path: &Path) -> ArgmaxResult<Vec<u8>> {
    let temp_dir = tempdir().map_err(|error| {
        ArgmaxError::service(
            "CHECKPOINT_TEMP_FAILED",
            format!("could not create temp dir: {error}"),
        )
    })?;
    let temp_index = temp_dir.path().join("index");

    let env_opts = || GitExecOptions::default().with_env("GIT_INDEX_FILE", temp_index.as_os_str());

    let mut text_opts = env_opts();
    text_opts.timeout = GIT_TIMEOUT;
    let mut text_opts_for_add = text_opts.clone();
    // `add` needs to scan the worktree, so give it the same timeout budget.
    text_opts_for_add.timeout = GIT_TIMEOUT;

    // Stage 1: read-tree HEAD → temp index.
    run_git_text_with_options(workspace_path, ["read-tree", "HEAD"], text_opts.clone()).await?;
    // Stage 2: add -A -- . against the temp index.
    run_git_text_with_options(workspace_path, ["add", "-A", "--", "."], text_opts_for_add).await?;
    // Stage 3: produce the binary diff against the temp index.
    let mut buffer_opts = env_opts();
    buffer_opts.timeout = GIT_TIMEOUT;
    let diff = run_git_buffer_with_options(
        workspace_path,
        ["diff", "--binary", "--cached", "HEAD"],
        buffer_opts,
    )
    .await?;
    Ok(diff)
}

async fn run_git_text_with_options(
    workspace_path: &Path,
    args: impl IntoIterator<Item = &'static str>,
    options: GitExecOptions,
) -> ArgmaxResult<String> {
    let bytes = run_git_buffer_with_options(workspace_path, args, options).await?;
    String::from_utf8(bytes).map_err(|error| {
        ArgmaxError::service(
            "GIT_STDOUT_NOT_UTF8",
            format!("git stdout was not valid UTF-8: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::database::Database;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use std::process::Command;
    use tempfile::TempDir;

    fn run_in_repo(repo: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(["-C", repo.to_str().unwrap()])
            .args(args)
            .status()
            .expect("git invoke failed");
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_repo(dir: &Path) {
        run_in_repo(dir, &["init", "-q", "-b", "main"]);
        run_in_repo(dir, &["config", "user.email", "test@argmax.dev"]);
        run_in_repo(dir, &["config", "user.name", "Argmax Test"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        run_in_repo(dir, &["add", "README.md"]);
        run_in_repo(dir, &["commit", "-q", "-m", "init"]);
    }

    #[tokio::test]
    async fn create_checkpoint_persists_patch_and_row() {
        let repo_dir = TempDir::new().unwrap();
        init_repo(repo_dir.path());

        // Make the worktree dirty so the checkpoint has something to capture.
        std::fs::write(repo_dir.path().join("notes.txt"), "scratch\n").unwrap();

        let data_dir = TempDir::new().unwrap();
        let db_path = data_dir.path().join("argmax.sqlite");
        let database = Arc::new(Database::open(&db_path).expect("database opens"));

        let project = {
            let conn = database.connection();
            persist_project(
                &conn,
                &PersistProjectInput {
                    id: "p1".to_string(),
                    name: "fixture".to_string(),
                    repo_path: repo_dir.path().to_string_lossy().into_owned(),
                    default_branch: Some("main".to_string()),
                    current_branch: "main".to_string(),
                    settings: ProjectSettings {
                        default_provider: "claude".to_string(),
                        default_model_label: "Claude Haiku 4.5".to_string(),
                        worktree_location: repo_dir
                            .path()
                            .join(".worktrees")
                            .to_string_lossy()
                            .into_owned(),
                        setup_command: String::new(),
                        check_commands: Vec::new(),
                    },
                },
            )
            .expect("project persists")
        };

        let workspace = {
            let conn = database.connection();
            persist_workspace(
                &conn,
                &PersistWorkspaceInput {
                    id: "w1".to_string(),
                    project_id: project.id.clone(),
                    task_label: "checkpoint-test".to_string(),
                    branch: "main".to_string(),
                    base_ref: "main".to_string(),
                    path: repo_dir.path().to_string_lossy().into_owned(),
                    state: "created".to_string(),
                    shared_workspace: true,
                    dirty: true,
                    changed_files: 1,
                },
            )
            .expect("workspace persists")
        };

        let service = CheckpointService::from_data_dir(database, data_dir.path());
        let checkpoint = service
            .create_checkpoint(CreateCheckpointInput {
                workspace_id: workspace.id.clone(),
                label: "first".to_string(),
            })
            .await
            .expect("checkpoint created");

        assert_eq!(checkpoint.label, "first");
        assert_eq!(checkpoint.workspace_id, "w1");
        assert_eq!(checkpoint.branch, "main");
        assert!(checkpoint.git_ref.is_some());
        let patch_path = checkpoint
            .patch_path
            .as_ref()
            .expect("patch_path is recorded");
        let bytes = std::fs::read(patch_path).expect("patch file exists");
        assert!(!bytes.is_empty(), "patch should contain the dirty diff");
        let as_text = String::from_utf8_lossy(&bytes);
        assert!(as_text.contains("notes.txt"));
    }
}
