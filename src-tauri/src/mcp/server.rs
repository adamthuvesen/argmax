//! The `argmax` MCP server: stdio transport in, socket calls out.

use rmcp::{
    model::{ServerCapabilities, ServerInfo},
    tool_handler, ServerHandler, ServiceExt,
};

use super::session_tools::ArgmaxTools;
use crate::providers::mcp_injection::agent_tools_instruction;

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
        // Two routers, one server: the session tools and the browser tools
        // are separate surfaces on the same socket.
        let mut tools = ArgmaxTools::new();
        tools.tool_router += ArgmaxTools::browser_tool_router();
        let service = match tools.serve(rmcp::transport::stdio()).await {
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
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(agent_tools_instruction())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_instructions_pre_authorize_cookie_acceptance() {
        use crate::providers::mcp_injection::{
            AGENT_TOOLS_INSTRUCTION, BROWSER_COOKIE_PERMISSION, CHECKOUT_MOVE_INSTRUCTION,
            SELF_PRESERVATION_INSTRUCTION,
        };

        let instructions = ArgmaxTools::new()
            .get_info()
            .instructions
            .expect("server instructions");

        assert!(instructions.contains(AGENT_TOOLS_INSTRUCTION));
        assert!(instructions.contains("Keep bounded delegated work in the current chat"));
        assert!(instructions.contains("Use `session_launch` when the user explicitly asks"));
        assert!(instructions.contains("when the work needs its own independent, durable lifecycle"));
        assert!(instructions.contains("Do not launch a session merely for parallelism"));
        assert!(instructions.contains("`session_move`"));
        assert!(instructions.contains(BROWSER_COOKIE_PERMISSION));
        assert!(instructions.contains(SELF_PRESERVATION_INSTRUCTION));
        assert!(instructions.contains(CHECKOUT_MOVE_INSTRUCTION));
        assert!(!instructions
            .to_ascii_lowercase()
            .contains("on your own initiative"));
    }

    /// One server, one tool list, injected the same way for all five providers
    /// — so a tool that is on this router reaches every provider, and a tool
    /// that is missing reaches none of them. That makes this the cheapest
    /// place to hold the surface still.
    #[test]
    fn every_tool_is_on_the_one_router_both_surfaces_share() {
        let mut tools = ArgmaxTools::new();
        tools.tool_router += ArgmaxTools::browser_tool_router();
        let listed = tools
            .tool_router
            .list_all()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect::<Vec<_>>();

        for name in [
            "session_launch",
            "session_list",
            "session_status",
            "session_read",
            "session_message",
            "session_wait",
            "session_stop",
            "session_rename",
            "session_move",
            "workspace_archive",
            "goal_set",
            "goal_clear",
            "inbox_read",
            "checks_run",
            "workspace_status",
            "workspace_diff",
            "learnings_add",
            "learnings_search",
            "terminal_spawn",
            "terminal_read",
            "project_list",
            "schedule_followup",
            "schedule_list",
            "schedule_cancel",
            "schedule_resume",
            "browser_open",
            "browser_snapshot",
            "browser_console",
            "browser_network",
        ] {
            assert!(
                listed.contains(&name.to_string()),
                "{name} is not on the router: {listed:?}"
            );
        }

        // Every tool the model can call needs a description, since the
        // description is the only place its bounds are stated.
        for tool in tools.tool_router.list_all() {
            let description = tool.description.clone().unwrap_or_default();
            assert!(
                description.len() > 40,
                "{} has no usable description",
                tool.name
            );
        }

        let launch = tools
            .tool_router
            .list_all()
            .into_iter()
            .find(|tool| tool.name == "session_launch")
            .expect("session_launch schema");
        let properties = launch.input_schema["properties"]
            .as_object()
            .expect("launch properties");
        assert!(properties.contains_key("reasoning"));
        assert!(properties.contains_key("permissionMode"));
        assert!(properties.contains_key("path"));
        assert!(properties.contains_key("branch"));
        assert!(!properties.contains_key("permission_mode"));
    }
}
