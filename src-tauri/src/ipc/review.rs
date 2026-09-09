use super::inputs::*;
use super::live_database;
use crate::{
    checkpoints::service::CheckpointService,
    error::ArgmaxResult,
    git::ops::{GitCommitInput, GitCommitResult, GitOpsService},
    review::git_review::{self, ChangedFileSummary, WorkspaceDiff},
    state::AppState,
    workspaces::WorkspaceTargetKind,
};
use serde::Deserialize;
use specta::Type;
use tauri::State;

/// Mutating review inputs stay beside their commands until the generated IPC
/// layer owns the public bridge shape. Their path and revision are checked by
/// `git_review` while the checkout lock is held.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewIndexFileInput {
    pub kind: WorkspaceTargetKind,
    pub id: String,
    pub file_path: String,
    pub revision: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewIndexHunkInput {
    pub kind: WorkspaceTargetKind,
    pub id: String,
    pub file_path: String,
    pub revision: String,
    pub hunk_index: u32,
    pub context_lines: Option<super::validation::DiffContextLines>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewCommitStagedInput {
    pub workspace_id: String,
    pub message: String,
}

#[tauri::command(rename = "review:list-changed-files")]
#[specta::specta]
pub async fn review_list_changed_files(
    state: State<'_, AppState>,
    input: ReviewListChangedFilesInput,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    review_list_changed_files_impl(&state, input).await
}

pub(crate) async fn review_list_changed_files_impl(
    state: &AppState,
    input: ReviewListChangedFilesInput,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let database = live_database(state)?;
    git_review::list_changed_files(
        database.as_ref(),
        input.kind,
        input.id.as_str(),
        input.comparison,
    )
    .await
}

#[tauri::command(rename = "review:load-diff")]
#[specta::specta]
pub async fn review_load_diff(
    state: State<'_, AppState>,
    input: ReviewLoadDiffInput,
) -> ArgmaxResult<WorkspaceDiff> {
    review_load_diff_impl(&state, input).await
}

pub(crate) async fn review_load_diff_impl(
    state: &AppState,
    input: ReviewLoadDiffInput,
) -> ArgmaxResult<WorkspaceDiff> {
    let database = live_database(state)?;
    git_review::load_diff(
        database.as_ref(),
        input.kind,
        input.id.as_str(),
        input.file_path.as_ref().map(|path| path.as_str()),
        input.comparison,
        input.context_lines.map(|context| context.get()),
    )
    .await
}

#[tauri::command(rename = "review:stage-file")]
#[specta::specta]
pub async fn review_stage_file(
    state: State<'_, AppState>,
    input: ReviewIndexFileInput,
) -> ArgmaxResult<()> {
    review_update_file_index_impl(&state, input, true).await
}

#[tauri::command(rename = "review:unstage-file")]
#[specta::specta]
pub async fn review_unstage_file(
    state: State<'_, AppState>,
    input: ReviewIndexFileInput,
) -> ArgmaxResult<()> {
    review_update_file_index_impl(&state, input, false).await
}

pub(crate) async fn review_update_file_index_impl(
    state: &AppState,
    input: ReviewIndexFileInput,
    stage: bool,
) -> ArgmaxResult<()> {
    let database = live_database(state)?;
    git_review::update_file_index(
        database.as_ref(),
        input.kind,
        &input.id,
        &input.file_path,
        &input.revision,
        stage,
    )
    .await
}

#[tauri::command(rename = "review:stage-hunk")]
#[specta::specta]
pub async fn review_stage_hunk(
    state: State<'_, AppState>,
    input: ReviewIndexHunkInput,
) -> ArgmaxResult<()> {
    review_update_hunk_index_impl(&state, input, true).await
}

#[tauri::command(rename = "review:unstage-hunk")]
#[specta::specta]
pub async fn review_unstage_hunk(
    state: State<'_, AppState>,
    input: ReviewIndexHunkInput,
) -> ArgmaxResult<()> {
    review_update_hunk_index_impl(&state, input, false).await
}

pub(crate) async fn review_update_hunk_index_impl(
    state: &AppState,
    input: ReviewIndexHunkInput,
    stage: bool,
) -> ArgmaxResult<()> {
    let database = live_database(state)?;
    git_review::update_hunk_index(
        database.as_ref(),
        input.kind,
        &input.id,
        &input.file_path,
        &input.revision,
        input.hunk_index as usize,
        input.context_lines.map(|value| value.get()),
        stage,
    )
    .await
}

#[tauri::command(rename = "review:commit-staged")]
#[specta::specta]
pub async fn review_commit_staged(
    state: State<'_, AppState>,
    input: ReviewCommitStagedInput,
) -> ArgmaxResult<GitCommitResult> {
    review_commit_staged_impl(&state, input).await
}

pub(crate) async fn review_commit_staged_impl(
    state: &AppState,
    input: ReviewCommitStagedInput,
) -> ArgmaxResult<GitCommitResult> {
    let service = GitOpsService::new(live_database(state)?);
    service
        .commit_staged(GitCommitInput {
            workspace_id: input.workspace_id,
            message: input.message,
            selected_files: Vec::new(),
        })
        .await
}

#[tauri::command(rename = "review:revert-file")]
#[specta::specta]
pub async fn review_revert_file(
    state: State<'_, AppState>,
    input: ReviewIndexFileInput,
) -> ArgmaxResult<()> {
    review_revert_file_impl(&state, input).await
}

pub(crate) async fn review_revert_file_impl(
    state: &AppState,
    input: ReviewIndexFileInput,
) -> ArgmaxResult<()> {
    if input.kind != WorkspaceTargetKind::Workspace {
        return Err(crate::error::ArgmaxError::service(
            "REVIEW_REVERT_PROJECT_UNSUPPORTED",
            "Reverting from a project review is unavailable because it has no workspace checkpoint.",
        ));
    }
    let database = live_database(state)?;
    // Capture before acquiring the review lock. The subsequent revision check
    // rejects a concurrent edit, so the checkpoint can never justify reverting
    // data that was not on the screen the user acted on.
    CheckpointService::new(database.clone())
        .create_recovery_checkpoint(
            input.id.clone(),
            None,
            format!("Before reverting {}", input.file_path),
        )
        .await?;
    git_review::revert_unstaged_file(
        database.as_ref(),
        &input.id,
        &input.file_path,
        &input.revision,
    )
    .await
}

#[tauri::command(rename = "review:revert-hunk")]
#[specta::specta]
pub async fn review_revert_hunk(
    state: State<'_, AppState>,
    input: ReviewIndexHunkInput,
) -> ArgmaxResult<()> {
    review_revert_hunk_impl(&state, input).await
}

pub(crate) async fn review_revert_hunk_impl(
    state: &AppState,
    input: ReviewIndexHunkInput,
) -> ArgmaxResult<()> {
    if input.kind != WorkspaceTargetKind::Workspace {
        return Err(crate::error::ArgmaxError::service(
            "REVIEW_REVERT_PROJECT_UNSUPPORTED",
            "Reverting from a project review is unavailable because it has no workspace checkpoint.",
        ));
    }
    let database = live_database(state)?;
    CheckpointService::new(database.clone())
        .create_recovery_checkpoint(
            input.id.clone(),
            None,
            format!("Before reverting a hunk in {}", input.file_path),
        )
        .await?;
    git_review::revert_unstaged_hunk(
        database.as_ref(),
        &input.id,
        &input.file_path,
        &input.revision,
        input.hunk_index as usize,
        input.context_lines.map(|value| value.get()),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        git::exec::{run_git_text, GIT_DEFAULT_TIMEOUT},
        persistence::projects::{persist_project, PersistProjectInput, ProjectSettings},
        persistence::Database,
        review::git_review::ReviewComparison,
        workspaces::WorkspaceTargetKind,
    };
    use std::{path::Path, sync::Arc};
    use tempfile::tempdir;

    #[tokio::test]
    async fn project_changed_files_command_reads_project_repo() {
        let repo = tempdir().expect("repo dir");
        init_repo(repo.path()).await;
        std::fs::write(repo.path().join("README.md"), "hello\nchanged\n").expect("write change");

        let state = state_with_project(repo.path());
        let database = live_database(&state).expect("live database");
        let files = git_review::list_changed_files(
            database.as_ref(),
            WorkspaceTargetKind::Project,
            "p1",
            ReviewComparison::default(),
        )
        .await
        .expect("changed files");

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "README.md");
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].additions, 1);
    }

    #[tokio::test]
    async fn branch_comparison_includes_committed_uncommitted_and_untracked() {
        // main has README.md + app.txt committed. A feature branch commits a
        // README change, leaves app.txt edited but uncommitted, and adds an
        // untracked notes.txt.
        let repo = tempdir().expect("repo dir");
        init_repo(repo.path()).await;
        std::fs::write(repo.path().join("app.txt"), "v1\n").expect("write app");
        run_git(repo.path(), &["add", "app.txt"]).await;
        run_git(repo.path(), &["commit", "-q", "-m", "add app"]).await;

        run_git(repo.path(), &["checkout", "-q", "-b", "feature"]).await;
        std::fs::write(repo.path().join("README.md"), "hello\nfrom feature\n")
            .expect("edit readme");
        run_git(repo.path(), &["commit", "-q", "-am", "feature readme"]).await;
        std::fs::write(repo.path().join("app.txt"), "v1\nv2\n").expect("edit app");
        std::fs::write(repo.path().join("notes.txt"), "scratch\n").expect("write notes");

        let state = state_with_project(repo.path());
        let database = live_database(&state).expect("live database");
        let working_tree = git_review::list_changed_files(
            database.as_ref(),
            WorkspaceTargetKind::Project,
            "p1",
            ReviewComparison::WorkingTree,
        )
        .await
        .expect("working-tree files");
        // Working tree vs HEAD: only the uncommitted edit + untracked file. The
        // committed README change is clean in the working tree, so it's absent.
        let working_paths: Vec<_> = working_tree.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(working_paths, vec!["app.txt", "notes.txt"]);

        let branch = git_review::list_changed_files(
            database.as_ref(),
            WorkspaceTargetKind::Project,
            "p1",
            ReviewComparison::Branch,
        )
        .await
        .expect("branch files");
        // Everything different from main: committed README + uncommitted app +
        // untracked notes.
        let mut branch_paths: Vec<_> = branch.iter().map(|file| file.path.as_str()).collect();
        branch_paths.sort_unstable();
        assert_eq!(branch_paths, vec!["README.md", "app.txt", "notes.txt"]);

        let committed = git_review::list_changed_files(
            database.as_ref(),
            WorkspaceTargetKind::Project,
            "p1",
            ReviewComparison::Committed,
        )
        .await
        .expect("committed files");
        // Commits only: the README change landed, the app edit and the
        // untracked scratch file did not.
        let committed_paths: Vec<_> = committed.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(committed_paths, vec!["README.md"]);

        // A file that is BOTH committed on the branch and dirty in the working
        // tree must diff against HEAD, not against its working-tree state.
        std::fs::write(
            repo.path().join("README.md"),
            "hello\nfrom feature\nand more\n",
        )
        .expect("dirty readme");
        let committed_diff = git_review::load_diff(
            database.as_ref(),
            WorkspaceTargetKind::Project,
            "p1",
            Some("README.md"),
            ReviewComparison::Committed,
            None,
        )
        .await
        .expect("committed diff");
        assert!(committed_diff.content.contains("+from feature"));
        assert!(
            !committed_diff.content.contains("+and more"),
            "committed diff leaked the uncommitted edit: {}",
            committed_diff.content
        );
    }

    fn state_with_project(repo_path: &Path) -> AppState {
        let state = AppState::new();
        let database = Arc::new(Database::open_in_memory().expect("open database"));
        {
            let connection = database.connection();
            persist_project(
                &connection,
                &PersistProjectInput {
                    id: "p1".to_string(),
                    name: "fixture".to_string(),
                    repo_path: repo_path.to_string_lossy().into_owned(),
                    current_branch: "main".to_string(),
                    default_branch: Some("main".to_string()),
                    settings: ProjectSettings {
                        archive_on_merge: false,
                        worktree_location: repo_path
                            .join(".argmax")
                            .join("worktrees")
                            .to_string_lossy()
                            .into_owned(),
                        setup_command: String::new(),
                        check_commands: Vec::new(),
                    },
                },
            )
            .expect("persist project");
        }
        assert!(state.db.set(database).is_ok());
        state
    }

    async fn init_repo(repo_path: &Path) {
        run_git(repo_path, &["init", "-q", "-b", "main"]).await;
        run_git(repo_path, &["config", "user.email", "test@argmax.dev"]).await;
        run_git(repo_path, &["config", "user.name", "Argmax Test"]).await;
        std::fs::write(repo_path.join("README.md"), "hello\n").expect("write readme");
        run_git(repo_path, &["add", "README.md"]).await;
        run_git(repo_path, &["commit", "-q", "-m", "init"]).await;
    }

    async fn run_git(repo_path: &Path, args: &[&str]) {
        run_git_text(repo_path, args, GIT_DEFAULT_TIMEOUT)
            .await
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"));
    }
}
