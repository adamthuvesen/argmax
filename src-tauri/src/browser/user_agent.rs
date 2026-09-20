//! Which browser a tab claims to be, and setting that on a live tab.
//!
//! WKWebView's default user agent reads as an embedded webview; Google then
//! warns "browser no longer supported" and refuses OAuth. Every tab therefore
//! presents as desktop Safari, which is what this engine actually is.
//!
//! The Docs editors are the exception. Google serves a Safari user agent a
//! grid canvas at *half* the device scale: measured against the same
//! spreadsheet in a bare `WKWebView` on a 2x display, the canvas backing store
//! is 0.5x its CSS box under the Safari UA and 2x under Chrome's — so every
//! cell, row number and column letter is drawn from a quarter of the pixels it
//! has room for and upscaled, while the surrounding DOM chrome stays crisp.
//! That is a Google decision, not a WebKit limit: the same view, same window,
//! same display renders the grid at full resolution the moment the UA says
//! Chrome. Only `docs.google.com` gets it; sign-in keeps the Safari UA, where
//! Google's embedded-browser checks already pass.

use tauri::{Url, Webview};

use crate::error::{ArgmaxError, ArgmaxResult};

/// What every tab says by default.
pub const SAFARI: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

/// What a Google Docs editor tab says, for the full-resolution grid.
pub const DOCS_EDITOR: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/// Docs, Sheets, Slides and Drawings all render their document surface here.
const DOCS_EDITOR_HOST: &str = "docs.google.com";

/// The user agent a tab should present while showing `url`.
pub fn for_url(url: &Url) -> &'static str {
    if needs_docs_editor(url) {
        DOCS_EDITOR
    } else {
        SAFARI
    }
}

/// Whether reaching `url` requires the Docs editor user agent.
///
/// Navigation callbacks fire for iframes too, so they may only ever *upgrade*
/// a tab: an `accounts.google.com` consent frame inside an open spreadsheet
/// must not drop the tab back to Safari's UA and take the full-resolution grid
/// with it. Explicit navigation, which is always the main frame, sets the UA
/// both ways through `for_url`.
pub fn needs_docs_editor(url: &Url) -> bool {
    url.host_str() == Some(DOCS_EDITOR_HOST)
}

/// Sets a live tab's user agent. Takes effect for the next document, so call
/// it before starting the navigation that needs it.
pub fn apply(webview: &Webview, user_agent: &'static str) -> ArgmaxResult<()> {
    apply_platform(webview, user_agent)
        .map_err(|error| ArgmaxError::service("BROWSER_USER_AGENT_FAILED", error.to_string()))
}

#[cfg(target_os = "macos")]
fn apply_platform(webview: &Webview, user_agent: &'static str) -> tauri::Result<()> {
    use objc2_foundation::NSString;
    use objc2_web_kit::WKWebView;

    webview.with_webview(move |platform| {
        // SAFETY: Tauri supplies the live WKWebView pointer and runs this
        // closure on AppKit's main thread, where WebKit requires it — inline
        // when the caller is already there, which is what lets a navigation
        // handler set the UA before the request it is deciding on.
        unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            view.setCustomUserAgent(Some(&NSString::from_str(user_agent)));
        }
    })
}

#[cfg(not(target_os = "macos"))]
fn apply_platform(_webview: &Webview, _user_agent: &'static str) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{for_url, needs_docs_editor, DOCS_EDITOR, SAFARI};
    use tauri::Url;

    fn parsed(url: &str) -> Url {
        Url::parse(url).expect("valid test URL")
    }

    #[test]
    fn a_docs_editor_url_asks_for_the_chrome_user_agent() {
        let sheet = parsed("https://docs.google.com/spreadsheets/d/abc/edit#gid=0");
        assert_eq!(for_url(&sheet), DOCS_EDITOR);
        assert!(needs_docs_editor(&sheet));
    }

    #[test]
    fn everything_else_stays_on_safari() {
        for url in [
            "https://accounts.google.com/ServiceLogin",
            "https://drive.google.com/drive/my-drive",
            "https://example.com/docs.google.com",
            "https://docs.google.com.evil.test/spreadsheets",
        ] {
            let url = parsed(url);
            assert_eq!(for_url(&url), SAFARI, "{url}");
            assert!(!needs_docs_editor(&url), "{url}");
        }
    }
}
