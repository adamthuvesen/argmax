use super::inputs::*;
use crate::{
    attachments::store::{AttachmentStore, AttachmentStoreError, SaveImageResult},
    error::{ArgmaxError, ArgmaxResult},
};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

#[tauri::command(rename = "attachments:save-image")]
#[specta::specta]
pub fn attachments_save_image(
    app: AppHandle,
    input: AttachmentsSaveImageInput,
) -> ArgmaxResult<SaveImageResult> {
    let store = AttachmentStore::from_data_dir(data_dir(&app)?);
    store
        .save_image(&input.session_id, input.mime_type, &input.data_base64)
        .map_err(attachment_error)
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> ArgmaxResult<PathBuf> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| ArgmaxError::service("APP_DATA_DIR", error.to_string()))?;
    Ok(app_data.join("local-state"))
}

fn attachment_error(error: AttachmentStoreError) -> ArgmaxError {
    match error {
        AttachmentStoreError::InvalidMime => {
            ArgmaxError::service("ATTACHMENT_INVALID_MIME", error.to_string())
        }
        AttachmentStoreError::EmptyPayload => {
            ArgmaxError::service("ATTACHMENT_EMPTY", error.to_string())
        }
        AttachmentStoreError::TooLarge { .. } => {
            ArgmaxError::service("ATTACHMENT_TOO_LARGE", error.to_string())
        }
        AttachmentStoreError::InvalidSessionId => {
            ArgmaxError::service("ATTACHMENT_INVALID_SESSION", error.to_string())
        }
        AttachmentStoreError::InvalidBase64 => {
            ArgmaxError::service("ATTACHMENT_INVALID_BASE64", error.to_string())
        }
        AttachmentStoreError::WriteFailed(_) => {
            ArgmaxError::service("ATTACHMENT_WRITE_FAILED", error.to_string())
        }
    }
}
