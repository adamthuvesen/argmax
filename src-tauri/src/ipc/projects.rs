use std::path::{Path, PathBuf};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use uuid::Uuid;

use super::inputs::*;
use super::live_database;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::exec::{run_git_text, GIT_DEFAULT_TIMEOUT};
use crate::persistence::projects::{
    delete_project, list_projects, persist_project, require_project, update_project_branch,
    update_project_settings, PersistProjectInput, ProjectSettings, ProjectSummary,
};
use crate::state::AppState;

#[tauri::command(rename = "projects:list")]
#[specta::specta]
pub fn projects_list(
    state: State<'_, AppState>,
    _input: ProjectsListInput,
) -> ArgmaxResult<Vec<ProjectSummary>> {
    let database = live_database(&state)?;
    let connection = database.connection();
    list_projects(&connection)
}

#[tauri::command(rename = "projects:pick-folder")]
#[specta::specta]
pub async fn projects_pick_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    _input: ProjectsPickFolderInput,
) -> ArgmaxResult<ProjectFolderPickResult> {
    let Some(path) = pick_project_folder(app).await? else {
        return Ok(ProjectFolderPickResult::Cancelled { cancelled: true });
    };

    let project = register_project_path(&state, path).await?;
    Ok(ProjectFolderPickResult::Picked {
        cancelled: false,
        project: Box::new(project),
    })
}

#[tauri::command(rename = "projects:register")]
#[specta::specta]
pub async fn projects_register(
    state: State<'_, AppState>,
    input: ProjectsRegisterInput,
) -> ArgmaxResult<ProjectSummary> {
    register_project_path(&state, input.repo_path.into_string().into()).await
}

#[tauri::command(rename = "projects:remove")]
#[specta::specta]
pub fn projects_remove(state: State<'_, AppState>, input: ProjectsRemoveInput) -> ArgmaxResult<()> {
    let database = live_database(&state)?;
    let connection = database.connection();
    delete_project(&connection, input.project_id.as_str())
}

#[tauri::command(rename = "projects:update-settings")]
#[specta::specta]
pub fn projects_update_settings(
    state: State<'_, AppState>,
    input: ProjectsUpdateSettingsInput,
) -> ArgmaxResult<ProjectSummary> {
    let database = live_database(&state)?;
    let connection = database.connection();
    let settings = ProjectSettings {
        default_provider: input.settings.default_provider.as_str().to_owned(),
        default_model_label: input.settings.default_model_label.as_str().to_owned(),
        worktree_location: input.settings.worktree_location.as_str().to_owned(),
        setup_command: input.settings.setup_command,
        check_commands: input.settings.check_commands,
    };
    update_project_settings(&connection, input.project_id.as_str(), &settings)
}

#[tauri::command(rename = "projects:list-branches")]
#[specta::specta]
pub async fn projects_list_branches(
    state: State<'_, AppState>,
    input: ProjectsListBranchesInput,
) -> ArgmaxResult<Vec<String>> {
    let (repo_path, default_branch) = {
        let database = live_database(&state)?;
        let connection = database.connection();
        let project = require_project(&connection, input.project_id.as_str())?;
        (project.repo_path, project.default_branch)
    };
    let raw = run_git_text(&repo_path, ["branch"], GIT_DEFAULT_TIMEOUT).await?;
    let branches = raw
        .lines()
        .map(|line| line.trim_start_matches('*').trim().to_owned())
        .filter(|name| !name.is_empty());
    Ok(order_branches_default_first(
        branches,
        default_branch.as_deref(),
    ))
}

/// Surface the default branch (typically main/master) at the top of the picker;
/// git lists alphabetically, which buries it. Other branches keep git's order.
fn order_branches_default_first(
    branches: impl IntoIterator<Item = String>,
    default_branch: Option<&str>,
) -> Vec<String> {
    let mut branches: Vec<String> = branches.into_iter().collect();
    if let Some(default_branch) = default_branch {
        if let Some(index) = branches.iter().position(|name| name == default_branch) {
            let default_branch = branches.remove(index);
            branches.insert(0, default_branch);
        }
    }
    branches
}

