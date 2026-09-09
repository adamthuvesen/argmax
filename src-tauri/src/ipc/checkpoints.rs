use serde::Deserialize;
use specta::Type;
use tauri::State;

use crate::{
    checkpoints::service::{
        CheckoutFingerprint, CheckpointService, RewindFilesInput, RewindFilesResult, RewindPreview,
    },
    error::ArgmaxResult,
    persistence::checkpoints::Checkpoint,
    state::AppState,
};

use super::{live_database, read_off_main};

#[derive(Debug, Clone, PartialEq, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointsListInput {
    pub workspace_id: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointsPreviewRewindInput {
    pub workspace_id: String,
    pub checkpoint_id: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointsRewindFilesInput {
    pub workspace_id: String,
    pub checkpoint_id: String,
    pub expected_fingerprint: CheckoutFingerprint,
}

const fn default_limit() -> usize {
    50
}

#[tauri::command(rename = "checkpoints:list")]
#[specta::specta]
pub async fn checkpoints_list(
    state: State<'_, AppState>,
    input: CheckpointsListInput,
) -> ArgmaxResult<Vec<Checkpoint>> {
    checkpoints_list_impl(&state, input).await
}

pub(crate) async fn checkpoints_list_impl(
    state: &AppState,
    input: CheckpointsListInput,
) -> ArgmaxResult<Vec<Checkpoint>> {
    let database = live_database(state)?;
    read_off_main(move || CheckpointService::new(database).list(&input.workspace_id, input.limit))
        .await
}

#[tauri::command(rename = "checkpoints:preview-rewind")]
#[specta::specta]
pub async fn checkpoints_preview_rewind(
    state: State<'_, AppState>,
    input: CheckpointsPreviewRewindInput,
) -> ArgmaxResult<RewindPreview> {
    checkpoints_preview_rewind_impl(&state, input).await
}

pub(crate) async fn checkpoints_preview_rewind_impl(
    state: &AppState,
    input: CheckpointsPreviewRewindInput,
) -> ArgmaxResult<RewindPreview> {
    CheckpointService::new(live_database(state)?)
        .preview_rewind(&input.workspace_id, &input.checkpoint_id)
        .await
}

#[tauri::command(rename = "checkpoints:rewind-files")]
#[specta::specta]
pub async fn checkpoints_rewind_files(
    state: State<'_, AppState>,
    input: CheckpointsRewindFilesInput,
) -> ArgmaxResult<RewindFilesResult> {
    checkpoints_rewind_files_impl(&state, input).await
}

pub(crate) async fn checkpoints_rewind_files_impl(
    state: &AppState,
    input: CheckpointsRewindFilesInput,
) -> ArgmaxResult<RewindFilesResult> {
    CheckpointService::new(live_database(state)?)
        .rewind_files(RewindFilesInput {
            workspace_id: input.workspace_id,
            checkpoint_id: input.checkpoint_id,
            expected_fingerprint: input.expected_fingerprint,
        })
        .await
}
