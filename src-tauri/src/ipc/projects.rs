use std::path::{Path, PathBuf};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use uuid::Uuid;

use super::inputs::*;
use super::{live_database, read_off_main};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::exec::{run_git_text, GIT_DEFAULT_TIMEOUT};
use crate::persistence::database::Database;
use crate::persistence::projects::{
    delete_project, list_projects, parse_github_remote, persist_project, require_project,
    update_project_settings, PersistProjectInput, ProjectRemote, ProjectSettings, ProjectSummary,
};
use crate::routing::project_check::ProjectCheck;
use crate::state::AppState;

#[tauri::command(rename = "projects:list")]
#[specta::specta]
pub async fn projects_list(
    state: State<'_, AppState>,
    _input: ProjectsListInput,
) -> ArgmaxResult<Vec<ProjectSummary>> {
    projects_list_impl(&state).await
}

pub(crate) async fn projects_list_impl(state: &AppState) -> ArgmaxResult<Vec<ProjectSummary>> {
    let database = live_database(state)?;
    read_off_main(move || list_projects(&database.read_connection())).await
}

/// Project check: whether the prompt reads like work for another project.
/// Never fails for want of an answer — no key, a Jev error or a short prompt
/// all come back as `none` (docs/routing.md#project-check).
#[tauri::command(rename = "projects:check-prompt")]
#[specta::specta]
pub async fn projects_check_prompt(
    state: State<'_, AppState>,
    input: ProjectsCheckPromptInput,
) -> ArgmaxResult<ProjectCheck> {
    projects_check_prompt_impl(&state, input).await
}

pub(crate) async fn projects_check_prompt_impl(
    state: &AppState,
    input: ProjectsCheckPromptInput,
) -> ArgmaxResult<ProjectCheck> {
    let database = live_database(state)?;
    crate::routing::project_check::check_prompt(
        database,
        state.app_data_dir.get().cloned(),
        input.project_id.into_string(),
        input.prompt.into_string(),
        input.picked_by_hand,
    )
    .await
}

/// Records what the user did with a check's suggestion or switch.
#[tauri::command(rename = "projects:resolve-check")]
#[specta::specta]
pub async fn projects_resolve_check(
    state: State<'_, AppState>,
    input: ProjectsResolveCheckInput,
) -> ArgmaxResult<()> {
    projects_resolve_check_impl(&state, input).await
}

pub(crate) async fn projects_resolve_check_impl(
    state: &AppState,
    input: ProjectsResolveCheckInput,
) -> ArgmaxResult<()> {
    let database = live_database(state)?;
    read_off_main(move || {
        crate::routing::project_check::resolve_check(
            &database,
            input.check_id.as_str(),
            input.outcome,
            input.session_id.as_ref().map(|id| id.as_str()),
        )
    })
    .await
}

