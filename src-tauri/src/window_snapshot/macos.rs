//! The macOS half: who is frontmost, which of their windows is on top, and
//! whether Screen Recording is allowed.
//!
//! Window ids and titles come from `CGWindowListCopyWindowInfo`, the metadata
//! API; it is not the image API Apple removed from current SDKs. Reading
//! another app's window titles needs the same Screen Recording grant the
//! capture does, so a denied grant also shows up here as missing titles.

use objc2_app_kit::NSWorkspace;
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_graphics::{
    kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowLayer, kCGWindowName,
    kCGWindowNumber, kCGWindowOwnerPID, CGPreflightScreenCaptureAccess,
    CGRequestScreenCaptureAccess, CGWindowListCopyWindowInfo, CGWindowListOption,
};

use super::target::WindowCandidate;

#[derive(Debug, Clone, PartialEq)]
pub struct FrontmostApp {
    pub pid: i32,
    pub name: String,
    pub bundle_id: Option<String>,
}

/// The app that has the keyboard right now. Read first, before Argmax raises
/// its own window, or it would only ever find Argmax.
pub fn frontmost_app() -> Option<FrontmostApp> {
    let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let bundle_id = app.bundleIdentifier().map(|id| id.to_string());
    let name = app
        .localizedName()
        .map(|name| name.to_string())
        .or_else(|| bundle_id.clone())
        .unwrap_or_else(|| "Unknown app".to_owned());
    Some(FrontmostApp {
        pid: app.processIdentifier(),
        name,
        bundle_id,
    })
}

pub fn screen_recording_granted() -> bool {
    CGPreflightScreenCaptureAccess()
}

/// Shows the system prompt the first time, and answers whether access is
/// granted. After a refusal macOS shows nothing, and the caller points the
/// user at System Settings instead.
pub fn request_screen_recording() -> bool {
    CGRequestScreenCaptureAccess()
}

type Dict = CFDictionary<CFString, CFType>;

fn int(dict: &Dict, key: &CFString) -> Option<i64> {
    dict.get(key)?.downcast_ref::<CFNumber>()?.as_i64()
}

fn float(dict: &Dict, key: &CFString) -> Option<f64> {
    dict.get(key)?.downcast_ref::<CFNumber>()?.as_f64()
}

fn text(dict: &Dict, key: &CFString) -> Option<String> {
    Some(dict.get(key)?.downcast_ref::<CFString>()?.to_string())
}

fn nested(dict: &Dict, key: &CFString) -> Option<CFRetained<Dict>> {
    let inner = dict.get(key)?.downcast::<CFDictionary>().ok()?;
    // SAFETY: window-server dictionaries are keyed by strings and hold CF values.
    Some(unsafe { CFRetained::cast_unchecked::<Dict>(inner) })
}

/// On-screen windows, front to back.
pub fn on_screen_windows() -> Vec<WindowCandidate> {
    let options =
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(options, kCGNullWindowID) else {
        return Vec::new();
    };
    // SAFETY: the window server returns an array of window dictionaries.
    let list = unsafe { CFRetained::cast_unchecked::<CFArray<Dict>>(list) };
    let mut windows = Vec::new();
    for dict in list.iter() {
        let (Some(id), Some(pid)) = (
            int(&dict, unsafe { kCGWindowNumber }),
            int(&dict, unsafe { kCGWindowOwnerPID }),
        ) else {
            continue;
        };
        let (width, height) = nested(&dict, unsafe { kCGWindowBounds })
            .map(|bounds| {
                let size = |name: &str| float(&bounds, &CFString::from_str(name)).unwrap_or(0.0);
                (size("Width"), size("Height"))
            })
            .unwrap_or((0.0, 0.0));
        windows.push(WindowCandidate {
            id: id as u32,
            owner_pid: pid as i32,
            title: text(&dict, unsafe { kCGWindowName }).filter(|title| !title.is_empty()),
            layer: int(&dict, unsafe { kCGWindowLayer }).unwrap_or(0) as i32,
            alpha: float(&dict, unsafe { kCGWindowAlpha }).unwrap_or(1.0),
            width,
            height,
        });
    }
    windows
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads the real window server. It proves the CoreGraphics bindings decode
    /// real dictionaries; what it finds depends on the machine, so it asserts
    /// shape, not content.
    #[test]
    fn the_window_server_list_decodes_into_candidates() {
        let windows = on_screen_windows();
        for window in &windows {
            assert!(window.owner_pid > 0);
            assert!(window.width >= 0.0 && window.height >= 0.0);
        }
        eprintln!(
            "{} on-screen windows; screen recording granted: {}",
            windows.len(),
            screen_recording_granted()
        );
    }

    #[test]
    fn the_frontmost_app_has_a_pid_and_a_name_when_there_is_one() {
        if let Some(app) = frontmost_app() {
            assert!(app.pid > 0);
            assert!(!app.name.is_empty());
        }
    }
}
