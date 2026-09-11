// Push notifications to a phone via ntfy (https://ntfy.sh or self-hosted).
//
// What fires, and when, lives in `signal.rs` — this module is only the ntfy
// delivery of it: HTTP headers on a POST to a topic URL, with a Click header
// deep-linking the mobile page. The APNs sink next door reads the same table.

use crate::persistence::sessions::SessionSummary;
use crate::remote::signal::{signal_for, PushSignal, SignalDedupe};

const REQUEST_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NtfyMessage {
    pub title: String,
    pub body: String,
    /// ntfy priority header value ("default" or "high").
    pub priority: &'static str,
    /// ntfy tags header value; rendered as emoji by the apps. Empty sends no
    /// Tags header, so the push shows the bare title.
    pub tags: &'static str,
    /// Where tapping the push should land: the mobile page deep-linked to the
    /// session that raised it. `None` when no mobile URL is known, which
    /// leaves the notification inert rather than opening the wrong place.
    pub click: Option<String>,
}

type Sink = Box<dyn Fn(NtfyMessage) + Send + Sync>;

pub struct NtfyPublisher {
    sink: Sink,
    /// Mobile page URL the pushes deep-link into, e.g.
    /// `http://mac.tail1234.ts.net:8790/mobile.html`. `None` while no remote
    /// URL is known, which sends pushes without a Click header.
    mobile_url: Option<String>,
    dedupe: SignalDedupe,
}

impl NtfyPublisher {
    /// Publisher POSTing to `topic_url` (the full topic URL, e.g.
    /// `https://ntfy.sh/<topic>`). Requests run on a throwaway thread so the
    /// dashboard-delta path never waits on the network.
    pub fn new(topic_url: String, mobile_url: Option<String>) -> Self {
        Self::with_sink(
            Box::new(move |message: NtfyMessage| {
                let topic_url = topic_url.clone();
                std::thread::spawn(move || {
                    let agent = ureq::AgentBuilder::new()
                        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
                        .build();
                    let mut request = agent
                        .post(&topic_url)
                        .set("Title", &message.title)
                        .set("Priority", message.priority);
                    if !message.tags.is_empty() {
                        request = request.set("Tags", message.tags);
                    }
                    if let Some(click) = message.click.as_deref() {
                        request = request.set("Click", click);
                    }
                    let result = request.send_string(&message.body);
                    if let Err(error) = result {
                        tracing::warn!(%error, "ntfy publish failed");
                    }
                });
            }),
            mobile_url,
        )
    }

    fn with_sink(sink: Sink, mobile_url: Option<String>) -> Self {
        Self {
            sink,
            mobile_url,
            dedupe: SignalDedupe::new("ntfy last signaled"),
        }
    }

    /// Called for every session row in a dashboard delta. Fires at most once
    /// per (state, attention) value per session, and only for the transitions
    /// `signal_for` admits.
    pub fn observe(&self, session: &SessionSummary) {
        let Some(signal) = signal_for(session) else {
            return;
        };
        if !self.dedupe.admit(session) {
            return;
        }
        (self.sink)(self.message(&signal));
    }

    fn message(&self, signal: &PushSignal) -> NtfyMessage {
        NtfyMessage {
            title: signal.title.clone(),
            body: signal.body.clone(),
            priority: signal.priority.ntfy_header(),
            tags: signal.tags,
            click: self
                .mobile_url
                .as_deref()
                .map(|base| deep_link(base, &signal.session_id)),
        }
    }
}

/// Blocking test post, used by the Settings panel's "Send test notification"
/// button. Unlike the fire-and-forget publisher sink, the caller gets the
/// failure so a wrong topic URL is visible immediately.
pub fn post_test(topic_url: &str) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build();
    agent
        .post(topic_url)
        .set("Title", "Argmax: Test notification")
        .set("Priority", "default")
        .set("Tags", "bell")
        .send_string("Push notifications are working.")
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// `<mobile page>?session=<id>`, read once by the phone on load
/// (`src/renderer/mobile/deepLink.ts`). Session ids are hex/dash ids from
/// SQLite, so they need no escaping; anything else is dropped rather than
/// half-escaped into a header ureq would reject.
fn deep_link(mobile_url: &str, session_id: &str) -> String {
    if !session_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return mobile_url.to_string();
    }
    let separator = if mobile_url.contains('?') { '&' } else { '?' };
    format!("{mobile_url}{separator}session={session_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::signal::fixtures::session;
    use crate::sessions::attention::AttentionState;
    use crate::sessions::state::SessionState;
    use std::sync::mpsc;

    const MOBILE_URL: &str = "http://mac.tail1234.ts.net:8790/mobile.html";

    fn capture_publisher() -> (NtfyPublisher, mpsc::Receiver<NtfyMessage>) {
        capture_publisher_linking(Some(MOBILE_URL.to_string()))
    }

    fn capture_publisher_linking(
        mobile_url: Option<String>,
    ) -> (NtfyPublisher, mpsc::Receiver<NtfyMessage>) {
        let (tx, rx) = mpsc::channel();
        let publisher = NtfyPublisher::with_sink(
            Box::new(move |message| {
                let _ = tx.send(message);
            }),
            mobile_url,
        );
        (publisher, rx)
    }

    #[test]
    fn fires_once_per_transition_and_again_on_change() {
        let (publisher, rx) = capture_publisher();
        publisher.observe(&session(
            SessionState::Running,
            AttentionState::ApprovalNeeded,
        ));
        publisher.observe(&session(
            SessionState::Running,
            AttentionState::ApprovalNeeded,
        ));
        publisher.observe(&session(SessionState::Complete, AttentionState::Normal));

        let first = rx.try_recv().expect("approval push");
        assert_eq!(first.title, "Argmax: Needs approval");
        assert_eq!(first.priority, "high");
        let second = rx.try_recv().expect("completion push");
        assert_eq!(second.title, "Argmax: Chat complete");
        assert!(rx.try_recv().is_err(), "duplicate transition must not fire");
    }

    #[test]
    fn normal_running_sessions_are_silent() {
        let (publisher, rx) = capture_publisher();
        publisher.observe(&session(SessionState::Running, AttentionState::Normal));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn pushes_deep_link_to_the_session_that_raised_them() {
        let (publisher, rx) = capture_publisher();
        publisher.observe(&session(
            SessionState::Running,
            AttentionState::ApprovalNeeded,
        ));
        let message = rx.try_recv().expect("signal");
        assert_eq!(
            message.click.as_deref(),
            Some("http://mac.tail1234.ts.net:8790/mobile.html?session=s1")
        );
        // The Click value is an HTTP header too, so it carries the same
        // ASCII-only constraint as the title.
        assert!(message.click.unwrap().is_ascii());
    }

    #[test]
    fn no_mobile_url_sends_a_push_without_a_link() {
        let (publisher, rx) = capture_publisher_linking(None);
        publisher.observe(&session(
            SessionState::Running,
            AttentionState::ApprovalNeeded,
        ));
        assert_eq!(rx.try_recv().expect("signal").click, None);
    }

    #[test]
    fn an_exotic_session_id_falls_back_to_the_bare_page() {
        let (publisher, rx) = capture_publisher();
        let mut summary = session(SessionState::Running, AttentionState::Blocked);
        summary.id = "s 1?&".to_string();
        publisher.observe(&summary);
        assert_eq!(
            rx.try_recv().expect("signal").click.as_deref(),
            Some(MOBILE_URL)
        );
    }
}
