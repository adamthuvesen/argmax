use super::inputs::*;

#[tauri::command(rename = "attachments:save-image")]
#[specta::specta]
pub fn attachments_save_image(_input: AttachmentsSaveImageInput) {
    super::unported("attachments:save-image")
}
