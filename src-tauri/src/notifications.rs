use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::{NotificationExt, PermissionState};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::gh::GhPrRecord;
use crate::persistence::sessions::SessionSummary;

const TERMINAL_STATES: [&str; 2] = ["complete", "failed"];
const LAST_NOTIFIED_CAPACITY: usize = 2_000;
const CHECK_FAILURE_CAPACITY: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationOptions {
    pub title: String,
    pub body: String,
}

pub trait NotificationSink: Send + Sync + 'static {
    fn is_supported(&self) -> bool;
    fn fire(&self, options: NotificationOptions) -> ArgmaxResult<()>;
}

pub type FocusProbe = Arc<dyn Fn() -> bool + Send + Sync>;

pub struct NotificationService<S: NotificationSink> {
    enabled: Mutex<bool>,
    is_window_focused: FocusProbe,
    sink: S,
    last_notified_state: Mutex<BoundedMap<String, String>>,
    notified_check_keys: Mutex<BoundedSet<String>>,
}

impl<S: NotificationSink> NotificationService<S> {
    pub fn new(is_window_focused: FocusProbe, sink: S) -> Self {
        Self {
            enabled: Mutex::new(true),
            is_window_focused,
            sink,
            last_notified_state: Mutex::new(BoundedMap::new(LAST_NOTIFIED_CAPACITY)),
            notified_check_keys: Mutex::new(BoundedSet::new(CHECK_FAILURE_CAPACITY)),
        }
    }

    pub fn set_enabled(&self, value: bool) {
        *self.enabled.lock().expect("notification enabled poisoned") = value;
    }

    pub fn notify(&self, session: &SessionSummary) -> ArgmaxResult<bool> {
        if !self.is_enabled() || !TERMINAL_STATES.contains(&session.state.as_str()) {
            return Ok(false);
        }

        // Check dedup WITHOUT stamping yet — stamping before the focus
        // probe meant a terminal transition that landed while the window
        // was focused would be permanently suppressed once the user
        // looked away.
        if self
            .last_notified_state
            .lock()
            .expect("last notified state poisoned")
            .get(&session.id)
            .is_some_and(|state| state == &session.state)
        {
            return Ok(false);
        }

        if (self.is_window_focused)() || !self.sink.is_supported() {
            return Ok(false);
        }

        self.sink.fire(build_session_options(session))?;
        // Only stamp after a successful fire so a redelivery is possible
        // until the user actually sees the toast.
        self.last_notified_state
            .lock()
            .expect("last notified state poisoned")
            .insert(session.id.clone(), session.state.clone());
        Ok(true)
    }

    pub fn notify_check_failure(
        &self,
        session: &SessionSummary,
        pr: &GhPrRecord,
    ) -> ArgmaxResult<bool> {
        if !self.is_enabled() {
            return Ok(false);
        }
        let dedup_key = format!("{}:{}:{}", session.id, pr.pr_number, pr.head_sha);
        // Atomic check-and-claim under one lock: prevents two concurrent
        // poller ticks for the same PR from both passing the contains
        // check and both firing the toast.
        {
            let mut keys = self
                .notified_check_keys
                .lock()
                .expect("notified check keys poisoned");
            if keys.contains(&dedup_key) {
                return Ok(false);
            }
            if (self.is_window_focused)() || !self.sink.is_supported() {
                return Ok(false);
            }
            keys.insert(dedup_key);
        }

        self.sink.fire(NotificationOptions {
            title: format!("PR #{} checks failed", pr.pr_number),
            body: format!(
                "{} — open Argmax to queue a follow-up.",
                session.model_label
            ),
        })?;
        Ok(true)
    }

    pub fn forget(&self, session_id: &str) {
        self.last_notified_state
            .lock()
            .expect("last notified state poisoned")
            .remove(session_id);
    }

    fn is_enabled(&self) -> bool {
        *self.enabled.lock().expect("notification enabled poisoned")
    }
}

pub struct TauriNotificationSink<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriNotificationSink<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> NotificationSink for TauriNotificationSink<R> {
    fn is_supported(&self) -> bool {
        !matches!(
            self.app.notification().permission_state(),
            Ok(PermissionState::Denied) | Err(_)
        )
    }

    fn fire(&self, options: NotificationOptions) -> ArgmaxResult<()> {
        self.app
            .notification()
            .builder()
            .title(options.title)
            .body(options.body)
            .show()
            .map_err(|error| {
                ArgmaxError::service(
                    "NOTIFICATION_FAILED",
                    format!("notification failed: {error}"),
                )
            })
    }
}

