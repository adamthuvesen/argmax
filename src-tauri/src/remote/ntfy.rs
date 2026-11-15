// Push notifications to a phone via ntfy (https://ntfy.sh or self-hosted).
//
// What fires, and when, lives in `signal.rs` — this module is only the ntfy
// delivery of it: HTTP headers on a POST to a topic URL. The APNs sink next
// door reads the same table.

use crate::remote::signal::{signal_for, PushSignal, SignalDedupe};
use argmax_store::sessions::SessionSummary;
use reqwest::blocking::Client;

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
}

type Sink = Box<dyn Fn(NtfyMessage) + Send + Sync>;

pub struct NtfyPublisher {
    sink: Sink,
    dedupe: SignalDedupe,
}

impl NtfyPublisher {
    /// Publisher POSTing to `topic_url` (the full topic URL, e.g.
    /// `https://ntfy.sh/<topic>`). Requests run on a throwaway thread so the
    /// dashboard-delta path never waits on the network.
    pub fn new(topic_url: String) -> Self {
        Self::with_sink(Box::new(move |message: NtfyMessage| {
            let topic_url = topic_url.clone();
            std::thread::spawn(move || {
                let result = ntfy_client()
                    .and_then(|client| {
                        let mut request = client
                            .post(&topic_url)
                            .header("Title", &message.title)
                            .header("Priority", message.priority);
                        if !message.tags.is_empty() {
                            request = request.header("Tags", message.tags);
                        }
                        request.body(message.body).send()
                    })
                    .and_then(|response| response.error_for_status());
                if let Err(error) = result {
                    tracing::warn!(%error, "ntfy publish failed");
                }
            });
        }))
    }

    fn with_sink(sink: Sink) -> Self {
        Self {
            sink,
            dedupe: SignalDedupe::new("ntfy last signaled"),
        }
    }

    /// Called for every session row in a dashboard delta. Fires at most once
    /// per (state, attention) value per session, and only for the transitions
    /// `signal_for` admits. `latest_answer` is the agent's most recent visible
    /// message, which the push body leads with.
    pub fn observe(&self, session: &SessionSummary, latest_answer: Option<&str>) {
        let Some(signal) = signal_for(session, latest_answer) else {
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
        }
    }
}

/// Blocking test post, used by the Settings panel's "Send test notification"
/// button. Unlike the fire-and-forget publisher sink, the caller gets the
/// failure so a wrong topic URL is visible immediately.
pub fn post_test(topic_url: &str) -> Result<(), String> {
    ntfy_client()
        .and_then(|client| {
            client
                .post(topic_url)
                .header("Title", "Argmax: Test notification")
                .header("Priority", "default")
                .header("Tags", "bell")
                .body("Push notifications are working.")
                .send()
        })
        .and_then(|response| response.error_for_status())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Built on the calling thread, which is never an async worker: the publisher
/// posts from a throwaway thread and the Settings test from `spawn_blocking`.
fn ntfy_client() -> reqwest::Result<Client> {
    crate::util::tls::install_crypto_provider();
    Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::signal::fixtures::session;
    use argmax_contracts::sessions::attention::AttentionState;
    use argmax_contracts::sessions::state::SessionState;
    use std::sync::mpsc;

    fn capture_publisher() -> (NtfyPublisher, mpsc::Receiver<NtfyMessage>) {
        let (tx, rx) = mpsc::channel();
        let publisher = NtfyPublisher::with_sink(Box::new(move |message| {
            let _ = tx.send(message);
        }));
        (publisher, rx)
    }

    #[test]
    fn fires_once_per_transition_and_again_on_change() {
        let (publisher, rx) = capture_publisher();
        publisher.observe(
            &session(SessionState::Running, AttentionState::ApprovalNeeded),
            None,
        );
        publisher.observe(
            &session(SessionState::Running, AttentionState::ApprovalNeeded),
            None,
        );
        publisher.observe(
            &session(SessionState::Complete, AttentionState::Normal),
            None,
        );

        let first = rx.try_recv().expect("approval push");
        assert_eq!(first.title, "Argmax: Needs approval");
        assert_eq!(first.priority, "high");
        let second = rx.try_recv().expect("completion push");
        assert_eq!(second.title, "Argmax: Chat complete");
        assert!(rx.try_recv().is_err(), "duplicate transition must not fire");
    }
}
