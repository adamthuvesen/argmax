//! `argmax mcp` — the stdio MCP face on the session-control socket.
//!
//! The same binary the app runs from also serves an MCP server: a provider CLI
//! launches `argmax mcp` as a stdio child, and every tool call is forwarded to
//! the running app over the private Unix socket `session_control` already
//! listens on, authenticated with the per-session bearer token the launcher put
//! in the child's environment. No sidecar, no second control plane, and no new
//! wire protocol — the tools speak the same `SessionControlRequest` the
//! `argmax session …` CLI does.

use std::ffi::OsString;

mod server;
mod session_tools;

/// Dispatch `argmax mcp` before the GUI boots, mirroring
/// [`crate::session_control::try_run_session_control_cli`]. Returns `None` when
/// this invocation is not the MCP subcommand.
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
