//! Desktop notifications through `UNUserNotificationCenter`.
//!
//! The Tauri notification plugin sends through the deprecated
//! `NSUserNotificationCenter`. macOS never shows one of those as a banner
//! while the sending app is frontmost: usernoted files it straight into
//! Notification Center history, which is why "Send test notification" looked
//! dead (Settings is always open when it is clicked). The plugin also reports
//! permission as always granted, so a user who declined never found out.
//!
//! `UNUserNotificationCenter` asks once, reports the real authorization
//! state, and lets the delegate opt into foreground banners. It has two
//! preconditions the plugin does not: a bundle identifier (an unbundled
//! `tauri dev` binary raises `bundleProxyForCurrentProcess is nil`, so
//! `desktop_sink` never builds this sink for one) and a real code signature.
//! A bundle that only carries the linker's signature gets
//! `UNErrorDomain 1` (notifications not allowed) from the authorization
//! request; `tauri.conf.json` ad-hoc signs local builds for that reason.
//! There is no runtime fallback to the plugin: once a process has talked to
//! `UNUserNotificationCenter`, usernoted denies its legacy sends ("You can't
//! mix modern clients with legacy clients"), so a refused request means
//! notifications are off for this install and the test button says so.

use std::ptr::NonNull;
use std::sync::{Arc, Mutex};

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_foundation::{NSBundle, NSError, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Manager, Runtime};

use super::{NotificationOptions, NotificationSink};
use crate::error::ArgmaxResult;
use crate::util::sync::LockOrRecover;

/// `UNUserNotificationCenter` needs a bundle identifier; without one it
/// raises an Objective-C exception on first use.
pub fn has_bundle_identifier() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Authorization {
    /// Settings not read yet, or the permission prompt is still open. Sends
    /// queue behind the prompt and land once the user answers.
    Pending,
    Granted,
    /// The user said no. Sending is pointless and the test button says so.
    Denied,
    /// macOS refused the request itself (unsigned bundle).
    Unavailable,
}

struct DelegateIvars {
    on_activate: Box<dyn Fn() + Send + Sync>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "ArgmaxNotificationDelegate"]
    #[ivars = DelegateIvars]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        // Without this, macOS drops a notification that arrives while Argmax
        // is frontmost. A banner in the corner is what "Notify when agent
        // finishes" promises, so present it regardless.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            _response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            (self.ivars().on_activate)();
            completion.call(());
        }
    }
);

impl NotificationDelegate {
    fn new(on_activate: Box<dyn Fn() + Send + Sync>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { on_activate });
        unsafe { msg_send![super(this), init] }
    }
}

pub struct UserNotificationCenterSink {
    authorization: Arc<Mutex<Authorization>>,
}

impl UserNotificationCenterSink {
    /// Installs the delegate and asks for permission. The permission prompt
    /// shows once per install; afterwards the request returns the stored
    /// answer immediately.
    pub fn new<R: Runtime>(app: AppHandle<R>) -> Self {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate = NotificationDelegate::new(Box::new(move || focus_main_window(&app)));
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The delegate property is weak and the center lives for the whole
        // process, so keep the delegate alive the same way (see app_nap.rs).
        std::mem::forget(delegate);

        let authorization = Arc::new(Mutex::new(Authorization::Pending));
        let cached = Arc::clone(&authorization);
        let settings_handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let known = match status {
                UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional => {
                    Authorization::Granted
                }
                UNAuthorizationStatus::Denied => Authorization::Denied,
                _ => return,
            };
            *cached.lock_or_recover("notification authorization") = known;
        });
        center.getNotificationSettingsWithCompletionHandler(&settings_handler);
        request_authorization(&center, Arc::clone(&authorization), |_| {});

        Self { authorization }
    }

    fn authorization(&self) -> Authorization {
        *self
            .authorization
            .lock_or_recover("notification authorization")
    }
}

impl NotificationSink for UserNotificationCenterSink {
    fn is_supported(&self) -> bool {
        !matches!(
            self.authorization(),
            Authorization::Denied | Authorization::Unavailable
        )
    }

    /// Success means the request was handed to the notification center; the
    /// add itself completes asynchronously and logs its own failure.
    fn fire(&self, options: NotificationOptions) -> ArgmaxResult<()> {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&options.title));
        content.setBody(&NSString::from_str(&options.body));
        let identifier = NSString::from_str(&uuid::Uuid::new_v4().to_string());
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None,
        );

        let center = UNUserNotificationCenter::currentNotificationCenter();
        let center_for_add = center.clone();
        request_authorization(&center, Arc::clone(&self.authorization), move |granted| {
            if !granted {
                tracing::warn!("desktop notification skipped: macOS did not authorize Argmax");
                return;
            }
            let add_handler = RcBlock::new(|error: *mut NSError| {
                if let Some(error) = unsafe { error.as_ref() } {
                    tracing::warn!(
                        error = %error.localizedDescription(),
                        "notification center rejected the notification"
                    );
                }
            });
            center_for_add
                .addNotificationRequest_withCompletionHandler(&request, Some(&add_handler));
        });
        Ok(())
    }
}

fn request_authorization(
    center: &UNUserNotificationCenter,
    authorization: Arc<Mutex<Authorization>>,
    then: impl Fn(bool) + 'static,
) {
    let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        let granted = granted.as_bool();
        let outcome = match unsafe { error.as_ref() } {
            Some(error) => {
                tracing::warn!(
                    error = %error.localizedDescription(),
                    "UNUserNotificationCenter refused the authorization request; \
                     desktop notifications are off (is the bundle code-signed?)"
                );
                Authorization::Unavailable
            }
            None if granted => Authorization::Granted,
            None => Authorization::Denied,
        };
        *authorization.lock_or_recover("notification authorization") = outcome;
        then(granted);
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge,
        &handler,
    );
}

/// Clicking the banner activates the app; also surface the window in case
/// it was minimized.
fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    });
}
