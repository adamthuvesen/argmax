//! Window snapshot: a global chord that attaches the frontmost app's window to
//! the Argmax composer as an image.
//!
//! The order is the point. The chord fires while another app is frontmost, so
//! the app, its top window and the picture are all taken first; only then does
//! Argmax raise its own window and hand the result to the renderer as the
//! `composer:attach-window-snapshot` event. A failure travels as
//! `window-snapshot:failed` and is never an empty attachment.
//!
//! Capture is macOS-only. Elsewhere every entry point answers
//! [`SnapshotError::Unsupported`], and Settings says so.

pub mod capture;
#[cfg(target_os = "macos")]
mod macos;
pub mod shortcut;
pub mod target;

use std::path::Path;

use serde::Serialize;
use specta::Type;

use crate::attachments::store::AttachmentStore;
use crate::ipc::validation::{AttachmentMimeType, SessionId};

pub const ATTACH_EVENT: &str = "composer:attach-window-snapshot";
pub const FAILED_EVENT: &str = "window-snapshot:failed";
/// The attachment store folder snapshots land in. Not a chat's own folder, so
/// deleting a chat never deletes a snapshot still waiting in another draft.
const STORE_FOLDER: &str = "window-snapshots";

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SnapshotError {
    #[error("Window snapshots are only available on macOS.")]
    Unsupported,
    #[error("Screen Recording is off for Argmax. Allow it in System Settings, then try again.")]
    PermissionDenied,
    #[error(
        "Argmax is the frontmost app. Switch to the window you want, then press the shortcut."
    )]
    NoExternalApp,
    #[error("{0} has no window on screen to capture.")]
    NoWindow(String),
    #[error("The capture came back empty. Check Screen Recording access for Argmax.")]
    BlankCapture,
    #[error("The snapshot is larger than an attachment may be.")]
    TooLarge,
    #[error("Could not capture the window: {0}")]
    CaptureFailed(String),
    #[error("Could not save the snapshot: {0}")]
    StoreFailed(String),
}

