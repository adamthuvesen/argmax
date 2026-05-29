use super::inputs::*;
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    ipc::live_database,
    persistence::checks::Checkpoint,
    review::checkpoints::{CheckpointService, CreateCheckpointInput},
    state::AppState,
};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime, State};

#[tauri::command(rename = "checkpoints:create")]
#[specta::specta]
pub async fn checkpoints_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CheckpointsCreateInput,
) -> ArgmaxResult<Checkpoint> {
    let service = CheckpointService::from_data_dir(live_database(&state)?, data_dir(&app)?);
    service
        .create_checkpoint(CreateCheckpointInput {
            workspace_id: input.workspace_id.into_string(),
            label: input.label.into_string(),
        })
        .await
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> ArgmaxResult<PathBuf> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| ArgmaxError::service("APP_DATA_DIR", error.to_string()))?;
    Ok(app_data.join("local-state"))
}