pub fn main_window_focus_probe<R: Runtime>(app: AppHandle<R>) -> FocusProbe {
    Arc::new(move || {
        app.get_webview_window("main")
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false)
    })
}

fn build_session_options(session: &SessionSummary) -> NotificationOptions {
    if session.state == "complete" {
        return NotificationOptions {
            title: "Session complete".to_string(),
            body: format!("{} finished — open Argmax to review.", session.model_label),
        };
    }

    NotificationOptions {
        title: "Session failed".to_string(),
        body: format!(
            "{} exited with an error. Open Argmax for details.",
            session.model_label
        ),
    }
}

#[derive(Debug)]
struct BoundedMap<K, V> {
    capacity: usize,
    values: HashMap<K, V>,
    order: VecDeque<K>,
}

impl<K, V> BoundedMap<K, V>
where
    K: Clone + Eq + Hash,
{
    fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "bounded map capacity must be positive");
        Self {
            capacity,
            values: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn get(&self, key: &K) -> Option<&V> {
        self.values.get(key)
    }

    fn insert(&mut self, key: K, value: V) {
        if !self.values.contains_key(&key) {
            self.order.push_back(key.clone());
        }
        self.values.insert(key, value);
        while self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.values.remove(&oldest);
            }
        }
    }

    fn remove(&mut self, key: &str)
    where
        K: AsRef<str>,
    {
        self.values.retain(|candidate, _| candidate.as_ref() != key);
        self.order.retain(|candidate| candidate.as_ref() != key);
    }
}

#[derive(Debug)]
struct BoundedSet<T> {
    map: BoundedMap<T, ()>,
}

