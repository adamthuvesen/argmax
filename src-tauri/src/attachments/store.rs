use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use serde::Serialize;
use specta::Type;
use uuid::Uuid;

use crate::ipc::validation::{AttachmentMimeType, Base64ImageData, SessionId, ATTACHMENT_BYTE_CAP};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveImageResult {
    pub file_path: String,
    pub size_bytes: usize,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum AttachmentStoreError {
    #[error("unsupported mime type")]
    InvalidMime,
    #[error("empty attachment payload")]
    EmptyPayload,
    #[error("attachment is {actual} bytes, exceeds {max} byte cap")]
    TooLarge { actual: usize, max: usize },
    #[error("session id resolves outside the attachments root")]
    InvalidSessionId,
    #[error("invalid base64 attachment payload")]
    InvalidBase64,
    #[error("could not write attachment: {0}")]
    WriteFailed(String),
}

#[derive(Debug, Clone)]
pub struct AttachmentStore {
    base_dir: PathBuf,
}

impl AttachmentStore {
    pub fn from_data_dir(data_dir: impl AsRef<Path>) -> Self {
        Self {
            base_dir: data_dir.as_ref().join("attachments"),
        }
    }

    pub fn with_base_dir(base_dir: impl AsRef<Path>) -> Self {
        Self {
            base_dir: base_dir.as_ref().to_path_buf(),
        }
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    pub fn save_image(
        &self,
        session_id: &SessionId,
        mime_type: AttachmentMimeType,
        data_base64: &Base64ImageData,
    ) -> Result<SaveImageResult, AttachmentStoreError> {
        let buffer = decode_base64(data_base64.as_str())?;
        if buffer.is_empty() {
            return Err(AttachmentStoreError::EmptyPayload);
        }
        if buffer.len() > ATTACHMENT_BYTE_CAP {
            return Err(AttachmentStoreError::TooLarge {
                actual: buffer.len(),
                max: ATTACHMENT_BYTE_CAP,
            });
        }

        let session_dir = self.session_dir(session_id)?;
        fs::create_dir_all(&session_dir)
            .map_err(|error| AttachmentStoreError::WriteFailed(error.to_string()))?;

        let file_path = session_dir.join(format!(
            "{}.{}",
            Uuid::new_v4(),
            extension_for_mime(mime_type)?
        ));
        fs::write(&file_path, &buffer)
            .map_err(|error| AttachmentStoreError::WriteFailed(error.to_string()))?;

        Ok(SaveImageResult {
            file_path: file_path.to_string_lossy().into_owned(),
            size_bytes: buffer.len(),
        })
    }

    pub fn prune_session(&self, session_id: &SessionId) -> Result<(), AttachmentStoreError> {
        let session_dir = self.session_dir(session_id)?;
        fs::remove_dir_all(&session_dir).or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(AttachmentStoreError::WriteFailed(error.to_string()))
            }
        })
    }

    fn session_dir(&self, session_id: &SessionId) -> Result<PathBuf, AttachmentStoreError> {
        let base = normalize_lexical(&absolute_path(&self.base_dir));
        let session_dir = normalize_lexical(&base.join(session_id.as_str()));
        if session_dir == base || !session_dir.starts_with(&base) {
            return Err(AttachmentStoreError::InvalidSessionId);
        }
        Ok(session_dir)
    }
}

