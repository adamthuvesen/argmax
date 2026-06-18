// Custom protocol handler for `argmax-attachment://`.
//
// The path-validation + bytes-fetching logic lives in `serve_attachment`
// as a pure function; the Tauri protocol hook is wired in `lib.rs::run`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use specta::Type;
use tokio::fs;

/// URL scheme name. Must be registered with Tauri before the webview
/// loads or requests routed at it will 404.
pub const ATTACHMENT_PROTOCOL_SCHEME: &str = "argmax-attachment";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub enum AttachmentStatus {
    Ok,
    NotFound,
    Forbidden,
    BadRequest,
}

#[derive(Debug, Clone)]
pub struct AttachmentResponse {
    pub status: AttachmentStatus,
    pub content_type: Option<&'static str>,
    pub bytes: Vec<u8>,
}

impl AttachmentResponse {
    fn forbidden() -> Self {
        Self {
            status: AttachmentStatus::Forbidden,
            content_type: None,
            bytes: Vec::new(),
        }
    }
    fn not_found() -> Self {
        Self {
            status: AttachmentStatus::NotFound,
            content_type: None,
            bytes: Vec::new(),
        }
    }
    fn bad_request() -> Self {
        Self {
            status: AttachmentStatus::BadRequest,
            content_type: None,
            bytes: Vec::new(),
        }
    }

    /// HTTP status code Tauri's protocol handler should return for this result.
    pub fn http_status(&self) -> u16 {
        match self.status {
            AttachmentStatus::Ok => 200,
            AttachmentStatus::BadRequest => 400,
            AttachmentStatus::Forbidden => 403,
            AttachmentStatus::NotFound => 404,
        }
    }
}

/// Serve a request URL like `argmax-attachment://localhost/<absolute-path>`
/// (Tauri passes the URL as-is to the registered handler). The path is
/// resolved against `base_dir` after realpath; any escape returns 403.
pub async fn serve_attachment(base_dir: &Path, url: &str) -> AttachmentResponse {
    let Some(path_component) = extract_url_path(url) else {
        return AttachmentResponse::bad_request();
    };
    let Ok(decoded) = percent_decode(&path_component) else {
        return AttachmentResponse::bad_request();
    };

    let Ok(base_real) = fs::canonicalize(base_dir).await else {
        return AttachmentResponse::forbidden();
    };
    let candidate = PathBuf::from(decoded);
    if !candidate.is_absolute() {
        return AttachmentResponse::forbidden();
    }

    // canonicalize fails for missing files — return NotFound rather
    // than Forbidden so an honest 404 surfaces. The containment check
    // below catches escapes for files that DO exist.
    let canonical = match fs::canonicalize(&candidate).await {
        Ok(path) => path,
        Err(_) => return AttachmentResponse::not_found(),
    };
    // File paths must live strictly inside base, not at the base dir
    // itself (matches the TS `isFileUnderBase`).
    if canonical == base_real || !canonical.starts_with(&base_real) {
        return AttachmentResponse::forbidden();
    }

    let bytes = match fs::read(&canonical).await {
        Ok(bytes) => bytes,
        Err(_) => return AttachmentResponse::not_found(),
    };
    let content_type = content_type_for_path(&canonical);
    AttachmentResponse {
        status: AttachmentStatus::Ok,
        content_type: Some(content_type),
        bytes,
    }
}

fn extract_url_path(url: &str) -> Option<String> {
    // Accept both `scheme://host/path` and `scheme:/path` forms. The
    // Tauri protocol surface usually passes the former.
    let prefix = format!("{ATTACHMENT_PROTOCOL_SCHEME}://");
    if let Some(rest) = url.strip_prefix(&prefix) {
        // Drop the host segment (typically "localhost" on Tauri).
        let after_host = rest.split_once('/').map(|(_, path)| path).unwrap_or(rest);
        // Anything after `?` or `#` is metadata, drop it.
        let path_only = after_host.split(['?', '#']).next()?;
        return Some(format!("/{path_only}"));
    }
    let prefix = format!("{ATTACHMENT_PROTOCOL_SCHEME}:");
    if let Some(rest) = url.strip_prefix(&prefix) {
        return Some(rest.to_string());
    }
    None
}

pub(crate) fn percent_decode(input: &str) -> Result<String, ()> {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if byte == b'%' {
            if i + 2 >= bytes.len() {
                return Err(());
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| ())?;
            let decoded = u8::from_str_radix(hex, 16).map_err(|_| ())?;
            out.push(decoded);
            i += 3;
        } else {
            out.push(byte);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

pub(crate) fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn url_for(path: &Path) -> String {
        format!(
            "{ATTACHMENT_PROTOCOL_SCHEME}://localhost{}",
            path.to_string_lossy()
        )
    }

    #[tokio::test]
    async fn serves_file_under_base_with_correct_mime() {
        let base = TempDir::new().unwrap();
        let file = base.path().join("hello.png");
        std::fs::write(&file, b"PNGDATA").unwrap();
        let canonical_file = std::fs::canonicalize(&file).unwrap();
        let response = serve_attachment(base.path(), &url_for(&canonical_file)).await;
        assert_eq!(response.status, AttachmentStatus::Ok);
        assert_eq!(response.content_type, Some("image/png"));
        assert_eq!(response.bytes, b"PNGDATA");
    }

    #[tokio::test]
    async fn rejects_path_outside_base() {
        let base = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let escape = outside.path().join("steal.png");
        std::fs::write(&escape, b"X").unwrap();
        let canonical = std::fs::canonicalize(&escape).unwrap();
        let response = serve_attachment(base.path(), &url_for(&canonical)).await;
        assert_eq!(response.status, AttachmentStatus::Forbidden);
    }

    #[tokio::test]
    async fn rejects_base_directory_itself() {
        let base = TempDir::new().unwrap();
        let canonical = std::fs::canonicalize(base.path()).unwrap();
        let response = serve_attachment(base.path(), &url_for(&canonical)).await;
        assert_eq!(response.status, AttachmentStatus::Forbidden);
    }

    #[tokio::test]
    async fn missing_file_returns_not_found() {
        let base = TempDir::new().unwrap();
        let ghost = base.path().join("ghost.png");
        let response = serve_attachment(base.path(), &url_for(&ghost)).await;
        assert_eq!(response.status, AttachmentStatus::NotFound);
    }

    #[tokio::test]
    async fn percent_encoded_path_decodes() {
        let base = TempDir::new().unwrap();
        let file = base.path().join("hello world.png");
        std::fs::write(&file, b"data").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let url = format!(
            "{ATTACHMENT_PROTOCOL_SCHEME}://localhost{}",
            canonical.to_string_lossy().replace(' ', "%20")
        );
        let response = serve_attachment(base.path(), &url).await;
        assert_eq!(response.status, AttachmentStatus::Ok);
    }

    #[tokio::test]
    async fn bad_url_returns_bad_request() {
        let base = TempDir::new().unwrap();
        let response = serve_attachment(base.path(), "https://example.com/foo").await;
        assert_eq!(response.status, AttachmentStatus::BadRequest);
    }

    #[test]
    fn http_status_maps_each_variant() {
        assert_eq!(AttachmentResponse::not_found().http_status(), 404);
        assert_eq!(AttachmentResponse::forbidden().http_status(), 403);
        assert_eq!(AttachmentResponse::bad_request().http_status(), 400);
        let ok = AttachmentResponse {
            status: AttachmentStatus::Ok,
            content_type: Some("image/png"),
            bytes: Vec::new(),
        };
        assert_eq!(ok.http_status(), 200);
    }
}
