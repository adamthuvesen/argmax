use serde::{Deserialize, Serialize};

use super::PROTOCOL_VERSION;
use crate::mcp::browser_bridge::{BrowserOutcome, BrowserRequest};
use crate::sessions::state::SessionState;

/// One request on the session-control socket.
///
/// This is the whole wire protocol: the `argmax session …` CLI and the
/// `argmax mcp` tools both build a [`SessionControlAction`] and hand it to
/// [`send_session_control`](super::send_session_control), and the socket
/// handler matches on the same enum.
/// Each action carries exactly the fields it uses, so a nonsense combination
/// (a project selector on a message, a prompt on a move) cannot be encoded.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionControlRequest {
    pub version: u32,
    pub token: String,
    pub action: SessionControlAction,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum SessionControlAction {
    Launch(LaunchAction),
    Move(MoveAction),
    Archive(ArchiveAction),
    List(ListAction),
    Message(MessageAction),
    /// Drive the in-app browser. The MCP process has no `AppHandle`, so the
    /// tools send the action here and the app runs it — see
    /// [`crate::mcp::browser_bridge`].
    Browser(BrowserRequest),
    Status(StatusAction),
    Read(ReadAction),
    Stop(StopAction),
    Inbox(InboxAction),
    Wait(WaitAction),
}

/// Start a new top-level session. Provider and model default to the calling
/// session's own, so an agent that names neither gets a peer of itself.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchAction {
    pub prompt: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub worktree: bool,
    #[serde(default)]
    pub provider: Option<crate::providers::ProviderId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub task_label: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveAction {
    /// Another registered project to move to. Mutually exclusive with `path`.
    #[serde(default)]
    pub project: Option<String>,
    /// An existing checkout of the current project to move to — any directory
    /// `git worktree list` reports for it. Mutually exclusive with `project`.
    #[serde(default)]
    pub path: Option<String>,
    /// The turn the destination chat opens with. A move relocates work in
    /// progress, so the destination has to be told what to pick up there.
    pub prompt: String,
    #[serde(default)]
    pub worktree: bool,
    #[serde(default)]
    pub keep_source: bool,
}

/// No arguments: a session may only archive the workspace it is running in.
/// Archiving someone else's checkout out from under them is not an agent's
/// call, and the caller's own is the one it can reason about.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveAction {}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListAction {
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageAction {
    pub session_id: String,
    pub message: String,
}

/// What one session looks like right now, without reading its transcript.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusAction {
    pub session_id: String,
}

/// The normalized timeline since a cursor. `cursor` is the `nextCursor` a
/// previous read returned; omitting it starts from the beginning.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadAction {
    pub session_id: String,
    #[serde(default)]
    pub cursor: Option<i64>,
    #[serde(default)]
    pub max_chars: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopAction {
    pub session_id: String,
}

/// No arguments: an inbox read is always the caller's own.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxAction {}

/// Block until a watched session settles or a message arrives. With no
/// `sessions`, the watch list is every session this caller has launched.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitAction {
    #[serde(default)]
    pub sessions: Option<Vec<String>>,
    #[serde(default)]
    pub timeout_s: Option<u64>,
}

