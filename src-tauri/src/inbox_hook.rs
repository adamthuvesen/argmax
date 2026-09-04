//! `argmax hook inbox` — the provider-hook face on the session-control socket.
//!
//! A provider CLI that runs a command after every tool call and feeds its
//! output back to the model can hand over Argmax inbox mail at every tool
//! boundary, not only the ones where the agent happens to touch an `argmax`
//! tool. Claude Code is the first: its `PostToolUse` hook takes
//! `hookSpecificOutput.additionalContext` and inserts it into the running turn
//! as a system reminder ([mcp_injection.rs](crate::providers::mcp_injection)
//! installs the hook per launch). This subcommand is that command. It collects
//! the caller's undelivered messages through the same `Inbox` action
//! `inbox_read` uses — so a message handed over here is marked collected and
//! the queued turn behind it is dropped, exactly as for a read — and prints
//! them in the hook's output shape.
//!
//! Every failure path exits 0 with nothing on stdout: a hook that errors would
//! surface as noise in the transcript, and an undelivered message is the safe
//! direction to be wrong in — it waits for the next tool call or the turn end.

use std::ffi::OsString;
use std::io::{self, Read};

use serde::Deserialize;
use serde_json::json;

use crate::session_control::{
    InboxAction, InboxMessage, SessionControlAction, SessionControlResult,
};

/// More than any hook input Claude writes — a tool response is capped well
/// below this — so hitting it means the input is not what we expect.
const MAX_HOOK_INPUT_BYTES: usize = 16 * 1024 * 1024;

/// The fields of the hook's stdin JSON this command reads. Everything else
/// (tool name, input, response) is ignored.
#[derive(Debug, Default, Deserialize)]
struct HookInput {
    #[serde(default)]
    hook_event_name: Option<String>,
    /// Set when the hook fired inside a subagent. The inbox belongs to the
    /// session, not to a child of it, and a subagent that collected the mail
    /// would mark it delivered to an agent whose context the parent never
    /// sees.
    #[serde(default)]
    agent_id: Option<String>,
}

/// Dispatch `argmax hook inbox` before the GUI boots, mirroring
/// [`crate::session_control::try_run_session_control_cli`]. Returns `None`
/// when this invocation is not the hook subcommand.
pub fn try_run_inbox_hook_cli<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) != Some("hook") {
        return None;
    }
    if args.get(2).and_then(|value| value.to_str()) != Some("inbox") || args.len() > 3 {
        eprintln!("argmax: usage: argmax hook inbox");
        return Some(2);
    }
    Some(run_inbox_hook())
}

#[cfg(not(unix))]
fn run_inbox_hook() -> i32 {
    0
}

#[cfg(unix)]
fn run_inbox_hook() -> i32 {
    let input = match read_hook_input() {
        Ok(input) => input,
        Err(reason) => {
            eprintln!("argmax hook inbox: {reason}");
            return 0;
        }
    };
    if input.agent_id.as_deref().is_some_and(|id| !id.is_empty()) {
        return 0;
    }
    let messages = match crate::session_control::send_session_control(SessionControlAction::Inbox(
        InboxAction {},
    )) {
        Ok(response) => match response.result {
            SessionControlResult::Inbox(delivery) => delivery.messages,
            _ => Vec::new(),
        },
        Err(error) => {
            eprintln!("argmax hook inbox: {}: {}", error.code, error.message);
            return 0;
        }
    };
    if let Some(output) = hook_output(input.hook_event_name.as_deref(), &messages) {
        println!("{output}");
    }
    0
}

