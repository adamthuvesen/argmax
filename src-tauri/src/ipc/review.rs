use super::inputs::*;
use super::live_database;
use crate::{
    error::ArgmaxResult,
    review::git_review::{self, ChangedFileSummary, WorkspaceDiff},
    state::AppState,
};
use tauri::State;

#[tauri::command(rename = "review:list-changed-files")]
#[specta::specta]
pub async fn review_list_changed_files(
    state: State<'_, AppState>,
    input: ReviewListChangedFilesInput,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    list_changed_files_for_workspace(&state, input).await
}

#[tauri::command(rename = "review:load-diff")]
#[specta::specta]
pub async fn review_load_diff(
    state: State<'_, AppState>,
    input: ReviewLoadDiffInput,
) -> ArgmaxResult<WorkspaceDiff> {
    load_diff_for_workspace(&state, input).await
}

#[tauri::command(rename = "review:list-changed-files-for-project")]
#[specta::specta]
pub async fn review_list_changed_files_for_project(
    state: State<'_, AppState>,
    input: ReviewListChangedFilesForProjectInput,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    list_changed_files_for_project(&state, input).await
}

#[tauri::command(rename = "review:load-diff-for-project")]
#[specta::specta]
pub async fn review_load_diff_for_project(
    state: State<'_, AppState>,
    input: ReviewLoadDiffForProjectInput,
) -> ArgmaxResult<WorkspaceDiff> {
    load_diff_for_project(&state, input).await
}

async fn list_changed_files_for_workspace(
    state: &AppState,
    input: ReviewListChangedFilesInput,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let database = live_database(state)?;
    git_review::list_changed_files(
        database.as_ref(),
        input.workspace_id.as_str(),
        input.comparison,
    )
    .await
}

async fn load_diff_for_workspace(
    state: &AppState,
    input: ReviewLoadDiffInput,
) -> ArgmaxResult<WorkspaceDiff> {
    let database = live_database(state)?;
    git_review::load_diff(
        database.as_ref(),
        input.workspace_id.as_str(),
        input.file_path.as_ref().map(|path| path.as_str()),
        input.comparison,
    )
    .await
}

async fn list_changed_files_for_project(
    state: &AppState,
    input: ReviewListChangedFilesForProjectInput,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let database = live_database(state)?;
    git_review::list_changed_files_for_project(
        database.as_ref(),
        input.project_id.as_str(),
        input.comparison,
    )
    .await
}

async fn load_diff_for_project(
    state: &AppState,
    input: ReviewLoadDiffForProjectInput,
) -> ArgmaxResult<WorkspaceDiff> {
    let database = live_database(state)?;
    git_review::load_diff_for_project(
        database.as_ref(),
        input.project_id.as_str(),
        input.file_path.as_ref().map(|path| path.as_str()),
        input.comparison,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ipc::validation::ProjectId,
        persistence::projects::{persist_project, PersistProjectInput, ProjectSettings},
        persistence::Database,
        review::git_review::ReviewComparison,
    };
    use std::{path::Path, process::Command, sync::Arc};
    use tempfile::tempdir;

    #[tokio::test]
    async fn project_changed_files_command_reads_project_repo() {
        let repo = tempdir().expect("repo dir");
        init_repo(repo.path());
        std::fs::write(repo.path().join("README.md"), "hello\nchanged\n").expect("write change");

        let state = state_with_project(repo.path());
        let files = list_changed_files_for_project(
            &state,
            ReviewListChangedFilesForProjectInput {
                project_id: ProjectId::try_from("p1".to_string()).expect("project id"),
                comparison: ReviewComparison::default(),
            },
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
        init_repo(repo.path());
        std::fs::write(repo.path().join("app.txt"), "v1\n").expect("write app");
        run_git(repo.path(), &["add", "app.txt"]);
        run_git(repo.path(), &["commit", "-q", "-m", "add app"]);

        run_git(repo.path(), &["checkout", "-q", "-b", "feature"]);
        std::fs::write(repo.path().join("README.md"), "hello\nfrom feature\n").expect("edit readme");
        run_git(repo.path(), &["commit", "-q", "-am", "feature readme"]);
        std::fs::write(repo.path().join("app.txt"), "v1\nv2\n").expect("edit app");
        std::fs::write(repo.path().join("notes.txt"), "scratch\n").expect("write notes");

        let state = state_with_project(repo.path());
        let project_id = || ProjectId::try_from("p1".to_string()).expect("project id");

        let working_tree = list_changed_files_for_project(
            &state,
            ReviewListChangedFilesForProjectInput {
                project_id: project_id(),
                comparison: ReviewComparison::WorkingTree,
            },
        )
        .await
        .expect("working-tree files");
        // Working tree vs HEAD: only the uncommitted edit + untracked file. The
        // committed README change is clean in the working tree, so it's absent.
        let working_paths: Vec<_> = working_tree.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(working_paths, vec!["app.txt", "notes.txt"]);

        let branch = list_changed_files_for_project(
            &state,
            ReviewListChangedFilesForProjectInput {
                project_id: project_id(),
                comparison: ReviewComparison::Branch,
            },
        )
        .await
        .expect("branch files");
        // Everything different from main: committed README + uncommitted app +
        // untracked notes.
        let mut branch_paths: Vec<_> = branch.iter().map(|file| file.path.as_str()).collect();
        branch_paths.sort_unstable();
        assert_eq!(branch_paths, vec!["README.md", "app.txt", "notes.txt"]);
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
                        default_provider: "codex".to_string(),
                        default_model_label: "Codex Spark".to_string(),
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

    fn init_repo(repo_path: &Path) {
        run_git(repo_path, &["init", "-q", "-b", "main"]);
        run_git(repo_path, &["config", "user.email", "test@argmax.dev"]);
        run_git(repo_path, &["config", "user.name", "Argmax Test"]);
        std::fs::write(repo_path.join("README.md"), "hello\n").expect("write readme");
        run_git(repo_path, &["add", "README.md"]);
        run_git(repo_path, &["commit", "-q", "-m", "init"]);
    }

    fn run_git(repo_path: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .args(args)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }
}
