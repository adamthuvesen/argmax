use super::inputs::*;

#[tauri::command(rename = "workspace:status")]
#[specta::specta]
pub fn workspace_status(_input: WorkspaceStatusInput) {
    super::unported("workspace:status")
}

#[tauri::command(rename = "workspace:list-files")]
#[specta::specta]
pub fn workspace_list_files(_input: WorkspaceListFilesInput) {
    super::unported("workspace:list-files")
}

#[tauri::command(rename = "workspace:read-file")]
#[specta::specta]
pub fn workspace_read_file(_input: WorkspaceReadFileInput) {
    super::unported("workspace:read-file")
}

#[tauri::command(rename = "workspace:list-files-for-project")]
#[specta::specta]
pub fn workspace_list_files_for_project(_input: WorkspaceListFilesForProjectInput) {
    super::unported("workspace:list-files-for-project")
}

#[tauri::command(rename = "workspace:read-file-for-project")]
#[specta::specta]
pub fn workspace_read_file_for_project(_input: WorkspaceReadFileForProjectInput) {
    super::unported("workspace:read-file-for-project")
}

#[tauri::command(rename = "workspace:write-file")]
#[specta::specta]
pub fn workspace_write_file(_input: WorkspaceWriteFileInput) {
    super::unported("workspace:write-file")
}

#[tauri::command(rename = "workspace:stat-file")]
#[specta::specta]
pub fn workspace_stat_file(_input: WorkspaceStatFileInput) {
    super::unported("workspace:stat-file")
}

#[tauri::command(rename = "workspace:write-file-for-project")]
#[specta::specta]
pub fn workspace_write_file_for_project(_input: WorkspaceWriteFileForProjectInput) {
    super::unported("workspace:write-file-for-project")
}

#[tauri::command(rename = "workspace:stat-file-for-project")]
#[specta::specta]
pub fn workspace_stat_file_for_project(_input: WorkspaceStatFileForProjectInput) {
    super::unported("workspace:stat-file-for-project")
}

#[tauri::command(rename = "workspace:grep-content")]
#[specta::specta]
pub fn workspace_grep_content(_input: WorkspaceGrepContentInput) {
    super::unported("workspace:grep-content")
}
