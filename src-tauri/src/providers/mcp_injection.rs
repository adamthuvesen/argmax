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
//! | OpenCode | `OPENCODE_CONFIG_CONTENT` (inline JSON) | no |
//! | Grok | `<workspace>/.grok/config.toml` | yes, git-excluded, removed at exit |
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

/// What a provider that actually loads the `argmax` server is told. The tool
/// descriptions carry the rest: what each tool does, and that a launch makes a
/// visible top-level session rather than a subagent.
pub const AGENT_TOOLS_INSTRUCTION: &str = "Argmax tools are available as the `argmax` MCP server; use them to launch, list and message other Argmax sessions, and to browse the web in Argmax's own browser, when the task needs it.";

/// The fallback for a provider whose launch cannot carry an MCP server yet:
/// Grok (its folder-trust gate refuses a config Argmax wrote) and Cursor's
/// one-shot PTY path. Same capabilities, spelled as shell commands.
pub const SHELL_COMMAND_INSTRUCTION: &str = r#"Argmax session controls are available to you. To create a separate top-level session, use "$ARGMAX_BIN" session launch --project <registered name or absolute repo path> --prompt '<task>'. Omit --project to use this session's project. To move this chat to another registered project, use "$ARGMAX_BIN" session move --project <registered name or absolute repo path>. Both commands use the shared checkout by default. Add --worktree for isolation. Moving archives the source workspace after this turn settles. Add --keep-source to keep it. To see what other sessions exist before targeting one, use "$ARGMAX_BIN" session list [--project <name-or-path> | --all]; it prints each session's id, project, task label, provider, and state as JSON, newest activity first. To send a message into an existing session — for example one you just launched, or one the user names — use "$ARGMAX_BIN" session message --session <id> --prompt '<message>'; it queues if that session is mid-turn. Use these on your own initiative when the task needs them. They create and address top-level sidebar sessions, not subagents: every one is visible to the user, spends real tokens, and outlives your turn. Launches are capped at two levels deep and ten per session."#;

/// Which instruction a launch carries. `via_acp` is Cursor's warm composer
/// path, the only Cursor launch that can hand the CLI an MCP server.
pub fn instruction(provider: ProviderId, via_acp: bool) -> &'static str {
    match provider {
        ProviderId::Claude | ProviderId::Codex | ProviderId::Opencode => AGENT_TOOLS_INSTRUCTION,
        ProviderId::Cursor if via_acp => AGENT_TOOLS_INSTRUCTION,
        ProviderId::Cursor | ProviderId::Grok => SHELL_COMMAND_INSTRUCTION,
    }
}

/// Strip whichever instruction Argmax prepended, so an imported transcript's
/// first prompt reads as the user wrote it.
pub fn strip_instruction(prompt: &str) -> &str {
    [AGENT_TOOLS_INSTRUCTION, SHELL_COMMAND_INSTRUCTION]
        .into_iter()
        .find_map(|instruction| prompt.strip_prefix(instruction))
        .unwrap_or(prompt)
}

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
            // OPENCODE_CONFIG_CONTENT is parsed after the global and project
            // configs and deep-merged over them, so the user's providers,
            // agents, and their own MCP servers all survive. Inline beats
            // OPENCODE_CONFIG with a file: nothing is written into the
            // workspace, so nothing has to be cleaned up or git-excluded.
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
            (
                vec![("OPENCODE_CONFIG_CONTENT".to_string(), body.to_string())],
                ScratchConfigFiles::default(),
            )
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
            let files = write_scratch(&path, &body).unwrap_or_default();
            if !files.paths.is_empty() {
                git_exclude(workspace_path, ".grok/");
            }
            (Vec::new(), files)
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

