//! Keep the Mac awake while agent chats are active.
//!
//! Off by default. When the renderer's "keep computer awake" setting is on,
//! the service holds a macOS activity assertion with
//! `NSActivityIdleSystemSleepDisabled` whenever at least one chat is in an
//! active state — the `running` / `waiting` / `blocked` set
//! [`SessionState::is_active`] defines — and releases it when the last one
//! settles. Idle display sleep still applies; this only stops the system
//! from suspending mid-turn.
//!
//! Fed from the same `dashboard:delta` publisher that drives the ntfy push
//! service and the dock badge, so the assertion tracks exactly the session
//! states the dashboard shows.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// One session id -> active/inactive observation per `dashboard:delta` batch.
#[derive(Default)]
pub struct KeepAwakeService {
    /// Renderer setting; off until `system:set-keep-awake` says otherwise.
    enabled: AtomicBool,
    /// Session ids currently active. Deltas only carry *changed* sessions,
    /// so the set persists between batches.
    sessions: Mutex<HashSet<String>>,
    #[cfg(target_os = "macos")]
    assertion: Mutex<Assertion>,
}

impl KeepAwakeService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arm or disarm the service. Disarming releases a held assertion
    /// immediately; arming only holds one once a session is active.
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        self.refresh();
    }

    /// `active` mirrors `SessionState::is_active()`. Re-observations of the
    /// same flag are no-ops, which is what repeated deltas with unchanged
    /// session states produce.
    pub fn observe(&self, session_id: &str, active: bool) {
        {
            let mut sessions = self.sessions.lock().expect("keep-awake sessions poisoned");
            let changed = if active {
                sessions.insert(session_id.to_string())
            } else {
                sessions.remove(session_id)
            };
            if !changed {
                return;
            }
        }
        self.refresh();
    }

    fn refresh(&self) {
        let should_hold = self.enabled.load(Ordering::SeqCst)
            && !self
                .sessions
                .lock()
                .expect("keep-awake sessions poisoned")
                .is_empty();
        #[cfg(target_os = "macos")]
        {
            self.assertion
                .lock()
                .expect("keep-awake assertion poisoned")
                .set(should_hold);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = should_hold;
        }
    }

    #[cfg(test)]
    fn session_is_tracked(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .expect("keep-awake sessions poisoned")
            .contains(session_id)
    }
}

#[cfg(target_os = "macos")]
mod macos_shim {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    pub type ActivityToken = Retained<ProtocolObject<dyn NSObjectProtocol>>;

    /// The held activity token, acquired lazily on the first active session
    /// and ended on the last settle.
    pub struct Assertion {
        token: Option<ActivityToken>,
    }

    // The activity handle is an immutable refcounted ObjC object; its
    // retain/release is atomic and `endActivity` only takes a shared
    // reference, so moving it between threads is safe.
    unsafe impl Send for Assertion {}

    impl Default for Assertion {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Assertion {
        pub fn new() -> Self {
            Self { token: None }
        }

        pub fn set(&mut self, held: bool) {
            match (&mut self.token, held) {
                (None, true) => {
                    self.token = Some(begin_activity());
                }
                (Some(_), false) => {
                    if let Some(token) = self.token.take() {
                        // SAFETY: the token came from `beginActivity` above,
                        // so it is exactly the type `endActivity` expects.
                        unsafe {
                            NSProcessInfo::processInfo().endActivity(&token);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn begin_activity() -> ActivityToken {
        let reason = NSString::from_str("Argmax agent chats are active (keep computer awake on)");
        NSProcessInfo::processInfo()
            .beginActivityWithOptions_reason(NSActivityOptions::IdleSystemSleepDisabled, &reason)
    }
}

#[cfg(target_os = "macos")]
use macos_shim::Assertion;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observe_tracks_active_sessions() {
        let service = KeepAwakeService::new();
        service.observe("s1", true);
        service.observe("s2", true);
        assert!(service.session_is_tracked("s1"));
        assert!(service.session_is_tracked("s2"));
        service.observe("s1", false);
        assert!(!service.session_is_tracked("s1"));
        assert!(service.session_is_tracked("s2"));
    }

    #[test]
    fn repeated_observations_are_idempotent() {
        let service = KeepAwakeService::new();
        service.observe("s1", true);
        service.observe("s1", true);
        assert!(service.session_is_tracked("s1"));
        service.observe("s1", false);
        service.observe("s1", false);
        assert!(!service.session_is_tracked("s1"));
    }

    #[test]
    fn toggling_enabled_never_panics_with_or_without_activity() {
        let service = KeepAwakeService::new();
        service.set_enabled(true);
        service.observe("s1", true);
        service.set_enabled(false);
        service.observe("s1", false);
    }
}
