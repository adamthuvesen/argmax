//! Settings channels for linked repositories and branch-name templates.
//! Both are per-project (or app-wide) preferences that a launch reads from
//! Rust, so they cannot live in the renderer's `localStorage`.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::{
    live_database, read_off_main,
    validation::{NonEmptyString, ProjectId},
};
use crate::{
    error::ArgmaxResult,
    persistence::{
        app_settings,
        linked_repos::{self, LinkedRepo, LinkedRepoInput},
        projects::{self, ProjectSummary},
    },
    state::AppState,
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedReposListInput {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedReposAddInput {
    pub project_id: ProjectId,
    pub repo: LinkedRepoInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedReposSetEnabledInput {
    pub project_id: ProjectId,
    pub id: NonEmptyString,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedReposRemoveInput {
    pub project_id: ProjectId,
    pub id: NonEmptyString,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsSetBranchTemplateInput {
    pub project_id: ProjectId,
    /// `null` removes the project's override.
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBranchTemplateInput {
    /// `null` returns to Argmax's built-in template.
    pub template: Option<String>,
}

/// The app-wide template as saved, and the built-in one it falls back to, so
/// the form can show what "unset" means.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchTemplateSettings {
    pub template: Option<String>,
    pub default_template: &'static str,
}

fn settings(template: Option<String>) -> BranchTemplateSettings {
    BranchTemplateSettings {
        template,
        default_template: crate::workspaces::branch_names::DEFAULT_BRANCH_TEMPLATE,
    }
}

#[tauri::command(rename = "linked-repos:list")]
#[specta::specta]
pub async fn linked_repos_list(
    state: State<'_, AppState>,
    input: LinkedReposListInput,
) -> ArgmaxResult<Vec<LinkedRepo>> {
    let database = live_database(&state)?;
    read_off_main(move || {
        linked_repos::list_linked_repos(&database.read_connection(), input.project_id.as_str())
    })
    .await
}

#[tauri::command(rename = "linked-repos:add")]
#[specta::specta]
pub async fn linked_repos_add(
    state: State<'_, AppState>,
    input: LinkedReposAddInput,
) -> ArgmaxResult<LinkedRepo> {
    let database = live_database(&state)?;
    // Canonicalizing the path touches the filesystem, so it runs off the main thread.
    read_off_main(move || {
        linked_repos::add_linked_repo(
            &database.connection(),
            input.project_id.as_str(),
            &input.repo,
        )
    })
    .await
}

#[tauri::command(rename = "linked-repos:set-enabled")]
#[specta::specta]
pub async fn linked_repos_set_enabled(
    state: State<'_, AppState>,
    input: LinkedReposSetEnabledInput,
) -> ArgmaxResult<LinkedRepo> {
    let database = live_database(&state)?;
    read_off_main(move || {
        linked_repos::set_linked_repo_enabled(
            &database.connection(),
            input.project_id.as_str(),
            input.id.as_str(),
            input.enabled,
        )
    })
    .await
}

#[tauri::command(rename = "linked-repos:remove")]
#[specta::specta]
pub async fn linked_repos_remove(
    state: State<'_, AppState>,
    input: LinkedReposRemoveInput,
) -> ArgmaxResult<()> {
    let database = live_database(&state)?;
    read_off_main(move || {
        linked_repos::delete_linked_repo(
            &database.connection(),
            input.project_id.as_str(),
            input.id.as_str(),
        )
    })
    .await
}

#[tauri::command(rename = "projects:set-branch-template")]
#[specta::specta]
pub async fn projects_set_branch_template(
    state: State<'_, AppState>,
    input: ProjectsSetBranchTemplateInput,
) -> ArgmaxResult<ProjectSummary> {
    let database = live_database(&state)?;
    read_off_main(move || {
        projects::set_project_branch_template(
            &database.connection(),
            input.project_id.as_str(),
            input.template.as_deref(),
        )
    })
    .await
}

#[tauri::command(rename = "settings:branch-template")]
#[specta::specta]
pub async fn settings_branch_template(
    state: State<'_, AppState>,
) -> ArgmaxResult<BranchTemplateSettings> {
    let database = live_database(&state)?;
    read_off_main(move || {
        Ok(settings(app_settings::branch_template(
            &database.read_connection(),
        )))
    })
    .await
}

#[tauri::command(rename = "settings:set-branch-template")]
#[specta::specta]
pub async fn settings_set_branch_template(
    state: State<'_, AppState>,
    input: SetBranchTemplateInput,
) -> ArgmaxResult<BranchTemplateSettings> {
    let database = live_database(&state)?;
    read_off_main(move || {
        let connection = database.connection();
        app_settings::set_branch_template(&connection, input.template.as_deref())?;
        Ok(settings(app_settings::branch_template(&connection)))
    })
    .await
}
