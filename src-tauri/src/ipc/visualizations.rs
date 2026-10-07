use crate::{
    error::ArgmaxResult,
    state::AppState,
    visualizations::{
        self, tools::VisualizationSource, VisualizationArtifact, VisualizationMode,
        VisualizationRead, VisualizationWidgetState,
    },
};
use serde::Deserialize;
use specta::Type;
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualizationImportInput {
    pub session_id: String,
    pub path: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub mode: Option<VisualizationMode>,
    pub source_event_id: Option<String>,
}
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualizationReadInput {
    pub session_id: String,
    pub artifact_id: String,
}
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualizationSetStateInput {
    pub session_id: String,
    pub artifact_id: String,
    pub state: VisualizationWidgetState,
}
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualizationPreviewInput {
    pub session_id: String,
    #[serde(flatten)]
    pub source: VisualizationSource,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualizationPublishInput {
    pub session_id: String,
    pub draft_id: String,
}

#[tauri::command(rename = "visualization:import")]
#[specta::specta]
pub async fn visualization_import(
    state: State<'_, AppState>,
    input: VisualizationImportInput,
) -> ArgmaxResult<VisualizationArtifact> {
    visualization_import_impl(&state, input).await
}
pub(crate) async fn visualization_import_impl(
    state: &AppState,
    input: VisualizationImportInput,
) -> ArgmaxResult<VisualizationArtifact> {
    visualizations::tools::ingest(
        state,
        &input.session_id,
        VisualizationSource {
            path: Some(input.path),
            title: input.title,
            summary: input.summary,
            mode: input.mode,
            source_event_id: input.source_event_id,
            ..Default::default()
        },
        true,
    )
    .await
}
#[tauri::command(rename = "visualization:read")]
#[specta::specta]
pub async fn visualization_read(
    state: State<'_, AppState>,
    input: VisualizationReadInput,
) -> ArgmaxResult<VisualizationRead> {
    visualization_read_impl(&state, input).await
}
pub(crate) async fn visualization_read_impl(
    state: &AppState,
    input: VisualizationReadInput,
) -> ArgmaxResult<VisualizationRead> {
    let db = super::live_database(state)?;
    crate::persistence::sessions::find_session_by_id(&db.read_connection(), &input.session_id)?;
    let store = visualizations::tools::store(state)?;
    super::read_off_main(move || store.read(&input.session_id, &input.artifact_id)).await
}
#[tauri::command(rename = "visualization:set-state")]
#[specta::specta]
pub async fn visualization_set_state(
    state: State<'_, AppState>,
    input: VisualizationSetStateInput,
) -> ArgmaxResult<VisualizationWidgetState> {
    visualization_set_state_impl(&state, input).await
}
pub(crate) async fn visualization_set_state_impl(
    state: &AppState,
    input: VisualizationSetStateInput,
) -> ArgmaxResult<VisualizationWidgetState> {
    let db = super::live_database(state)?;
    crate::persistence::sessions::find_session_by_id(&db.read_connection(), &input.session_id)?;
    let store = visualizations::tools::store(state)?;
    super::read_off_main(move || {
        store.set_state(&input.session_id, &input.artifact_id, input.state)
    })
    .await
}
#[tauri::command(rename = "visualization:preview")]
#[specta::specta]
pub async fn visualization_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    input: VisualizationPreviewInput,
) -> ArgmaxResult<visualizations::tools::VisualizationPreviewResult> {
    visualizations::tools::preview(&state, Some(&app), &input.session_id, input.source).await
}
#[tauri::command(rename = "visualization:publish")]
#[specta::specta]
pub async fn visualization_publish(
    state: State<'_, AppState>,
    input: VisualizationPublishInput,
) -> ArgmaxResult<VisualizationArtifact> {
    visualization_publish_impl(&state, input).await
}
pub(crate) async fn visualization_publish_impl(
    state: &AppState,
    input: VisualizationPublishInput,
) -> ArgmaxResult<VisualizationArtifact> {
    visualizations::tools::publish(state, &input.session_id, &input.draft_id).await
}

#[tauri::command(rename = "visualization:export")]
#[specta::specta]
pub async fn visualization_export(
    state: State<'_, AppState>,
    input: VisualizationReadInput,
) -> ArgmaxResult<String> {
    visualization_export_impl(&state, input).await
}
pub(crate) async fn visualization_export_impl(
    state: &AppState,
    input: VisualizationReadInput,
) -> ArgmaxResult<String> {
    let read = visualization_read_impl(state, input).await?;
    let fragment = match read.artifact.format {
        visualizations::VisualizationFormat::Html => read.source,
        visualizations::VisualizationFormat::Image => format!(
            "<img src=\"{}\" alt=\"{}\" style=\"max-width:100%;height:auto\">",
            read.source,
            visualizations::store::escape_attribute(&read.artifact.summary)
        ),
    };
    Ok(visualizations::document::build_document(
        &fragment,
        &serde_json::json!({"instanceId":read.artifact.id,"appearance":{"dark":false,"variables":{}},"state":read.state,"controlValues":read.control_values,"standalone":true,"capabilities":{"controls":false}}),
    ))
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualizationSetControlsInput {
    pub session_id: String,
    pub artifact_id: String,
    pub control_values: visualizations::VisualizationControlValues,
}
#[tauri::command(rename = "visualization:set-controls")]
#[specta::specta]
pub async fn visualization_set_controls(
    state: State<'_, AppState>,
    input: VisualizationSetControlsInput,
) -> ArgmaxResult<visualizations::VisualizationControlValues> {
    visualization_set_controls_impl(&state, input).await
}
pub(crate) async fn visualization_set_controls_impl(
    state: &AppState,
    input: VisualizationSetControlsInput,
) -> ArgmaxResult<visualizations::VisualizationControlValues> {
    let db = super::live_database(state)?;
    crate::persistence::sessions::find_session_by_id(&db.read_connection(), &input.session_id)?;
    let store = visualizations::tools::store(state)?;
    super::read_off_main(move || {
        store.set_controls(&input.session_id, &input.artifact_id, input.control_values)
    })
    .await
}