#[tauri::command(rename = "projects:pick-folder")]
#[specta::specta]
pub async fn projects_pick_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    _input: ProjectsPickFolderInput,
) -> ArgmaxResult<ProjectFolderPickResult> {
    let Some(path) = pick_project_folder(app, "Add Project").await? else {
        return Ok(ProjectFolderPickResult::Cancelled { cancelled: true });
    };

    let project = register_project_path(&state, path).await?;
    Ok(ProjectFolderPickResult::Picked {
        cancelled: false,
        project: Box::new(project),
    })
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryPickResult {
    pub cancelled: bool,
    pub path: Option<String>,
}

#[tauri::command(rename = "projects:pick-directory")]
#[specta::specta]
pub async fn projects_pick_directory(
    app: AppHandle,
    _input: ProjectsPickFolderInput,
) -> ArgmaxResult<ProjectDirectoryPickResult> {
    let path = pick_project_folder(app, "Add project folder").await?;
    Ok(ProjectDirectoryPickResult {
        cancelled: path.is_none(),
        path: path.map(|path| path.to_string_lossy().into_owned()),
    })
}

#[tauri::command(rename = "projects:create")]
#[specta::specta]
pub async fn projects_create(
    state: State<'_, AppState>,
    input: ProjectsCreateInput,
) -> ArgmaxResult<ProjectSummary> {
    projects_create_impl(&state, input).await
}

#[tauri::command(rename = "projects:configure")]
#[specta::specta]
pub async fn projects_configure(
    state: State<'_, AppState>,
    input: ProjectsConfigureInput,
) -> ArgmaxResult<ProjectSummary> {
    projects_configure_impl(&state, input).await
}

#[tauri::command(rename = "projects:get-folders")]
#[specta::specta]
pub async fn projects_get_folders(
    state: State<'_, AppState>,
    input: ProjectsGetFoldersInput,
) -> ArgmaxResult<Vec<crate::persistence::project_folders::ProjectFolderSummary>> {
    projects_get_folders_impl(&state, input).await
}

pub(crate) async fn projects_get_folders_impl(
    state: &AppState,
    input: ProjectsGetFoldersInput,
) -> ArgmaxResult<Vec<crate::persistence::project_folders::ProjectFolderSummary>> {
    let database = live_database(state)?;
    read_off_main(move || {
        crate::persistence::project_folders::list_project_folders(
            &database.read_connection(),
            input.project_id.as_str(),
        )
    })
    .await
}

pub(crate) async fn projects_create_impl(
    state: &AppState,
    input: ProjectsCreateInput,
) -> ArgmaxResult<ProjectSummary> {
    let database = live_database(state)?;
    let project_id = Uuid::new_v4().to_string();
    let (folders, primary) =
        validate_project_folders(&database, &project_id, &input.folders, &input.primary_path)
            .await?;
    let primary_folder = folders
        .iter()
        .find(|folder| folder.root_path == primary)
        .expect("validated primary");
    let project = PersistProjectInput {
        id: project_id.clone(),
        name: input.name.as_str().trim().to_owned(),
        repo_path: primary.clone(),
        current_branch: primary_folder.current_branch.clone(),
        default_branch: primary_folder.default_branch.clone(),
        settings: primary_folder.settings.clone(),
    };
    let connection = database.connection();
    let transaction = connection
        .unchecked_transaction()
        .map_err(crate::persistence::sqlite_error)?;
    persist_project(&transaction, &project)?;
    crate::persistence::project_folders::configure_project_folders_in_transaction(
        &transaction,
        &project_id,
        input.name.as_str(),
        &folders,
        &primary,
    )?;
    let generation =
        crate::persistence::project_overviews::begin_generation(&transaction, &project_id, true)?;
    let result = require_project(&transaction, &project_id)?;
    transaction
        .commit()
        .map_err(crate::persistence::sqlite_error)?;
    drop(connection);
    if let Some(generation) = generation {
        super::project_overviews::spawn_generation(state, database, project_id, generation);
    }
    super::publish_dashboard_changed(state);
    Ok(result)
}

pub(crate) async fn projects_configure_impl(
    state: &AppState,
    input: ProjectsConfigureInput,
) -> ArgmaxResult<ProjectSummary> {
    let database = live_database(state)?;
    let (folders, primary) = validate_project_folders(
        &database,
        input.project_id.as_str(),
        &input.folders,
        &input.primary_path,
    )
    .await?;
    let connection = database.connection();
    crate::persistence::project_folders::configure_project_folders(
        &connection,
        input.project_id.as_str(),
        input.name.as_str(),
        &folders,
        &primary,
    )
}

async fn validate_project_folders(
    database: &Database,
    project_id: &str,
    paths: &[String],
    primary_path: &str,
) -> ArgmaxResult<(
    Vec<crate::persistence::project_folders::PersistProjectFolderInput>,
    String,
)> {
    use crate::persistence::project_folders::{
        list_project_folders, project_for_folder, PersistProjectFolderInput,
    };
    let existing = {
        let connection = database.read_connection();
        if crate::persistence::projects::find_project_by_id(&connection, project_id)?.is_some() {
            list_project_folders(&connection, project_id)?
        } else {
            Vec::new()
        }
    };
    if paths.is_empty() {
        return Err(ArgmaxError::service(
            "PROJECT_FOLDERS_REQUIRED",
            "Add at least one project folder.",
        ));
    }
    let mut folders: Vec<PersistProjectFolderInput> = Vec::new();
    let mut primary = None;
    for path in paths {
        let previous = existing.iter().find(|folder| folder.root_path == *path);
        let root = if previous.is_some() && path != primary_path {
            PathBuf::from(path)
        } else {
            crate::persistence::linked_repos::canonical_folder_root(path)?
        };
        let root_text = root.to_string_lossy().into_owned();
        if folders.iter().any(|folder| folder.root_path == root_text) {
            return Err(ArgmaxError::service(
                "PROJECT_FOLDER_DUPLICATE",
                "A project cannot include the same folder twice.",
            ));
        }
        if folders.iter().any(|folder| {
            Path::new(&folder.root_path).starts_with(&root) || root.starts_with(&folder.root_path)
        }) {
            return Err(ArgmaxError::service(
                "PROJECT_FOLDER_OVERLAP",
                "Project folders cannot contain one another.",
            ));
        }
        let mut settings = previous
            .map(|folder| {
                project_for_folder(&database.read_connection(), &folder.id)
                    .map(|project| project.settings)
            })
            .transpose()?
            .unwrap_or(default_settings(&Uuid::new_v4().to_string())?);
        if previous.is_none() {
            settings.worktree_location = crate::util::data_dir::worktree_root()?
                .join(project_id)
                .join(Uuid::new_v4().to_string())
                .to_string_lossy()
                .into_owned();
        }
        let is_primary = path == primary_path;
        let metadata = if is_primary || root.join(".git").exists() {
            Some(read_git_metadata(&canonicalize_repo_path(&root).await?).await?)
        } else {
            None
        };
        if is_primary {
            primary = Some(root_text.clone());
        }
        let prior_project = previous
            .map(|folder| project_for_folder(&database.read_connection(), &folder.id))
            .transpose()?;
        let prior_remote = previous.map(|folder| {
            let connection = database.read_connection();
            connection.query_row("SELECT repo_remote_owner, repo_remote_name FROM project_folders WHERE id = ?", [&folder.id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?))).map_err(crate::persistence::sqlite_error)
        }).transpose()?.and_then(|(owner, name)| owner.zip(name).map(|(owner, name)| ProjectRemote { owner, name }));
        folders.push(PersistProjectFolderInput {
            root_path: root_text,
            current_branch: metadata
                .as_ref()
                .map(|metadata| metadata.current_branch.clone())
                .or_else(|| {
                    prior_project
                        .as_ref()
                        .map(|project| project.current_branch.clone())
                })
                .unwrap_or_else(|| "HEAD".to_owned()),
            default_branch: metadata
                .as_ref()
                .and_then(|metadata| metadata.default_branch.clone())
                .or_else(|| {
                    prior_project
                        .as_ref()
                        .and_then(|project| project.default_branch.clone())
                }),
            remote: metadata
                .and_then(|metadata| metadata.remote)
                .or(prior_remote),
            settings,
        });
    }
    let primary = primary.ok_or_else(|| {
        ArgmaxError::service(
            "PROJECT_PRIMARY_REQUIRED",
            "Select a primary folder from the project folders.",
        )
    })?;
    Ok((folders, primary))
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
pub async fn projects_remove(
    state: State<'_, AppState>,
    input: ProjectsRemoveInput,
) -> ArgmaxResult<()> {
    projects_remove_impl(&state, input).await
}

pub(crate) async fn projects_remove_impl(
    state: &AppState,
    input: ProjectsRemoveInput,
) -> ArgmaxResult<()> {
    // `workspaces.project_id` cascades on project delete: removing the hidden
    // scratch project would silently take every side chat with it.
    if input.project_id.as_str() == crate::workspaces::SCRATCH_PROJECT_ID {
        return Err(ArgmaxError::service(
            "PROJECT_NOT_REMOVABLE",
            "The side-chats project is app-managed and cannot be removed.",
        ));
    }
    // Resolve the database before tearing anything down: an unopened database
    // would otherwise leave the project row standing with every agent, check,
    // terminal and watcher under it already destroyed.
    let database = live_database(state)?;
    // The same cascade takes sessions, checks and approvals with it, and every
    // subsystem looks its victims up by those rows — so stop the project's
    // agents, checks, terminals and watchers before the delete, not after.
    if let Some(workspaces) = state.workspaces.get() {
        workspaces.teardown_project(input.project_id.as_str()).await;
    }
    let connection = database.connection();
    delete_project(&connection, input.project_id.as_str())
}

#[tauri::command(rename = "projects:update-settings")]
#[specta::specta]
pub fn projects_update_settings(
    state: State<'_, AppState>,
    input: ProjectsUpdateSettingsInput,
) -> ArgmaxResult<ProjectSummary> {
    projects_update_settings_impl(&state, input)
}

pub(crate) fn projects_update_settings_impl(
    state: &AppState,
    input: ProjectsUpdateSettingsInput,
) -> ArgmaxResult<ProjectSummary> {
    let database = live_database(state)?;
    let connection = database.connection();
    let settings = ProjectSettings {
        worktree_location: input.settings.worktree_location.as_str().to_owned(),
        setup_command: input.settings.setup_command,
        check_commands: input.settings.check_commands,
        merge_cleanup: input.settings.merge_cleanup,
    };
    update_project_settings(&connection, input.project_id.as_str(), &settings)
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolderContext {
    pub project: ProjectSummary,
    pub is_git: bool,
    pub folder_id: String,
}

#[tauri::command(rename = "projects:get-folder-context")]
#[specta::specta]
pub async fn projects_get_folder_context(
    state: State<'_, AppState>,
    input: ProjectsGetFolderContextInput,
) -> ArgmaxResult<ProjectFolderContext> {
    projects_get_folder_context_impl(&state, input).await
}

pub(crate) async fn projects_get_folder_context_impl(
    state: &AppState,
    input: ProjectsGetFolderContextInput,
) -> ArgmaxResult<ProjectFolderContext> {
    let database = live_database(state)?;
    read_off_main(move || {
        let (mut project, folder_id) = crate::persistence::project_folders::project_for_launch(
            &database.read_connection(),
            input.project_id.as_str(),
            input.project_folder_id.as_deref(),
        )?;
        let is_git = crate::persistence::project_folders::folder_is_git(&project.repo_path)?;
        if is_git {
            let branch = crate::git::exec::run_git_text_blocking(
                Path::new(&project.repo_path),
                ["branch", "--show-current"],
                GIT_DEFAULT_TIMEOUT,
            )?;
            project.current_branch = if branch.trim().is_empty() {
                "HEAD".into()
            } else {
                branch.trim().into()
            };
            crate::persistence::project_folders::update_folder_branch(
                &database.connection(),
                &project.id,
                &folder_id,
                &project.current_branch,
            )?;
        } else {
            project.current_branch.clear();
            project.default_branch = None;
        }
        Ok(ProjectFolderContext {
            project,
            is_git,
            folder_id,
        })
    })
    .await
}

#[tauri::command(rename = "projects:list-branches")]
#[specta::specta]
pub async fn projects_list_branches(
    state: State<'_, AppState>,
    input: ProjectsListBranchesInput,
) -> ArgmaxResult<Vec<String>> {
    projects_list_branches_impl(&state, input).await
}

pub(crate) async fn projects_list_branches_impl(
    state: &AppState,
    input: ProjectsListBranchesInput,
) -> ArgmaxResult<Vec<String>> {
    let (repo_path, default_branch) = {
        let database = live_database(state)?;
        let connection = database.connection();
        let (project, _) = crate::persistence::project_folders::project_for_launch(
            &connection,
            input.project_id.as_str(),
            input.project_folder_id.as_deref(),
        )?;
        (project.repo_path, project.default_branch)
    };
    if !crate::persistence::project_folders::folder_is_git(&repo_path)? {
        return Err(ArgmaxError::service(
            "PROJECT_GIT_REQUIRED",
            "Choose a Git repository to select a branch.",
        ));
    }
    // Display output adds `+` for linked worktrees and can contain colors or
    // columns from user config. Request only ref names for the picker.
    let raw = run_git_text(
        &repo_path,
        [
            "for-each-ref",
            "--format=%(refname:lstrip=2)",
            "refs/heads/",
        ],
        GIT_DEFAULT_TIMEOUT,
    )
    .await?;
    let branches = raw
        .lines()
        .map(str::to_owned)
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
    projects_refresh_branch_impl(&state, input).await
}

pub(crate) async fn projects_refresh_branch_impl(
    state: &AppState,
    input: ProjectsRefreshBranchInput,
) -> ArgmaxResult<ProjectSummary> {
    let (project, folder_id) = {
        let database = live_database(state)?;
        let connection = database.connection();
        crate::persistence::project_folders::project_for_launch(
            &connection,
            input.project_id.as_str(),
            input.project_folder_id.as_deref(),
        )?
    };
    let repo_path = project.repo_path;
    if !crate::persistence::project_folders::folder_is_git(&repo_path)? {
        return Err(ArgmaxError::service(
            "PROJECT_GIT_REQUIRED",
            "Choose a Git repository to select a branch.",
        ));
    }
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
    let database = live_database(state)?;
    let connection = database.connection();
    crate::persistence::project_folders::update_folder_branch(
        &connection,
        input.project_id.as_str(),
        &folder_id,
        &current_branch,
    )
}

#[tauri::command(rename = "projects:list-checkouts")]
#[specta::specta]
pub async fn projects_list_checkouts(
    state: State<'_, AppState>,
    input: ProjectsListCheckoutsInput,
) -> ArgmaxResult<Vec<crate::workspaces::ProjectCheckout>> {
    projects_list_checkouts_impl(&state, input).await
}

pub(crate) async fn projects_list_checkouts_impl(
    state: &AppState,
    input: ProjectsListCheckoutsInput,
) -> ArgmaxResult<Vec<crate::workspaces::ProjectCheckout>> {
    super::workspaces::live_workspaces(state)?
        .list_checkouts_in_folder(
            input.project_id.as_str(),
            input.project_folder_id.as_deref(),
        )
        .await
}

#[tauri::command(rename = "projects:switch-branch")]
#[specta::specta]
pub async fn projects_switch_branch(
    state: State<'_, AppState>,
    input: ProjectsSwitchBranchInput,
) -> ArgmaxResult<ProjectSummary> {
    projects_switch_branch_impl(&state, input).await
}

pub(crate) async fn projects_switch_branch_impl(
    state: &AppState,
    input: ProjectsSwitchBranchInput,
) -> ArgmaxResult<ProjectSummary> {
    let (project, folder_id) = {
        let database = live_database(state)?;
        let connection = database.connection();
        crate::persistence::project_folders::project_for_launch(
            &connection,
            input.project_id.as_str(),
            input.project_folder_id.as_deref(),
        )?
    };
    let repo_path = project.repo_path;
    if !crate::persistence::project_folders::folder_is_git(&repo_path)? {
        return Err(ArgmaxError::service(
            "PROJECT_GIT_REQUIRED",
            "Choose a Git repository to select a branch.",
        ));
    }
    // `--` separator is defense-in-depth on top of the BranchName newtype's
    // leading-dash rejection.
    run_git_text(
        &repo_path,
        ["checkout", input.branch.as_str(), "--"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await?;
    let database = live_database(state)?;
    let connection = database.connection();
    crate::persistence::project_folders::update_folder_branch(
        &connection,
        input.project_id.as_str(),
        &folder_id,
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
    remote: Option<ProjectRemote>,
}

pub(crate) async fn pick_project_folder(
    app: AppHandle,
    title: &str,
) -> ArgmaxResult<Option<PathBuf>> {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
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

pub(crate) async fn register_project_path(
    state: &AppState,
    candidate_path: PathBuf,
) -> ArgmaxResult<ProjectSummary> {
    let database = live_database(state)?;
    register_repo_path(&database, candidate_path).await
}

/// Add the repository at `candidate_path`, or return the project already
/// registered for it. Takes the database rather than the app state so the
/// session-control socket, which has no `AppState`, can register a repository
/// an agent named for the first time.
pub(crate) async fn register_repo_path(
    database: &Database,
    candidate_path: PathBuf,
) -> ArgmaxResult<ProjectSummary> {
    let canonical_path = canonicalize_repo_path(&candidate_path).await?;
    {
        let connection = database.connection();
        if let Some(project) = crate::persistence::projects::find_project_by_repo_path(
            &connection,
            &canonical_path.to_string_lossy(),
        )? {
            return Ok(project);
        }
    }
    let metadata = read_git_metadata(&canonical_path).await?;
    if let Some(default_branch) = metadata.default_branch.as_deref() {
        assert_valid_ref_name(&metadata.repo_path, default_branch).await?;
    }

    let project_id = Uuid::new_v4().to_string();
    let settings = default_settings(&project_id)?;
    let project = PersistProjectInput {
        id: project_id,
        name: metadata
            .repo_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project")
            .to_string(),
        repo_path: metadata.repo_path.to_string_lossy().to_string(),
        current_branch: metadata.current_branch,
        default_branch: metadata.default_branch,
        settings,
    };

    let project = {
        let connection = database.connection();
        if let Some(existing) = crate::persistence::projects::find_project_by_repo_path(
            &connection,
            &project.repo_path,
        )? {
            return Ok(existing);
        }
        persist_project(&connection, &project)?
    };
    let remote = match metadata.remote {
        Some(remote) => Some(remote),
        None => crate::git::ops::resolve_project_remote(&canonical_path).await,
    };
    if let Some(remote) = remote.as_ref() {
        let connection = database.connection();
        let _ = crate::persistence::projects::update_project_remote(
            &connection,
            &project.id,
            Some(remote),
        );
    }
    Ok(project)
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
    let remote_url = run_git_text(
        &repo_path,
        ["config", "--get", "remote.origin.url"],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    .ok();
    let remote = remote_url.as_deref().and_then(parse_github_remote);

    Ok(GitMetadata {
        repo_path,
        current_branch,
        default_branch,
        remote,
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

fn default_settings(project_id: &str) -> ArgmaxResult<ProjectSettings> {
    Ok(ProjectSettings {
        worktree_location: crate::util::data_dir::worktree_root()?
            .join(project_id)
            .to_string_lossy()
            .to_string(),
        setup_command: String::new(),
        check_commands: Vec::new(),
        merge_cleanup: Default::default(),
    })
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

    #[tokio::test]
    async fn branch_picker_returns_refs_without_worktree_or_display_markers() {
        use super::*;
        use std::sync::Arc;

        let root = tempfile::tempdir().expect("repo directory");
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).expect("create repo");
        let worktree = root.path().join("worktree");
        let setup: &[&[&str]] = &[
            &["init", "-q", "-b", "main"],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Test"],
            &["config", "commit.gpgsign", "false"],
            &["config", "core.hooksPath", "/dev/null"],
            &["config", "branch.sort", "refname"],
            &["commit", "--allow-empty", "-qm", "initial"],
            &["branch", "zeta"],
            &[
                "worktree",
                "add",
                "-b",
                "adam/topic",
                worktree.to_str().unwrap(),
            ],
        ];
        for args in setup {
            run_git_text(&repo, *args, GIT_DEFAULT_TIMEOUT)
                .await
                .unwrap();
        }

        let state = AppState::new();
        let database = Arc::new(Database::open_in_memory().expect("database"));
        let project = register_repo_path(&database, repo.clone()).await.unwrap();
        assert_eq!(
            PathBuf::from(&project.settings.worktree_location),
            crate::util::data_dir::worktree_root()
                .unwrap()
                .join(&project.id)
        );
        assert!(state.db.set(database).is_ok());

        let phases: &[&[&[&str]]] = &[
            &[],
            &[
                &["config", "color.branch", "always"],
                &["config", "column.branch", "always"],
            ],
            &[&["checkout", "--detach", "HEAD"]],
        ];
        for commands in phases {
            for args in *commands {
                run_git_text(&repo, *args, GIT_DEFAULT_TIMEOUT)
                    .await
                    .unwrap();
            }
            let input = serde_json::from_value(serde_json::json!({
                "projectId": project.id,
            }))
            .unwrap();
            let branches = projects_list_branches_impl(&state, input).await.unwrap();
            assert_eq!(branches, owned(&["main", "adam/topic", "zeta"]));
            for branch in branches {
                serde_json::from_value::<ProjectsSwitchBranchInput>(serde_json::json!({
                    "projectId": project.id,
                    "branch": branch,
                }))
                .expect("listed branch passes switch validation");
            }
        }
    }

    #[tokio::test]
    async fn concurrent_registers_of_one_repo_create_one_project() {
        use super::*;
        let repo = tempfile::tempdir().unwrap();
        run_git_text(
            repo.path(),
            ["init", "-q", "-b", "main"],
            GIT_DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        let database = Database::open_in_memory().unwrap();
        let (first, second) = tokio::join!(
            register_repo_path(&database, repo.path().into()),
            register_repo_path(&database, repo.path().into()),
        );
        assert_eq!(first.unwrap().id, second.unwrap().id);
        let count: i64 = database
            .read_connection()
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn folder_context_and_branch_switch_preserve_project_primary() {
        use super::*;
        use crate::persistence::project_folders::{
            configure_project_folders, list_project_folders, PersistProjectFolderInput,
        };
        use std::sync::Arc;
        let primary = tempfile::tempdir().unwrap();
        let secondary = tempfile::tempdir().unwrap();
        let plain = tempfile::tempdir().unwrap();
        for repo in [primary.path(), secondary.path()] {
            for args in [
                vec!["init", "-q", "-b", "main"],
                vec![
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "initial",
                ],
            ] {
                run_git_text(repo, args, GIT_DEFAULT_TIMEOUT).await.unwrap();
            }
        }
        run_git_text(
            secondary.path(),
            ["branch", "secondary-only"],
            GIT_DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        let database = Arc::new(Database::open_in_memory().unwrap());
        let project = register_repo_path(&database, primary.path().into())
            .await
            .unwrap();
        let folders = [primary.path(), secondary.path(), plain.path()]
            .into_iter()
            .map(|root| PersistProjectFolderInput {
                root_path: root.canonicalize().unwrap().display().to_string(),
                current_branch: "main".into(),
                default_branch: Some("main".into()),
                remote: None,
                settings: project.settings.clone(),
            })
            .collect::<Vec<_>>();
        configure_project_folders(
            &database.connection(),
            &project.id,
            "Project",
            &folders,
            &project.repo_path,
        )
        .unwrap();
        let configured = list_project_folders(&database.read_connection(), &project.id).unwrap();
        let secondary_id = configured
            .iter()
            .find(|folder| {
                folder.root_path
                    == secondary
                        .path()
                        .canonicalize()
                        .unwrap()
                        .display()
                        .to_string()
            })
            .unwrap()
            .id
            .clone();
        let plain_id = configured
            .iter()
            .find(|folder| {
                folder.root_path == plain.path().canonicalize().unwrap().display().to_string()
            })
            .unwrap()
            .id
            .clone();
        let state = AppState::new();
        assert!(state.db.set(database.clone()).is_ok());
        let input = |folder_id: &str| {
            serde_json::from_value(
                serde_json::json!({"projectId": project.id, "projectFolderId": folder_id}),
            )
            .unwrap()
        };
        assert!(
            !projects_get_folder_context_impl(&state, input(&plain_id))
                .await
                .unwrap()
                .is_git
        );
        assert!(
            projects_get_folder_context_impl(&state, input(&secondary_id))
                .await
                .unwrap()
                .is_git
        );
        projects_switch_branch_impl(&state, serde_json::from_value(serde_json::json!({"projectId": project.id, "projectFolderId": secondary_id, "branch":"secondary-only"})).unwrap()).await.unwrap();
        let context = projects_get_folder_context_impl(&state, input(&secondary_id))
            .await
            .unwrap();
        assert_eq!(context.project.current_branch, "secondary-only");
        assert_eq!(
            require_project(&database.read_connection(), &project.id)
                .unwrap()
                .current_branch,
            "main"
        );
        database
            .connection()
            .execute(
                "UPDATE project_folders SET removed = 1 WHERE id = ?",
                [&secondary_id],
            )
            .unwrap();
        assert!(
            projects_get_folder_context_impl(&state, input(&secondary_id))
                .await
                .is_err()
        );
    }

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
