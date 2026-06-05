use super::inputs::*;
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    ipc::system::SystemOk,
    persistence::workspaces::WorkspaceSummary,
    state::AppState,
    workspaces::WorkspaceService,
};
use std::sync::Arc;
use tauri::State;

#[tauri::command(rename = "workspaces:create-isolated")]
#[specta::specta]
pub async fn workspaces_create_isolated(
    state: State<'_, AppState>,
    input: WorkspacesCreateIsolatedInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(&state)?.create_isolated(input).await
}

#[tauri::command(rename = "workspaces:create-current")]
#[specta::specta]
pub fn workspaces_create_current(
    state: State<'_, AppState>,
    input: WorkspacesCreateCurrentInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(&state)?.create_current(input)
}

#[tauri::command(rename = "workspaces:refresh-status")]
#[specta::specta]
pub async fn workspaces_refresh_status(
    state: State<'_, AppState>,
    input: WorkspacesRefreshStatusInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(&state)?
        .refresh_status(input.workspace_id.as_str())
        .await
}

#[tauri::command(rename = "workspaces:keep")]
#[specta::specta]
pub fn workspaces_keep(
    state: State<'_, AppState>,
    input: WorkspacesKeepInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(&state)?.keep(input)
}

#[tauri::command(rename = "workspaces:archive")]
#[specta::specta]
pub async fn workspaces_archive(
    state: State<'_, AppState>,
    input: WorkspacesArchiveInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(&state)?.archive(input).await
}

#[tauri::command(rename = "workspaces:open-in-ide")]
#[specta::specta]
pub fn workspaces_open_in_ide(
    state: State<'_, AppState>,
    input: WorkspacesOpenInIdeInput,
) -> ArgmaxResult<SystemOk> {
    live_workspaces(&state)?.open_in_ide(input)?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "workspaces:set-pinned")]
#[specta::specta]
pub fn workspaces_set_pinned(
    state: State<'_, AppState>,
    input: WorkspacesSetPinnedInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(&state)?.set_pinned(input)
}

#[tauri::command(rename = "workspaces:set-label")]
#[specta::specta]
pub fn workspaces_set_label(
    state: State<'_, AppState>,
    input: WorkspacesSetLabelInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(&state)?.set_label(input)
}

fn live_workspaces(state: &AppState) -> ArgmaxResult<Arc<WorkspaceService>> {
    state.workspaces.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "WORKSPACE_SERVICE_NOT_READY",
            "workspace service is not initialized",
        )
    })
}
