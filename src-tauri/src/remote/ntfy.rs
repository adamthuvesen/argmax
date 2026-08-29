// Push notifications to a phone via ntfy (https://ntfy.sh or self-hosted).
//
// The desktop notification path (`notifications.rs`) is deliberately gated on
// the window being unfocused — a toast is redundant while you are looking at
// the app. Phone push is the opposite: it exists for when you are away from
// the machine, so it fires on every qualifying transition regardless of
// focus, deduplicated per session on the (state, attention) pair.

use std::sync::Mutex;

use crate::notifications::BoundedMap;
use crate::persistence::sessions::SessionSummary;
use crate::util::sync::LockOrRecover;

const DEDUP_CAPACITY: usize = 2_000;
const REQUEST_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NtfyMessage {
    pub title: String,
    pub body: String,
    /// ntfy priority header value ("default" or "high").
    pub priority: &'static str,
    /// ntfy tags header value; rendered as emoji by the apps.
    pub tags: &'static str,
}

type Sink = Box<dyn Fn(NtfyMessage) + Send + Sync>;

pub struct NtfyPublisher {
    sink: Sink,
    last_signaled: Mutex<BoundedMap<String, String>>,
}

impl NtfyPublisher {
    /// Publisher POSTing to `topic_url` (the full topic URL, e.g.
    /// `https://ntfy.sh/<topic>`). Requests run on a throwaway thread so the
    /// dashboard-delta path never waits on the network.
    pub fn new(topic_url: String) -> Self {
        Self::with_sink(Box::new(move |message: NtfyMessage| {
            let topic_url = topic_url.clone();
            std::thread::spawn(move || {
                let agent = ureq::AgentBuilder::new()
                    .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
                    .build();
                let result = agent
                    .post(&topic_url)
                    .set("Title", &message.title)
                    .set("Priority", message.priority)
                    .set("Tags", message.tags)
                    .send_string(&message.body);
                if let Err(error) = result {
                    tracing::warn!(%error, "ntfy publish failed");
                }
            });
        }))
    }

    fn with_sink(sink: Sink) -> Self {
        Self {
            sink,
            last_signaled: Mutex::new(BoundedMap::new(DEDUP_CAPACITY)),
        }
    }

    /// Called for every session row in a dashboard delta. Fires at most once
    /// per (state, attention) value per session, and only for transitions a
    /// phone cares about: stalled on the user, failed, or finished.
    pub fn observe(&self, session: &SessionSummary) {
        let Some(message) = signal_for(session) else {
            return;
        };
        let signature = format!("{}|{}", session.state, session.attention);
        {
            let mut last = self.last_signaled.lock_or_recover("ntfy last signaled");
            if last
                .get(&session.id)
                .is_some_and(|prior| prior == &signature)
            {
                return;
            }
            last.insert(session.id.clone(), signature);
        }
        (self.sink)(message);
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

fn signal_for(session: &SessionSummary) -> Option<NtfyMessage> {
    let prompt = truncated_prompt(&session.prompt);
    let (title, priority, tags) = match (session.attention.as_str(), session.state.as_str()) {
        ("approval-needed", _) => ("Needs approval", "high", "raised_hand"),
        ("blocked", _) => ("Waiting on you", "high", "speech_balloon"),
        (_, "failed") => ("Session failed", "default", "x"),
        (_, "complete") => ("Session complete", "default", "white_check_mark"),
        _ => return None,
    };
    Some(NtfyMessage {
        // ASCII only: the title travels as an HTTP header, and ureq rejects
        // non-ASCII header values (an em dash here broke every live push).
        title: format!("Argmax: {title}"),
        body: prompt,
        priority,
        tags,
    })
}

fn truncated_prompt(prompt: &str) -> String {
    const MAX: usize = 140;
    let trimmed = prompt.trim();
    if trimmed.chars().count() <= MAX {
        return trimmed.to_string();
    }
    let mut cut: String = trimmed.chars().take(MAX).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn session(state: &str, attention: &str) -> SessionSummary {
        SessionSummary {
            id: "s1".to_string(),
            workspace_id: "w1".to_string(),
            provider: "codex".to_string(),
            model_label: "GPT".to_string(),
            model_id: "gpt".to_string(),
            reasoning_effort: None,
            permission_mode: "auto-approve".to_string(),
            agent_mode: None,
            provider_conversation_id: None,
            prompt: "Build the dashboard".to_string(),
            state: state.to_string(),
            attention: attention.to_string(),
            attention_changed_at: None,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            completed_at: None,
            last_activity_at: "2026-01-01T00:00:00Z".to_string(),
            cost_usd: 0.0,
            tokens: crate::persistence::sessions::UsageCounts {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            },
            context_tokens: 0,
            context_window: None,
        }
    }

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
        publisher.observe(&session("running", "approval-needed"));
        publisher.observe(&session("running", "approval-needed"));
        publisher.observe(&session("complete", "normal"));

        let first = rx.try_recv().expect("approval push");
        assert_eq!(first.title, "Argmax: Needs approval");
        assert_eq!(first.priority, "high");
        let second = rx.try_recv().expect("completion push");
        assert_eq!(second.title, "Argmax: Session complete");
        assert!(rx.try_recv().is_err(), "duplicate transition must not fire");
    }

    #[test]
    fn titles_are_ascii_header_safe() {
        for (state, attention) in [
            ("running", "approval-needed"),
            ("running", "blocked"),
            ("failed", "normal"),
            ("complete", "normal"),
        ] {
            let message = signal_for(&session(state, attention)).expect("signal");
            assert!(message.title.is_ascii(), "non-ASCII title: {}", message.title);
        }
    }

    #[test]
    fn normal_running_sessions_are_silent() {
        let (publisher, rx) = capture_publisher();
        publisher.observe(&session("running", "normal"));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn long_prompts_truncate() {
        let long = "x".repeat(400);
        let mut summary = session("failed", "normal");
        summary.prompt = long;
        let message = signal_for(&summary).expect("failed signal");
        assert!(message.body.chars().count() <= 141);
        assert!(message.body.ends_with('…'));
    }
}