/// Keep a scratch config out of `git status`. The pattern goes in the
/// checkout's own exclude file, which is per-repository and never committed —
/// a shared checkout is the user's real repo, and a launch must not make it
/// look dirty. A linked worktree keeps `info/` in the common git directory.
fn git_exclude(workspace_path: &Path, pattern: &str) {
    let Some(exclude_path) = git_exclude_path(workspace_path) else {
        return;
    };
    let existing = fs::read_to_string(&exclude_path).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == pattern) {
        return;
    }
    let separator = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    if let Some(parent) = exclude_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::write(&exclude_path, format!("{existing}{separator}{pattern}\n")) {
        tracing::warn!(?error, path = %exclude_path.display(), "could not update the git exclude file");
    }
}

fn git_exclude_path(workspace_path: &Path) -> Option<PathBuf> {
    let dot_git = workspace_path.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        // A linked worktree's `.git` is a file: `gitdir: <path>`.
        let pointer = fs::read_to_string(&dot_git).ok()?;
        let target = pointer.trim().strip_prefix("gitdir:")?.trim();
        workspace_path.join(target)
    };
    let common_dir = match fs::read_to_string(git_dir.join("commondir")) {
        Ok(relative) => git_dir.join(relative.trim()),
        Err(_) => git_dir,
    };
    Some(common_dir.join("info").join("exclude"))
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
    fn opencode_takes_its_server_inline_and_writes_nothing() {
        let workspace = tempfile::tempdir().expect("temp workspace");
        let (environment, files) =
            launch_files(ProviderId::Opencode, workspace.path(), Some(&config()));
        assert_eq!(environment.len(), 1);
        assert_eq!(environment[0].0, "OPENCODE_CONFIG_CONTENT");
        let written: Value = serde_json::from_str(&environment[0].1).expect("valid JSON");
        assert_eq!(written["mcp"]["argmax"]["type"], "local");
        assert_eq!(written["mcp"]["argmax"]["command"][1], "mcp");
        assert_eq!(
            written["mcp"]["argmax"]["environment"][SESSION_LAUNCH_TOKEN_ENV],
            "token-123"
        );
        assert!(files.paths.is_empty());
        assert!(!workspace.path().join(".argmax").exists());
    }

    #[test]
    fn grok_config_is_written_git_excluded_and_removed_again() {
        let workspace = tempfile::tempdir().expect("temp workspace");
        fs::create_dir_all(workspace.path().join(".git").join("info")).expect("git dir");
        let (environment, files) =
            launch_files(ProviderId::Grok, workspace.path(), Some(&config()));
        let grok_config = workspace.path().join(".grok").join("config.toml");
        assert!(environment.is_empty());
        let body = fs::read_to_string(&grok_config).expect("written");
        assert!(body.starts_with("[mcp_servers.argmax]\n"));
        assert!(body.contains(r#"args = ["mcp"]"#));
        let exclude =
            fs::read_to_string(workspace.path().join(".git/info/exclude")).expect("exclude");
        assert_eq!(exclude, ".grok/\n");

        // A second launch in the same checkout does not double the entry.
        let (_, second) = launch_files(ProviderId::Grok, workspace.path(), Some(&config()));
        assert_eq!(
            fs::read_to_string(workspace.path().join(".git/info/exclude")).expect("exclude"),
            ".grok/\n"
        );
        second.remove();

        files.remove();
        assert!(!grok_config.exists());
        assert!(!grok_config.parent().expect("parent").exists());
    }

    #[test]
    fn a_linked_worktree_excludes_through_the_common_git_directory() {
        let repo = tempfile::tempdir().expect("repo");
        let common = repo.path().join(".git");
        fs::create_dir_all(common.join("worktrees").join("wt")).expect("worktree git dir");
        fs::write(
            common.join("worktrees").join("wt").join("commondir"),
            "../..\n",
        )
        .expect("commondir");
        let worktree = repo.path().join("wt");
        fs::create_dir_all(&worktree).expect("worktree");
        fs::write(
            worktree.join(".git"),
            format!(
                "gitdir: {}\n",
                common.join("worktrees").join("wt").display()
            ),
        )
        .expect("git pointer");

        let (_, files) = launch_files(ProviderId::Grok, &worktree, Some(&config()));
        assert_eq!(
            fs::read_to_string(common.join("info").join("exclude")).expect("exclude"),
            ".grok/\n"
        );
        files.remove();
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