impl SnapshotError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported-platform",
            Self::PermissionDenied => "screen-recording-denied",
            Self::NoExternalApp => "no-external-app",
            Self::NoWindow(_) => "no-window",
            Self::BlankCapture => "blank-capture",
            Self::TooLarge => "too-large",
            Self::CaptureFailed(_) => "capture-failed",
            Self::StoreFailed(_) => "store-failed",
        }
    }

    /// What the failure toast can offer. Only a permission problem has one.
    fn action(&self) -> Option<&'static str> {
        match self {
            Self::PermissionDenied | Self::BlankCapture => Some("open-screen-recording-settings"),
            _ => None,
        }
    }

    pub fn payload(&self) -> SnapshotFailure {
        SnapshotFailure {
            code: self.code().to_owned(),
            message: self.to_string(),
            action: self.action().map(str::to_owned),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFailure {
    pub code: String,
    pub message: String,
    pub action: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotAttachment {
    pub file_path: String,
    pub mime_type: String,
    pub size_bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSource {
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    /// RFC 3339.
    pub captured_at: String,
}

/// The `composer:attach-window-snapshot` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshotAttach {
    pub attachment: SnapshotAttachment,
    pub source: SnapshotSource,
}

/// What the capture needs to know about the app it was taken from.
struct Target {
    window_id: u32,
    app_name: String,
    bundle_id: Option<String>,
    window_title: Option<String>,
}

/// Pick the window to capture from the frontmost app, before anything of
/// Argmax's own is raised. `own_pid` is Argmax: pressing the chord while it is
/// frontmost is an error, not a snapshot of Argmax itself.
#[cfg(target_os = "macos")]
fn resolve_target(own_pid: i32) -> Result<Target, SnapshotError> {
    if !macos::screen_recording_granted() {
        return Err(SnapshotError::PermissionDenied);
    }
    let app = macos::frontmost_app().ok_or(SnapshotError::NoExternalApp)?;
    if app.pid == own_pid {
        return Err(SnapshotError::NoExternalApp);
    }
    let windows = macos::on_screen_windows();
    let window = target::pick_window(&windows, app.pid)
        .ok_or_else(|| SnapshotError::NoWindow(app.name.clone()))?;
    Ok(Target {
        window_id: window.id,
        window_title: window.title.clone(),
        app_name: app.name,
        bundle_id: app.bundle_id,
    })
}

#[cfg(not(target_os = "macos"))]
fn resolve_target(_own_pid: i32) -> Result<Target, SnapshotError> {
    Err(SnapshotError::Unsupported)
}

/// Capture the frontmost external app's top window into the attachment store.
pub fn capture_frontmost_window(
    store: &AttachmentStore,
    own_pid: i32,
) -> Result<WindowSnapshotAttach, SnapshotError> {
    let target = resolve_target(own_pid)?;
    capture_target(
        store,
        &target,
        Path::new(capture::SCREENCAPTURE),
        Path::new(capture::SIPS),
    )
}

fn capture_target(
    store: &AttachmentStore,
    target: &Target,
    program: &Path,
    sips: &Path,
) -> Result<WindowSnapshotAttach, SnapshotError> {
    let scratch = tempfile::tempdir()
        .map_err(|error| SnapshotError::CaptureFailed(format!("no scratch directory: {error}")))?;
    let output = scratch.path().join("window.png");
    capture::run_screencapture(program, target.window_id, &output)?;
    let bytes = std::fs::read(&output).map_err(|error| {
        SnapshotError::CaptureFailed(format!("the capture wrote no file: {error}"))
    })?;
    // Held to the pasted-image edge before the size cap and the provider's
    // line budget see it.
    let bytes = capture::prepare_png(bytes, scratch.path(), sips)?;

    let folder = SessionId::try_from(STORE_FOLDER.to_owned()).expect("a fixed, valid folder name");
    let saved = store
        .save_bytes(&folder, AttachmentMimeType::ImagePng, &bytes)
        .map_err(|error| match error {
            crate::attachments::store::AttachmentStoreError::TooLarge { .. } => {
                SnapshotError::TooLarge
            }
            other => SnapshotError::StoreFailed(other.to_string()),
        })?;
    Ok(WindowSnapshotAttach {
        attachment: SnapshotAttachment {
            file_path: saved.file_path,
            mime_type: "image/png".to_owned(),
            size_bytes: u32::try_from(saved.size_bytes).unwrap_or(u32::MAX),
        },
        source: SnapshotSource {
            app_name: target.app_name.clone(),
            bundle_id: target.bundle_id.clone(),
            window_title: target.window_title.clone(),
            captured_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        },
    })
}

/// "granted" or "denied". Elsewhere than macOS the question does not arise.
pub fn permission_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        if macos::screen_recording_granted() {
            "granted"
        } else {
            "denied"
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unsupported"
    }
}

/// Shows the system prompt where macOS still shows one. `true` once granted.
pub fn request_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::request_screen_recording()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub const fn is_supported() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(test)]
mod tests {
    use super::*;
    use capture::fixtures::rgba_png;

    #[cfg(unix)]
    fn tool_writing(dir: &Path, png: &[u8]) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let fixture = dir.join("fixture.png");
        std::fs::write(&fixture, png).unwrap();
        let tool = dir.join("screencapture");
        std::fs::write(
            &tool,
            format!(
                "#!/bin/sh\nfor last; do :; done\ncp '{}' \"$last\"\n",
                fixture.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        tool
    }

    fn target() -> Target {
        Target {
            window_id: 7,
            app_name: "Safari".to_owned(),
            bundle_id: Some("com.apple.Safari".to_owned()),
            window_title: Some("Docs".to_owned()),
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_capture_lands_in_the_attachment_store_with_its_source() {
        let dir = tempfile::tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path().join("attachments"));
        let tool = tool_writing(dir.path(), &rgba_png(20, 10, [9, 9, 9, 255]));

        let snapshot = capture_target(&store, &target(), &tool, Path::new(capture::SIPS)).unwrap();

        assert_eq!(snapshot.attachment.mime_type, "image/png");
        assert!(snapshot.attachment.file_path.contains("window-snapshots"));
        let written = std::fs::read(&snapshot.attachment.file_path).unwrap();
        assert_eq!(written.len() as u32, snapshot.attachment.size_bytes);
        assert_eq!(capture::verify_png(&written), Ok((20, 10)));
        assert_eq!(snapshot.source.app_name, "Safari");
        assert_eq!(snapshot.source.window_title.as_deref(), Some("Docs"));
        assert!(chrono::DateTime::parse_from_rfc3339(&snapshot.source.captured_at).is_ok());
    }

    /// A Retina-sized capture goes through the real `sips` before the store.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_retina_capture_is_stored_at_the_paste_edge() {
        let dir = tempfile::tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path().join("attachments"));
        let tool = tool_writing(dir.path(), &rgba_png(5120, 2880, [9, 9, 9, 255]));

        let snapshot = capture_target(&store, &target(), &tool, Path::new(capture::SIPS)).unwrap();

        let written = std::fs::read(&snapshot.attachment.file_path).unwrap();
        assert_eq!(capture::verify_png(&written), Ok((1920, 1080)));
        assert_eq!(written.len() as u32, snapshot.attachment.size_bytes);
    }

    #[cfg(unix)]
    #[test]
    fn a_blank_capture_saves_nothing_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path().join("attachments"));
        let tool = tool_writing(dir.path(), &rgba_png(20, 10, [0, 0, 0, 0]));

        let error = capture_target(&store, &target(), &tool, Path::new(capture::SIPS)).unwrap_err();

        assert_eq!(error, SnapshotError::BlankCapture);
        assert!(
            !dir.path().join("attachments").exists(),
            "nothing reached the store"
        );
    }

    #[test]
    fn failures_carry_a_stable_code_and_only_permission_failures_offer_an_action() {
        let denied = SnapshotError::PermissionDenied.payload();
        assert_eq!(denied.code, "screen-recording-denied");
        assert_eq!(
            denied.action.as_deref(),
            Some("open-screen-recording-settings")
        );
        assert_eq!(SnapshotError::NoExternalApp.payload().action, None);
        assert_eq!(
            SnapshotError::Unsupported.payload().code,
            "unsupported-platform"
        );
        assert!(SnapshotError::NoWindow("Mail".to_owned())
            .to_string()
            .contains("Mail"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn where_capture_is_unavailable_every_entry_point_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path());
        assert_eq!(
            capture_frontmost_window(&store, 1).unwrap_err(),
            SnapshotError::Unsupported
        );
        assert!(!is_supported());
        assert_eq!(permission_label(), "unsupported");
    }

    /// Real capture of whatever app is frontmost when the test runs. Ignored:
    /// it needs Screen Recording for the process running `cargo test`. Run it
    /// by hand with `cargo test --lib live_capture -- --ignored --nocapture`
    /// from a terminal that has the grant, with another app in front.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "needs Screen Recording access and a frontmost app"]
    fn live_capture_of_the_frontmost_window() {
        let dir = tempfile::tempdir().unwrap();
        let store = AttachmentStore::with_base_dir(dir.path());
        match capture_frontmost_window(&store, -1) {
            Ok(snapshot) => eprintln!("captured {:?}", snapshot),
            Err(error) => eprintln!("refused with {}: {error}", error.code()),
        }
    }
}
