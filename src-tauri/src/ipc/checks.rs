use super::inputs::*;

#[tauri::command(rename = "checks:run")]
#[specta::specta]
pub fn checks_run(_input: ChecksRunInput) {
    super::unported("checks:run")
}
