use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tokio::process::Command;

use crate::{ipc::validation::ProviderId, util::login_shell};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionKind {
    McpServer,
    Plugin,
    Connector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionScope {
    BuiltIn,
    User,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionAvailability {
    Available,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionAuthentication {
    Authenticated,
    Required,
    NotApplicable,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub name: String,
    pub kind: ConnectionKind,
    pub scope: ConnectionScope,
    pub availability: ConnectionAvailability,
    pub authentication: ConnectionAuthentication,
    pub status_detail: String,
    pub authentication_command: Option<String>,
}

pub async fn list_connections(
    provider: ProviderId,
    binary_path: Option<&str>,
    workspace: Option<&Path>,
) -> Vec<ConnectionSummary> {
    let workspace_owned = workspace.map(Path::to_path_buf);
    let mut rows = tokio::task::spawn_blocking(move || scan_filesystem(provider, workspace_owned))
        .await
        .unwrap_or_default();

    if let Some(binary) = binary_path {
        if let Some(output) = probe(provider, binary, workspace).await {
            merge_probe(provider, &output, &mut rows);
        }
    }

    rows.into_values().collect()
}

/// The synchronous config/plugin-cache scan, run off the tokio worker so a
/// slow disk (a cold plugin cache directory walk) never stalls other async
/// commands sharing the runtime.
fn scan_filesystem(
    provider: ProviderId,
    workspace: Option<PathBuf>,
) -> BTreeMap<String, ConnectionSummary> {
    let workspace = workspace.as_deref();
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut rows = BTreeMap::new();
    insert(
        &mut rows,
        ConnectionSummary {
            name: "argmax".to_owned(),
            kind: ConnectionKind::McpServer,
            scope: ConnectionScope::BuiltIn,
            availability: ConnectionAvailability::Available,
            authentication: ConnectionAuthentication::NotApplicable,
            status_detail: "Injected into every Argmax chat".to_owned(),
            authentication_command: None,
        },
    );

    match provider {
        ProviderId::Claude => {
            read_json_mcp(
                &home.join(".claude.json"),
                "mcpServers",
                ConnectionScope::User,
                provider,
                &mut rows,
            );
            if let Some(workspace) = workspace {
                read_json_mcp(
                    &workspace.join(".mcp.json"),
                    "mcpServers",
                    ConnectionScope::Project,
                    provider,
                    &mut rows,
                );
            }
            read_plugin_manifest(
                &home.join(".claude/plugins/installed_plugins.json"),
                &mut rows,
            );
        }
        ProviderId::Cursor => {
            read_json_mcp(
                &home.join(".cursor/mcp.json"),
                "mcpServers",
                ConnectionScope::User,
                provider,
                &mut rows,
            );
            if let Some(workspace) = workspace {
                read_json_mcp(
                    &workspace.join(".cursor/mcp.json"),
                    "mcpServers",
                    ConnectionScope::Project,
                    provider,
                    &mut rows,
                );
            }
            read_plugin_cache(&home.join(".cursor/plugins/cache"), &mut rows);
        }
        ProviderId::Opencode => {
            read_json_mcp(
                &home.join(".config/opencode/opencode.json"),
                "mcp",
                ConnectionScope::User,
                provider,
                &mut rows,
            );
            if let Some(workspace) = workspace {
                read_json_mcp(
                    &workspace.join("opencode.json"),
                    "mcp",
                    ConnectionScope::Project,
                    provider,
                    &mut rows,
                );
            }
        }
        ProviderId::Codex => {
            read_toml_sections(&home.join(".codex/config.toml"), provider, &mut rows);
        }
        ProviderId::Grok => {
            read_toml_sections(&home.join(".grok/config.toml"), provider, &mut rows);
            read_plugin_root(&home.join(".grok/installed-plugins"), &mut rows);
        }
    }

    rows
}

fn insert(rows: &mut BTreeMap<String, ConnectionSummary>, mut row: ConnectionSummary) {
    let key = format!("{:?}:{}", row.kind, row.name.to_lowercase());
    if let Some(existing) = rows.get(&key) {
        if existing.scope == ConnectionScope::BuiltIn {
            return;
        }
        row.scope = match (existing.scope, row.scope) {
            (_, ConnectionScope::BuiltIn) => ConnectionScope::BuiltIn,
            (ConnectionScope::Project, _) | (_, ConnectionScope::Project) => {
                ConnectionScope::Project
            }
            _ => ConnectionScope::User,
        };
    }
    rows.insert(key, row);
}

fn read_json_mcp(
    path: &Path,
    section: &str,
    scope: ConnectionScope,
    provider: ProviderId,
    rows: &mut BTreeMap<String, ConnectionSummary>,
) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let Ok(document) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    let Some(servers) = document.get(section).and_then(Value::as_object) else {
        return;
    };
    for (name, config) in servers {
        let is_remote = config
            .get("url")
            .or_else(|| config.get("serverUrl"))
            .and_then(Value::as_str)
            .is_some();
        let disabled = config
            .get("enabled")
            .and_then(Value::as_bool)
            .is_some_and(|enabled| !enabled);
        insert(
            rows,
            configured_server(name, scope, provider, is_remote, disabled),
        );
    }
}

fn configured_server(
    name: &str,
    scope: ConnectionScope,
    provider: ProviderId,
    is_remote: bool,
    disabled: bool,
) -> ConnectionSummary {
    let availability = if disabled {
        ConnectionAvailability::Disabled
    } else {
        ConnectionAvailability::Available
    };
    let authentication = if is_remote {
        ConnectionAuthentication::Unknown
    } else {
        ConnectionAuthentication::NotApplicable
    };
    ConnectionSummary {
        name: display_name(name),
        kind: ConnectionKind::McpServer,
        scope,
        availability,
        authentication,
        status_detail: match (availability, authentication) {
            (ConnectionAvailability::Disabled, _) => "Disabled in provider configuration",
            (_, ConnectionAuthentication::Unknown) => "Configured; authentication not reported",
            _ => "Local server; separate OAuth is not required",
        }
        .to_owned(),
        authentication_command: auth_command(provider, name, is_remote),
    }
}

fn read_plugin_manifest(path: &Path, rows: &mut BTreeMap<String, ConnectionSummary>) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let Ok(document) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    let Some(plugins) = document.get("plugins").and_then(Value::as_object) else {
        return;
    };
    for name in plugins.keys() {
        insert_plugin(name, rows);
    }
}

fn read_plugin_cache(path: &Path, rows: &mut BTreeMap<String, ConnectionSummary>) {
    let Ok(marketplaces) = fs::read_dir(path) else {
        return;
    };
    for marketplace in marketplaces.flatten() {
        let Ok(plugins) = fs::read_dir(marketplace.path()) else {
            continue;
        };
        for plugin in plugins.flatten() {
            if plugin.path().is_dir() {
                insert_plugin(&plugin.file_name().to_string_lossy(), rows);
            }
        }
    }
}

fn read_plugin_root(path: &Path, rows: &mut BTreeMap<String, ConnectionSummary>) {
    let Ok(plugins) = fs::read_dir(path) else {
        return;
    };
    for plugin in plugins.flatten() {
        if !plugin.path().is_dir() {
            continue;
        }
        let manifest = plugin.path().join(".claude-plugin/plugin.json");
        let manifest_name = fs::read_to_string(manifest)
            .ok()
            .and_then(|content| serde_json::from_str::<Value>(&content).ok())
            .and_then(|document| {
                document
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let fallback = plugin.file_name();
        insert_plugin(
            manifest_name
                .as_deref()
                .unwrap_or_else(|| fallback.to_str().unwrap_or("plugin")),
            rows,
        );
    }
}

fn insert_plugin(name: &str, rows: &mut BTreeMap<String, ConnectionSummary>) {
    let short_name = name.split('@').next().unwrap_or(name);
    insert(
        rows,
        ConnectionSummary {
            name: display_name(short_name),
            kind: ConnectionKind::Plugin,
            scope: ConnectionScope::User,
            availability: ConnectionAvailability::Available,
            authentication: ConnectionAuthentication::Unknown,
            status_detail: "Installed for this provider".to_owned(),
            authentication_command: None,
        },
    );
}

fn read_toml_sections(
    path: &Path,
    provider: ProviderId,
    rows: &mut BTreeMap<String, ConnectionSummary>,
) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let mut current_server: Option<(String, bool, bool)> = None;
    for line in content.lines().chain(std::iter::once("")) {
        let trimmed = line.trim();
        let section = trimmed
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'));
        if let Some(section) = section {
            finish_toml_server(current_server.take(), provider, rows);
            if let Some(name) = section.strip_prefix("mcp_servers.") {
                if !name.contains('.') {
                    current_server = Some((name.trim_matches('"').to_owned(), false, false));
                }
            } else if let Some(name) = section.strip_prefix("plugins.") {
                if !name.contains('.') {
                    insert_plugin(name.trim_matches('"'), rows);
                }
            }
            continue;
        }
        if let Some((_, is_remote, disabled)) = current_server.as_mut() {
            if trimmed.starts_with("url") && trimmed.contains('=') {
                *is_remote = true;
            }
            if trimmed
                .strip_prefix("enabled")
                .and_then(|value| value.split_once('='))
                .is_some_and(|(_, value)| value.trim() == "false")
            {
                *disabled = true;
            }
        }
    }
    finish_toml_server(current_server, provider, rows);
}

fn finish_toml_server(
    server: Option<(String, bool, bool)>,
    provider: ProviderId,
    rows: &mut BTreeMap<String, ConnectionSummary>,
) {
    if let Some((name, is_remote, disabled)) = server {
        insert(
            rows,
            configured_server(&name, ConnectionScope::User, provider, is_remote, disabled),
        );
    }
}

async fn probe(provider: ProviderId, binary: &str, workspace: Option<&Path>) -> Option<String> {
    let args: &[&str] = match provider {
        ProviderId::Claude => &["mcp", "list"],
        ProviderId::Codex => &["mcp", "list", "--json"],
        ProviderId::Opencode => &["mcp", "list"],
        ProviderId::Grok => &["mcp", "list", "--json"],
        ProviderId::Cursor => return None,
    };
    let mut command = Command::new(binary);
    command
        .args(args)
        .envs(login_shell::environment())
        .env("PATH", login_shell::path())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(workspace) = workspace {
        command.current_dir(workspace);
    }
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr.as_ref()
    } else {
        stdout.as_ref()
    };
    Some(text.to_owned())
}

fn merge_probe(provider: ProviderId, output: &str, rows: &mut BTreeMap<String, ConnectionSummary>) {
    match provider {
        ProviderId::Claude => merge_claude_probe(output, rows),
        ProviderId::Codex | ProviderId::Grok => merge_json_probe(provider, output, rows),
        ProviderId::Opencode => merge_opencode_probe(output, rows),
        ProviderId::Cursor => {}
    }
}

fn merge_claude_probe(output: &str, rows: &mut BTreeMap<String, ConnectionSummary>) {
    for line in output.lines().map(str::trim) {
        let authentication = if line.contains("Connected") {
            Some(ConnectionAuthentication::Authenticated)
        } else if line.contains("Needs authentication") {
            Some(ConnectionAuthentication::Required)
        } else {
            None
        };
        let Some(authentication) = authentication else {
            continue;
        };
        let (kind, name) = if let Some(plugin) = line.strip_prefix("plugin:") {
            let Some(name) = plugin.split(':').next() else {
                continue;
            };
            (ConnectionKind::Plugin, name)
        } else {
            let Some((raw_name, _)) = line.split_once(':') else {
                continue;
            };
            if let Some(name) = raw_name.strip_prefix("claude.ai ") {
                (ConnectionKind::Connector, name)
            } else {
                (ConnectionKind::McpServer, raw_name)
            }
        };
        insert(
            rows,
            ConnectionSummary {
                name: display_name(name),
                kind,
                scope: ConnectionScope::User,
                availability: ConnectionAvailability::Available,
                authentication,
                status_detail: authentication_detail(authentication).to_owned(),
                authentication_command: (authentication == ConnectionAuthentication::Required)
                    .then(|| format!("claude mcp login {}", login_shell::quote(name))),
            },
        );
    }
}

fn merge_json_probe(
    provider: ProviderId,
    output: &str,
    rows: &mut BTreeMap<String, ConnectionSummary>,
) {
    let Ok(items) = serde_json::from_str::<Vec<Value>>(output) else {
        return;
    };
    for item in items {
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let disabled = item
            .get("enabled")
            .and_then(Value::as_bool)
            .is_some_and(|enabled| !enabled);
        let auth_kind = item.get("auth_status").and_then(Value::as_str);
        let is_remote = item.get("url").is_some()
            || item
                .get("transport")
                .and_then(|transport| transport.get("type"))
                .and_then(Value::as_str)
                .is_some_and(|kind| kind != "stdio");
        let availability = if disabled {
            ConnectionAvailability::Disabled
        } else {
            ConnectionAvailability::Available
        };
        let authentication = if is_remote || auth_kind == Some("o_auth") {
            ConnectionAuthentication::Unknown
        } else {
            ConnectionAuthentication::NotApplicable
        };
        insert(
            rows,
            ConnectionSummary {
                name: display_name(name),
                kind: ConnectionKind::McpServer,
                scope: ConnectionScope::User,
                availability,
                authentication,
                status_detail: match (availability, authentication) {
                    (ConnectionAvailability::Disabled, _) => {
                        "Disabled in provider configuration".to_owned()
                    }
                    (_, ConnectionAuthentication::NotApplicable) => {
                        "Provider reports this local server as available".to_owned()
                    }
                    _ if auth_kind == Some("o_auth") => {
                        "Uses OAuth; login validity is not reported".to_owned()
                    }
                    _ => "Configured; authentication not reported".to_owned(),
                },
                authentication_command: auth_command(provider, name, is_remote),
            },
        );
    }
}

fn merge_opencode_probe(output: &str, rows: &mut BTreeMap<String, ConnectionSummary>) {
    for raw_line in output.lines() {
        let line = strip_ansi(raw_line);
        let authentication = if line.contains("needs authentication") {
            Some(ConnectionAuthentication::Required)
        } else if line.contains("connected") {
            Some(ConnectionAuthentication::Authenticated)
        } else {
            None
        };
        let Some(authentication) = authentication else {
            continue;
        };
        let marker = if authentication == ConnectionAuthentication::Authenticated {
            "✓ "
        } else {
            "⚠ "
        };
        let Some(after_marker) = line.split(marker).nth(1) else {
            continue;
        };
        let status_word = if authentication == ConnectionAuthentication::Authenticated {
            " connected"
        } else {
            " needs authentication"
        };
        let name = after_marker
            .split(status_word)
            .next()
            .unwrap_or(after_marker)
            .trim();
        insert(
            rows,
            ConnectionSummary {
                name: display_name(name),
                kind: ConnectionKind::McpServer,
                scope: ConnectionScope::User,
                availability: ConnectionAvailability::Available,
                authentication,
                status_detail: authentication_detail(authentication).to_owned(),
                authentication_command: (authentication == ConnectionAuthentication::Required)
                    .then(|| format!("opencode mcp auth {}", login_shell::quote(name))),
            },
        );
    }
}

fn strip_ansi(value: &str) -> String {
    let mut clean = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            for next in chars.by_ref() {
                if next == 'm' {
                    break;
                }
            }
        } else {
            clean.push(character);
        }
    }
    clean
}

