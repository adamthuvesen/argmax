use super::inputs::*;

#[tauri::command(rename = "terminal:spawn")]
#[specta::specta]
pub fn terminal_spawn(_input: TerminalSpawnInput) {
    super::unported("terminal:spawn")
}

#[tauri::command(rename = "terminal:write")]
#[specta::specta]
pub fn terminal_write(_input: TerminalWriteInput) {
    super::unported("terminal:write")
}

#[tauri::command(rename = "terminal:resize")]
#[specta::specta]
pub fn terminal_resize(_input: TerminalResizeInput) {
    super::unported("terminal:resize")
}

#[tauri::command(rename = "terminal:terminate")]
#[specta::specta]
pub fn terminal_terminate(_input: TerminalTerminateInput) {
    super::unported("terminal:terminate")
}
