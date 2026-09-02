//! The `argmax` MCP server: tools over stdio, socket calls under them.

use rmcp::{
    handler::server::router::tool::ToolRouter,
    model::{CallToolResult, ContentBlock, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router, ErrorData, ServerHandler, ServiceExt,
};

/// Serve the tool surface on stdin/stdout until the client disconnects.
///
/// A fresh current-thread Tokio runtime: this process is the MCP child, not the
/// app, so nothing else is running in it.
pub fn serve_stdio() -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("argmax mcp: could not start the runtime: {error}");
            return 1;
        }
    };
    runtime.block_on(async {
        let service = match ArgmaxTools::new().serve(rmcp::transport::stdio()).await {
            Ok(service) => service,
            Err(error) => {
                eprintln!("argmax mcp: could not start the server: {error}");
                return 1;
            }
        };
        match service.waiting().await {
            Ok(_) => 0,
            Err(error) => {
                eprintln!("argmax mcp: server stopped: {error}");
                1
            }
        }
    })
}

#[derive(Clone)]
pub struct ArgmaxTools {
    tool_router: ToolRouter<Self>,
}

#[tool_router(router = tool_router)]
impl ArgmaxTools {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    /// List the Argmax sessions in this session's project — id, project, task
    /// label, provider, state, and last activity, newest activity first.
    #[tool(
        name = "session_list",
        description = "List the other Argmax sessions in this session's project. Returns each session's id, project, task label, provider, state, and last activity time as JSON, newest activity first."
    )]
    async fn session_list(&self) -> Result<CallToolResult, ErrorData> {
        let response = tokio::task::spawn_blocking(list_sessions_over_socket)
            .await
            .map_err(|error| {
                ErrorData::internal_error(format!("session_list panicked: {error}"), None)
            })??;
        Ok(CallToolResult::success(vec![ContentBlock::text(response)]))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ArgmaxTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Argmax session and workspace control for the agent running inside Argmax.",
        )
    }
}

/// One round trip on the session-control socket, reusing the CLI's own client
/// so the wire protocol has exactly one implementation.
#[cfg(unix)]
fn list_sessions_over_socket() -> Result<String, ErrorData> {
    use crate::session_control::{run_session_control_cli_unix, SessionControlCliInput};

    let response = run_session_control_cli_unix(SessionControlCliInput::List {
        project: None,
        all: false,
    })
    .map_err(|error| {
        ErrorData::internal_error(format!("{}: {}", error.code, error.message), None)
    })?;
    serde_json::to_string(&response).map_err(|error| {
        ErrorData::internal_error(format!("could not encode the response: {error}"), None)
    })
}

#[cfg(not(unix))]
fn list_sessions_over_socket() -> Result<String, ErrorData> {
    Err(ErrorData::internal_error(
        "Argmax session control is not supported on this platform".to_string(),
        None,
    ))
}
