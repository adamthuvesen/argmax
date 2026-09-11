//! Native support for JavaScript-closing browser popup windows.

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::CString;

    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel};

    thread_local! {
        /// `with_webview` runs on AppKit's main thread, so the cache shares
        /// that same confinement as the Objective-C classes it indexes.
        static CLOSE_DELEGATE_CLASSES: RefCell<HashMap<usize, &'static AnyClass>> =
            RefCell::new(HashMap::new());
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

    fn close_delegate_class(superclass: &AnyClass) -> &'static AnyClass {
        let key = superclass as *const AnyClass as usize;
        CLOSE_DELEGATE_CLASSES.with(|classes| {
            if let Some(class) = classes.borrow().get(&key) {
                return *class;
            }

            let name = CString::new(format!("ArgmaxPopupCloseDelegate_{key:x}"))
                .expect("generated Objective-C class name has no NUL bytes");
            let class = if let Some(mut builder) = ClassBuilder::new(&name, superclass) {
                // SAFETY: The subclass adds no ivars, satisfying
                // `AnyObject::set_class`'s layout requirement. The callback's
                // ABI and argument types exactly match `webViewDidClose:`.
                unsafe {
                    builder.add_method(
                        sel!(webViewDidClose:),
                        web_view_did_close as extern "C-unwind" fn(_, _, _),
                    );
                }
                builder.register()
            } else {
                AnyClass::get(&name).expect("popup close delegate class was already registered")
            };

            classes.borrow_mut().insert(key, class);
            class
        })
    }

    pub(super) fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
        window.with_webview(|platform| {
            // SAFETY: `with_webview` hands us the live WKWebView pointer on
            // AppKit's main thread. Wry owns and retains its UI delegate for
            // the webview lifetime. We only change that delegate object's
            // class to a no-ivar subclass of its current class.
            unsafe {
                let web_view = &*platform.inner().cast::<AnyObject>();
                let delegate: *mut AnyObject = msg_send![web_view, UIDelegate];
                let Some(delegate) = delegate.as_ref() else {
                    return;
                };

                if delegate.class().responds_to(sel!(webViewDidClose:)) {
                    return;
                }

                let superclass = delegate.class();
                let subclass = close_delegate_class(superclass);
                let previous = AnyObject::set_class(delegate, subclass);
                debug_assert_eq!(previous, superclass);
                // WebKit caches optional delegate methods when it is assigned.
                // Reassign after subclassing so it observes webViewDidClose:.
                let _: () = msg_send![web_view, setUIDelegate: Option::<&AnyObject>::None];
                let _: () = msg_send![web_view, setUIDelegate: delegate];
            }
        })
    }
}

/// Installs native `window.close()` handling on a browser popup window.
pub fn install_close_handler(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos::install(window)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(())
    }
}
