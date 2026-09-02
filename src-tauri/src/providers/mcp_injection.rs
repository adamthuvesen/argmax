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
//! | Cursor (PTY) | `<workspace>/.cursor/mcp.json` | yes, restored at exit |
//! | Grok | `<workspace>/.grok/config.toml` + a folder-trust grant | yes, removed at exit |
//!
//! Wherever the spec is per-launch, the per-session bearer token rides in its
//! own `env` rather than the provider process's environment, so a warm shared
//! process (Cursor's ACP pool) can still hand each session its own credential.
//!
//! The two file-based paths are the exception, and have to be: one checkout is
//! one file, and [ADR 0004] makes several sessions over one checkout the normal
//! case, so neither file may hold anything one session can overwrite for
//! another. Grok starts its MCP server with the environment its own process has
//! (verified with `grok mcp doctor` 1.0.13 against a server that dumps it), so
//! its config carries no credential and every session writes identical bytes.
//! Cursor sanitises that environment — the same server reports `ENV_MISSING` —
//! so its spec carries the credential and its entry is named per session
//! instead. Either way the file itself is ref-counted, put back by whichever
//! launch leaves last, and kept out of `git status` until then.
//!
//! [ADR 0004]: ../../../docs/adr/0004-parallelism-comes-from-workspaces.md

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Map, Value};

use super::grok_trust;

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

/// What Grok and Cursor's one-shot PTY path were told before they could carry
/// the server themselves: the same capabilities, spelled as shell commands.
/// No launch prepends this any more. It survives only so
/// [`strip_instruction`] still recognises it at the head of a prompt recorded
/// or imported before those two paths were closed.
pub const LEGACY_SHELL_COMMAND_INSTRUCTION: &str = r#"Argmax session controls are available to you. To create a separate top-level session, use "$ARGMAX_BIN" session launch --project <registered name or absolute repo path> --prompt '<task>'. Omit --project to use this session's project. To move this chat to another registered project, use "$ARGMAX_BIN" session move --project <registered name or absolute repo path>. Both commands use the shared checkout by default. Add --worktree for isolation. Moving archives the source workspace after this turn settles. Add --keep-source to keep it. To see what other sessions exist before targeting one, use "$ARGMAX_BIN" session list [--project <name-or-path> | --all]; it prints each session's id, project, task label, provider, and state as JSON, newest activity first. To send a message into an existing session — for example one you just launched, or one the user names — use "$ARGMAX_BIN" session message --session <id> --prompt '<message>'; it queues if that session is mid-turn. Use these on your own initiative when the task needs them. They create and address top-level sidebar sessions, not subagents: every one is visible to the user, spends real tokens, and outlives your turn. Launches are capped at two levels deep and ten per session."#;

/// Strip whichever instruction Argmax prepended, so an imported transcript's
/// first prompt reads as the user wrote it.
pub fn strip_instruction(prompt: &str) -> &str {
    [AGENT_TOOLS_INSTRUCTION, LEGACY_SHELL_COMMAND_INSTRUCTION]
        .into_iter()
        .find_map(|instruction| prompt.strip_prefix(instruction))
        .unwrap_or(prompt)
}

/// The single subcommand the server is launched with: `argmax mcp`.
const SERVER_ARGS: [&str; 1] = ["mcp"];

/// What one launch changed outside Argmax's own data, and how to put it back
/// once the child exits. Empty for every provider that takes its config on the
/// command line.
#[derive(Debug, Default)]
pub struct LaunchScratch {
    undo: Vec<Undo>,
}

#[derive(Debug)]
enum Undo {
    /// One share in a workspace config file, plus the server entry this
    /// session added to it, if the file names servers per session. See
    /// [`ConfigLease`].
    ReleaseConfig(PathBuf, Option<String>),
    /// A folder-trust grant in Grok's global store, keyed by canonical path.
    ReleaseGrokTrust(PathBuf),
}

