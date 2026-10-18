use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::validation::ProjectId;
use super::{live_database, read_off_main};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::{
    project_overviews as store,
    projects::{require_project, ProjectSummary},
    Database,
};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsGenerateOverviewInput {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsUpdateOverviewInput {
    pub project_id: ProjectId,
    pub text: String,
    pub expected_revision: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsOverviewDraftInput {
    pub project_id: ProjectId,
    pub expected_revision: u32,
}

#[tauri::command(rename = "projects:generate-overview")]
#[specta::specta]
pub async fn projects_generate_overview(
    state: State<'_, AppState>,
    input: ProjectsGenerateOverviewInput,
) -> ArgmaxResult<ProjectSummary> {
    projects_generate_overview_impl(&state, input).await
}

pub(crate) async fn projects_generate_overview_impl(
    state: &AppState,
    input: ProjectsGenerateOverviewInput,
) -> ArgmaxResult<ProjectSummary> {
    let database = live_database(state)?;
    let id = input.project_id.into_string();
    let request_database = Arc::clone(&database);
    let (project, generation) = read_off_main(move || {
        let connection = request_database.connection();
        let generation = store::begin_generation(&connection, &id, false)?;
        Ok((require_project(&connection, &id)?, generation))
    })
    .await?;
    if let Some(generation) = generation {
        spawn_generation(state, database, project.id.clone(), generation);
    }
    super::publish_dashboard_changed(state);
    Ok(project)
}

#[tauri::command(rename = "projects:update-overview")]
#[specta::specta]
pub async fn projects_update_overview(
    state: State<'_, AppState>,
    input: ProjectsUpdateOverviewInput,
) -> ArgmaxResult<ProjectSummary> {
    projects_update_overview_impl(&state, input).await
}

pub(crate) async fn projects_update_overview_impl(
    state: &AppState,
    input: ProjectsUpdateOverviewInput,
) -> ArgmaxResult<ProjectSummary> {
    let database = live_database(state)?;
    let project = read_off_main(move || {
        let connection = database.connection();
        store::edit_overview(
            &connection,
            input.project_id.as_str(),
            input.expected_revision,
            store::OverviewEdit::Save(&input.text),
        )?;
        require_project(&connection, input.project_id.as_str())
    })
    .await?;
    super::publish_dashboard_changed(state);
    Ok(project)
}

#[tauri::command(rename = "projects:apply-overview-draft")]
#[specta::specta]
pub async fn projects_apply_overview_draft(
    state: State<'_, AppState>,
    input: ProjectsOverviewDraftInput,
) -> ArgmaxResult<ProjectSummary> {
    projects_apply_overview_draft_impl(&state, input).await
}

pub(crate) async fn projects_apply_overview_draft_impl(
    state: &AppState,
    input: ProjectsOverviewDraftInput,
) -> ArgmaxResult<ProjectSummary> {
    edit_draft(state, input, true).await
}

#[tauri::command(rename = "projects:discard-overview-draft")]
#[specta::specta]
pub async fn projects_discard_overview_draft(
    state: State<'_, AppState>,
    input: ProjectsOverviewDraftInput,
) -> ArgmaxResult<ProjectSummary> {
    projects_discard_overview_draft_impl(&state, input).await
}

pub(crate) async fn projects_discard_overview_draft_impl(
    state: &AppState,
    input: ProjectsOverviewDraftInput,
) -> ArgmaxResult<ProjectSummary> {
    edit_draft(state, input, false).await
}

async fn edit_draft(
    state: &AppState,
    input: ProjectsOverviewDraftInput,
    apply: bool,
) -> ArgmaxResult<ProjectSummary> {
    let database = live_database(state)?;
    let project = read_off_main(move || {
        let connection = database.connection();
        store::edit_overview(
            &connection,
            input.project_id.as_str(),
            input.expected_revision,
            if apply {
                store::OverviewEdit::ApplyDraft
            } else {
                store::OverviewEdit::DiscardDraft
            },
        )?;
        require_project(&connection, input.project_id.as_str())
    })
    .await?;
    super::publish_dashboard_changed(state);
    Ok(project)
}

pub(crate) fn spawn_generation(
    state: &AppState,
    database: Arc<Database>,
    project_id: String,
    generation: store::OverviewGeneration,
) {
    let discovery = Arc::clone(&state.provider_discovery);
    let publisher = state.providers.get().cloned();
    tauri::async_runtime::spawn(async move {
        let result = generate(&database, &project_id, &discovery)
            .await
            .map_err(|error| error.to_string());
        let completion = read_off_main(move || {
            store::complete_generation(&database.connection(), &project_id, &generation, result)
        })
        .await;
        match completion {
            Ok(true) => {
                if let Some(publisher) = publisher {
                    publisher.publish_dashboard_changed();
                }
            }
            Ok(false) => {}
            Err(error) => tracing::error!(?error, "failed to save project overview"),
        }
    });
}

async fn generate(
    database: &Arc<Database>,
    project_id: &str,
    discovery: &crate::providers::discovery::ProviderDiscovery,
) -> ArgmaxResult<store::OverviewDocument> {
    let request_database = Arc::clone(database);
    let id = project_id.to_owned();
    let (name, folders) = read_off_main(move || {
        let connection = request_database.read_connection();
        Ok((
            require_project(&connection, &id)?.name,
            crate::persistence::project_folders::list_project_folders(&connection, &id)?,
        ))
    })
    .await?;
    let folders: Vec<_> = folders
        .into_iter()
        .filter(|folder| folder.enabled || folder.is_primary)
        .collect();
    // The total sample stays bounded even when a project has many folders.
    let budget = 32_000usize.saturating_sub(name.chars().count() + 30) / folders.len().max(1);
    if budget < 1_000 {
        return Err(ArgmaxError::service(
            "PROJECT_OVERVIEW_TOO_MANY_FOLDERS",
            "This project has too many folders to summarize together. Add the overview manually.",
        ));
    }
    let mut context = format!("Project: {name}\n");
    let mut sources = Vec::new();
    for folder in folders {
        let header = format!(
            "\nFolder ID: {}\nRole: {}\n",
            folder.id,
            if folder.is_primary {
                "primary"
            } else {
                "context"
            }
        );
        let repo = crate::persistence::linked_repos::LinkedRepo {
            id: folder.id.clone(),
            project_id: folder.project_id,
            name: folder.name,
            root_path: folder.root_path,
            summary: None,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let (sample, paths) = super::linked_repos::repository_summary_sample(
            &repo,
            budget.saturating_sub(header.chars().count()),
        )
        .await?;
        context.push_str(&header);
        context.push_str(&sample);
        sources.extend(paths.into_iter().map(|path| store::OverviewSource {
            folder_id: folder.id.clone(),
            path,
        }));
    }
    if sources.is_empty() {
        return Err(ArgmaxError::service("PROJECT_OVERVIEW_UNAVAILABLE", "No supported project documents were found. Add an overview manually or add a README, then refresh."));
    }
    for provider in discovery.available_providers().await {
        if let Some(document) = crate::providers::one_shot::generate_project_overview(
            provider,
            crate::providers::one_shot::helper_model(provider),
            &context,
            &sources,
        )
        .await
        {
            return Ok(document);
        }
    }
    Err(ArgmaxError::service("PROJECT_OVERVIEW_UNAVAILABLE", "Could not generate the project overview. Check that an agent provider is available, then refresh."))
}
