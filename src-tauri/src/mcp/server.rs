//! The `argmax` MCP server: stdio transport in, socket calls out.

use rmcp::{
    model::{ServerCapabilities, ServerConfig},
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
        let tools = ArgmaxTools::new();
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
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(agent_tools_instruction(self.browser_tools))
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

        let instructions = ArgmaxTools::with_browser_tools(true)
            .get_info()
            .instructions
            .expect("server instructions");

        assert!(instructions.contains(AGENT_TOOLS_INSTRUCTION));
        assert!(instructions.contains(BROWSER_COOKIE_PERMISSION));
        assert!(instructions.contains(SELF_PRESERVATION_INSTRUCTION));
        assert!(instructions.contains(CHECKOUT_MOVE_INSTRUCTION));
        assert!(!instructions
            .to_ascii_lowercase()
            .contains("on your own initiative"));
    }

    /// A session without the browser tools must not be told it has them. The
    /// cookie grant goes too: there is nothing left to accept a prompt on.
    #[test]
    fn browser_tools_off_removes_every_promise_of_a_browser() {
        use crate::providers::mcp_injection::{
            BROWSER_COOKIE_PERMISSION, CHECKOUT_MOVE_INSTRUCTION, SELF_PRESERVATION_INSTRUCTION,
        };

        let tools = ArgmaxTools::with_browser_tools(false);
        let listed = tools
            .tool_router
            .list_all()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect::<Vec<_>>();
        assert!(
            !listed.iter().any(|name| name.starts_with("browser_")),
            "browser tools are still on the router: {listed:?}"
        );
        assert!(listed.contains(&"session_launch".to_string()));

        let instructions = tools.get_info().instructions.expect("server instructions");
        assert!(!instructions.to_ascii_lowercase().contains("browser"));
        assert!(!instructions.contains(BROWSER_COOKIE_PERMISSION));
        // Everything that does not depend on a browser is untouched.
        assert!(instructions.contains(SELF_PRESERVATION_INSTRUCTION));
        assert!(instructions.contains(CHECKOUT_MOVE_INSTRUCTION));
    }

    /// One server, one tool list, injected the same way for all five providers
    /// — so a tool that is on this router reaches every provider, and a tool
    /// that is missing reaches none of them. That makes this the cheapest
    /// place to hold the surface still.
    #[test]
    fn every_tool_is_on_the_one_router_both_surfaces_share() {
        let tools = ArgmaxTools::with_browser_tools(true);
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
            "sources_list",
            "sources_read",
            "sources_add",
            "terminal_spawn",
            "terminal_read",
            "project_list",
            "arc_status",
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
        // description is the only place its bounds are stated. None of them
        // carries schemars' dialect stamp, which no client reads and every
        // turn pays for.
        for tool in tools.tool_router.list_all() {
            let description = tool.description.clone().unwrap_or_default();
            assert!(
                description.len() > 40,
                "{} has no usable description",
                tool.name
            );
            assert!(
                !tool.input_schema.contains_key("$schema"),
                "{} still carries $schema",
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
