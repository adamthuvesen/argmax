use super::inputs::*;

#[tauri::command(rename = "health:ping")]
#[specta::specta]
pub fn health_ping(_input: HealthPingInput) {
    super::unported("health:ping")
}