/// The response to one request. `result` is flattened, so a launch reads
/// `{"version":1,"launched":{…}}`, a list `{"version":1,"listed":{…}}`, and a
/// failure `{"version":1,"error":{…}}`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionControlResponse {
    pub version: u32,
    #[serde(flatten)]
    pub result: SessionControlResult,
    /// How much inbox mail is still undelivered to the calling session once
    /// this action has run. A running agent cannot be pushed into, but it
    /// reads every tool result — this is the one channel that reaches it
    /// mid-turn, so the tool client surfaces it as an extra note pointing at
    /// `inbox_read`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread_inbox: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionControlResult {
    Launched(LaunchedSession),
    Scheduled(ScheduledMove),
    Archiving(ScheduledArchive),
    Listed(SessionList),
    Messaged(MessageDelivery),
    Browsed(BrowserOutcome),
    Status(SessionStatus),
    Read(SessionRead),
    Stopped(SessionStopped),
    Inbox(InboxDelivery),
    Waited(WaitOutcome),
    Error(SessionControlError),
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchedSession {
    pub session_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledMove {
    pub scheduled: bool,
    pub source_session_id: String,
    pub project_id: String,
    pub project_name: String,
    /// Set for a checkout move: the directory the chat is headed for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledArchive {
    pub scheduled: bool,
    pub session_id: String,
    pub workspace_id: String,
    /// Always false, and kept for older tool clients. Archiving retains an
    /// isolated checkout and its branch in the archive location and leaves a
    /// shared checkout where it is, so nothing it does removes a worktree.
    pub removes_worktree: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionList {
    pub sessions: Vec<SessionListEntry>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDelivery {
    pub session_id: String,
    /// True when the target was mid-turn and the message waits for turn end.
    pub queued: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionListEntry {
    pub session_id: String,
    pub project_id: String,
    pub project_name: String,
    pub task_label: String,
    pub provider: String,
    pub state: SessionState,
    pub last_activity_at: String,
    /// The session that launched this one, when an agent did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launched_by_session_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStatus {
    pub session_id: String,
    pub task_label: String,
    pub provider: String,
    pub model_id: String,
    pub state: SessionState,
    /// Seconds since the current turn's prompt landed. `None` once the session
    /// has settled — there is no turn running to age.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_age_seconds: Option<i64>,
    pub last_activity_at: String,
    /// The session's most recent visible answer, capped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_text: Option<String>,
    /// Messages addressed to this session that no one has collected yet.
    pub unread_inbox: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launched_by_session_id: Option<String>,
    pub launch_depth: i64,
}

/// One normalized timeline row. `kind` is what the chat shows it as, not the
/// provider's own event name.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadEntry {
    pub at: String,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRead {
    pub session_id: String,
    pub entries: Vec<ReadEntry>,
    /// Feed this back as `cursor` to read only what arrives after these rows.
    pub next_cursor: i64,
    /// True when the byte cap cut the page short; read again from
    /// `next_cursor` for the rest.
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStopped {
    pub session_id: String,
    pub state: SessionState,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_label: Option<String>,
    pub kind: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxDelivery {
    pub messages: Vec<InboxMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitedSession {
    pub session_id: String,
    pub task_label: String,
    pub state: SessionState,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitOutcome {
    /// True when nothing happened before the timeout. Both lists are empty.
    pub timed_out: bool,
    /// Watched sessions that have settled.
    pub sessions: Vec<WaitedSession>,
    /// Messages that arrived for the caller, already marked delivered.
    pub messages: Vec<InboxMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionControlError {
    pub code: String,
    pub message: String,
}

impl SessionControlResponse {
    pub(super) fn new(result: SessionControlResult) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            result,
            unread_inbox: None,
        }
    }

    pub(super) fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(SessionControlResult::Error(SessionControlError {
            code: code.into(),
            message: message.into(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ProviderId;
    use crate::session_control::server::{read_json_line, Frame};
    use crate::session_control::MAX_REQUEST_BYTES;

    #[test]
    fn a_move_action_accepts_either_destination_on_the_wire() {
        // What an agent's `session_move` call actually deserializes into.
        let by_path: MoveAction =
            serde_json::from_str(r#"{"path":"/repo/worktrees/feature","prompt":"Carry on here"}"#)
                .expect("path-only move");
        assert_eq!(by_path.path.as_deref(), Some("/repo/worktrees/feature"));
        assert_eq!(by_path.project, None);

        let by_project: MoveAction =
            serde_json::from_str(r#"{"project":"Other","prompt":"Port the fix"}"#)
                .expect("project-only move");
        assert_eq!(by_project.project.as_deref(), Some("Other"));
        assert_eq!(by_project.path, None);
    }

    #[test]
    fn request_rejects_unknown_fields_and_requires_newline() {
        let with_unknown =
            b"{\"version\":1,\"token\":\"x\",\"action\":{\"list\":{\"all\":true}},\"extra\":true}\n";
        assert_eq!(
            read_json_line::<SessionControlRequest>(
                &mut with_unknown.as_slice(),
                MAX_REQUEST_BYTES,
                Frame::Request
            )
            .unwrap_err()
            .code,
            "REQUEST_INVALID"
        );
        // A field that belongs to another action is rejected with it.
        let wrong_action =
            b"{\"version\":1,\"token\":\"x\",\"action\":{\"list\":{\"keepSource\":true}}}\n";
        assert_eq!(
            read_json_line::<SessionControlRequest>(
                &mut wrong_action.as_slice(),
                MAX_REQUEST_BYTES,
                Frame::Request
            )
            .unwrap_err()
            .code,
            "REQUEST_INVALID"
        );
        let no_newline = br#"{"version":1,"token":"x","action":{"list":{"all":false}}}"#;
        assert_eq!(
            read_json_line::<SessionControlRequest>(
                &mut no_newline.as_slice(),
                MAX_REQUEST_BYTES,
                Frame::Request
            )
            .unwrap_err()
            .code,
            "REQUEST_NOT_TERMINATED"
        );
    }

    #[test]
    fn the_wire_round_trips_every_action_and_result() {
        let request = SessionControlRequest {
            version: PROTOCOL_VERSION,
            token: "t".to_string(),
            action: SessionControlAction::Launch(LaunchAction {
                prompt: "Do it".to_string(),
                project: Some("Argmax".to_string()),
                worktree: true,
                provider: Some(ProviderId::Claude),
                model: Some("claude-opus-5".to_string()),
                task_label: Some("Side quest".to_string()),
            }),
        };
        let encoded = serde_json::to_value(&request).expect("encode");
        assert_eq!(encoded["action"]["launch"]["provider"], "claude");
        assert_eq!(
            serde_json::from_value::<SessionControlRequest>(encoded).expect("decode"),
            request
        );

        for action in [
            SessionControlAction::Move(MoveAction {
                project: Some("Other".to_string()),
                path: None,
                prompt: "Port the fix here".to_string(),
                worktree: false,
                keep_source: true,
            }),
            SessionControlAction::List(ListAction::default()),
            SessionControlAction::Message(MessageAction {
                session_id: "s1".to_string(),
                message: "ping".to_string(),
            }),
        ] {
            let encoded = serde_json::to_string(&action).expect("encode");
            assert_eq!(
                serde_json::from_str::<SessionControlAction>(&encoded).expect("decode"),
                action
            );
        }

        // The result is flattened, so an agent reads `{"version":1,"messaged":…}`.
        let response =
            SessionControlResponse::new(SessionControlResult::Messaged(MessageDelivery {
                session_id: "s1".to_string(),
                queued: true,
            }));
        let encoded = serde_json::to_value(&response).expect("encode");
        assert_eq!(encoded["messaged"]["queued"], true);
        assert_eq!(encoded["version"], PROTOCOL_VERSION);
    }
}
