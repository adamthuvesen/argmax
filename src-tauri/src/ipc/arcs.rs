use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::{live_database, publish_dashboard_changed, read_off_main, validation::NonEmptyString};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::arcs::{self, ArcCreateInput, ArcRecord, ArcState, ArcUpdateInput},
    providers::{ProviderId, ReasoningEffort},
    state::AppState,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcListInput {}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcGetInput {
    pub id: NonEmptyString,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcUpdateFieldsInput {
    pub id: NonEmptyString,
    pub name: Option<String>,
    pub brief: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcSetStateInput {
    pub id: NonEmptyString,
    pub state: ArcState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcLaunchCoordinatorInput {
    pub arc_id: NonEmptyString,
    pub provider: ProviderId,
    /// Both default to that provider's own default model when omitted.
    pub model_label: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
}

#[tauri::command(rename = "arc:create")]
#[specta::specta]
pub async fn arc_create(
    state: State<'_, AppState>,
    input: ArcCreateInput,
) -> ArgmaxResult<ArcRecord> {
    arc_create_impl(&state, input).await
}

pub(crate) async fn arc_create_impl(
    state: &AppState,
    input: ArcCreateInput,
) -> ArgmaxResult<ArcRecord> {
    let database = live_database(state)?;
    let app_data_dir = state.require_app_data_dir()?.to_path_buf();
    let created =
        read_off_main(move || arcs::create_arc(&database.connection(), &app_data_dir, &input))
            .await?;
    publish_dashboard_changed(state);
    Ok(created)
}

#[tauri::command(rename = "arc:list")]
#[specta::specta]
pub async fn arc_list(
    state: State<'_, AppState>,
    input: ArcListInput,
) -> ArgmaxResult<Vec<ArcRecord>> {
    arc_list_impl(&state, input).await
}

pub(crate) async fn arc_list_impl(
    state: &AppState,
    _input: ArcListInput,
) -> ArgmaxResult<Vec<ArcRecord>> {
    let database = live_database(state)?;
    read_off_main(move || arcs::list_arcs(&database.read_connection())).await
}

#[tauri::command(rename = "arc:get")]
#[specta::specta]
pub async fn arc_get(state: State<'_, AppState>, input: ArcGetInput) -> ArgmaxResult<ArcRecord> {
    arc_get_impl(&state, input).await
}

pub(crate) async fn arc_get_impl(state: &AppState, input: ArcGetInput) -> ArgmaxResult<ArcRecord> {
    let database = live_database(state)?;
    read_off_main(move || arcs::get_arc(&database.read_connection(), input.id.as_str())).await
}

#[tauri::command(rename = "arc:update")]
#[specta::specta]
pub async fn arc_update(
    state: State<'_, AppState>,
    input: ArcUpdateFieldsInput,
) -> ArgmaxResult<ArcRecord> {
    arc_update_impl(&state, input).await
}

pub(crate) async fn arc_update_impl(
    state: &AppState,
    input: ArcUpdateFieldsInput,
) -> ArgmaxResult<ArcRecord> {
    let database = live_database(state)?;
    let updated = read_off_main(move || {
        arcs::update_arc(
            &database.connection(),
            input.id.as_str(),
            &ArcUpdateInput {
                name: input.name,
                brief: input.brief,
            },
        )
    })
    .await?;
    publish_dashboard_changed(state);
    Ok(updated)
}

#[tauri::command(rename = "arc:set-state")]
#[specta::specta]
pub async fn arc_set_state(
    state: State<'_, AppState>,
    input: ArcSetStateInput,
) -> ArgmaxResult<ArcRecord> {
    arc_set_state_impl(&state, input).await
}

pub(crate) async fn arc_set_state_impl(
    state: &AppState,
    input: ArcSetStateInput,
) -> ArgmaxResult<ArcRecord> {
    let database = live_database(state)?;
    let updated = read_off_main(move || {
        arcs::set_arc_state(&database.connection(), input.id.as_str(), input.state)
    })
    .await?;
    publish_dashboard_changed(state);
    Ok(updated)
}

#[tauri::command(rename = "arc:launch-coordinator")]
#[specta::specta]
pub async fn arc_launch_coordinator(
    state: State<'_, AppState>,
    input: ArcLaunchCoordinatorInput,
) -> ArgmaxResult<ArcRecord> {
    arc_launch_coordinator_impl(&state, input).await
}

pub(crate) async fn arc_launch_coordinator_impl(
    state: &AppState,
    input: ArcLaunchCoordinatorInput,
) -> ArgmaxResult<ArcRecord> {
    let database = live_database(state)?;
    let workspaces = state.workspaces.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "WORKSPACE_SERVICE_NOT_READY",
            "workspace service is not initialized",
        )
    })?;
    let providers = state.providers.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "PROVIDER_SERVICE_NOT_READY",
            "provider service is not initialized",
        )
    })?;
    let updated = crate::arcs::launch_coordinator(
        crate::arcs::LaunchCoordinatorRequest {
            arc_id: input.arc_id.into_string(),
            provider: input.provider,
            model_label: input.model_label,
            model_id: input.model_id,
            reasoning_effort: input.reasoning_effort,
        },
        database,
        workspaces,
        providers,
    )
    .await?;
    publish_dashboard_changed(state);
    Ok(updated)
}
