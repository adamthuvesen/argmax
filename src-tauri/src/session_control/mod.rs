//! The session-control socket: one private Unix socket that every agent tool
//! and every `argmax session …` command speaks to. [`protocol`] is the wire
//! itself, [`registry`] mints and resolves the per-session credential,
//! [`server`] accepts connections, [`actions`] runs what each request asks
//! for, and [`cli`] and [`client`] are the two callers on the other end.

mod actions;
mod cli;
mod client;
mod protocol;
mod registry;
mod server;

pub use actions::resume_after_turn_actions;
pub(crate) use actions::{launch_with_spec, task_label, AlongsideCheckout, LaunchSpec};
pub use cli::{try_run_session_control_cli, CliPrompt, SessionControlCliInput};
#[cfg(unix)]
pub use client::send_session_control;
pub use protocol::{
    ArchiveAction, InboxAction, InboxDelivery, InboxMessage, LaunchAction, LaunchedSession,
    ListAction, MessageAction, MessageDelivery, MoveAction, ReadAction, ReadEntry,
    ScheduledArchive, ScheduledMove, SessionControlAction, SessionControlError,
    SessionControlRequest, SessionControlResponse, SessionControlResult, SessionList,
    SessionListEntry, SessionRead, SessionStatus, SessionStopped, StatusAction, StopAction,
    WaitAction, WaitOutcome, WaitedSession,
};
pub use registry::{AfterTurn, SessionLaunchProcessConfig, SessionLaunchRegistry};
pub use server::{SessionLaunchError, SessionLaunchServer};

use std::time::Duration;

use crate::error::ArgmaxError;

const PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// A screenshot's base64 PNG rides in the reply, so the browser action gets
/// its own ceiling. `mcp::browser_bridge` caps the image well below this.
const MAX_BROWSER_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// Inbox and wait replies carry message bodies, and a body is marked delivered
/// as it is handed over — a reply refused for its size is a message nobody ever
/// reads. So they get a ceiling the worst case cannot reach:
/// `take_undelivered_messages` always takes its first row, capped at
/// `MAX_MESSAGE_BODY_CHARS` (16K characters, up to 64 KiB), and fills the rest
/// to `INBOX_READ_BYTE_BUDGET`, so at most 64K characters reach one reply. JSON
/// escaping spends at most six bytes on a character (a control character
/// becomes a six-byte unicode escape), which is 384 KiB, and the per-message
/// envelope is a few hundred bytes across at most `INBOX_READ_LIMIT` rows.
const MAX_INBOX_RESPONSE_BYTES: usize = 512 * 1024;
const SERVER_IO_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_IO_TIMEOUT: Duration = Duration::from_secs(75);
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// Back-off after an accept failure the listener survives, longer than the
/// poll interval so a condition that persists — running out of file
/// descriptors — neither spins the thread nor floods the log.
const ACCEPT_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const SESSION_LIST_LIMIT: usize = 40;
/// A session the user started is depth 0, so two levels of agent-launched
/// sessions exist below it and the third is refused.
const MAX_LAUNCH_DEPTH: i64 = 2;
const MAX_LAUNCHES_PER_SESSION: i64 = 10;
/// How many moves a chat may pick the work up after. A move starts a turn in
/// the destination, and that turn can move again; past this the chat lands,
/// says why it stopped, and waits for a person.
const MAX_CONTINUED_MOVES: i64 = 3;
/// `session_read`'s byte budget: the default an agent gets when it names none,
/// and the ceiling it may ask for. The ceiling leaves headroom under
/// `MAX_RESPONSE_BYTES` for the envelope and for JSON escaping.
const SESSION_READ_DEFAULT_CHARS: usize = 16 * 1024;
const SESSION_READ_MAX_CHARS: usize = 40 * 1024;
/// The last assistant message `session_status` carries, so a status call stays
/// a status call rather than a transcript read.
const STATUS_ANSWER_CHARS: usize = 2 * 1024;
const INBOX_READ_LIMIT: usize = 50;
/// How many bytes of message body one inbox hand-over may carry, so a big
/// backlog drains across several reads rather than one enormous reply. It is
/// not what keeps a hand-over readable: `take_undelivered_messages` takes its
/// first row whatever it costs, and a 16K-character body of four-byte scalars
/// is 64 KiB on its own — over `MAX_RESPONSE_BYTES`. Since a row is marked
/// delivered as it is handed over, the reply the caller reads has to be the
/// one that always fits, which is `MAX_INBOX_RESPONSE_BYTES`.
const INBOX_READ_BYTE_BUDGET: usize = 48 * 1024;
const WAIT_DEFAULT_SECONDS: u64 = 120;
const WAIT_MAX_SECONDS: u64 = 600;
/// A safety re-read while a wait is blocked. The broadcast is what makes a
/// wake immediate; this only covers an edge written by something other than
/// the provider service (or a subscriber that fell behind a burst).
const WAIT_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// How much longer than its own timeout a waiting client keeps the socket
/// open, so the answer to a wait that ran the full duration still arrives.
const WAIT_RESPONSE_SLACK: Duration = Duration::from_secs(30);
const INBOX_BROADCAST_CAPACITY: usize = 256;
/// Per-row caps inside a `session_read` page, so one enormous tool result
/// cannot spend the whole byte budget.
const READ_ENTRY_MAX_CHARS: usize = 2000;
const TOOL_ARGUMENT_MAX_CHARS: usize = 160;
const DEFAULT_TASK_LABEL: &str = "Local agent task";
const MAX_TASK_LABEL_CHARS: usize = 64;
const MAX_TASK_LABEL_BYTES: usize = 200;
const TASK_LABEL_ELLIPSIS: &str = "...";

pub const SESSION_LAUNCH_SOCKET_ENV: &str = "ARGMAX_SESSION_LAUNCH_SOCKET";
pub const SESSION_LAUNCH_TOKEN_ENV: &str = "ARGMAX_SESSION_LAUNCH_TOKEN";
pub const ARGMAX_BIN_ENV: &str = "ARGMAX_BIN";

fn invalid_input_error(error: crate::error::InvalidInputIssue) -> SessionControlError {
    protocol_error(error.code, error.message)
}

pub(crate) fn argmax_protocol_error(error: ArgmaxError) -> SessionControlError {
    match error {
        ArgmaxError::InvalidInput { issues } => issues.into_iter().next().map_or_else(
            || protocol_error("INVALID_INPUT", "Input is invalid."),
            invalid_input_error,
        ),
        ArgmaxError::RecordNotFound { kind, id } => {
            protocol_error("RECORD_NOT_FOUND", format!("{kind} '{id}' was not found."))
        }
        ArgmaxError::MigrationDrift { detail } => protocol_error("MIGRATION_DRIFT", detail),
        ArgmaxError::ServiceError { sub_code, message } => SessionControlError {
            code: sub_code,
            message,
        },
    }
}

fn protocol_error(code: impl Into<String>, message: impl Into<String>) -> SessionControlError {
    SessionControlError {
        code: code.into(),
        message: message.into(),
    }
}