#[tauri::command(rename = "projects:refresh-branch")]
#[specta::specta]
pub async fn projects_refresh_branch(
    state: State<'_, AppState>,
    input: ProjectsRefreshBranchInput,
) -> ArgmaxResult<ProjectSummary> {
    let repo_path = {
        let database = live_database(&state)?;
        let connection = database.connection();
        require_project(&connection, input.project_id.as_str())?.repo_path
    };
    // Re-read the repo's live HEAD so the launcher defaults to whatever branch
    // the user has checked out (in a terminal or elsewhere), not the branch we
    // recorded at add time. Detached HEAD persists as "HEAD".
    let current_branch = run_git_text(
        &repo_path,
        ["branch", "--show-current"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await?
    .trim()
    .to_string();
    let current_branch = if current_branch.is_empty() {
        "HEAD".to_string()
    } else {
        current_branch
    };
    let database = live_database(&state)?;
    let connection = database.connection();
    update_project_branch(&connection, input.project_id.as_str(), &current_branch)
}

#[tauri::command(rename = "projects:switch-branch")]
#[specta::specta]
pub async fn projects_switch_branch(
    state: State<'_, AppState>,
    input: ProjectsSwitchBranchInput,
) -> ArgmaxResult<ProjectSummary> {
    let repo_path = {
        let database = live_database(&state)?;
        let connection = database.connection();
        require_project(&connection, input.project_id.as_str())?.repo_path
    };
    // `--` separator is defense-in-depth on top of the BranchName newtype's
    // leading-dash rejection.
    run_git_text(
        &repo_path,
        ["checkout", input.branch.as_str(), "--"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await?;
    let database = live_database(&state)?;
    let connection = database.connection();
    update_project_branch(
        &connection,
        input.project_id.as_str(),
        input.branch.as_str(),
    )
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase", untagged)]
pub enum ProjectFolderPickResult {
    Cancelled {
        cancelled: bool,
    },
    Picked {
        cancelled: bool,
        project: Box<ProjectSummary>,
    },
}

struct GitMetadata {
    repo_path: PathBuf,
    current_branch: String,
    default_branch: Option<String>,
}

async fn pick_project_folder(app: AppHandle) -> ArgmaxResult<Option<PathBuf>> {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Add Project")
        .pick_folder(move |folder| {
            let _ = sender.send(folder);
        });

    let folder = receiver
        .await
        .map_err(|error| ArgmaxError::service("DIALOG_CLOSED", error.to_string()))?;
    folder
        .map(|path| {
            path.into_path()
                .map_err(|error| ArgmaxError::service("DIALOG_PATH", error.to_string()))
        })
        .transpose()
}

async fn register_project_path(
    state: &AppState,
    candidate_path: PathBuf,
) -> ArgmaxResult<ProjectSummary> {
    let canonical_path = canonicalize_repo_path(&candidate_path).await?;
    let metadata = read_git_metadata(&canonical_path).await?;
    if let Some(default_branch) = metadata.default_branch.as_deref() {
        assert_valid_ref_name(&metadata.repo_path, default_branch).await?;
    }

    let project = PersistProjectInput {
        id: Uuid::new_v4().to_string(),
        name: metadata
            .repo_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project")
            .to_string(),
        repo_path: metadata.repo_path.to_string_lossy().to_string(),
        current_branch: metadata.current_branch,
        default_branch: metadata.default_branch,
        settings: default_settings(&metadata.repo_path),
    };

    let database = live_database(state)?;
    let connection = database.connection();
    persist_project(&connection, &project)
}

async fn canonicalize_repo_path(candidate_path: &Path) -> ArgmaxResult<PathBuf> {
    let resolved = tokio::fs::canonicalize(candidate_path)
        .await
        .map_err(|error| {
            ArgmaxError::service(
                "PROJECT_PATH",
                format!(
                    "Argmax could not resolve {}. {error}",
                    candidate_path.display()
                ),
            )
        })?;
    let metadata = tokio::fs::metadata(&resolved).await.map_err(|error| {
        ArgmaxError::service(
            "PROJECT_PATH",
            format!("Argmax could not stat {}. {error}", resolved.display()),
        )
    })?;
    if !metadata.is_dir() {
        return Err(ArgmaxError::service(
            "PROJECT_PATH",
            format!("{} is not a directory.", resolved.display()),
        ));
    }
    if tokio::fs::metadata(resolved.join(".git")).await.is_err() {
        return Err(ArgmaxError::service(
            "PROJECT_NOT_GIT",
            format!(
                "{} is not a git repository (.git missing).",
                resolved.display()
            ),
        ));
    }
    Ok(resolved)
}

async fn read_git_metadata(candidate_path: &Path) -> ArgmaxResult<GitMetadata> {
    let root = run_git_text(
        candidate_path,
        ["rev-parse", "--show-toplevel"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    .map_err(project_git_error)?;
    let repo_path = PathBuf::from(root.trim());
    let current_branch = run_git_text(
        &repo_path,
        ["branch", "--show-current"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    .map_err(project_git_error)?
    .trim()
    .to_string();
    let current_branch = if current_branch.is_empty() {
        "HEAD".to_string()
    } else {
        current_branch
    };
    let default_branch = discover_default_branch(&repo_path, &current_branch).await?;

    Ok(GitMetadata {
        repo_path,
        current_branch,
        default_branch,
    })
}

async fn discover_default_branch(
    repo_path: &Path,
    current_branch: &str,
) -> ArgmaxResult<Option<String>> {
    if let Ok(origin_head) = run_git_text(
        repo_path,
        [
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    {
        let branch = origin_head
            .trim()
            .strip_prefix("origin/")
            .unwrap_or(origin_head.trim());
        if !branch.is_empty() {
            return Ok(Some(branch.to_string()));
        }
    }

    for branch in ["main", "master", "trunk"] {
        if run_git_text(
            repo_path,
            [
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
            GIT_DEFAULT_TIMEOUT,
        )
        .await
        .is_ok()
        {
            return Ok(Some(branch.to_string()));
        }
    }

    Ok((current_branch != "HEAD").then(|| current_branch.to_string()))
}

async fn assert_valid_ref_name(repo_path: &Path, reference: &str) -> ArgmaxResult<()> {
    run_git_text(
        repo_path,
        ["check-ref-format", "--allow-onelevel", reference],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    .map(|_| ())
    .map_err(|_| {
        ArgmaxError::service(
            "GIT_REF_INVALID",
            format!("Invalid git ref name: {reference}"),
        )
    })
}

fn default_settings(repo_path: &Path) -> ProjectSettings {
    ProjectSettings {
        default_provider: "codex".to_string(),
        default_model_label: "GPT-5.5".to_string(),
        worktree_location: repo_path
            .join(".argmax")
            .join("worktrees")
            .to_string_lossy()
            .to_string(),
        setup_command: String::new(),
        check_commands: Vec::new(),
    }
}

fn project_git_error(error: ArgmaxError) -> ArgmaxError {
    ArgmaxError::service(
        "PROJECT_GIT",
        format!("Argmax requires a local git repository. {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::order_branches_default_first;

    fn owned(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn default_branch_moves_to_front_preserving_rest() {
        let ordered =
            order_branches_default_first(owned(&["adam/feature", "main", "zeta"]), Some("main"));
        assert_eq!(ordered, owned(&["main", "adam/feature", "zeta"]));
    }

    #[test]
    fn unknown_or_absent_default_leaves_order_untouched() {
        let input = owned(&["adam/feature", "zeta"]);
        assert_eq!(
            order_branches_default_first(input.clone(), Some("main")),
            input,
        );
        assert_eq!(order_branches_default_first(input.clone(), None), input);
    }
}
