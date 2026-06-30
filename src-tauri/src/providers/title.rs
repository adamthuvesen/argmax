//! One-shot session-title generation.
//!
//! None of the provider CLIs expose a human-readable title in their protocol
//! output — they emit only opaque session/thread ids — so we mint one
//! ourselves: a single cheap, no-tools model call that turns the launch prompt
//! into a short sidebar label, mirroring what the Codex/Cursor/Claude desktop
//! apps do. It is strictly best-effort: any failure (CLI missing, not logged
//! in, timeout, junk output) returns `None` and the provisional first-line
//! title stays in place.
//!
//! The call runs in a neutral temp dir with MCP/user-config loading disabled so
//! it never picks up the project's `CLAUDE.md`, spawns MCP servers, or touches
//! the workspace — it only needs the prompt text.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::{
    adapters::get_provider_definition, environment::build_provider_environment, ProviderId,
};

/// Generous upper bound — a cold CLI start (auth refresh, model spin-up) can
/// take several seconds. Past this we give up and keep the provisional title.
const TITLE_TIMEOUT: Duration = Duration::from_secs(20);
/// Display cap for the generated title. Matches `titleFromPrompt` (renderer) and
/// stays well under the 200-byte `taskLabel` validation cap.
const MAX_TITLE_CHARS: usize = 64;
const MAX_TITLE_BYTES: usize = 200;

/// Generates a short title for `prompt` using the given provider's CLI and a
/// cheap model. Returns `None` on any failure; callers must treat that as
/// "keep the existing title".
pub async fn generate_title(provider: ProviderId, model_id: &str, prompt: &str) -> Option<String> {
    let instruction = meta_prompt(prompt);
    let command = title_command(provider, model_id, &instruction);
    let raw = run_capture(provider, command).await?;
    let text = extract_title(provider, &raw)?;
    sanitize_title(&text)
}

/// Wraps the user's prompt as data and asks for a bare title. Keeping the prompt
/// clearly framed as data contains injection: the worst case is an odd title the
/// user can rename, never a tool call or file edit (the call has no tools).
fn meta_prompt(prompt: &str) -> String {
    format!(
        "Write a short title (3-6 words, Title Case, no quotes and no trailing \
         punctuation) summarizing the coding task below for a sidebar entry. \
         Reply with ONLY the title.\n\nTASK:\n{prompt}"
    )
}

struct TitleCommand {
    args: Vec<String>,
    /// `Some` when the prompt is delivered on stdin (Codex); `None` when it is
    /// carried as a positional arg after `--` (Claude/Cursor).
    stdin: Option<String>,
}

/// Minimal, no-tools, no-bypass invocation per provider. Deliberately separate
/// from the streaming launch builders in `adapters.rs`, which spin up the full
/// agent with permission bypass — titling needs neither.
fn title_command(provider: ProviderId, model_id: &str, instruction: &str) -> TitleCommand {
    match provider {
        // `--strict-mcp-config` + empty `--mcp-config` skips MCP loading so the
        // call is fast and side-effect free. Plain `--output-format text`
        // returns the answer verbatim.
        ProviderId::Claude => TitleCommand {
            args: vec![
                "-p".into(),
                "--model".into(),
                model_id.into(),
                "--output-format".into(),
                "text".into(),
                "--strict-mcp-config".into(),
                "--mcp-config".into(),
                r#"{"mcpServers":{}}"#.into(),
                "--".into(),
                instruction.into(),
            ],
            stdin: None,
        },
        // `--trust` is the headless-safe way to skip the workspace-trust prompt
        // (our cwd is a throwaway temp dir); we deliberately omit `--force`, so
        // the agent still cannot run commands.
        ProviderId::Cursor => TitleCommand {
            args: vec![
                "agent".into(),
                "-p".into(),
                "--output-format".into(),
                "text".into(),
                "--trust".into(),
                "--model".into(),
                model_id.into(),
                "--".into(),
                instruction.into(),
            ],
            stdin: None,
        },
        // `--json` gives a parseable event stream (plain `exec` stdout mixes in
        // chrome). `--skip-git-repo-check` lets it run in the temp dir,
        // `--ignore-user-config` keeps it deterministic, and low reasoning keeps
        // a title fast.
        ProviderId::Codex => TitleCommand {
            args: vec![
                "exec".into(),
                "--json".into(),
                "--skip-git-repo-check".into(),
                "--ignore-user-config".into(),
                "--model".into(),
                model_id.into(),
                "-c".into(),
                "model_reasoning_effort=\"low\"".into(),
                "-".into(),
            ],
            stdin: Some(instruction.to_string()),
        },
    }
}

