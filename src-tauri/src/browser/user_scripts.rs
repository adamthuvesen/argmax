//! Reinstalls a browser tab's injected scripts without Tauri's own.
//!
//! Wry gives every webview it creates
//! `Object.defineProperty(window, 'ipc', { value: … })`, and Tauri adds its
//! API bootstrap beside it. A browser tab needs neither: it reaches Rust
//! through native callbacks and the `argmax-newtab:` scheme, never through
//! Tauri's IPC. The property is also non-configurable and non-writable, so a
//! page whose own script declares `function ipc(…)` at global scope dies on
//! "Can't declare global function 'ipc'" — which is what Google Sheets'
//! editor binary does, and why it showed "Loading issue" over a blank grid.
//!
//! Removing all user scripts and adding ours back is the only way out: no
//! script can redefine or delete that property once WebKit has installed it.
//! This runs on the main thread right after the webview is created, before
//! WebKit can create the first document, so the page never sees either script.
//!
//! macOS only. Elsewhere the tab keeps whatever the builder injected.

use tauri::Webview;

use crate::error::{ArgmaxError, ArgmaxResult};

/// One injected script and whether every frame gets it.
pub struct PageScript {
    pub source: String,
    pub all_frames: bool,
}

/// Replaces the webview's user scripts with exactly `scripts`, at document
/// start, in order.
pub fn replace(webview: &Webview, scripts: &[PageScript]) -> ArgmaxResult<()> {
    replace_platform(webview, scripts)
        .map_err(|error| ArgmaxError::service("BROWSER_SCRIPTS_FAILED", error.to_string()))
}

#[cfg(target_os = "macos")]
fn replace_platform(webview: &Webview, scripts: &[PageScript]) -> tauri::Result<()> {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_foundation::NSString;
    use objc2_web_kit::{WKUserScript, WKUserScriptInjectionTime, WKWebView};

    let sources: Vec<(String, bool)> = scripts
        .iter()
        .map(|script| (script.source.clone(), script.all_frames))
        .collect();

    webview.with_webview(move |platform| {
        // SAFETY: `with_webview` hands us the live WKWebView pointer on
        // AppKit's main thread, which is where WebKit requires content-
        // controller changes.
        let Some(mtm) = MainThreadMarker::new() else {
            tracing::error!("browser scripts were installed off the macOS main thread");
            return;
        };
        unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            let controller = view.configuration().userContentController();
            controller.removeAllUserScripts();
            for (source, all_frames) in &sources {
                let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                    WKUserScript::alloc(mtm),
                    &NSString::from_str(source),
                    WKUserScriptInjectionTime::AtDocumentStart,
                    !all_frames,
                );
                controller.addUserScript(&script);
            }
        }
    })
}

#[cfg(not(target_os = "macos"))]
fn replace_platform(_webview: &Webview, _scripts: &[PageScript]) -> tauri::Result<()> {
    Ok(())
}
