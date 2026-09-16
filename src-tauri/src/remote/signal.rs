// One trigger table for phone push.
//
// ntfy and APNs fire on the same session transitions and swallow repeats on
// the same (state, attention) pair; only the delivery differs. `signal_for`
// and `SignalDedupe` live here so a change to what a phone hears cannot reach
// one sink and miss the other.
//
// The desktop notification path (`notifications.rs`) is deliberately gated on
// the window being unfocused — a toast is redundant while you are looking at
// the app. Phone push is the opposite: it exists for when you are away from
// the machine, so it fires on every qualifying transition regardless of focus.

use std::sync::Mutex;

use crate::notifications::BoundedMap;
use crate::persistence::sessions::SessionSummary;
use crate::sessions::attention::AttentionState;
use crate::sessions::state::SessionState;
use crate::util::sync::LockOrRecover;

use pulldown_cmark::{Event, Options, Parser, TagEnd};

const DEDUP_CAPACITY: usize = 2_000;

/// How loudly a signal should land. `Urgent` is a chat stalled on the user and
/// worth a buzz through a focus filter; `Normal` is a chat that ended on its
/// own and can wait for the next glance at the phone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalPriority {
    Urgent,
    Normal,
}

impl SignalPriority {
    /// ntfy `Priority` header value.
    pub fn ntfy_header(self) -> &'static str {
        match self {
            Self::Urgent => "high",
            Self::Normal => "default",
        }
    }

    /// APNs `apns-priority` header value: 10 delivers immediately, 5 lets the
    /// device batch it for power.
    pub fn apns_header(self) -> &'static str {
        match self {
            Self::Urgent => "10",
            Self::Normal => "5",
        }
    }

    /// APNs `aps.interruption-level`. `time-sensitive` is what breaks through
    /// a Focus mode, which is exactly the case a stalled chat needs.
    pub fn interruption_level(self) -> &'static str {
        match self {
            Self::Urgent => "time-sensitive",
            Self::Normal => "active",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushSignal {
    /// ASCII only: ntfy carries this as an HTTP header and ureq rejects
    /// non-ASCII header values (an em dash here broke every live push).
    pub title: String,
    pub body: String,
    pub priority: SignalPriority,
    /// The session that raised it, so each sink can deep-link its own way —
    /// a `Click` URL for ntfy, a `sessionId` in the payload for APNs.
    pub session_id: String,
    /// ntfy `Tags` header value, rendered as emoji by the ntfy apps. Empty
    /// sends no header. APNs has no equivalent and ignores it.
    pub tags: &'static str,
}

/// True when this session row is one the phone hears. Callers use it to skip
/// the transcript read that fills the body of a push that would never fire.
pub fn signals(session: &SessionSummary) -> bool {
    trigger(session).is_some()
}

/// The transitions a phone cares about: stalled on the user, failed, or
/// finished. Everything else is silent.
///
/// `latest_answer` is the agent's most recent visible message, which is what
/// the body says: on the phone the push is the only place that text shows up
/// before you open the chat, and the initial prompt is something you already
/// know. Falls back to the prompt when the agent has not said anything yet.
pub fn signal_for(session: &SessionSummary, latest_answer: Option<&str>) -> Option<PushSignal> {
    let (title, priority, tags) = trigger(session)?;
    let body = latest_answer
        .map(str::trim)
        .filter(|answer| !answer.is_empty())
        .map(preview)
        .filter(|body| !body.is_empty())
        .unwrap_or_else(|| preview(&session.prompt));
    Some(PushSignal {
        title: format!("Argmax: {title}"),
        body,
        priority,
        session_id: session.id.clone(),
        tags,
    })
}

fn trigger(session: &SessionSummary) -> Option<(&'static str, SignalPriority, &'static str)> {
    let trigger = match (session.attention, session.state) {
        (AttentionState::ApprovalNeeded, _) => {
            ("Needs approval", SignalPriority::Urgent, "raised_hand")
        }
        (AttentionState::QuestionAsked, _) => (
            "Asked you a question",
            SignalPriority::Urgent,
            "speech_balloon",
        ),
        (AttentionState::Blocked, _) => {
            ("Waiting on you", SignalPriority::Urgent, "speech_balloon")
        }
        (_, SessionState::Failed) => ("Chat failed", SignalPriority::Normal, "x"),
        (_, SessionState::Complete) => ("Chat complete", SignalPriority::Normal, ""),
        _ => return None,
    };
    Some(trigger)
}

/// Per-session latch on the (state, attention) pair. A busy turn emits a
/// dashboard delta per streamed chunk, so without this every chunk of a
/// stalled chat would be its own push. Each sink owns one: sharing a latch
/// would let whichever publisher observed first silence the other.
pub struct SignalDedupe {
    last_signaled: Mutex<BoundedMap<String, String>>,
    label: &'static str,
}

impl SignalDedupe {
    pub fn new(label: &'static str) -> Self {
        Self {
            last_signaled: Mutex::new(BoundedMap::new(DEDUP_CAPACITY)),
            label,
        }
    }

    /// True the first time a session reaches a given (state, attention), and
    /// again once it moves to a different one.
    pub fn admit(&self, session: &SessionSummary) -> bool {
        let signature = format!("{}|{}", session.state.as_str(), session.attention.as_str());
        let mut last = self.last_signaled.lock_or_recover(self.label);
        if last
            .get(&session.id)
            .is_some_and(|prior| prior == &signature)
        {
            return false;
        }
        last.insert(session.id.clone(), signature);
        true
    }
}

/// The opening of a message as notification-safe plain text, on one line.
/// Newlines are collapsed because both sinks render the body as a single
/// wrapped paragraph, so a Markdown answer's blank lines would otherwise
/// spend the visible space on nothing.
fn preview(text: &str) -> String {
    const MAX: usize = 140;
    let plain_text = strip_markdown(text);
    let mut flattened = String::new();
    for word in plain_text.split_whitespace() {
        if !flattened.is_empty() {
            flattened.push(' ');
        }
        flattened.push_str(word);
        if flattened.chars().count() > MAX {
            break;
        }
    }
    if flattened.chars().count() <= MAX {
        return flattened;
    }
    let mut cut: String = flattened.chars().take(MAX).collect();
    cut.push('…');
    cut
}

/// Project Markdown events onto the text native notification surfaces can show.
/// Links keep their labels, code keeps its contents, and block boundaries turn
/// into whitespace for preview() to collapse.
fn strip_markdown(text: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_MATH;
    let mut plain_text = String::with_capacity(text.len());

    for event in Parser::new_ext(text, options) {
        match event {
            Event::Text(value)
            | Event::Code(value)
            | Event::InlineMath(value)
            | Event::DisplayMath(value) => plain_text.push_str(value.as_ref()),
            Event::Html(value) | Event::InlineHtml(value) => {
                append_html_text(&mut plain_text, value.as_ref());
            }
            Event::SoftBreak | Event::HardBreak => plain_text.push('\n'),
            Event::End(tag) if is_block_end(tag) => append_block_separator(&mut plain_text),
            Event::TaskListMarker(_) | Event::FootnoteReference(_) | Event::Rule => {}
            Event::Start(_) | Event::End(_) => {}
        }
    }

    plain_text
}

fn append_block_separator(text: &mut String) {
    if !text.ends_with('\n') {
        text.push('\n');
    }
}

fn is_block_end(tag: TagEnd) -> bool {
    matches!(
        tag,
        TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::List(_)
            | TagEnd::Item
            | TagEnd::FootnoteDefinition
            | TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition
            | TagEnd::Table
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::TableCell
            | TagEnd::MetadataBlock(_)
    )
}

fn append_html_text(text: &mut String, html: &str) {
    let mut in_tag = false;
    for character in html.chars() {
        match (in_tag, character) {
            (false, '<') => in_tag = true,
            (true, '>') => in_tag = false,
            (false, character) => text.push(character),
            (true, _) => {}
        }
    }
}
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub(crate) fn session(state: SessionState, attention: AttentionState) -> SessionSummary {
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
            state,
            attention,
            attention_changed_at: None,
            imported: false,
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
            launched_by_session_id: None,
            launch_kind: crate::persistence::sessions::LAUNCH_KIND_AGENT.to_string(),
            arc_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::session;
    use super::*;

    #[test]
    fn the_trigger_table_covers_attention_states_and_terminal_states() {
        let cases = [
            (
                SessionState::Running,
                AttentionState::ApprovalNeeded,
                "Argmax: Needs approval",
                SignalPriority::Urgent,
                "raised_hand",
            ),
            (
                SessionState::Running,
                AttentionState::QuestionAsked,
                "Argmax: Asked you a question",
                SignalPriority::Urgent,
                "speech_balloon",
            ),
            (
                SessionState::Running,
                AttentionState::Blocked,
                "Argmax: Waiting on you",
                SignalPriority::Urgent,
                "speech_balloon",
            ),
            (
                SessionState::Failed,
                AttentionState::Normal,
                "Argmax: Chat failed",
                SignalPriority::Normal,
                "x",
            ),
            (
                SessionState::Complete,
                AttentionState::Normal,
                "Argmax: Chat complete",
                SignalPriority::Normal,
                "",
            ),
        ];
        for (state, attention, title, priority, tags) in cases {
            let signal = signal_for(&session(state, attention), None).expect("signal");
            assert_eq!(signal.title, title);
            assert_eq!(signal.priority, priority);
            assert_eq!(signal.tags, tags);
            assert_eq!(signal.session_id, "s1");
        }
    }

    #[test]
    fn normal_running_sessions_are_silent() {
        assert!(signal_for(
            &session(SessionState::Running, AttentionState::Normal),
            None
        )
        .is_none());
    }

    /// The title travels as an ntfy HTTP header, so every branch of the table
    /// has to stay inside ASCII.
    #[test]
    fn titles_are_ascii_header_safe() {
        for (state, attention) in [
            (SessionState::Running, AttentionState::ApprovalNeeded),
            (SessionState::Running, AttentionState::QuestionAsked),
            (SessionState::Running, AttentionState::Blocked),
            (SessionState::Failed, AttentionState::Normal),
            (SessionState::Complete, AttentionState::Normal),
        ] {
            let signal = signal_for(&session(state, attention), None).expect("signal");
            assert!(signal.title.is_ascii(), "non-ASCII title: {}", signal.title);
        }
    }

    #[test]
    fn long_bodies_truncate() {
        let mut summary = session(SessionState::Failed, AttentionState::Normal);
        summary.prompt = "x".repeat(400);
        let signal = signal_for(&summary, None).expect("failed signal");
        assert!(signal.body.chars().count() <= 141);
        assert!(signal.body.ends_with('…'));
    }

    #[test]
    fn the_body_leads_with_the_agents_answer_not_the_prompt() {
        let summary = session(SessionState::Complete, AttentionState::Normal);
        let signal = signal_for(&summary, Some("  Shipped the dashboard.\n\nTests pass.  "))
            .expect("completion signal");
        assert_eq!(signal.body, "Shipped the dashboard. Tests pass.");
    }

    #[test]
    fn notification_body_strips_markdown_syntax() {
        let summary = session(SessionState::Complete, AttentionState::Normal);
        let signal = signal_for(
            &summary,
            Some(
                "# Summary\n\n**Done** with _care_ and ~~legacy~~. See [the docs](https://example.com).\n\n- `code` and <https://example.com>.",
            ),
        )
        .expect("completion signal");
        assert_eq!(
            signal.body,
            "Summary Done with care and legacy. See the docs. code and https://example.com."
        );
    }

    #[test]
    fn notification_body_preserves_code_and_autolink_text() {
        let summary = session(SessionState::Complete, AttentionState::Normal);
        let signal = signal_for(
            &summary,
            Some(
                "`[label](https://example.com)` Contact <dev@example.com> and <urn:isbn:123>.\n\n```swift\nprint(\"**done**\")\n```",
            ),
        )
        .expect("completion signal");
        assert_eq!(
            signal.body,
            "[label](https://example.com) Contact dev@example.com and urn:isbn:123. print(\"**done**\")"
        );
    }

    #[test]
    fn notification_body_handles_balanced_link_destinations() {
        let summary = session(SessionState::Complete, AttentionState::Normal);
        let signal = signal_for(
            &summary,
            Some("Read [the docs](https://example.com/a_(b)) for details."),
        )
        .expect("completion signal");
        assert_eq!(signal.body, "Read the docs for details.");
    }

    /// A chat can stall or fail before the agent says anything; the prompt is
    /// the only text there is then.
    #[test]
    fn a_blank_answer_falls_back_to_the_prompt() {
        let summary = session(SessionState::Complete, AttentionState::Normal);
        assert_eq!(
            signal_for(&summary, Some("   \n ")).expect("signal").body,
            "Build the dashboard"
        );
    }

    #[test]
    fn a_markdown_only_answer_falls_back_to_the_prompt() {
        let summary = session(SessionState::Complete, AttentionState::Normal);
        assert_eq!(
            signal_for(&summary, Some("---")).expect("signal").body,
            "Build the dashboard"
        );
    }

    #[test]
    fn dedupe_admits_once_per_transition_and_again_on_change() {
        let dedupe = SignalDedupe::new("test");
        let stalled = session(SessionState::Running, AttentionState::ApprovalNeeded);

        assert!(dedupe.admit(&stalled));
        assert!(!dedupe.admit(&stalled));
        assert!(dedupe.admit(&session(SessionState::Complete, AttentionState::Normal)));
    }

    #[test]
    fn dedupe_tracks_sessions_independently() {
        let dedupe = SignalDedupe::new("test");
        let first = session(SessionState::Running, AttentionState::ApprovalNeeded);
        let mut second = first.clone();
        second.id = "s2".to_string();

        assert!(dedupe.admit(&first));
        assert!(dedupe.admit(&second));
        assert!(!dedupe.admit(&first));
    }

    #[test]
    fn priority_maps_to_both_sinks() {
        assert_eq!(SignalPriority::Urgent.ntfy_header(), "high");
        assert_eq!(SignalPriority::Urgent.apns_header(), "10");
        assert_eq!(
            SignalPriority::Urgent.interruption_level(),
            "time-sensitive"
        );
        assert_eq!(SignalPriority::Normal.ntfy_header(), "default");
        assert_eq!(SignalPriority::Normal.apns_header(), "5");
        assert_eq!(SignalPriority::Normal.interruption_level(), "active");
    }
}
