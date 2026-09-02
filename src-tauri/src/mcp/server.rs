//! The `argmax` MCP server: stdio transport in, socket calls out.

use rmcp::{
    model::{ServerCapabilities, ServerInfo},
    tool_handler, ServerHandler, ServiceExt,
};

use super::session_tools::ArgmaxTools;

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

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ArgmaxTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Argmax runs this session. These tools reach the sessions around it: list them, launch \
             new ones on tasks of their own, message them, and move this session to another \
             project. Use them on your own initiative whenever the work calls for it — they act on \
             top-level sidebar sessions the user can see, not on subagents.",
        )
    }
}