async fn run_capture(provider: ProviderId, command: TitleCommand) -> Option<String> {
    let binary = get_provider_definition(provider).binary_name;
    let env = build_provider_environment([("NO_COLOR".to_string(), "1".to_string())]);

    let run = async {
        let mut child = Command::new(binary)
            .args(&command.args)
            // Neutral cwd: no project CLAUDE.md / git context, nothing in the
            // workspace can be read or written by the title call.
            .current_dir(std::env::temp_dir())
            .env_clear()
            .envs(env)
            .stdin(if command.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Ensure a timed-out / dropped future actually kills the CLI.
            .kill_on_drop(true)
            .spawn()
            .ok()?;

        if let Some(input) = command.stdin {
            // Drop the handle after writing so the CLI sees EOF. The payload is
            // tiny, so writing fully before reading stdout can't deadlock.
            let mut stdin = child.stdin.take()?;
            stdin.write_all(input.as_bytes()).await.ok()?;
            drop(stdin);
        }

        let output = child.wait_with_output().await.ok()?;
        if output.status.success() {
            Some(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            tracing::debug!(
                ?provider,
                status = %output.status,
                stderr = %String::from_utf8_lossy(&output.stderr),
                "title generation CLI failed"
            );
            None
        }
    };

    tokio::time::timeout(TITLE_TIMEOUT, run)
        .await
        .ok()
        .flatten()
}

fn extract_title(provider: ProviderId, raw: &str) -> Option<String> {
    match provider {
        // `--output-format text` is already the bare answer.
        ProviderId::Claude | ProviderId::Cursor => Some(raw.to_string()),
        ProviderId::Codex => extract_codex_agent_message(raw),
    }
}

/// Pulls the final assistant message text out of a Codex `exec --json` stream.
/// Tolerant of shape drift: tries the current `item.completed`/`agent_message`
/// shape plus older `msg`/flat-`assistant` envelopes, and keeps the last match.
fn extract_codex_agent_message(raw: &str) -> Option<String> {
    let mut last: Option<String> = None;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(text) = codex_message_text(&value) {
            if !text.trim().is_empty() {
                last = Some(text);
            }
        }
    }
    last
}

fn codex_message_text(value: &serde_json::Value) -> Option<String> {
    let as_str = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).map(str::to_string);

    // Current shape: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    if let Some(item) = value.get("item") {
        if item.get("type").and_then(|t| t.as_str()) == Some("agent_message") {
            if let Some(text) = as_str(item.get("text")) {
                return Some(text);
            }
        }
    }
    // Envelope shape: {"msg":{"type":"agent_message","message":"..."}}
    if let Some(msg) = value.get("msg") {
        if msg.get("type").and_then(|t| t.as_str()) == Some("agent_message") {
            if let Some(text) = as_str(msg.get("message")).or_else(|| as_str(msg.get("text"))) {
                return Some(text);
            }
        }
    }
    // Flat shape: {"type":"assistant","message":"..."}
    if value.get("type").and_then(|t| t.as_str()) == Some("assistant") {
        if let Some(text) = as_str(value.get("message")).or_else(|| as_str(value.get("text"))) {
            return Some(text);
        }
    }
    None
}