fn auth_command(provider: ProviderId, name: &str, is_remote: bool) -> Option<String> {
    if !is_remote {
        return None;
    }
    match provider {
        ProviderId::Claude => Some(format!("claude mcp login {}", login_shell::quote(name))),
        ProviderId::Codex => Some(format!("codex mcp login {}", login_shell::quote(name))),
        ProviderId::Opencode => Some(format!("opencode mcp auth {}", login_shell::quote(name))),
        ProviderId::Cursor => Some("Open Cursor Settings → Tools & MCP".to_owned()),
        ProviderId::Grok => None,
    }
}

fn authentication_detail(authentication: ConnectionAuthentication) -> &'static str {
    match authentication {
        ConnectionAuthentication::Authenticated => "Provider confirmed the connection",
        ConnectionAuthentication::Required => "Provider reports that login is required",
        ConnectionAuthentication::NotApplicable => "Separate OAuth login is not required",
        ConnectionAuthentication::Unknown => "Authentication not reported",
    }
}

fn display_name(value: &str) -> String {
    value
        .trim()
        .replace(['-', '_'], " ")
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn claude_probe_distinguishes_connectors_plugins_and_authentication() {
        let mut rows = BTreeMap::new();
        merge_claude_probe(
            "claude.ai Notion: https://mcp.notion.com - ✔ Connected\n\
             plugin:vercel:vercel: https://mcp.vercel.com - ! Needs authentication\n\
             trace: uv run trace - ✔ Connected",
            &mut rows,
        );
        let values = rows.into_values().collect::<Vec<_>>();

        assert!(values.iter().any(|row| {
            row.name == "Notion"
                && row.kind == ConnectionKind::Connector
                && row.authentication == ConnectionAuthentication::Authenticated
        }));
        assert!(values.iter().any(|row| {
            row.name == "Vercel"
                && row.kind == ConnectionKind::Plugin
                && row.authentication == ConnectionAuthentication::Required
        }));
        assert!(values.iter().any(|row| {
            row.name == "Trace"
                && row.kind == ConnectionKind::McpServer
                && row.authentication == ConnectionAuthentication::Authenticated
        }));
    }

    #[test]
    fn opencode_probe_reads_status_without_ansi_formatting() {
        let mut rows = BTreeMap::new();
        merge_opencode_probe(
            "\u{1b}[32m●  ✓ notion \u{1b}[90mconnected\u{1b}[0m\n\
             ●  ⚠ hex \u{1b}[90mneeds authentication\u{1b}[0m",
            &mut rows,
        );
        let values = rows.into_values().collect::<Vec<_>>();

        assert_eq!(values.len(), 2);
        assert!(values.iter().any(|row| {
            row.name == "Notion" && row.authentication == ConnectionAuthentication::Authenticated
        }));
        assert!(values.iter().any(|row| {
            row.name == "Hex" && row.authentication == ConnectionAuthentication::Required
        }));
    }

    #[test]
    fn json_probe_never_calls_oauth_authenticated_without_provider_evidence() {
        let mut rows = BTreeMap::new();
        merge_json_probe(
            ProviderId::Codex,
            r#"[{"name":"notion","enabled":true,"transport":{"type":"streamable_http"},"auth_status":"o_auth"}]"#,
            &mut rows,
        );
        let row = rows.into_values().next().unwrap();

        assert_eq!(row.authentication, ConnectionAuthentication::Unknown);
        assert_eq!(
            row.authentication_command.as_deref(),
            Some("codex mcp login 'notion'")
        );
    }

    #[test]
    fn toml_config_distinguishes_local_remote_and_disabled_servers() {
        let root = tempdir().unwrap();
        let path = root.path().join("config.toml");
        fs::write(
            &path,
            "[mcp_servers.local]\ncommand = \"uv\"\n\
             [mcp_servers.remote]\nurl = \"https://example.com/mcp\"\n\
             [mcp_servers.off]\ncommand = \"off\"\nenabled = false\n",
        )
        .unwrap();
        let mut rows = BTreeMap::new();
        read_toml_sections(&path, ProviderId::Codex, &mut rows);
        let values = rows.into_values().collect::<Vec<_>>();

        assert!(values.iter().any(|row| {
            row.name == "Local" && row.authentication == ConnectionAuthentication::NotApplicable
        }));
        assert!(values.iter().any(|row| {
            row.name == "Remote" && row.authentication == ConnectionAuthentication::Unknown
        }));
        assert!(values.iter().any(|row| {
            row.name == "Off" && row.availability == ConnectionAvailability::Disabled
        }));
    }

    #[test]
    fn grok_plugin_root_uses_manifest_name_instead_of_inner_directories() {
        let root = tempdir().unwrap();
        let plugin = root.path().join("vercel-plugin-deadbeef");
        fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        fs::create_dir_all(plugin.join("skills/deploy")).unwrap();
        fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"name":"vercel"}"#,
        )
        .unwrap();
        let mut rows = BTreeMap::new();
        read_plugin_root(root.path(), &mut rows);
        let values = rows.into_values().collect::<Vec<_>>();

        assert_eq!(values.len(), 1);
        assert_eq!(values[0].name, "Vercel");
        assert_eq!(values[0].kind, ConnectionKind::Plugin);
    }
}