impl<T> BoundedSet<T>
where
    T: Clone + Eq + Hash,
{
    fn new(capacity: usize) -> Self {
        Self {
            map: BoundedMap::new(capacity),
        }
    }

    fn contains(&self, value: &T) -> bool {
        self.map.get(value).is_some()
    }

    fn insert(&mut self, value: T) {
        self.map.insert(value, ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct StubSink {
        supported: AtomicBool,
        fired: Mutex<Vec<NotificationOptions>>,
    }

    impl StubSink {
        fn supported() -> Self {
            Self {
                supported: AtomicBool::new(true),
                fired: Mutex::new(Vec::new()),
            }
        }

        fn fired(&self) -> Vec<NotificationOptions> {
            self.fired.lock().expect("fired poisoned").clone()
        }
    }

    impl NotificationSink for Arc<StubSink> {
        fn is_supported(&self) -> bool {
            self.supported.load(Ordering::SeqCst)
        }

        fn fire(&self, options: NotificationOptions) -> ArgmaxResult<()> {
            self.fired.lock().expect("fired poisoned").push(options);
            Ok(())
        }
    }

    #[test]
    fn fires_on_terminal_state_with_unfocused_window() {
        let sink = Arc::new(StubSink::supported());
        let service = service_with_focus(false, sink.clone());

        assert!(service.notify(&session("complete")).expect("notify ok"));

        let fired = sink.fired();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].title, "Session complete");
        assert!(fired[0].body.contains("Claude Haiku 4.5"));
    }

    #[test]
    fn suppresses_when_window_is_focused() {
        let sink = Arc::new(StubSink::supported());
        let service = service_with_focus(true, sink.clone());

        assert!(!service.notify(&session("complete")).expect("notify ok"));
        assert!(sink.fired().is_empty());
    }

    #[test]
    fn suppresses_when_platform_is_not_supported() {
        let sink = Arc::new(StubSink::supported());
        sink.supported.store(false, Ordering::SeqCst);
        let service = service_with_focus(false, sink.clone());

        assert!(!service.notify(&session("complete")).expect("notify ok"));
        assert!(sink.fired().is_empty());
    }

    #[test]
    fn ignores_non_terminal_states() {
        let sink = Arc::new(StubSink::supported());
        let service = service_with_focus(false, sink.clone());

        for state in ["running", "cancelled", "waiting"] {
            assert!(!service.notify(&session(state)).expect("notify ok"));
        }
        assert!(sink.fired().is_empty());
    }

    #[test]
    fn dedupes_repeated_terminal_state() {
        let sink = Arc::new(StubSink::supported());
        let service = service_with_focus(false, sink.clone());
        let session = session("complete");

        service.notify(&session).expect("notify ok");
        service.notify(&session).expect("notify ok");
        service.notify(&session).expect("notify ok");

        assert_eq!(sink.fired().len(), 1);
    }

    #[test]
    fn fires_once_for_complete_then_failed() {
        let sink = Arc::new(StubSink::supported());
        let service = service_with_focus(false, sink.clone());

        service
            .notify(&session("complete"))
            .expect("complete notify ok");
        service
            .notify(&session("failed"))
            .expect("failed notify ok");

        let fired = sink.fired();
        assert_eq!(fired.len(), 2);
        assert_eq!(fired[0].title, "Session complete");
        assert_eq!(fired[1].title, "Session failed");
    }

    #[test]
    fn can_be_disabled_at_runtime() {
        let sink = Arc::new(StubSink::supported());
        let service = service_with_focus(false, sink.clone());

        service.set_enabled(false);

        assert!(!service.notify(&session("complete")).expect("notify ok"));
        assert!(sink.fired().is_empty());
    }

    #[test]
    fn notifies_after_user_looks_away_from_initially_focused_session() {
        let sink = Arc::new(StubSink::supported());
        let focused = Arc::new(AtomicBool::new(true));
        let service = NotificationService::new(
            {
                let focused = focused.clone();
                Arc::new(move || focused.load(Ordering::SeqCst))
            },
            sink.clone(),
        );
        let session = session("complete");

        // First attempt while focused: suppressed, but state must not be
        // stamped — otherwise the later unfocused call dedupes against
        // a transition the user never saw.
        assert!(!service.notify(&session).expect("focused notify"));
        focused.store(false, Ordering::SeqCst);
        assert!(service.notify(&session).expect("unfocused notify"));
        assert_eq!(sink.fired().len(), 1);
    }

    #[test]
    fn renotifies_after_forget() {
        let sink = Arc::new(StubSink::supported());
        let service = service_with_focus(false, sink.clone());
        let session = session("complete");

        service.notify(&session).expect("notify ok");
        service.forget(&session.id);
        service.notify(&session).expect("notify ok");

        assert_eq!(sink.fired().len(), 2);
    }

    #[test]
    fn check_failure_does_not_stamp_key_while_focused() {
        let sink = Arc::new(StubSink::supported());
        let focused = Arc::new(AtomicBool::new(true));
        let service = NotificationService::new(
            {
                let focused = focused.clone();
                Arc::new(move || focused.load(Ordering::SeqCst))
            },
            sink.clone(),
        );
        let session = session("complete");
        let pr = pr();

        assert!(!service
            .notify_check_failure(&session, &pr)
            .expect("focused notify ok"));

        focused.store(false, Ordering::SeqCst);
        assert!(service
            .notify_check_failure(&session, &pr)
            .expect("unfocused notify ok"));
        assert!(!service
            .notify_check_failure(&session, &pr)
            .expect("dedup notify ok"));

        let fired = sink.fired();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].title, "PR #42 checks failed");
    }

    fn service_with_focus(
        focused: bool,
        sink: Arc<StubSink>,
    ) -> NotificationService<Arc<StubSink>> {
        NotificationService::new(Arc::new(move || focused), sink)
    }

    fn session(state: &str) -> SessionSummary {
        SessionSummary {
            id: "session-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            provider: "claude".to_string(),
            model_label: "Claude Haiku 4.5".to_string(),
            model_id: "claude-haiku-4-5".to_string(),
            reasoning_effort: None,
            permission_mode: "auto-approve".to_string(),
            agent_mode: None,
            provider_conversation_id: None,
            prompt: "Build the thing".to_string(),
            state: state.to_string(),
            attention: "normal".to_string(),
            started_at: "2026-05-01T00:00:00.000Z".to_string(),
            completed_at: Some("2026-05-01T00:01:00.000Z".to_string()),
            last_activity_at: "2026-05-01T00:01:00.000Z".to_string(),
            cost_usd: 0.0,
            tokens: crate::persistence::sessions::UsageCounts {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            },
        }
    }

    fn pr() -> GhPrRecord {
        GhPrRecord {
            session_id: "session-1".to_string(),
            pr_number: 42,
            head_sha: "deadbeef".to_string(),
            last_seen_check_state: "failure".to_string(),
            updated_at: "2026-05-18T00:00:00.000Z".to_string(),
            pr_state: Some("OPEN".to_string()),
            notified_at: None,
        }
    }
}
