//! Native `alert` / `confirm` / `prompt` for the browser pane's tabs.
//!
//! WKWebView shows nothing for these unless its UI delegate implements the
//! `runJavaScript…Panel` methods, and wry's delegate does not: `alert` is a
//! no-op, `confirm` answers false, `prompt` answers null. A page that guards a
//! destructive action behind `confirm` (GitHub's "Delete comment") therefore
//! silently does nothing. This adds the three methods to wry's delegate class
//! and answers them with an `NSAlert` sheet on the tab's window.
//!
//! Tabs a session opened keep answering from `dialog.js`, which replaces the
//! functions in the page before these methods would ever be reached.

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;

    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, Imp, Sel};
    use objc2::{msg_send, sel, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSModalResponse, NSTextField, NSView, NSWindow,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    /// The sheet for one page dialog, or `None` when nobody can see the page.
    /// A hidden tab (a background tab, or one an agent is driving) answers the
    /// way WebKit always did, rather than raising a sheet for a page the user
    /// is not looking at.
    unsafe fn alert_for(
        web_view: &AnyObject,
        frame: &AnyObject,
        message: &NSString,
    ) -> Option<(Retained<NSAlert>, Retained<NSWindow>)> {
        let mtm = MainThreadMarker::new()?;
        let view: &NSView = &*(web_view as *const AnyObject).cast();
        if view.isHiddenOrHasHiddenAncestor() {
            return None;
        }
        let window = view.window()?;
        let origin: *mut AnyObject = msg_send![frame, securityOrigin];
        let host: Option<Retained<NSString>> = match origin.as_ref() {
            Some(origin) => msg_send![origin, host],
            None => None,
        };
        let alert = NSAlert::new(mtm);
        let title = match host
            .map(|host| host.to_string())
            .filter(|host| !host.is_empty())
        {
            Some(host) => format!("{host} says"),
            None => "This page says".to_string(),
        };
        alert.setMessageText(&NSString::from_str(&title));
        alert.setInformativeText(message);
        Some((alert, window))
    }

    extern "C-unwind" fn run_alert(
        _delegate: &AnyObject,
        _cmd: Sel,
        web_view: &AnyObject,
        message: &NSString,
        frame: &AnyObject,
        handler: &DynBlock<dyn Fn()>,
    ) {
        // SAFETY: WebKit calls UI delegate methods on the main thread with the
        // argument types of `-webView:runJavaScriptAlertPanelWithMessage:…`.
        unsafe {
            let Some((alert, window)) = alert_for(web_view, frame, message) else {
                handler.call(());
                return;
            };
            alert.addButtonWithTitle(&NSString::from_str("OK"));
            let handler = handler.copy();
            let done = RcBlock::new(move |_: NSModalResponse| handler.call(()));
            alert.beginSheetModalForWindow_completionHandler(&window, Some(&done));
        }
    }

    extern "C-unwind" fn run_confirm(
        _delegate: &AnyObject,
        _cmd: Sel,
        web_view: &AnyObject,
        message: &NSString,
        frame: &AnyObject,
        handler: &DynBlock<dyn Fn(Bool)>,
    ) {
        // SAFETY: as `run_alert`, for `-…runJavaScriptConfirmPanelWithMessage:…`.
        unsafe {
            let Some((alert, window)) = alert_for(web_view, frame, message) else {
                handler.call((Bool::NO,));
                return;
            };
            alert.addButtonWithTitle(&NSString::from_str("OK"));
            alert.addButtonWithTitle(&NSString::from_str("Cancel"));
            let handler = handler.copy();
            let done = RcBlock::new(move |response: NSModalResponse| {
                handler.call((Bool::new(response == NSAlertFirstButtonReturn),));
            });
            alert.beginSheetModalForWindow_completionHandler(&window, Some(&done));
        }
    }

    extern "C-unwind" fn run_prompt(
        _delegate: &AnyObject,
        _cmd: Sel,
        web_view: &AnyObject,
        prompt: &NSString,
        default_text: Option<&NSString>,
        frame: &AnyObject,
        handler: &DynBlock<dyn Fn(*mut NSString)>,
    ) {
        // SAFETY: as `run_alert`, for `-…runJavaScriptTextInputPanelWithPrompt:…`.
        unsafe {
            let Some((alert, window)) = alert_for(web_view, frame, prompt) else {
                handler.call((std::ptr::null_mut(),));
                return;
            };
            let Some(mtm) = MainThreadMarker::new() else {
                handler.call((std::ptr::null_mut(),));
                return;
            };
            alert.addButtonWithTitle(&NSString::from_str("OK"));
            alert.addButtonWithTitle(&NSString::from_str("Cancel"));
            let field = NSTextField::initWithFrame(
                NSTextField::alloc(mtm),
                NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(260.0, 24.0)),
            );
            if let Some(default_text) = default_text {
                field.setStringValue(default_text);
            }
            alert.setAccessoryView(Some(&field));
            alert.window().setInitialFirstResponder(Some(&field));
            let handler = handler.copy();
            let done = RcBlock::new(move |response: NSModalResponse| {
                if response == NSAlertFirstButtonReturn {
                    handler.call((Retained::as_ptr(&field.stringValue()) as *mut NSString,));
                } else {
                    handler.call((std::ptr::null_mut(),));
                }
            });
            alert.beginSheetModalForWindow_completionHandler(&window, Some(&done));
        }
    }

    unsafe fn add_method(
        class: *mut objc2::runtime::AnyClass,
        selector: Sel,
        imp: Imp,
        types: &str,
    ) {
        let types = CString::new(types).expect("valid Objective-C method encoding");
        let _ = objc2::ffi::class_addMethod(class.cast(), selector, imp, types.as_ptr());
    }

    pub(super) fn install(webview: &tauri::Webview) -> tauri::Result<()> {
        webview.with_webview(|platform| {
            // SAFETY: `with_webview` runs on the main thread with the live
            // WKWebView. Wry retains its UI delegate; WebKit holds it weakly.
            unsafe {
                let web_view = &*platform.inner().cast::<AnyObject>();
                let delegate: *mut AnyObject = msg_send![web_view, UIDelegate];
                let Some(delegate) = delegate.as_ref() else {
                    return;
                };
                let class = delegate.class() as *const _ as *mut objc2::runtime::AnyClass;
                if !delegate
                    .class()
                    .responds_to(sel!(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))
                {
                    add_method(
                        class,
                        sel!(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:),
                        std::mem::transmute::<
                            extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, &NSString, &AnyObject, &DynBlock<dyn Fn()>),
                            Imp,
                        >(run_alert),
                        "v@:@@@@?",
                    );
                    add_method(
                        class,
                        sel!(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:),
                        std::mem::transmute::<
                            extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, &NSString, &AnyObject, &DynBlock<dyn Fn(Bool)>),
                            Imp,
                        >(run_confirm),
                        "v@:@@@@?",
                    );
                    add_method(
                        class,
                        sel!(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:),
                        std::mem::transmute::<
                            extern "C-unwind" fn(
                                &AnyObject,
                                Sel,
                                &AnyObject,
                                &NSString,
                                Option<&NSString>,
                                &AnyObject,
                                &DynBlock<dyn Fn(*mut NSString)>,
                            ),
                            Imp,
                        >(run_prompt),
                        "v@:@@@@@?",
                    );
                }
                // WebKit reads which optional methods the delegate implements
                // when it is assigned, so the tab whose install added them has
                // to be handed the same delegate again to notice. This runs as
                // the tab is created, never inside a popup's createNewPage,
                // where reassigning the delegate aborts.
                let _: () = msg_send![web_view, setUIDelegate: delegate];
            }
        })
    }
}

/// Gives the tab's page working `alert` / `confirm` / `prompt` dialogs.
pub fn install(webview: &tauri::Webview) -> tauri::Result<()> {
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
