// MCP server registry — discovers user-scope MCP servers configured for each
// CLI client Argmax launches (Claude Code, Codex, Cursor). Mirrors the TS
// implementation in `src/main/mcp/mcpRegistry.ts`. Project-scoped overrides
// are intentionally out of scope — only the top-level `mcpServers` map under
// each user-level config file is read.
//
// Config files:
//   claude:  ~/.claude.json (top-level `mcpServers`)
//   codex:   ~/.codex/config.toml (every `[mcp_servers.NAME]` table)
//   cursor:  ~/.cursor/mcp.json (top-level `mcpServers`)
//
// Every client returns a listing even when its config file is missing — the
// UI distinguishes "no config" from "empty config" from "parse error" via
// `configExists` and `error`. None of the read paths return Err; a missing
// file is the normal initial state.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ipc::validation::ProviderId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    User,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub client: ProviderId,
    pub name: String,
    pub transport: McpTransport,
    pub scope: McpScope,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub env_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpClientListing {
    pub client: ProviderId,
    pub display_name: String,
    pub config_path: String,
    pub config_exists: bool,
    pub servers: Vec<McpServerEntry>,
    pub error: Option<String>,
}

fn display_name(client: ProviderId) -> &'static str {
    match client {
        ProviderId::Claude => "Claude Code",
        ProviderId::Codex => "Codex",
        ProviderId::Cursor => "Cursor",
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// List user-scope MCP servers configured for each CLI client. When `home`
/// is `None`, falls back to `$HOME`. Returns three listings in canonical
/// order: claude, codex, cursor. Never errors — a missing or malformed
/// config surfaces via `config_exists` / `error` on the listing.
pub async fn list_mcp_servers(home: Option<&Path>) -> Vec<McpClientListing> {
    let owned_home = home.map(Path::to_path_buf).or_else(home_dir);
    let Some(home) = owned_home else {
        // No HOME set — return every client with `configExists: false`
        // and an empty path. Matches the "no config" branch the renderer
        // already handles.
        return vec![
            empty_listing(ProviderId::Claude, ""),
            empty_listing(ProviderId::Codex, ""),
            empty_listing(ProviderId::Cursor, ""),
        ];
    };

    let claude = list_claude_mcp(&home).await;
    let codex = list_codex_mcp(&home).await;
    let cursor = list_cursor_mcp(&home).await;
    vec![claude, codex, cursor]
}

// ---------------------------------------------------------------------------
// Claude — ~/.claude.json, top-level `mcpServers` map
// ---------------------------------------------------------------------------

async fn list_claude_mcp(home: &Path) -> McpClientListing {
    let config_path = home.join(".claude.json");
    read_json_mcp_servers(&config_path, ProviderId::Claude).await
}

// ---------------------------------------------------------------------------
// Cursor — ~/.cursor/mcp.json, top-level `mcpServers` map
// ---------------------------------------------------------------------------

async fn list_cursor_mcp(home: &Path) -> McpClientListing {
    let config_path = home.join(".cursor").join("mcp.json");
    read_json_mcp_servers(&config_path, ProviderId::Cursor).await
}

/// Shared read path for the two JSON-shaped MCP configs (Claude + Cursor):
/// load the file, parse, extract the `mcpServers` map. A missing file is
/// the normal initial state and surfaces as `config_exists: false`; a parse
/// failure surfaces as `config_exists: true` + `error`.
async fn read_json_mcp_servers(config_path: &Path, client: ProviderId) -> McpClientListing {
    let config_path_str = config_path.to_string_lossy().into_owned();
    let raw = match tokio::fs::read_to_string(config_path).await {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return empty_listing(client, &config_path_str);
        }
        Err(error) => {
            return McpClientListing {
                client,
                display_name: display_name(client).to_string(),
                config_path: config_path_str.clone(),
                config_exists: true,
                servers: Vec::new(),
                error: Some(format!("Could not read {config_path_str}: {error}")),
            };
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => {
            return McpClientListing {
                client,
                display_name: display_name(client).to_string(),
                config_path: config_path_str.clone(),
                config_exists: true,
                servers: Vec::new(),
                error: Some(format!("Could not parse {config_path_str}")),
            };
        }
    };

    let servers = extract_json_mcp_servers(&parsed, client, &config_path_str);
    McpClientListing {
        client,
        display_name: display_name(client).to_string(),
        config_path: config_path_str,
        config_exists: true,
        servers,
        error: None,
    }
}

fn extract_json_mcp_servers(
    parsed: &serde_json::Value,
    client: ProviderId,
    config_path: &str,
) -> Vec<McpServerEntry> {
    let Some(obj) = parsed.as_object() else {
        return Vec::new();
    };
    let Some(mcp_servers) = obj.get("mcpServers").and_then(|v| v.as_object()) else {
        return Vec::new();
    };

    let mut entries: Vec<McpServerEntry> = Vec::new();
    for (name, raw) in mcp_servers {
        let Some(raw_obj) = raw.as_object() else {
            continue;
        };
        let url = raw_obj
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let command = raw_obj
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let explicit_type = raw_obj
            .get("type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_lowercase());
        let transport = classify_transport(
            explicit_type.as_deref(),
            command.as_deref(),
            url.as_deref(),
        );
        let env_keys = raw_obj
            .get("env")
            .and_then(|v| v.as_object())
            .map(|env| env.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        entries.push(McpServerEntry {
            client,
            name: name.clone(),
            transport,
            scope: McpScope::User,
            source: config_path.to_string(),
            command,
            url,
            env_keys,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

// ---------------------------------------------------------------------------
// Codex — ~/.codex/config.toml, every `[mcp_servers.NAME]` table
// ---------------------------------------------------------------------------

async fn list_codex_mcp(home: &Path) -> McpClientListing {
    let config_path = home.join(".codex").join("config.toml");
    let config_path_str = config_path.to_string_lossy().into_owned();
    let raw = match tokio::fs::read_to_string(&config_path).await {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return empty_listing(ProviderId::Codex, &config_path_str);
        }
        Err(error) => {
            return McpClientListing {
                client: ProviderId::Codex,
                display_name: display_name(ProviderId::Codex).to_string(),
                config_path: config_path_str.clone(),
                config_exists: true,
                servers: Vec::new(),
                error: Some(format!("Could not read {config_path_str}: {error}")),
            };
        }
    };

    let servers = parse_codex_mcp_tables(&raw, &config_path_str);
    McpClientListing {
        client: ProviderId::Codex,
        display_name: display_name(ProviderId::Codex).to_string(),
        config_path: config_path_str,
        config_exists: true,
        servers,
        error: None,
    }
}

/// Focused TOML reader: collects `[mcp_servers.NAME]` and
/// `[mcp_servers.NAME.env]` tables and pulls out the three fields we care
/// about (command, url, env keys). It is NOT a general TOML parser —
/// inline arrays, comments, and quoted-string keys are handled just enough
/// for typical Codex configs. Anything outside `mcp_servers.*` is ignored.
pub fn parse_codex_mcp_tables(content: &str, source: &str) -> Vec<McpServerEntry> {
    #[derive(Debug, Default)]
    struct Acc {
        command: Option<String>,
        url: Option<String>,
        env_keys: Vec<String>,
    }
    enum Section {
        Ignore,
        Server(String),
        Env(String),
    }

    // Preserve insertion order so the final sort is stable, but keep a
    // side index so we can look up & mutate.
    let mut order: Vec<String> = Vec::new();
    let mut servers: std::collections::HashMap<String, Acc> = std::collections::HashMap::new();
    let mut section = Section::Ignore;
    // While inside a multi-line inline array, ignore content lines until we
    // hit `]`. We don't need the values — just need to avoid misreading
    // `command = "..."` inside a string in the array.
    let mut in_array = false;

    for raw_line in content.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let stripped = strip_toml_comment(line);
        let stripped = stripped.trim();
        if stripped.is_empty() {
            continue;
        }

        if in_array {
            if stripped.contains(']') {
                in_array = false;
            }
            continue;
        }

        if let Some(header) = match_table_header(stripped) {
            // Match `mcp_servers.NAME` or `mcp_servers.NAME.SUB`.
            let Some(rest) = header.strip_prefix("mcp_servers.") else {
                section = Section::Ignore;
                continue;
            };
            let (name_raw, sub) = match rest.find('.') {
                Some(idx) => (&rest[..idx], Some(&rest[idx + 1..])),
                None => (rest, None),
            };
            let name = unquote_toml_key(name_raw);
            if name.is_empty() {
                section = Section::Ignore;
                continue;
            }
            if !servers.contains_key(&name) {
                order.push(name.clone());
                servers.insert(name.clone(), Acc::default());
            }
            section = match sub {
                Some("env") => Section::Env(name),
                Some(_) => Section::Ignore,
                None => Section::Server(name),
            };
            continue;
        }

        if matches!(section, Section::Ignore) {
            if stripped.ends_with('[') || ends_with_array_open(stripped) {
                in_array = true;
            }
            continue;
        }

        let Some(eq) = stripped.find('=') else {
            continue;
        };
        let key = stripped[..eq].trim();
        let value = stripped[eq + 1..].trim();

        match &section {
            Section::Env(name) => {
                if let Some(entry) = servers.get_mut(name) {
                    if !key.is_empty() {
                        entry.env_keys.push(unquote_toml_key(key));
                    }
                }
            }
            Section::Server(name) => {
                let Some(entry) = servers.get_mut(name) else {
                    continue;
                };
                if key == "command" {
                    if let Some(s) = parse_toml_string(value) {
                        entry.command = Some(s);
                    }
                } else if key == "url" {
                    if let Some(s) = parse_toml_string(value) {
                        entry.url = Some(s);
                    }
                } else if value.starts_with('[') && !value.ends_with(']') {
                    // Multi-line array; skip its body.
                    in_array = true;
                }
            }
            Section::Ignore => {}
        }
    }

    let mut out: Vec<McpServerEntry> = order
        .into_iter()
        .filter_map(|name| {
            let data = servers.remove(&name)?;
            let transport = classify_transport(None, data.command.as_deref(), data.url.as_deref());
            Some(McpServerEntry {
                client: ProviderId::Codex,
                name,
                transport,
                scope: McpScope::User,
                source: source.to_string(),
                command: data.command,
                url: data.url,
                env_keys: data.env_keys,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn match_table_header(line: &str) -> Option<&str> {
    if !line.starts_with('[') || line.starts_with("[[") {
        return None;
    }
    let end = line.find(']')?;
    Some(line[1..end].trim())
}

fn strip_toml_comment(line: &str) -> String {
    // Strip `#` and anything after, but only when not inside a string.
    let mut in_double = false;
    let mut in_single = false;
    let bytes = line.as_bytes();
    for (i, &ch) in bytes.iter().enumerate() {
        match ch {
            b'"' if !in_single => in_double = !in_double,
            b'\'' if !in_double => in_single = !in_single,
            b'#' if !in_double && !in_single => return line[..i].to_string(),
            _ => {}
        }
    }
    line.to_string()
}

fn unquote_toml_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        let first = bytes[0];
        let last = bytes[trimmed.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn parse_toml_string(value: &str) -> Option<String> {
    let v = value.trim();
    if v.len() < 2 {
        return None;
    }
    let bytes = v.as_bytes();
    let first = bytes[0];
    let last = bytes[v.len() - 1];
    if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
        return Some(v[1..v.len() - 1].to_string());
    }
    None
}

fn ends_with_array_open(line: &str) -> bool {
    // Match the JS regex `/=\s*\[\s*$/`: an `=` followed by whitespace,
    // a `[`, then optional whitespace at end of line.
    let trimmed = line.trim_end();
    if !trimmed.ends_with('[') {
        return false;
    }
    let without_bracket = &trimmed[..trimmed.len() - 1];
    let after_eq = without_bracket.trim_end();
    after_eq.ends_with('=')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn classify_transport(
    explicit_type: Option<&str>,
    command: Option<&str>,
    url: Option<&str>,
) -> McpTransport {
    match explicit_type {
        Some("stdio") => return McpTransport::Stdio,
        Some("http") => return McpTransport::Http,
        Some("sse") => return McpTransport::Sse,
        _ => {}
    }
    if url.is_some() {
        return McpTransport::Http;
    }
    if command.is_some() {
        return McpTransport::Stdio;
    }
    McpTransport::Unknown
}

fn empty_listing(client: ProviderId, config_path: &str) -> McpClientListing {
    McpClientListing {
        client,
        display_name: display_name(client).to_string(),
        config_path: config_path.to_string(),
        config_exists: false,
        servers: Vec::new(),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn find<'a>(
        listings: &'a [McpClientListing],
        client: ProviderId,
    ) -> &'a McpClientListing {
        listings
            .iter()
            .find(|l| l.client == client)
            .expect("listing present")
    }

    #[tokio::test]
    async fn missing_configs_return_one_listing_per_client() {
        let dir = TempDir::new().unwrap();
        let listings = list_mcp_servers(Some(dir.path())).await;
        assert_eq!(listings.len(), 3);
        let clients: Vec<ProviderId> = listings.iter().map(|l| l.client).collect();
        assert_eq!(
            clients,
            vec![ProviderId::Claude, ProviderId::Codex, ProviderId::Cursor]
        );
        for listing in &listings {
            assert!(!listing.config_exists, "{:?} should be missing", listing.client);
            assert!(listing.servers.is_empty());
            assert!(listing.error.is_none());
        }
    }

    #[tokio::test]
    async fn claude_json_extracts_servers_and_classifies_transport() {
        let dir = TempDir::new().unwrap();
        let json = serde_json::json!({
            "mcpServers": {
                "stdio-one": {
                    "type": "stdio",
                    "command": "x",
                    "args": ["a"],
                    "env": { "FOO": "1", "BAR": "2" }
                },
                "http-one": { "type": "http", "url": "https://example.com" },
                "infer-stdio": { "command": "y" },
                "infer-http": { "url": "https://z.example.com" }
            }
        });
        tokio::fs::write(dir.path().join(".claude.json"), json.to_string())
            .await
            .unwrap();

        let listings = list_mcp_servers(Some(dir.path())).await;
        let claude = find(&listings, ProviderId::Claude);
        assert!(claude.config_exists);
        let names: Vec<&str> = claude.servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["http-one", "infer-http", "infer-stdio", "stdio-one"]);

        let stdio_one = claude
            .servers
            .iter()
            .find(|s| s.name == "stdio-one")
            .unwrap();
        assert_eq!(stdio_one.transport, McpTransport::Stdio);
        assert_eq!(stdio_one.command.as_deref(), Some("x"));
        let mut env_keys = stdio_one.env_keys.clone();
        env_keys.sort();
        assert_eq!(env_keys, vec!["BAR".to_string(), "FOO".to_string()]);

        let http_one = claude
            .servers
            .iter()
            .find(|s| s.name == "http-one")
            .unwrap();
        assert_eq!(http_one.transport, McpTransport::Http);
        let infer_stdio = claude
            .servers
            .iter()
            .find(|s| s.name == "infer-stdio")
            .unwrap();
        assert_eq!(infer_stdio.transport, McpTransport::Stdio);
        let infer_http = claude
            .servers
            .iter()
            .find(|s| s.name == "infer-http")
            .unwrap();
        assert_eq!(infer_http.transport, McpTransport::Http);
    }

    #[tokio::test]
    async fn cursor_mcp_json_is_read() {
        let dir = TempDir::new().unwrap();
        tokio::fs::create_dir_all(dir.path().join(".cursor"))
            .await
            .unwrap();
        let json = serde_json::json!({
            "mcpServers": {
                "slack": { "type": "http", "url": "https://mcp.slack.com/mcp" }
            }
        });
        tokio::fs::write(dir.path().join(".cursor/mcp.json"), json.to_string())
            .await
            .unwrap();

        let listings = list_mcp_servers(Some(dir.path())).await;
        let cursor = find(&listings, ProviderId::Cursor);
        assert!(cursor.config_exists);
        assert_eq!(cursor.servers.len(), 1);
        assert_eq!(cursor.servers[0].name, "slack");
        assert_eq!(cursor.servers[0].transport, McpTransport::Http);
    }

    #[tokio::test]
    async fn malformed_json_surfaces_parse_error_without_panicking() {
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join(".claude.json"), "{not json")
            .await
            .unwrap();
        let listings = list_mcp_servers(Some(dir.path())).await;
        let claude = find(&listings, ProviderId::Claude);
        assert!(claude.config_exists);
        assert!(claude.error.as_deref().unwrap_or("").contains("Could not parse"));
        assert!(claude.servers.is_empty());
    }

    #[tokio::test]
    async fn codex_toml_is_parsed() {
        let dir = TempDir::new().unwrap();
        tokio::fs::create_dir_all(dir.path().join(".codex"))
            .await
            .unwrap();
        let toml = r#"
# unrelated config
model = "gpt"
[features]
hooks = true

[mcp_servers.trace]
command = "uv"
args = [
  "run",
  "--directory",
  "/tmp/trace",
  "trace",
]
default_tools_approval_mode = "approve"
[mcp_servers.trace.env]
KB_COLLECTIONS = "wiki:/tmp/wiki"
LOG_LEVEL = "INFO"

[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
default_tools_approval_mode = "approve"
"#;
        tokio::fs::write(dir.path().join(".codex/config.toml"), toml)
            .await
            .unwrap();

        let listings = list_mcp_servers(Some(dir.path())).await;
        let codex = find(&listings, ProviderId::Codex);
        assert!(codex.config_exists);
        let names: Vec<&str> = codex.servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["context7", "linear", "trace"]);

        let trace = codex
            .servers
            .iter()
            .find(|s| s.name == "trace")
            .unwrap();
        assert_eq!(trace.transport, McpTransport::Stdio);
        assert_eq!(trace.command.as_deref(), Some("uv"));
        assert!(trace.url.is_none());
        let mut env_keys = trace.env_keys.clone();
        env_keys.sort();
        assert_eq!(
            env_keys,
            vec!["KB_COLLECTIONS".to_string(), "LOG_LEVEL".to_string()]
        );

        let context7 = codex
            .servers
            .iter()
            .find(|s| s.name == "context7")
            .unwrap();
        assert_eq!(context7.transport, McpTransport::Http);
        assert_eq!(
            context7.url.as_deref(),
            Some("https://mcp.context7.com/mcp")
        );
        assert!(context7.command.is_none());
    }

    #[test]
    fn codex_inline_arrays_dont_leak_into_next_table() {
        let toml = r#"
[mcp_servers.a]
command = "x"
args = ["one", "two"]

[mcp_servers.b]
url = "https://example.com"
"#;
        let result = parse_codex_mcp_tables(toml, "/x/config.toml");
        assert_eq!(result.len(), 2);
        let a = result.iter().find(|r| r.name == "a").unwrap();
        assert_eq!(a.transport, McpTransport::Stdio);
        let b = result.iter().find(|r| r.name == "b").unwrap();
        assert_eq!(b.transport, McpTransport::Http);
    }

    #[test]
    fn codex_unknown_transport_when_neither_command_nor_url() {
        let toml = r#"
[mcp_servers.weird]
some_field = "x"
"#;
        let result = parse_codex_mcp_tables(toml, "/x/config.toml");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].transport, McpTransport::Unknown);
    }

    #[test]
    fn codex_strips_comments_and_blank_lines() {
        let toml = r#"
# top comment

[mcp_servers.x] # inline comment after header
command = "x" # trailing comment
"#;
        let result = parse_codex_mcp_tables(toml, "/x/config.toml");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "x");
        assert_eq!(result[0].command.as_deref(), Some("x"));
    }
}
