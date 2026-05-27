use super::inputs::*;

#[tauri::command(rename = "projects:list")]
#[specta::specta]
pub fn projects_list(_input: ProjectsListInput) {
    super::unported("projects:list")
}

#[tauri::command(rename = "projects:pick-folder")]
#[specta::specta]
pub fn projects_pick_folder(_input: ProjectsPickFolderInput) {
    super::unported("projects:pick-folder")
}

#[tauri::command(rename = "projects:register")]
#[specta::specta]
pub fn projects_register(_input: ProjectsRegisterInput) {
    super::unported("projects:register")
}

#[tauri::command(rename = "projects:remove")]
#[specta::specta]
pub fn projects_remove(_input: ProjectsRemoveInput) {
    super::unported("projects:remove")
}

#[tauri::command(rename = "projects:update-settings")]
#[specta::specta]
pub fn projects_update_settings(_input: ProjectsUpdateSettingsInput) {
    super::unported("projects:update-settings")
}

#[tauri::command(rename = "projects:list-branches")]
#[specta::specta]
pub fn projects_list_branches(_input: ProjectsListBranchesInput) {
    super::unported("projects:list-branches")
}

#[tauri::command(rename = "projects:switch-branch")]
#[specta::specta]
pub fn projects_switch_branch(_input: ProjectsSwitchBranchInput) {
    super::unported("projects:switch-branch")
}