impl LaunchScratch {
    /// Undo everything this launch wrote. Called once per launch, from the
    /// child's wait thread.
    pub fn restore(&self) {
        for undo in &self.undo {
            match undo {
                Undo::ReleaseConfig(path, entry) => release_config(path, entry.as_deref()),
                Undo::ReleaseGrokTrust(folder) => grok_trust::release(folder),
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
        ProviderId::Cursor => {
            // The server spec itself is a file (see launch_files), but a
            // `.cursor/mcp.json` entry the CLI has not seen before is listed
            // and then never started: without this the model reports the
            // namespace as "not found" while the file sits right there.
            vec!["--approve-mcps".to_string()]
        }
        // OpenCode and Grok go through launch_files below.
        ProviderId::Opencode | ProviderId::Grok => Vec::new(),
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
/// Returns the extra environment overrides plus everything this launch changed
/// outside Argmax, so the caller can put it back when the child exits.
pub fn launch_files(
    provider: ProviderId,
    workspace_path: &Path,
    session_id: &str,
    config: Option<&SessionLaunchProcessConfig>,
) -> (Vec<(String, String)>, LaunchScratch) {
    let Some(config) = config else {
        return (Vec::new(), LaunchScratch::default());
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
                LaunchScratch::default(),
            )
        }
        ProviderId::Cursor => {
            // `cursor-agent --help` has no per-launch MCP flag and no config
            // env var (`CURSOR_CONFIG_DIR` moves the whole `~/.cursor`, auth
            // included). The project-scoped `.cursor/mcp.json` the CLI already
            // reads is the only injection path, so it is written, merged over
            // whatever the user keeps there, and put back at exit.
            //
            // Unlike Grok, `cursor-agent` starts its MCP servers with a
            // sanitised environment — the server reports `ENV_MISSING` when the
            // spec does not carry the credential — so this entry does, and its
            // name has to be the session's rather than a shared `argmax`.
            let path = workspace_path.join(".cursor").join("mcp.json");
            let entry = cursor_server_name(session_id);
            let scratch = claim_config(
                workspace_path,
                &path,
                ".cursor/",
                Shape::CursorServer {
                    entry,
                    spec: json!({
                        "command": config.argmax_bin(),
                        "args": SERVER_ARGS,
                        "env": server_env_object(config),
                    }),
                },
            );
            (Vec::new(), scratch)
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
            let body = format!(
                "[mcp_servers.{SERVER_NAME}]\ncommand = {bin}\nargs = [{args}]\nenabled = true\n"
            );
            let mut scratch = claim_config(workspace_path, &path, ".grok/", Shape::WholeFile(body));
            if !scratch.undo.is_empty() {
                // A repo-local `mcp_servers` table is gated on folder trust,
                // so the config above is inert until the folder is recorded as
                // trusted the way Grok records it when the user says yes.
                if let Some(folder) = grok_trust::grant(workspace_path) {
                    scratch.undo.push(Undo::ReleaseGrokTrust(folder));
                }
            }
            (Vec::new(), scratch)
        }
        ProviderId::Claude | ProviderId::Codex => (Vec::new(), LaunchScratch::default()),
    }
}

/// The server's name in `.cursor/mcp.json`. One checkout is one file, and
/// [ADR 0004] makes several sessions over one checkout normal, so the name
/// carries the session: two sessions merge into one file instead of
/// overwriting each other's credential. Cursor reports the tool to the model
/// without its namespace, so the suffix does not reach the tool name.
///
/// [ADR 0004]: ../../../docs/adr/0004-parallelism-comes-from-workspaces.md
fn cursor_server_name(session_id: &str) -> String {
    let short: String = session_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if short.is_empty() {
        SERVER_NAME.to_string()
    } else {
        format!("{SERVER_NAME}_{short}")
    }
}

/// Merge one server into a `.cursor/mcp.json`, leaving everything else in the
/// document alone. `None` means the file is not something we dare rewrite.
fn merge_cursor_server(body: &str, entry: &str, spec: Option<&Value>) -> Option<String> {
    let mut document = if body.trim().is_empty() {
        Map::new()
    } else {
        match serde_json::from_str::<Value>(body) {
            Ok(Value::Object(document)) => document,
            _ => return None,
        }
    };
    let servers = document
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = servers.as_object_mut()?;
    match spec {
        Some(spec) => {
            servers.insert(entry.to_string(), spec.clone());
        }
        None => {
            servers.remove(entry);
        }
    }
    Some(format!(
        "{}\n",
        serde_json::to_string_pretty(&document).unwrap_or_default()
    ))
}

/// One checkout, many sessions: [ADR 0004](../../../docs/adr) makes parallel
/// work over a single checkout the normal case, and both file-based providers
/// read one path per checkout. The file therefore cannot carry anything that
/// differs per session — the credential rides the child's own environment,
/// which the CLI passes down to the server it spawns — and its lifetime is
/// ref-counted rather than owned by whichever launch happens to finish first.
struct ConfigLease {
    holders: usize,
    /// What the file held before the first launch claimed it, or `None` when
    /// there was no file.
    original: Option<String>,
    /// The exclude file and pattern this lease added, if it added one.
    exclude: Option<(PathBuf, String)>,
}

/// How a launch writes itself into the shared file.
enum Shape {
    /// Grok: the whole file is Argmax's and identical for every session, so a
    /// second claim finds exactly the file it wanted already there.
    WholeFile(String),
    /// Cursor: one named server merged into a JSON document that may hold the
    /// user's own servers and other sessions'.
    CursorServer { entry: String, spec: Value },
}

fn leases() -> &'static Mutex<HashMap<PathBuf, ConfigLease>> {
    static LEASES: OnceLock<Mutex<HashMap<PathBuf, ConfigLease>>> = OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Take a share in the workspace's config file. The first claim remembers what
/// was there and hides the file from git; every claim writes its own shape in.
fn claim_config(
    workspace_path: &Path,
    path: &Path,
    exclude_pattern: &str,
    shape: Shape,
) -> LaunchScratch {
    let mut held = leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let known = held.contains_key(path);
    let current = fs::read_to_string(path).unwrap_or_default();

    let (body, undo) = match &shape {
        Shape::WholeFile(body) => (body.clone(), Undo::ReleaseConfig(path.to_path_buf(), None)),
        Shape::CursorServer { entry, spec } => {
            let Some(body) = merge_cursor_server(&current, entry, Some(spec)) else {
                tracing::warn!(path = %path.display(), "leaving an MCP config we cannot rewrite alone; the agent tools stay off for this launch");
                return LaunchScratch::default();
            };
            (
                body,
                Undo::ReleaseConfig(path.to_path_buf(), Some(entry.clone())),
            )
        }
    };

    // Only a directory this launch creates is ours to exclude. Excluding one
    // the user already keeps would hide their own files from git for good.
    let directory_is_ours = !known && path.parent().is_some_and(|parent| !parent.exists());
    if !write_config(path, &body) {
        return LaunchScratch::default();
    }
    match held.get_mut(path) {
        Some(lease) => lease.holders += 1,
        None => {
            let exclude = directory_is_ours
                .then(|| git_exclude(workspace_path, exclude_pattern))
                .flatten();
            held.insert(
                path.to_path_buf(),
                ConfigLease {
                    holders: 1,
                    original: (!current.is_empty()).then_some(current),
                    exclude,
                },
            );
        }
    }
    LaunchScratch { undo: vec![undo] }
}

/// Give up one share: this session's entry goes now, and the last one out puts
/// the whole file back the way it was and drops the exclude line it added.
fn release_config(path: &Path, entry: Option<&str>) {
    let mut held = leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(lease) = held.get_mut(path) else {
        return;
    };
    lease.holders -= 1;
    if lease.holders > 0 {
        // Another session is still running out of this file. Take only this
        // session's own entry out of it.
        if let Some(entry) = entry {
            let current = fs::read_to_string(path).unwrap_or_default();
            if let Some(body) = merge_cursor_server(&current, entry, None) {
                write_config(path, &body);
            }
        }
        return;
    }
    let Some(lease) = held.remove(path) else {
        return;
    };
    match lease.original {
        Some(body) => {
            if let Err(error) = fs::write(path, body) {
                tracing::warn!(?error, path = %path.display(), "could not restore the user's MCP config");
            }
        }
        None => {
            let _ = fs::remove_file(path);
            // The directory only goes if we are the last thing in it, so a
            // user's own `.grok/` or `.cursor/` survives.
            if let Some(parent) = path.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
    }
    if let Some((exclude_path, pattern)) = lease.exclude {
        git_unexclude(&exclude_path, &pattern);
    }
}

fn write_config(path: &Path, body: &str) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if let Err(error) = fs::create_dir_all(parent) {
        tracing::warn!(?error, path = %path.display(), "could not create the MCP config directory");
        return false;
    }
    if let Err(error) = fs::write(path, body) {
        tracing::warn!(?error, path = %path.display(), "could not write the MCP config");
        return false;
    }
    true
}

/// Keep a scratch config out of `git status`. The pattern goes in the
/// checkout's own exclude file, which is per-repository and never committed —
/// a shared checkout is the user's real repo, and a launch must not make it
/// look dirty. A linked worktree keeps `info/` in the common git directory.
/// Returns what to hand [`git_unexclude`] later, and `None` when the pattern
/// was already there: a line the user wrote is not ours to take away.
fn git_exclude(workspace_path: &Path, pattern: &str) -> Option<(PathBuf, String)> {
    let exclude_path = git_exclude_path(workspace_path)?;
    let existing = fs::read_to_string(&exclude_path).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == pattern) {
        return None;
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
        return None;
    }
    Some((exclude_path, pattern.to_string()))
}

/// Drop the one line [`git_exclude`] added, leaving every other line alone.
fn git_unexclude(exclude_path: &Path, pattern: &str) {
    let Ok(existing) = fs::read_to_string(exclude_path) else {
        return;
    };
    let kept: Vec<&str> = existing
        .lines()
        .filter(|line| line.trim() != pattern)
        .collect();
    let body = if kept.is_empty() {
        String::new()
    } else {
        format!("{}\n", kept.join("\n"))
    };
    if let Err(error) = fs::write(exclude_path, body) {
        tracing::warn!(?error, path = %exclude_path.display(), "could not tidy the git exclude file");
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
        let (environment, files) = launch_files(
            ProviderId::Opencode,
            workspace.path(),
            "session-1",
            Some(&config()),
        );
        assert_eq!(environment.len(), 1);
        assert_eq!(environment[0].0, "OPENCODE_CONFIG_CONTENT");
        let written: Value = serde_json::from_str(&environment[0].1).expect("valid JSON");
        assert_eq!(written["mcp"]["argmax"]["type"], "local");
        assert_eq!(written["mcp"]["argmax"]["command"][1], "mcp");
        assert_eq!(
            written["mcp"]["argmax"]["environment"][SESSION_LAUNCH_TOKEN_ENV],
            "token-123"
        );
        assert!(files.undo.is_empty());
        assert!(!workspace.path().join(".argmax").exists());
    }

    #[test]
    fn grok_config_is_written_git_excluded_and_removed_again() {
        let workspace = tempfile::tempdir().expect("temp workspace");
        fs::create_dir_all(workspace.path().join(".git").join("info")).expect("git dir");
        let (environment, scratch) = launch_files(
            ProviderId::Grok,
            workspace.path(),
            "session-1",
            Some(&config()),
        );
        let grok_config = workspace.path().join(".grok").join("config.toml");
        assert!(environment.is_empty());
        let body = fs::read_to_string(&grok_config).expect("written");
        assert!(body.starts_with("[mcp_servers.argmax]\n"));
        assert!(body.contains(r#"args = ["mcp"]"#));
        // The credential rides the child's environment, never the file: this
        // one path is shared by every session over the checkout.
        assert!(
            !body.contains("token-123"),
            "the token must not be written into the user's checkout: {body}"
        );
        let exclude =
            fs::read_to_string(workspace.path().join(".git/info/exclude")).expect("exclude");
        assert_eq!(exclude, ".grok/\n");

        scratch.restore();
        assert!(!grok_config.exists());
        assert!(!grok_config.parent().expect("parent").exists());
        // The exclude line goes with the file it was hiding.
        assert_eq!(
            fs::read_to_string(workspace.path().join(".git/info/exclude")).expect("exclude"),
            ""
        );
    }

    #[test]
    fn a_second_session_over_one_checkout_holds_the_config_until_it_exits() {
        // ADR 0004: several sessions over one checkout is the normal case, and
        // both file-based providers read one path per checkout. The first one
        // to finish must not pull the config out from under the other.
        for (provider, relative) in [
            (ProviderId::Grok, ".grok/config.toml"),
            (ProviderId::Cursor, ".cursor/mcp.json"),
        ] {
            let workspace = tempfile::tempdir().expect("temp workspace");
            fs::create_dir_all(workspace.path().join(".git").join("info")).expect("git dir");
            let path = workspace.path().join(relative);

            let (_, first) =
                launch_files(provider, workspace.path(), "aaaaaaaa-1", Some(&config()));
            let (_, second) =
                launch_files(provider, workspace.path(), "bbbbbbbb-2", Some(&config()));
            let both = fs::read_to_string(&path).expect("written");

            first.restore();
            let after = fs::read_to_string(&path).expect("still there for the second session");
            assert!(
                !after.is_empty(),
                "{relative} must survive the first session's exit"
            );
            if provider == ProviderId::Cursor {
                // Each session names its own server, so one leaving takes only
                // its own entry with it.
                assert!(both.contains(&cursor_server_name("aaaaaaaa-1")));
                assert!(!after.contains(&cursor_server_name("aaaaaaaa-1")));
                assert!(after.contains(&cursor_server_name("bbbbbbbb-2")));
            } else {
                assert_eq!(after, both);
            }

            second.restore();
            assert!(!path.exists(), "{relative} should go with the last session");
        }
    }

    #[test]
    fn cursor_merges_its_server_into_the_users_own_mcp_json_and_restores_it() {
        let workspace = tempfile::tempdir().expect("temp workspace");
        fs::create_dir_all(workspace.path().join(".git").join("info")).expect("git dir");
        let path = workspace.path().join(".cursor").join("mcp.json");
        let mine = "{\n  \"mcpServers\": {\n    \"mine\": { \"command\": \"my-server\" }\n  }\n}\n";
        fs::create_dir_all(path.parent().expect("parent")).expect("cursor dir");
        fs::write(&path, mine).expect("seed");

        let (environment, scratch) = launch_files(
            ProviderId::Cursor,
            workspace.path(),
            "session-1",
            Some(&config()),
        );
        assert!(environment.is_empty());
        let written: Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("written")).expect("valid JSON");
        let entry = cursor_server_name("session-1");
        assert_eq!(written["mcpServers"][&entry]["args"][0], "mcp");
        // Cursor starts its MCP servers with a sanitised environment, so the
        // credential has to be in the spec.
        assert_eq!(
            written["mcpServers"][&entry]["env"][SESSION_LAUNCH_TOKEN_ENV],
            "token-123"
        );
        // The user's own server is still there, and their `.cursor/` was not
        // theirs to exclude.
        assert_eq!(written["mcpServers"]["mine"]["command"], "my-server");
        assert!(!workspace.path().join(".git/info/exclude").exists());

        scratch.restore();
        assert_eq!(fs::read_to_string(&path).expect("restored"), mine);
    }

    #[test]
    fn a_cursor_launch_that_creates_the_directory_excludes_and_removes_it() {
        let workspace = tempfile::tempdir().expect("temp workspace");
        fs::create_dir_all(workspace.path().join(".git").join("info")).expect("git dir");
        let path = workspace.path().join(".cursor").join("mcp.json");

        let (_, scratch) = launch_files(
            ProviderId::Cursor,
            workspace.path(),
            "session-1",
            Some(&config()),
        );
        assert!(path.exists());
        assert_eq!(
            fs::read_to_string(workspace.path().join(".git/info/exclude")).expect("exclude"),
            ".cursor/\n"
        );

        scratch.restore();
        assert!(!path.exists());
        assert!(!path.parent().expect("parent").exists());
    }

    #[test]
    fn an_unreadable_cursor_config_is_left_exactly_as_it_was() {
        let workspace = tempfile::tempdir().expect("temp workspace");
        let path = workspace.path().join(".cursor").join("mcp.json");
        fs::create_dir_all(path.parent().expect("parent")).expect("cursor dir");
        fs::write(&path, "{ not json").expect("seed");

        let (_, scratch) = launch_files(
            ProviderId::Cursor,
            workspace.path(),
            "session-1",
            Some(&config()),
        );
        assert!(scratch.undo.is_empty());
        assert_eq!(fs::read_to_string(&path).expect("untouched"), "{ not json");
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

        let (_, files) = launch_files(ProviderId::Grok, &worktree, "session-1", Some(&config()));
        assert_eq!(
            fs::read_to_string(common.join("info").join("exclude")).expect("exclude"),
            ".grok/\n"
        );
        files.restore();
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
            let (environment, files) =
                launch_files(provider, Path::new("/repo"), "session-1", None);
            assert!(environment.is_empty());
            files.restore();
        }
        assert_eq!(acp_mcp_servers(None), json!([]));
    }
}
