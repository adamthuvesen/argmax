//! Keeps a hidden browser tab from taking the window's keyboard.
//!
//! When a page moves DOM focus — its own `element.focus()`, an `autofocus`
//! field, a modal opening — WebKit asks the window to make that tab's
//! WKWebView first responder, hidden or not, and `document.hasFocus()` in the
//! page still reads false. Agent tabs live hidden in the main window, so a
//! page an agent is clicking through pulls the keyboard out of the composer
//! mid-sentence. This adds `makeFirstResponder:` to tao's window class and
//! refuses hidden views before the current responder resigns: refusing in
//! `becomeFirstResponder` instead would leave the window itself as first
//! responder, and the keystrokes would be lost just the same.

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::{Once, OnceLock};

    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{msg_send, sel, ClassType};
    use objc2_app_kit::NSView;

    type MakeFirstResponder = unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> Bool;

    /// NSWindow's own implementation, captured before tao's class shadows it.
    static FORWARD: OnceLock<MakeFirstResponder> = OnceLock::new();

    extern "C-unwind" fn make_first_responder(
        window: &AnyObject,
        cmd: Sel,
        responder: *mut AnyObject,
    ) -> Bool {
        // SAFETY: AppKit calls this on the main thread with the arguments of
        // `-[NSWindow makeFirstResponder:]`; `responder` is nil or an
        // NSResponder, and is only treated as a view once it says it is one.
        unsafe {
            if let Some(object) = responder.as_ref() {
                let is_view: bool = msg_send![object, isKindOfClass: NSView::class()];
                if is_view {
                    let view: &NSView = &*(object as *const AnyObject).cast();
                    if view.isHiddenOrHasHiddenAncestor() {
                        tracing::debug!("refused keyboard focus for a hidden view");
                        return Bool::NO;
                    }
                }
            }
            let Some(forward) = FORWARD.get() else {
                return Bool::NO;
            };
            forward(window, cmd, responder)
        }
    }

    pub(super) fn install() {
        static INSTALLED: Once = Once::new();
        INSTALLED.call_once(|| {
            // By name: the class of a live window can be a KVO subclass.
            let Some(class) = AnyClass::get(c"TaoWindow") else {
                tracing::warn!("tao window class not found; hidden browser tabs can take keyboard focus");
                return;
            };
            let selector = sel!(makeFirstResponder:);
            let Some(method) = class
                .superclass()
                .and_then(|superclass| superclass.instance_method(selector))
            else {
                tracing::warn!("NSWindow has no makeFirstResponder:; hidden browser tabs can take keyboard focus");
                return;
            };
            // SAFETY: `method` is NSWindow's `makeFirstResponder:`, whose IMP has
            // exactly the `MakeFirstResponder` signature. The class is only
            // modified here, once, on the main thread.
            unsafe {
                let forward = std::mem::transmute::<Imp, MakeFirstResponder>(method.implementation());
                let _ = FORWARD.set(forward);
                let added = objc2::ffi::class_addMethod(
                    class as *const AnyClass as *mut AnyClass,
                    selector,
                    std::mem::transmute::<
                        extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> Bool,
                        Imp,
                    >(make_first_responder),
                    objc2::ffi::method_getTypeEncoding(method),
                );
                if !added.as_bool() {
                    tracing::warn!(
                        "tao window class already defines makeFirstResponder:; hidden browser tabs can take keyboard focus"
                    );
                }
            }
        });
    }
}

/// Stops hidden webviews from becoming the window's first responder. Runs on
/// the main thread; later calls are no-ops.
pub fn install() {
    #[cfg(target_os = "macos")]
    macos::install();
}
