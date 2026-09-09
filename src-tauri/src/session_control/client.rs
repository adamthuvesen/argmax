use std::{
    env,
    io::{self, Read, Write},
    path::PathBuf,
    time::Duration,
};

use super::{
    protocol::{
        SessionControlAction, SessionControlError, SessionControlRequest, SessionControlResponse,
        SessionControlResult,
    },
    protocol_error,
    server::{read_json_line, Frame},
    CLIENT_IO_TIMEOUT, MAX_BROWSER_RESPONSE_BYTES, MAX_INBOX_RESPONSE_BYTES, MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES, PROTOCOL_VERSION, SESSION_LAUNCH_SOCKET_ENV, SESSION_LAUNCH_TOKEN_ENV,
    WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS, WAIT_RESPONSE_SLACK,
};

/// One round trip on the session-control socket. Every caller — the CLI, the
/// MCP tools — goes through here, so the framing, the timeouts, and the size
/// caps have one implementation.
#[cfg(unix)]
pub fn send_session_control(
    action: SessionControlAction,
) -> Result<SessionControlResponse, SessionControlError> {
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;

    let socket = env::var_os(SESSION_LAUNCH_SOCKET_ENV).ok_or_else(|| {
        protocol_error(
            "ENV_MISSING",
            format!("{SESSION_LAUNCH_SOCKET_ENV} is not set. Run this command inside Argmax."),
        )
    })?;
    let token = env::var(SESSION_LAUNCH_TOKEN_ENV).map_err(|_| {
        protocol_error(
            "ENV_MISSING",
            format!("{SESSION_LAUNCH_TOKEN_ENV} is not set. Run this command inside Argmax."),
        )
    })?;
    let request = SessionControlRequest {
        version: PROTOCOL_VERSION,
        token,
        action,
    };
    let mut encoded = serde_json::to_vec(&request).map_err(|error| {
        protocol_error(
            "REQUEST_ENCODE_FAILED",
            format!("Could not encode request: {error}"),
        )
    })?;
    encoded.push(b'\n');
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err(protocol_error(
            "REQUEST_TOO_LARGE",
            format!("Request exceeds the {MAX_REQUEST_BYTES}-byte limit."),
        ));
    }
    let mut stream = UnixStream::connect(PathBuf::from(socket)).map_err(|error| {
        protocol_error(
            "CONNECT_FAILED",
            format!("Could not connect to Argmax: {error}"),
        )
    })?;
    stream
        .set_read_timeout(Some(client_read_timeout(&request.action)))
        .map_err(|error| protocol_error("TIMEOUT_SETUP_FAILED", error.to_string()))?;
    stream
        .set_write_timeout(Some(CLIENT_IO_TIMEOUT))
        .map_err(|error| protocol_error("TIMEOUT_SETUP_FAILED", error.to_string()))?;
    stream.write_all(&encoded).map_err(|error| {
        protocol_error(
            "REQUEST_WRITE_FAILED",
            format!("Could not send request: {error}"),
        )
    })?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| protocol_error("REQUEST_WRITE_FAILED", error.to_string()))?;
    let response_cap = match request.action {
        SessionControlAction::Browser(_) => MAX_BROWSER_RESPONSE_BYTES,
        SessionControlAction::Inbox(_) | SessionControlAction::Wait(_) => MAX_INBOX_RESPONSE_BYTES,
        _ => MAX_RESPONSE_BYTES,
    };
    let response =
        read_json_line::<SessionControlResponse>(&mut stream, response_cap, Frame::Response)
            .map_err(|error| protocol_error(error.code, error.message))?;
    if response.version != PROTOCOL_VERSION {
        return Err(protocol_error(
            "VERSION_UNSUPPORTED",
            format!("Argmax returned protocol version {}.", response.version),
        ));
    }
    // Kept as a match: one arm per action is the readable form of this
    // request/response conformance table, and rustfmt explodes the `matches!`
    // alternative to four lines per pair.
    #[allow(clippy::match_like_matches_macro)]
    let matches_action = match (&request.action, &response.result) {
        (_, SessionControlResult::Error(_)) => true,
        (SessionControlAction::Launch(_), SessionControlResult::Launched(_)) => true,
        (SessionControlAction::Move(_), SessionControlResult::Scheduled(_)) => true,
        (SessionControlAction::List(_), SessionControlResult::Listed(_)) => true,
        (SessionControlAction::Message(_), SessionControlResult::Messaged(_)) => true,
        (SessionControlAction::Browser(_), SessionControlResult::Browsed(_)) => true,
        (SessionControlAction::Status(_), SessionControlResult::Status(_)) => true,
        (SessionControlAction::Read(_), SessionControlResult::Read(_)) => true,
        (SessionControlAction::Stop(_), SessionControlResult::Stopped(_)) => true,
        (SessionControlAction::Inbox(_), SessionControlResult::Inbox(_)) => true,
        (SessionControlAction::Wait(_), SessionControlResult::Waited(_)) => true,
        (SessionControlAction::GoalSet(_), SessionControlResult::Goal(_)) => true,
        (SessionControlAction::GoalClear, SessionControlResult::Goal(_)) => true,
        _ => false,
    };
    if !matches_action {
        return Err(protocol_error(
            "RESPONSE_INVALID",
            "Argmax answered with a result that does not match the request.",
        ));
    }
    match response.result {
        SessionControlResult::Error(error) => Err(error),
        result => Ok(SessionControlResponse {
            version: PROTOCOL_VERSION,
            unread_inbox: response.unread_inbox,
            result,
        }),
    }
}

/// How long the client waits for an answer. Every action but `wait` settles
/// within the ordinary timeout; a wait is a deliberate block, so the socket
/// stays open for its own timeout plus enough slack to carry the reply.
fn client_read_timeout(action: &SessionControlAction) -> Duration {
    match action {
        SessionControlAction::Wait(action) => {
            Duration::from_secs(
                action
                    .timeout_s
                    .unwrap_or(WAIT_DEFAULT_SECONDS)
                    .clamp(1, WAIT_MAX_SECONDS),
            ) + WAIT_RESPONSE_SLACK
        }
        _ => CLIENT_IO_TIMEOUT,
    }
}

pub(super) fn read_bounded_stdin() -> Result<String, SessionControlError> {
    let mut bytes = Vec::new();
    io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            protocol_error(
                "STDIN_READ_FAILED",
                format!("Could not read prompt from stdin: {error}"),
            )
        })?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(protocol_error(
            "REQUEST_TOO_LARGE",
            format!("Prompt exceeds the {MAX_REQUEST_BYTES}-byte request limit."),
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| protocol_error("PROMPT_INVALID", "Prompt stdin must be valid UTF-8."))
}
