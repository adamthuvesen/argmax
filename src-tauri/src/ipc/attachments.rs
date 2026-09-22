use super::inputs::*;
use crate::{
    attachments::store::{AttachmentStore, AttachmentStoreError, SaveImageResult},
    error::{ArgmaxError, ArgmaxResult},
};
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

#[tauri::command(rename = "attachments:save-image")]
#[specta::specta]
pub async fn attachments_save_image(
    app: AppHandle,
    input: AttachmentsSaveImageInput,
) -> ArgmaxResult<SaveImageResult> {
    let store = AttachmentStore::from_data_dir(data_dir(&app)?);
    // Up to 10 MiB of base64 decode plus a file write: off the main thread so
    // pasting a large screenshot cannot freeze the window.
    tauri::async_runtime::spawn_blocking(move || save_image(&store, input))
        .await
        .map_err(|error| ArgmaxError::service("ATTACHMENT_SAVE_JOIN", error.to_string()))?
}

/// Shared by the native command and the remote dispatcher. The native command
/// owns the app-data lookup; the remote path receives the same store from
/// `AppState` after setup has resolved that directory.
pub(crate) fn save_image(
    store: &AttachmentStore,
    input: AttachmentsSaveImageInput,
) -> ArgmaxResult<SaveImageResult> {
    store
        .save_image(&input.session_id, input.mime_type, &input.data_base64)
        .map_err(attachment_error)
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> ArgmaxResult<PathBuf> {
    let app_data = crate::util::data_dir::app_data_dir(app)
        .map_err(|error| ArgmaxError::service("APP_DATA_DIR", error.to_string()))?;
    Ok(app_data.join("local-state"))
}

fn attachment_error(error: AttachmentStoreError) -> ArgmaxError {
    match error {
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
