use super::inputs::*;

#[tauri::command(rename = "checkpoints:create")]
#[specta::specta]
pub fn checkpoints_create(_input: CheckpointsCreateInput) {
    super::unported("checkpoints:create")
}
