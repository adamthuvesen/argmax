use super::inputs::*;

#[tauri::command(rename = "attempts:select-preferred")]
#[specta::specta]
pub fn attempts_select_preferred(_input: AttemptsSelectPreferredInput) {
    super::unported("attempts:select-preferred")
}
