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
    workspaces_create_isolated_impl(&state, input).await
}

pub(crate) async fn workspaces_create_isolated_impl(
    state: &AppState,
    input: WorkspacesCreateIsolatedInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(state)?.create_isolated(input).await
}

#[tauri::command(rename = "workspaces:create-current")]
#[specta::specta]
pub fn workspaces_create_current(
    state: State<'_, AppState>,
    input: WorkspacesCreateCurrentInput,
) -> ArgmaxResult<WorkspaceSummary> {
    workspaces_create_current_impl(&state, input)
}

pub(crate) fn workspaces_create_current_impl(
    state: &AppState,
    input: WorkspacesCreateCurrentInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(state)?.create_current(input)
}

#[tauri::command(rename = "workspaces:refresh-status")]
#[specta::specta]
pub async fn workspaces_refresh_status(
    state: State<'_, AppState>,
    input: WorkspacesRefreshStatusInput,
) -> ArgmaxResult<WorkspaceSummary> {
    workspaces_refresh_status_impl(&state, input).await
}

pub(crate) async fn workspaces_refresh_status_impl(
    state: &AppState,
    input: WorkspacesRefreshStatusInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(state)?
        .refresh_status(input.workspace_id.as_str())
        .await
}

#[tauri::command(rename = "workspaces:keep")]
#[specta::specta]
pub fn workspaces_keep(
    state: State<'_, AppState>,
    input: WorkspacesKeepInput,
) -> ArgmaxResult<WorkspaceSummary> {
    workspaces_keep_impl(&state, input)
}

pub(crate) fn workspaces_keep_impl(
    state: &AppState,
    input: WorkspacesKeepInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(state)?.keep(input)
}

#[tauri::command(rename = "workspaces:archive")]
#[specta::specta]
pub async fn workspaces_archive(
    state: State<'_, AppState>,
    input: WorkspacesArchiveInput,
) -> ArgmaxResult<WorkspaceSummary> {
    workspaces_archive_impl(&state, input).await
}

pub(crate) async fn workspaces_archive_impl(
    state: &AppState,
    input: WorkspacesArchiveInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(state)?.archive(input).await
}

#[tauri::command(rename = "workspaces:open-in-ide")]
#[specta::specta]
pub fn workspaces_open_in_ide(
    state: State<'_, AppState>,
    input: WorkspacesOpenInIdeInput,
) -> ArgmaxResult<SystemOk> {
    workspaces_open_in_ide_impl(&state, input)
}

pub(crate) fn workspaces_open_in_ide_impl(
    state: &AppState,
    input: WorkspacesOpenInIdeInput,
) -> ArgmaxResult<SystemOk> {
    live_workspaces(state)?.open_in_ide(input)?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "workspaces:autotitle")]
#[specta::specta]
pub async fn workspaces_autotitle(
    state: State<'_, AppState>,
    input: WorkspacesAutotitleInput,
) -> ArgmaxResult<SystemOk> {
    workspaces_autotitle_impl(&state, input).await
}

pub(crate) async fn workspaces_autotitle_impl(
    state: &AppState,
    input: WorkspacesAutotitleInput,
) -> ArgmaxResult<SystemOk> {
    live_workspaces(state)?.autotitle(input).await?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "workspaces:set-pinned")]
#[specta::specta]
pub fn workspaces_set_pinned(
    state: State<'_, AppState>,
    input: WorkspacesSetPinnedInput,
) -> ArgmaxResult<WorkspaceSummary> {
    workspaces_set_pinned_impl(&state, input)
}

pub(crate) fn workspaces_set_pinned_impl(
    state: &AppState,
    input: WorkspacesSetPinnedInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(state)?.set_pinned(input)
}

#[tauri::command(rename = "workspaces:set-priority-added")]
#[specta::specta]
pub fn workspaces_set_priority_added(
    state: State<'_, AppState>,
    input: WorkspacesSetPriorityAddedInput,
) -> ArgmaxResult<WorkspaceSummary> {
    workspaces_set_priority_added_impl(&state, input)
}

pub(crate) fn workspaces_set_priority_added_impl(
    state: &AppState,
    input: WorkspacesSetPriorityAddedInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(state)?.set_priority_added(input)
}

#[tauri::command(rename = "workspaces:set-priority-dismissed")]
#[specta::specta]
pub fn workspaces_set_priority_dismissed(
    state: State<'_, AppState>,
    input: WorkspacesSetPriorityDismissedInput,
) -> ArgmaxResult<WorkspaceSummary> {
    workspaces_set_priority_dismissed_impl(&state, input)
}

pub(crate) fn workspaces_set_priority_dismissed_impl(
    state: &AppState,
    input: WorkspacesSetPriorityDismissedInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(state)?.set_priority_dismissed(input)
}

#[tauri::command(rename = "workspaces:set-label")]
#[specta::specta]
pub fn workspaces_set_label(
    state: State<'_, AppState>,
    input: WorkspacesSetLabelInput,
) -> ArgmaxResult<WorkspaceSummary> {
    workspaces_set_label_impl(&state, input)
}

pub(crate) fn workspaces_set_label_impl(
    state: &AppState,
    input: WorkspacesSetLabelInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(state)?.set_label(input)
}

#[tauri::command(rename = "workspaces:set-icon")]
#[specta::specta]
pub fn workspaces_set_icon(
    state: State<'_, AppState>,
    input: WorkspacesSetIconInput,
) -> ArgmaxResult<WorkspaceSummary> {
    workspaces_set_icon_impl(&state, input)
}

pub(crate) fn workspaces_set_icon_impl(
    state: &AppState,
    input: WorkspacesSetIconInput,
) -> ArgmaxResult<WorkspaceSummary> {
    live_workspaces(state)?.set_icon(input)
}

fn live_workspaces(state: &AppState) -> ArgmaxResult<Arc<WorkspaceService>> {
    state.workspaces.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "WORKSPACE_SERVICE_NOT_READY",
            "workspace service is not initialized",
        )
    })
}