#[cfg(unix)]
fn read_hook_input() -> Result<HookInput, String> {
    let mut bytes = Vec::new();
    io::stdin()
        .take((MAX_HOOK_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read hook input: {error}"))?;
    if bytes.len() > MAX_HOOK_INPUT_BYTES {
        return Err("hook input exceeds the size limit".to_string());
    }
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(HookInput::default());
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("hook input is not JSON: {error}"))
}

/// The hook's stdout, or `None` when there is nothing to hand over — an empty
/// stdout is how a hook says "carry on".
fn hook_output(hook_event_name: Option<&str>, messages: &[InboxMessage]) -> Option<String> {
    if messages.is_empty() {
        return None;
    }
    Some(
        json!({
            "hookSpecificOutput": {
                "hookEventName": hook_event_name.unwrap_or("PostToolUse"),
                "additionalContext": additional_context(messages),
            }
        })
        .to_string(),
    )
}

/// The messages as the model reads them: a one-line header saying what this
/// is and that it is already collected, then each message under its own
/// separator line naming the sender.
fn additional_context(messages: &[InboxMessage]) -> String {
    let count = messages.len();
    let plural = if count == 1 { "" } else { "s" };
    let mut text = format!(
        "{count} message{plural} from other Argmax sessions arrived while you were working \
and {} handed over here, already collected: no inbox_read call is needed. Act on {} as part of \
your current turn.",
        if count == 1 { "is" } else { "are" },
        if count == 1 { "it" } else { "them" },
    );
    for message in messages {
        let what = match message.kind.as_str() {
            "completion" => "completion notice",
            "multitask" => "multitask result",
            _ => "message",
        };
        let sender = match (&message.from_label, &message.from_session_id) {
            (Some(label), Some(id)) => format!(" from \"{label}\" (session {id})"),
            (None, Some(id)) => format!(" from session {id}"),
            _ => String::new(),
        };
        text.push_str(&format!(
            "\n\n--- {what}{sender}, {} ---\n{}",
            message.created_at, message.body
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(kind: &str, label: Option<&str>, body: &str) -> InboxMessage {
        InboxMessage {
            from_session_id: Some("s-1".to_string()),
            from_label: label.map(str::to_string),
            kind: kind.to_string(),
            body: body.to_string(),
            created_at: "2026-09-04T10:00:00Z".to_string(),
        }
    }

    #[test]
    fn empty_inbox_prints_nothing() {
        assert_eq!(hook_output(Some("PostToolUse"), &[]), None);
    }

    #[test]
    fn output_is_the_hook_shape_and_names_each_sender() {
        let output = hook_output(
            None,
            &[
                message("message", Some("Review"), "Ship it"),
                message("completion", None, "Session s-1 finished"),
            ],
        )
        .expect("mail to hand over");
        let parsed: serde_json::Value = serde_json::from_str(&output).expect("JSON");
        assert_eq!(parsed["hookSpecificOutput"]["hookEventName"], "PostToolUse");
        let context = parsed["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .expect("context");
        assert!(context.starts_with("2 messages from other Argmax sessions"));
        assert!(context.contains(
            "--- message from \"Review\" (session s-1), 2026-09-04T10:00:00Z ---\nShip it"
        ));
        assert!(context.contains("--- completion notice from session s-1, 2026-09-04T10:00:00Z ---\nSession s-1 finished"));
    }

    #[test]
    fn subagent_input_is_recognised() {
        let input: HookInput = serde_json::from_str(
            r#"{"hook_event_name":"PostToolUse","tool_name":"Bash","agent_id":"agent-7","agent_type":"Explore"}"#,
        )
        .expect("hook input");
        assert_eq!(input.agent_id.as_deref(), Some("agent-7"));
        let top_level: HookInput =
            serde_json::from_str(r#"{"hook_event_name":"PostToolUse","tool_name":"Bash"}"#)
                .expect("hook input");
        assert_eq!(top_level.agent_id, None);
    }

    #[test]
    fn dispatch_only_claims_the_hook_subcommand() {
        assert_eq!(try_run_inbox_hook_cli(["argmax", "session", "list"]), None);
        assert_eq!(try_run_inbox_hook_cli(["argmax", "hook", "wat"]), Some(2));
        assert_eq!(try_run_inbox_hook_cli(["argmax", "hook"]), Some(2));
    }
}
