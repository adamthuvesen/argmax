use super::inputs::*;

#[tauri::command(rename = "workspaces:create-isolated")]
#[specta::specta]
pub fn workspaces_create_isolated(_input: WorkspacesCreateIsolatedInput) {
    super::unported("workspaces:create-isolated")
}

#[tauri::command(rename = "workspaces:create-current")]
#[specta::specta]
pub fn workspaces_create_current(_input: WorkspacesCreateCurrentInput) {
    super::unported("workspaces:create-current")
}

#[tauri::command(rename = "workspaces:refresh-status")]
#[specta::specta]
pub fn workspaces_refresh_status(_input: WorkspacesRefreshStatusInput) {
    super::unported("workspaces:refresh-status")
}

#[tauri::command(rename = "workspaces:keep")]
#[specta::specta]
pub fn workspaces_keep(_input: WorkspacesKeepInput) {
    super::unported("workspaces:keep")
}

#[tauri::command(rename = "workspaces:archive")]
#[specta::specta]
pub fn workspaces_archive(_input: WorkspacesArchiveInput) {
    super::unported("workspaces:archive")
}

#[tauri::command(rename = "workspaces:open-in-ide")]
#[specta::specta]
pub fn workspaces_open_in_ide(_input: WorkspacesOpenInIdeInput) {
    super::unported("workspaces:open-in-ide")
}

#[tauri::command(rename = "workspaces:set-pinned")]
#[specta::specta]
pub fn workspaces_set_pinned(_input: WorkspacesSetPinnedInput) {
    super::unported("workspaces:set-pinned")
}
