//! `argmax mcp` — the stdio MCP face on the session-control socket.
//!
//! The same binary the app runs from also serves an MCP server: a provider CLI
//! launches `argmax mcp` as a stdio child, and every tool call is forwarded to
//! the running app over the private Unix socket `session_control` already
//! listens on, authenticated with the per-session bearer token the launcher put
//! in the child's environment. No sidecar, no second control plane, and no new
//! wire protocol — the tools speak `SessionControlRequest`. The browser tools
//! ride the same socket, with
//! their own action; `browser_bridge` holds both ends of that request.

use std::ffi::OsString;

pub mod browser_bridge;
mod browser_tools;
mod server;
mod session_tools;
mod visualization_tools;

/// Dispatch `argmax mcp` before the GUI boots. Returns `None` when this
/// invocation is not the MCP subcommand.
pub fn try_run_mcp_cli<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) != Some("mcp") {
        return None;
    }
    Some(server::serve_stdio())
}

/// Old chats may still tell the agent to run `$ARGMAX_BIN session …`. That
/// subcommand was removed; without this guard it would start a second GUI and
/// hit the instance lock.
pub fn try_reject_removed_session_cli<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) != Some("session") {
        return None;
    }
    eprintln!("argmax: the session CLI was removed; agents use the MCP tools");
    Some(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_removed_session_cli_exits_without_starting_the_app() {
        assert_eq!(
            try_reject_removed_session_cli(["argmax", "session", "list"]),
            Some(2)
        );
        assert_eq!(try_reject_removed_session_cli(["argmax"]), None);
        assert_eq!(try_reject_removed_session_cli(["argmax", "mcp"]), None);
    }
}
