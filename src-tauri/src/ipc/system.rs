use super::inputs::*;

#[tauri::command(rename = "system:open-path")]
#[specta::specta]
pub fn system_open_path(_input: SystemOpenPathInput) {
    super::unported("system:open-path")
}

#[tauri::command(rename = "system:list-detected-ides")]
#[specta::specta]
pub fn system_list_detected_ides(_input: SystemListDetectedIdesInput) {
    super::unported("system:list-detected-ides")
}

#[tauri::command(rename = "system:diagnostics")]
#[specta::specta]
pub fn system_diagnostics(_input: SystemDiagnosticsInput) {
    super::unported("system:diagnostics")
}

#[tauri::command(rename = "system:vacuum-database")]
#[specta::specta]
pub fn system_vacuum_database(_input: SystemVacuumDatabaseInput) {
    super::unported("system:vacuum-database")
}

#[tauri::command(rename = "system:set-theme")]
#[specta::specta]
pub fn system_set_theme(_input: SystemSetThemeInput) {
    super::unported("system:set-theme")
}
