//! Native support for JavaScript-closing browser popup windows.

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;

    use objc2::runtime::{AnyObject, Imp, Sel};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_web_kit::WKUserContentController;

    pub(super) fn reset_user_content_controller(
        features: &tauri::webview::NewWindowFeatures,
        filtered: bool,
    ) -> Result<(), &'static str> {
        let Some(mtm) = MainThreadMarker::new() else {
            return Err("popup callback did not run on the macOS main thread");
        };

        // WebKit's target configuration inherits the opener's content
        // controller, including Wry's `ipc` script-message handler. Wry
        // registers that handler while constructing the popup, and WebKit
        // raises an Objective-C exception if the name already exists. Keep
        // the target configuration (required for the opener relationship),
        // but give the new webview its own empty controller for Wry to fill.
        unsafe {
            let controller = WKUserContentController::new(mtm);
            if filtered {
                let identifier = super::super::content_blocking_macos::active_identifier()
                    .ok_or("browser content rules have not been prepared")?;
                super::super::content_blocking_macos::add_to_controller(&controller, &identifier)
                    .map_err(|_| "could not attach popup content rules")?;
            }
            features
                .opener()
                .target_configuration
                .setUserContentController(&controller);
        }
        Ok(())
    }

    extern "C-unwind" fn web_view_did_close(
        _delegate: &AnyObject,
        _cmd: Sel,
        web_view: &AnyObject,
    ) {
        // SAFETY: WebKit invokes this delegate method on the main thread. The
        // selector signature is `-webViewDidClose:(WKWebView *)webView`, and
        // `window` returns the containing NSWindow. `performClose:` follows
        // AppKit's normal close path so Tao can emit CloseRequested and Tauri
        // can tear down its WebviewWindow state.
        unsafe {
            let window: Option<&AnyObject> = msg_send![web_view, window];
            if let Some(window) = window {
                let _: () = msg_send![window, performClose: Option::<&AnyObject>::None];
            }
        }
    }

    pub(super) fn install(webview: &tauri::Webview) -> tauri::Result<()> {
        webview.with_webview(|platform| {
            // SAFETY: `with_webview` hands us the live WKWebView pointer on
            // AppKit's main thread. Wry owns and retains its UI delegate. Add
            // the optional close method to Wry's delegate class before any
            // popup is created, so WebKit sees it when assigning that same
            // delegate class to the popup. Reassigning a popup's delegate
            // while createNewPage is still on the stack aborts on macOS 26.
            unsafe {
                let web_view = &*platform.inner().cast::<AnyObject>();
                let delegate: *mut AnyObject = msg_send![web_view, UIDelegate];
                let Some(delegate) = delegate.as_ref() else {
                    return;
                };

                if delegate.class().responds_to(sel!(webViewDidClose:)) {
                    return;
                }

                let types = CString::new("v@:@").expect("valid Objective-C method encoding");
                let added = objc2::ffi::class_addMethod(
                    delegate.class() as *const _ as *mut _,
                    sel!(webViewDidClose:),
                    std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel, &AnyObject), Imp>(
                        web_view_did_close,
                    ),
                    types.as_ptr(),
                );
                debug_assert!(
                    added.as_bool() || delegate.class().responds_to(sel!(webViewDidClose:))
                );
            }
        })
    }
}

/// Removes message handlers inherited through WebKit's popup configuration.
pub fn prepare_configuration(
    features: &tauri::webview::NewWindowFeatures,
    filtered: bool,
) -> Result<(), &'static str> {
    #[cfg(target_os = "macos")]
    {
        macos::reset_user_content_controller(features, filtered)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (features, filtered);
        Ok(())
    }
}

/// Installs native `window.close()` handling before this webview opens a popup.
pub fn install_close_handler(webview: &tauri::Webview) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos::install(webview)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        Ok(())
    }
}
