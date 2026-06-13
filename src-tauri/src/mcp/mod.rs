// Section 8 of the rust port — MCP registry + auth PTY subsystem.
//
// `registry` enumerates user-scope MCP servers from each CLI client's
// global config (~/.claude.json, ~/.codex/config.toml, ~/.cursor/mcp.json).
// `auth` owns the interactive PTY behind Settings → MCP servers →
// "Authenticate via Claude (/mcp)". See `docs/architecture.md`.

pub mod auth;
pub mod registry;
