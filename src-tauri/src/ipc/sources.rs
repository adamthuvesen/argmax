use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::{
    live_database, read_off_main,
    validation::{NonEmptyString, ProjectId},
};
use crate::{
    error::ArgmaxResult,
    persistence::project_sources::{self, ProjectSource, ProjectSourceAddedBy, SourceInput},
    state::AppState,
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcesListInput {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcesAddInput {
    pub project_id: ProjectId,
    pub source: SourceInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcesUpdateInput {
    pub project_id: ProjectId,
    pub id: NonEmptyString,
    pub source: SourceInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcesDeleteInput {
    pub project_id: ProjectId,
    pub id: NonEmptyString,
}

#[tauri::command(rename = "sources:list")]
#[specta::specta]
pub async fn sources_list(
    state: State<'_, AppState>,
    input: SourcesListInput,
) -> ArgmaxResult<Vec<ProjectSource>> {
    sources_list_impl(&state, input).await
}

pub(crate) async fn sources_list_impl(
    state: &AppState,
    input: SourcesListInput,
) -> ArgmaxResult<Vec<ProjectSource>> {
    let database = live_database(state)?;
    read_off_main(move || {
        project_sources::list_sources(&database.read_connection(), input.project_id.as_str())
    })
    .await
}

#[tauri::command(rename = "sources:add")]
#[specta::specta]
pub async fn sources_add(
    state: State<'_, AppState>,
    input: SourcesAddInput,
) -> ArgmaxResult<ProjectSource> {
    sources_add_impl(&state, input).await
}

pub(crate) async fn sources_add_impl(
    state: &AppState,
    input: SourcesAddInput,
) -> ArgmaxResult<ProjectSource> {
    let database = live_database(state)?;
    read_off_main(move || {
        project_sources::insert_source(
            &database.connection(),
            input.project_id.as_str(),
            &input.source,
            ProjectSourceAddedBy::User,
            None,
        )
        .map(|(source, _)| source)
    })
    .await
}

#[tauri::command(rename = "sources:update")]
#[specta::specta]
pub async fn sources_update(
    state: State<'_, AppState>,
    input: SourcesUpdateInput,
) -> ArgmaxResult<ProjectSource> {
    sources_update_impl(&state, input).await
}

pub(crate) async fn sources_update_impl(
    state: &AppState,
    input: SourcesUpdateInput,
) -> ArgmaxResult<ProjectSource> {
    let database = live_database(state)?;
    read_off_main(move || {
        project_sources::update_source(
            &database.connection(),
            input.project_id.as_str(),
            input.id.as_str(),
            &input.source,
        )
    })
    .await
}

#[tauri::command(rename = "sources:delete")]
#[specta::specta]
pub async fn sources_delete(
    state: State<'_, AppState>,
    input: SourcesDeleteInput,
) -> ArgmaxResult<()> {
    sources_delete_impl(&state, input).await
}

pub(crate) async fn sources_delete_impl(
    state: &AppState,
    input: SourcesDeleteInput,
) -> ArgmaxResult<()> {
    let database = live_database(state)?;
    read_off_main(move || {
        project_sources::delete_source(
            &database.connection(),
            input.project_id.as_str(),
            input.id.as_str(),
        )
    })
    .await
}
