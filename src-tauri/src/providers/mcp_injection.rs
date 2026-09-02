//! Per-provider injection of the `argmax` MCP server into a launch.
//!
//! Every provider CLI has its own way to attach one stdio MCP server to a
//! single run, and only two of the five take it on the command line. This
//! module is the one place that knows which is which, so `adapters.rs` only
//! asks for argv and `runtime.rs` only asks for environment and scratch files.
//!
//! | Provider | Mechanism | Leaves a file? |
//! |---|---|---|
//! | Claude | `--mcp-config '<inline json>'` | no |
//! | Codex | `-c mcp_servers.argmax.*` | no |
//! | Cursor (ACP) | `mcpServers` in `session/new` / `session/load` | no |
//! | OpenCode | `OPENCODE_CONFIG` → `<workspace>/.argmax/opencode.json` | yes, removed at exit |
//! | Grok | `<workspace>/.grok/config.toml` | yes, removed at exit |
//!
//! The per-session bearer token rides in the server spec's own `env`, not the
//! provider process's environment, so a warm shared process (Cursor's ACP pool)
//! can still hand each session its own credential.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::session_control::{
    SessionLaunchProcessConfig, SESSION_LAUNCH_SOCKET_ENV, SESSION_LAUNCH_TOKEN_ENV,
};

use super::ProviderId;

/// The MCP server name; tools reach the model as `mcp__argmax__<tool>`
/// (Claude, Codex, Cursor) or `argmax__<tool>` (Grok, OpenCode).
pub const SERVER_NAME: &str = "argmax";

/// The single subcommand the server is launched with: `argmax mcp`.
const SERVER_ARGS: [&str; 1] = ["mcp"];

/// Files written into the workspace for one launch, removed once the child
/// exits. Empty for every provider that takes its config on the command line.
#[derive(Debug, Default)]
pub struct ScratchConfigFiles {
    paths: Vec<PathBuf>,
}

