use tauri::{AppHandle, Manager, Webview};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::validation::ThemeMode;

/// Applies a website appearance without changing the app shell's appearance.
pub fn apply(webview: &Webview, mode: ThemeMode) -> ArgmaxResult<()> {
    apply_platform_theme(webview, mode)
        .map_err(|error| ArgmaxError::service("BROWSER_THEME_FAILED", error.to_string()))
}

pub fn apply_all(app: &AppHandle, mode: ThemeMode) -> ArgmaxResult<()> {
    for (label, webview) in app.webviews() {
        if label.starts_with("browser-") {
            apply(&webview, mode)?;
        }
    }
    Ok(())
}

/// Keeps System browser appearance live even when the app itself is pinned to
/// Light or Dark. AppKit's ordinary effective-appearance event follows the
/// app override, so the browser observes the global notification directly.
#[cfg(target_os = "macos")]
pub fn observe_system_changes(app: &AppHandle) {
    use std::ptr::NonNull;
    use std::sync::Once;

    use block2::RcBlock;
    use objc2_foundation::{
        NSDistributedNotificationCenter, NSNotification, NSNotificationName, NSOperationQueue,
        NSString,
    };

    static INSTALL: Once = Once::new();
    let app = app.clone();
    INSTALL.call_once(move || {
        let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            let mode = *app
                .state::<crate::state::AppState>()
                .browser_theme
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if mode == ThemeMode::System {
                if let Err(error) = apply_all(&app, mode) {
                    tracing::warn!(%error, "could not follow macOS browser appearance");
                }
            }
        });
        let name = NSString::from_str("AppleInterfaceThemeChangedNotification");
        // SAFETY: the distributed center retains the observer and block for
        // the process lifetime, and the main queue satisfies WebKit's thread
        // confinement requirement.
        unsafe {
            NSDistributedNotificationCenter::defaultCenter()
                .addObserverForName_object_queue_usingBlock(
                    Some(&name as &NSNotificationName),
                    None,
                    Some(&NSOperationQueue::mainQueue()),
                    &block,
                );
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn observe_system_changes(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
fn apply_platform_theme(webview: &Webview, mode: ThemeMode) -> tauri::Result<()> {
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    };
    use objc2_foundation::{NSString, NSUserDefaults};
    use objc2_web_kit::WKWebView;

    webview.with_webview(move |platform| {
        // SAFETY: Tauri supplies the live WKWebView pointer and schedules this
        // closure on AppKit's main thread.
        unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            // A nil appearance inherits NSApplication.appearance, which is the
            // app theme, not necessarily macOS's preference. Resolve System
            // from the global user default so browser and app can diverge.
            let dark = match mode {
                ThemeMode::Light => false,
                ThemeMode::Dark => true,
                ThemeMode::System => NSUserDefaults::standardUserDefaults()
                    .stringForKey(&NSString::from_str("AppleInterfaceStyle"))
                    .is_some_and(|value| value.to_string().eq_ignore_ascii_case("dark")),
            };
            let appearance = NSAppearance::appearanceNamed(if dark {
                NSAppearanceNameDarkAqua
            } else {
                NSAppearanceNameAqua
            });
            view.setAppearance(appearance.as_deref());
        }
    })
}

#[cfg(not(target_os = "macos"))]
fn apply_platform_theme(_webview: &Webview, _mode: ThemeMode) -> tauri::Result<()> {
    Ok(())
}
