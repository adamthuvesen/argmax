use super::inputs::*;

#[tauri::command(rename = "dashboard:list")]
#[specta::specta]
pub fn dashboard_list(_input: DashboardListInput) {
    super::unported("dashboard:list")
}

#[tauri::command(rename = "dashboard:load")]
#[specta::specta]
pub fn dashboard_load(_input: DashboardLoadInput) {
    super::unported("dashboard:load")
}