/// Normalizes raw model output into a sidebar label: first non-empty line,
/// quote/punctuation stripped, clamped to the display and byte caps. Returns
/// `None` when nothing usable remains.
fn sanitize_title(raw: &str) -> Option<String> {
    let first = raw.lines().map(str::trim).find(|line| !line.is_empty())?;
    let trimmed = first
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '*')
        .trim()
        .trim_end_matches(['.', ',', ';', ':', '!', '?'])
        .trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut clamped: String = trimmed.chars().take(MAX_TITLE_CHARS).collect();
    // Keep within the persisted byte cap even for multibyte titles.
    while clamped.len() > MAX_TITLE_BYTES {
        clamped.pop();
    }
    let clamped = clamped.trim().to_string();
    (!clamped.is_empty()).then_some(clamped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_command_is_text_mode_with_mcp_disabled() {
        let command = title_command(ProviderId::Claude, "claude-haiku-4-5", "META");
        assert_eq!(
            command.args,
            vec![
                "-p",
                "--model",
                "claude-haiku-4-5",
                "--output-format",
                "text",
                "--strict-mcp-config",
                "--mcp-config",
                r#"{"mcpServers":{}}"#,
                "--",
                "META",
            ]
        );
        assert!(command.stdin.is_none());
        // Never hand the title call a permission bypass.
        assert!(!command.args.iter().any(|a| a == "bypassPermissions"));
    }

    #[test]
    fn cursor_command_trusts_but_never_forces() {
        let command = title_command(ProviderId::Cursor, "composer-2.5", "META");
        assert!(command.args.iter().any(|a| a == "--trust"));
        assert!(!command.args.iter().any(|a| a == "--force"));
        assert_eq!(command.args.last().unwrap(), "META");
        assert!(command.stdin.is_none());
    }

    #[test]
    fn codex_command_streams_json_with_prompt_on_stdin() {
        let command = title_command(ProviderId::Codex, "gpt-5.5", "META");
        assert!(command.args.iter().any(|a| a == "--json"));
        assert!(command.args.iter().any(|a| a == "--skip-git-repo-check"));
        assert_eq!(command.args.last().unwrap(), "-");
        assert_eq!(command.stdin.as_deref(), Some("META"));
        assert!(!command
            .args
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
    }

    #[test]
    fn codex_extraction_takes_last_agent_message() {
        let stream = concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"t1\"}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"reasoning\",\"text\":\"thinking\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Fix Mobile Login Button\"}}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10}}\n",
        );
        assert_eq!(
            extract_codex_agent_message(stream).as_deref(),
            Some("Fix Mobile Login Button")
        );
    }

    #[test]
    fn codex_extraction_handles_envelope_and_flat_shapes() {
        assert_eq!(
            extract_codex_agent_message(
                "{\"msg\":{\"type\":\"agent_message\",\"message\":\"Envelope Title\"}}"
            )
            .as_deref(),
            Some("Envelope Title")
        );
        assert_eq!(
            extract_codex_agent_message("{\"type\":\"assistant\",\"message\":\"Flat Title\"}")
                .as_deref(),
            Some("Flat Title")
        );
    }

    #[test]
    fn codex_extraction_ignores_non_json_and_empty() {
        assert_eq!(extract_codex_agent_message("not json\n\n"), None);
    }

    #[test]
    fn sanitize_strips_quotes_and_trailing_punctuation() {
        assert_eq!(
            sanitize_title("\"Fix Mobile Login Button.\"").as_deref(),
            Some("Fix Mobile Login Button")
        );
        assert_eq!(
            sanitize_title("**Add Dark Mode Toggle!**").as_deref(),
            Some("Add Dark Mode Toggle")
        );
    }

    #[test]
    fn sanitize_takes_first_nonempty_line() {
        assert_eq!(
            sanitize_title("\n  \nRefactor Auth Flow\nignored second line").as_deref(),
            Some("Refactor Auth Flow")
        );
    }

    #[test]
    fn sanitize_clamps_to_char_cap() {
        let long = "Word ".repeat(40);
        let title = sanitize_title(&long).expect("clamped title");
        assert!(title.chars().count() <= MAX_TITLE_CHARS);
        assert!(title.len() <= MAX_TITLE_BYTES);
    }

    #[test]
    fn sanitize_rejects_empty() {
        assert_eq!(sanitize_title("   \n  "), None);
        assert_eq!(sanitize_title("\"\""), None);
    }
}