fn extension_for_mime(mime_type: AttachmentMimeType) -> Result<&'static str, AttachmentStoreError> {
    match mime_type {
        AttachmentMimeType::ImagePng => Ok("png"),
        AttachmentMimeType::ImageJpeg => Ok("jpg"),
        AttachmentMimeType::ImageGif => Ok("gif"),
        AttachmentMimeType::ImageWebp => Ok("webp"),
    }
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(_) | Component::RootDir | Component::Prefix(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

fn decode_base64(value: &str) -> Result<Vec<u8>, AttachmentStoreError> {
    let cleaned = value
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();

    if cleaned.is_empty() || cleaned.len() % 4 != 0 {
        return Err(AttachmentStoreError::InvalidBase64);
    }

    let mut decoded = Vec::with_capacity(cleaned.len() / 4 * 3);
    for (index, chunk) in cleaned.chunks_exact(4).enumerate() {
        let is_last = index == cleaned.len() / 4 - 1;
        let padding = chunk.iter().rev().take_while(|byte| **byte == b'=').count();
        if padding > 2 || (!is_last && padding > 0) || chunk[0] == b'=' || chunk[1] == b'=' {
            return Err(AttachmentStoreError::InvalidBase64);
        }
        if padding == 1 && chunk[2] == b'=' {
            return Err(AttachmentStoreError::InvalidBase64);
        }

        let a = base64_value(chunk[0])?;
        let b = base64_value(chunk[1])?;
        let c = if chunk[2] == b'=' {
            0
        } else {
            base64_value(chunk[2])?
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            base64_value(chunk[3])?
        };

        decoded.push((a << 2) | (b >> 4));
        if padding < 2 {
            decoded.push((b << 4) | (c >> 2));
        }
        if padding == 0 {
            decoded.push((c << 6) | d);
        }
    }

    Ok(decoded)
}

fn base64_value(byte: u8) -> Result<u8, AttachmentStoreError> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(AttachmentStoreError::InvalidBase64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const PNG_BASE64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    fn session_id(value: &str) -> SessionId {
        SessionId::try_from(value.to_owned()).unwrap()
    }

    fn data(value: &str) -> Base64ImageData {
        Base64ImageData::try_from(value.to_owned()).unwrap()
    }

    #[test]
    fn saves_png_into_per_session_folder_and_reports_size() {
        let dir = tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path());

        let result = store
            .save_image(
                &session_id("session-1"),
                AttachmentMimeType::ImagePng,
                &data(PNG_BASE64),
            )
            .unwrap();

        assert_eq!(result.size_bytes, decode_base64(PNG_BASE64).unwrap().len());
        assert!(result
            .file_path
            .starts_with(&dir.path().join("session-1").to_string_lossy().to_string()));
        assert!(result.file_path.ends_with(".png"));
        assert_eq!(
            fs::read(result.file_path).unwrap(),
            decode_base64(PNG_BASE64).unwrap()
        );
    }

    #[test]
    fn from_data_dir_nests_under_attachments() {
        let dir = tempdir().unwrap();
        let store = AttachmentStore::from_data_dir(dir.path());

        assert_eq!(store.base_dir(), &dir.path().join("attachments"));
    }

    #[test]
    fn uses_the_right_extension_for_each_supported_mime_type() {
        let dir = tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path());
        let cases = [
            (AttachmentMimeType::ImageJpeg, ".jpg"),
            (AttachmentMimeType::ImageGif, ".gif"),
            (AttachmentMimeType::ImageWebp, ".webp"),
        ];

        for (mime_type, extension) in cases {
            let result = store
                .save_image(&session_id("session-1"), mime_type, &data(PNG_BASE64))
                .unwrap();
            assert!(result.file_path.ends_with(extension));
        }
    }

    #[test]
    fn rejects_oversized_payload() {
        let dir = tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path());
        let too_big = "////".repeat((ATTACHMENT_BYTE_CAP / 3) + 1);

        let error = store
            .save_image(
                &session_id("session-1"),
                AttachmentMimeType::ImagePng,
                &data(&too_big),
            )
            .unwrap_err();

        assert!(matches!(error, AttachmentStoreError::TooLarge { .. }));
    }

    #[test]
    fn rejects_empty_and_invalid_payloads() {
        assert!(matches!(
            decode_base64(""),
            Err(AttachmentStoreError::InvalidBase64)
        ));
        assert!(matches!(
            decode_base64("not@@base64"),
            Err(AttachmentStoreError::InvalidBase64)
        ));
    }

    #[test]
    fn isolates_sessions_in_distinct_subfolders() {
        let dir = tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path());

        let first = store
            .save_image(
                &session_id("session-1"),
                AttachmentMimeType::ImagePng,
                &data(PNG_BASE64),
            )
            .unwrap();
        let second = store
            .save_image(
                &session_id("session-2"),
                AttachmentMimeType::ImagePng,
                &data(PNG_BASE64),
            )
            .unwrap();

        assert_ne!(
            Path::new(&first.file_path).parent(),
            Path::new(&second.file_path).parent()
        );
    }

    #[test]
    fn prune_session_removes_folder_and_missing_folder_is_ok() {
        let dir = tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path());
        let session = session_id("session-1");
        store
            .save_image(&session, AttachmentMimeType::ImagePng, &data(PNG_BASE64))
            .unwrap();

        store.prune_session(&session).unwrap();
        assert!(!dir.path().join("session-1").exists());
        store.prune_session(&session).unwrap();
    }

    #[test]
    fn rejects_session_ids_that_escape_the_attachment_root() {
        let dir = tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path());
        let session = session_id("../outside");

        let error = store
            .save_image(&session, AttachmentMimeType::ImagePng, &data(PNG_BASE64))
            .unwrap_err();

        assert!(matches!(error, AttachmentStoreError::InvalidSessionId));
    }
}