impl ScratchConfigFiles {
    pub fn remove(&self) {
        for path in &self.paths {
            let _ = fs::remove_file(path);
            // The directory only goes if we are the last thing in it, so a
            // user's own `.grok/` or `.argmax/` survives untouched.
            if let Some(parent) = path.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
    }
}

fn server_env(config: &SessionLaunchProcessConfig) -> Vec<(String, String)> {
    vec![
        (
            SESSION_LAUNCH_SOCKET_ENV.to_string(),
            config.socket_path().to_string_lossy().into_owned(),
        ),
        (
            SESSION_LAUNCH_TOKEN_ENV.to_string(),
            config.token().to_string(),
        ),
    ]
}

fn server_env_object(config: &SessionLaunchProcessConfig) -> Value {
    Value::Object(
        server_env(config)
            .into_iter()
            .map(|(name, value)| (name, Value::String(value)))
            .collect(),
    )
}

/// Extra argv for the providers that take an MCP server on the command line.
/// Empty for everyone else, so callers can append unconditionally.
pub fn mcp_args(provider: ProviderId, config: Option<&SessionLaunchProcessConfig>) -> Vec<String> {
    let Some(config) = config else {
        return Vec::new();
    };
    match provider {
        ProviderId::Claude => {
            // Inline JSON rather than a file: `--mcp-config` takes either, and
            // no file means nothing to clean up. `--strict-mcp-config` is
            // deliberately NOT passed — the user's own servers stay loaded.
            let spec = json!({
                "mcpServers": {
                    SERVER_NAME: {
                        "type": "stdio",
                        "command": config.argmax_bin(),
                        "args": SERVER_ARGS,
                        "env": server_env_object(config),
                    }
                }
            });
            vec!["--mcp-config".to_string(), spec.to_string()]
        }
        ProviderId::Codex => {
            // `-c key=value` parses the value as TOML. JSON string escaping is
            // a subset of TOML basic-string escaping, so serde_json produces a
            // literal Codex accepts for the path and each env value.
            let bin = json_string(&config.argmax_bin().to_string_lossy());
            let args = SERVER_ARGS
                .iter()
                .map(|arg| json_string(arg))
                .collect::<Vec<_>>()
                .join(", ");
            let env = server_env(config)
                .into_iter()
                .map(|(name, value)| format!("{name} = {}", json_string(&value)))
                .collect::<Vec<_>>()
                .join(", ");
            vec![
                "-c".to_string(),
                format!("mcp_servers.{SERVER_NAME}.command={bin}"),
                "-c".to_string(),
                format!("mcp_servers.{SERVER_NAME}.args=[{args}]"),
                "-c".to_string(),
                format!("mcp_servers.{SERVER_NAME}.env={{{env}}}"),
            ]
        }
        // Cursor goes through cursor_acp::mcp_servers_value; OpenCode and Grok
        // through launch_files below.
        ProviderId::Cursor | ProviderId::Opencode | ProviderId::Grok => Vec::new(),
    }
}

/// The ACP `mcpServers` value for `session/new` and `session/load`: an array of
/// stdio server descriptors, `env` as `{name, value}` pairs per the ACP schema.
pub fn acp_mcp_servers(config: Option<&SessionLaunchProcessConfig>) -> Value {
    let Some(config) = config else {
        return json!([]);
    };
    json!([{
        "name": SERVER_NAME,
        "command": config.argmax_bin(),
        "args": SERVER_ARGS,
        "env": server_env(config)
            .into_iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect::<Vec<_>>(),
    }])
}

/// Config files and environment for the providers with no per-launch flag.
/// Returns the extra environment overrides plus whatever was written, so the
/// caller can delete it when the child exits.
pub fn launch_files(
    provider: ProviderId,
    workspace_path: &Path,
    config: Option<&SessionLaunchProcessConfig>,
) -> (Vec<(String, String)>, ScratchConfigFiles) {
    let Some(config) = config else {
        return (Vec::new(), ScratchConfigFiles::default());
    };
    match provider {
        ProviderId::Opencode => {
            // OPENCODE_CONFIG is merged on top of the global config, never a
            // replacement for it, so the user's providers and plugins survive.
            let path = workspace_path.join(".argmax").join("opencode.json");
            let body = json!({
                "$schema": "https://opencode.ai/config.json",
                "mcp": {
                    SERVER_NAME: {
                        "type": "local",
                        "command": [config.argmax_bin().to_string_lossy(), SERVER_ARGS[0]],
                        "enabled": true,
                        "environment": server_env_object(config),
                    }
                }
            });
            match write_scratch(&path, &format!("{body}\n")) {
                Some(files) => (
                    vec![("OPENCODE_CONFIG".to_string(), path.display().to_string())],
                    files,
                ),
                None => (Vec::new(), ScratchConfigFiles::default()),
            }
        }
        ProviderId::Grok => {
            // Grok's GROK_CONFIG / GROK_CONFIG_PATH overlays are allowlisted to
            // soft settings and explicitly cannot spawn commands, so a
            // project-scoped `.grok/config.toml` is the only injection path.
            let path = workspace_path.join(".grok").join("config.toml");
            let bin = json_string(&config.argmax_bin().to_string_lossy());
            let args = SERVER_ARGS
                .iter()
                .map(|arg| json_string(arg))
                .collect::<Vec<_>>()
                .join(", ");
            let env = server_env(config)
                .into_iter()
                .map(|(name, value)| format!("{name} = {}", json_string(&value)))
                .collect::<Vec<_>>()
                .join(", ");
            let body = format!(
                "[mcp_servers.{SERVER_NAME}]\ncommand = {bin}\nargs = [{args}]\nenv = {{ {env} }}\nenabled = true\n"
            );
            (Vec::new(), write_scratch(&path, &body).unwrap_or_default())
        }
        ProviderId::Claude | ProviderId::Codex | ProviderId::Cursor => {
            (Vec::new(), ScratchConfigFiles::default())
        }
    }
}

fn write_scratch(path: &Path, body: &str) -> Option<ScratchConfigFiles> {
    let parent = path.parent()?;
    if let Err(error) = fs::create_dir_all(parent) {
        tracing::warn!(?error, path = %path.display(), "could not create the MCP config directory");
        return None;
    }
    if let Err(error) = fs::write(path, body) {
        tracing::warn!(?error, path = %path.display(), "could not write the MCP config");
        return None;
    }
    Some(ScratchConfigFiles {
        paths: vec![path.to_path_buf()],
    })
}

/// A quoted, escaped string literal — valid in both JSON and TOML.
fn json_string(value: &str) -> String {
    Value::String(value.to_string()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SessionLaunchProcessConfig {
        SessionLaunchProcessConfig::for_tests(
            "/tmp/argmax/launch.sock",
            "token-123",
            "/Applications/Argmax.app/Contents/MacOS/argmax",
        )
    }

    #[test]
    fn claude_gets_one_inline_stdio_server_and_keeps_the_user_config() {
        let args = mcp_args(ProviderId::Claude, Some(&config()));
        assert_eq!(args[0], "--mcp-config");
        let spec: Value = serde_json::from_str(&args[1]).expect("inline JSON");
        assert_eq!(spec["mcpServers"]["argmax"]["type"], "stdio");
        assert_eq!(spec["mcpServers"]["argmax"]["args"][0], "mcp");
        assert_eq!(
            spec["mcpServers"]["argmax"]["env"][SESSION_LAUNCH_TOKEN_ENV],
            "token-123"
        );
        // --strict-mcp-config would drop the user's own servers.
        assert!(!args.iter().any(|arg| arg == "--strict-mcp-config"));
    }

    #[test]
    fn codex_overrides_are_parseable_toml_with_quoted_values() {
        let args = mcp_args(ProviderId::Codex, Some(&config()));
        let overrides = args
            .chunks(2)
            .map(|pair| {
                assert_eq!(pair[0], "-c");
                pair[1].clone()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            overrides[0],
            r#"mcp_servers.argmax.command="/Applications/Argmax.app/Contents/MacOS/argmax""#
        );
        assert_eq!(overrides[1], r#"mcp_servers.argmax.args=["mcp"]"#);
        assert!(overrides[2].starts_with("mcp_servers.argmax.env={"));
        assert!(overrides[2].contains(r#"ARGMAX_SESSION_LAUNCH_TOKEN = "token-123""#));
    }

    #[test]
    fn acp_env_is_a_name_value_array_per_the_schema() {
        let servers = acp_mcp_servers(Some(&config()));
        assert_eq!(servers[0]["name"], "argmax");
        assert_eq!(servers[0]["args"][0], "mcp");
        let env = servers[0]["env"].as_array().expect("env array");
        assert!(env.iter().any(|entry| {
            entry["name"] == SESSION_LAUNCH_TOKEN_ENV && entry["value"] == "token-123"
        }));
    }

    #[test]
    fn opencode_and_grok_write_config_files_that_are_removed_again() {
        let workspace = tempfile::tempdir().expect("temp workspace");
        let (environment, opencode_files) =
            launch_files(ProviderId::Opencode, workspace.path(), Some(&config()));
        let opencode_config = workspace.path().join(".argmax").join("opencode.json");
        assert_eq!(
            environment,
            vec![(
                "OPENCODE_CONFIG".to_string(),
                opencode_config.display().to_string()
            )]
        );
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&opencode_config).expect("written"))
                .expect("valid JSON");
        assert_eq!(written["mcp"]["argmax"]["type"], "local");
        assert_eq!(written["mcp"]["argmax"]["command"][1], "mcp");

        let (grok_environment, grok_files) =
            launch_files(ProviderId::Grok, workspace.path(), Some(&config()));
        let grok_config = workspace.path().join(".grok").join("config.toml");
        assert!(grok_environment.is_empty());
        let body = std::fs::read_to_string(&grok_config).expect("written");
        assert!(body.starts_with("[mcp_servers.argmax]\n"));
        assert!(body.contains(r#"args = ["mcp"]"#));

        opencode_files.remove();
        grok_files.remove();
        assert!(!opencode_config.exists());
        assert!(!grok_config.exists());
        assert!(!opencode_config.parent().expect("parent").exists());
    }

    #[test]
    fn no_launch_credential_means_no_injection_anywhere() {
        for provider in [
            ProviderId::Claude,
            ProviderId::Codex,
            ProviderId::Cursor,
            ProviderId::Opencode,
            ProviderId::Grok,
        ] {
            assert!(mcp_args(provider, None).is_empty());
            let (environment, files) = launch_files(provider, Path::new("/repo"), None);
            assert!(environment.is_empty());
            files.remove();
        }
        assert_eq!(acp_mcp_servers(None), json!([]));
    }
}
