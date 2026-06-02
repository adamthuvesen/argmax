//! macOS App Nap suppression.
//!
//! When the Argmax window sits in the background (e.g. the user is watching
//! `tauri dev` logs in a terminal), macOS App Nap suspends the WKWebView
//! "WebContent" process. Tauri's `emit` delivers events by evaluating
//! JavaScript inside that process, and the JS does not run while it's napping —
//! so `dashboard:delta` pushes pile up and only flush when the user refocuses
//! or interacts with the window. The visible symptom is a finished turn stuck
//! on the "thinking" bubble until you click Stop (which both refocuses the app
//! and fires a manual pull of the already-persisted events).
//!
//! Holding an `NSProcessInfo` activity assertion for the lifetime of the
//! process tells macOS we're doing user-initiated work, which keeps the app
//! (and its WebContent process) out of App Nap. This is Apple's documented
//! remedy for "WKWebView JavaScript goes to sleep in the background".

/// Acquire a process-lifetime activity assertion that keeps macOS App Nap from
/// suspending the webview. No-op on every other platform.
#[cfg(target_os = "macos")]
pub fn prevent_app_nap() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    let reason = NSString::from_str(
        "Argmax streams live agent output to the UI while the window is in the background",
    );
    // `UserInitiatedAllowingIdleSystemSleep` blocks App Nap (and automatic
    // termination) without preventing the display or system from sleeping —
    // we only need the app to keep processing, not to keep the Mac awake.
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &reason,
    );
    // The assertion lasts exactly as long as the returned token is retained.
    // Argmax wants it for the whole run, so deliberately leak the token instead
    // of threading an end-of-life handle through app state.
    std::mem::forget(activity);
    tracing::info!("macOS App Nap suppressed for live event delivery");
}

/// No-op on non-macOS platforms — App Nap is a macOS-only power feature.
#[cfg(not(target_os = "macos"))]
pub fn prevent_app_nap() {}
