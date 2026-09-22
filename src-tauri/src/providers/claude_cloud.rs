use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    providers::{environment::build_provider_environment, ProviderId},
    util::process_control::signal_pty_session_term_and_kill_blocking,
};

const CLOUD_LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CLOUD_OUTPUT_BYTES: usize = 64 * 1024;
const OSC_BACKGROUND_QUERY: &[u8] = b"\x1b]11;?";
const OSC_DARK_BACKGROUND_RESPONSE: &[u8] = b"\x1b]11;rgb:0000/0000/0000\x07";

pub fn selected_environment() -> ArgmaxResult<(String, String)> {
    let environment = build_provider_environment(Vec::new())
        .into_iter()
        .collect::<HashMap<_, _>>();
    let config_dir = environment
        .get("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| environment.get("HOME").map(|home| PathBuf::from(home).join(".claude")))
        .ok_or_else(|| {
            ArgmaxError::service(
                "CLOUD_ENVIRONMENT_NOT_SELECTED",
                "Claude's config directory could not be resolved. Select Default with /remote-env in Claude Code first.",
            )
        })?;
    let settings_path = config_dir.join("settings.json");
    let settings = std::fs::read_to_string(&settings_path).map_err(|_| {
        ArgmaxError::service(
            "CLOUD_ENVIRONMENT_NOT_SELECTED",
            "No Claude Cloud environment is selected. Run /remote-env in Claude Code and select Default.",
        )
    })?;
    let value: serde_json::Value = serde_json::from_str(&settings).map_err(|error| {
        ArgmaxError::service(
            "CLOUD_ENVIRONMENT_SETTINGS_INVALID",
            format!("Claude settings could not be read: {error}"),
        )
    })?;
    let id = value
        .pointer("/remote/defaultEnvironmentId")
        .and_then(serde_json::Value::as_str)
        .filter(|id| valid_environment_id(id))
        .ok_or_else(|| {
            ArgmaxError::service(
                "CLOUD_ENVIRONMENT_NOT_SELECTED",
                "No hosted Claude Cloud environment is selected. Run /remote-env in Claude Code and select Default.",
            )
        })?
        .to_string();
    Ok((id, "Selected in Claude Code".to_string()))
}

pub async fn launch(
    binary_path: &str,
    checkout: &Path,
    environment_id: &str,
    brief: &str,
) -> ArgmaxResult<String> {
    if !valid_environment_id(environment_id) {
        return Err(ArgmaxError::service(
            "CLOUD_ENVIRONMENT_CHANGED",
            "The selected Claude Cloud environment is no longer valid. Select Default with /remote-env and prepare the handoff again.",
        ));
    }
    let binary_path = binary_path.to_string();
    let checkout = checkout.to_path_buf();
    let environment_id = environment_id.to_string();
    let brief = brief.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        launch_blocking(
            &binary_path,
            &checkout,
            &environment_id,
            &brief,
            CLOUD_LAUNCH_TIMEOUT,
        )
    })
    .await
    .map_err(|error| ArgmaxError::service("CLOUD_LAUNCH_JOIN_FAILED", error.to_string()))?
}

fn launch_blocking(
    binary_path: &str,
    checkout: &Path,
    environment_id: &str,
    brief: &str,
    timeout: Duration,
) -> ArgmaxResult<String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| {
            ArgmaxError::service(
                "CLOUD_LAUNCH_PTY_FAILED",
                format!("Could not open a terminal for Claude Cloud: {error}"),
            )
        })?;
    let settings = json!({"remote": {"defaultEnvironmentId": environment_id}}).to_string();
    let cloud_prompt = format!("--cloud={brief}");
    let mut command = CommandBuilder::new(binary_path);
    command.args([
        "--safe-mode",
        "--settings",
        settings.as_str(),
        cloud_prompt.as_str(),
    ]);
    command.cwd(checkout);
    command.env_clear();
    for (key, value) in build_provider_environment(Vec::new()) {
        command.env(key, value);
    }
    command.env("CCR_FORCE_BUNDLE", "1");
    command.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(command).map_err(|error| {
        ArgmaxError::service(
            "CLOUD_LAUNCH_SPAWN_FAILED",
            format!("Could not start Claude Cloud: {error}"),
        )
    })?;
    drop(pair.slave);
    let mut writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            terminate_and_reap_cloud_child(child.as_mut());
            return Err(ArgmaxError::service(
                "CLOUD_LAUNCH_PTY_FAILED",
                format!("Could not answer Claude Cloud's checkout prompt: {error}"),
            ));
        }
    };
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            terminate_and_reap_cloud_child(child.as_mut());
            return Err(ArgmaxError::service(
                "CLOUD_LAUNCH_PTY_FAILED",
                format!("Could not read Claude Cloud launch output: {error}"),
            ));
        }
    };
    let timed_out = Arc::new(AtomicBool::new(false));
    let timeout_flag = Arc::clone(&timed_out);
    let child_process_id = child.process_id();
    let mut timeout_killer = child.clone_killer();
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        if done_rx.recv_timeout(timeout).is_err() {
            timeout_flag.store(true, Ordering::SeqCst);
            if let Some(process_id) = child_process_id {
                let _ = signal_pty_session_term_and_kill_blocking(process_id, &[process_id]);
            }
            // The session-aware path above is authoritative on Unix. Keep the
            // portable child killer as a fallback when there is no PID or on
            // platforms without Unix session signalling.
            let _ = timeout_killer.kill();
        }
    });

    let mut output = Vec::new();
    let mut chunk = [0_u8; 4096];
    let mut trust_answered = false;
    let mut background_query_answered = false;
    let mut known_url = None;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                output.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&output);
                let clean = strip_terminal_sequences(&text);
                if known_url.is_none() {
                    known_url = cloud_session_url_from_complete_lines(&clean);
                }
                if !background_query_answered && has_complete_osc_background_query(&output) {
                    if let Err(error) = writer
                        .write_all(OSC_DARK_BACKGROUND_RESPONSE)
                        .and_then(|_| writer.flush())
                    {
                        terminate_and_reap_cloud_child(child.as_mut());
                        let _ = done_tx.send(());
                        return Err(ArgmaxError::service(
                            "CLOUD_LAUNCH_PTY_FAILED",
                            format!("Could not answer Claude Cloud's terminal query: {error}"),
                        ));
                    }
                    background_query_answered = true;
                }
                if !trust_answered && has_workspace_trust_prompt(&clean) {
                    // Claude ignores confirmation keys during the trust
                    // dialog's 150 ms opening guard. This is an owned clone,
                    // so answer once after the dialog has settled.
                    std::thread::sleep(Duration::from_millis(250));
                    let answer = writer
                        .write_all(b"\x1b[B")
                        .and_then(|_| writer.flush())
                        .and_then(|_| {
                            std::thread::sleep(Duration::from_millis(100));
                            writer.write_all(b"\r")
                        })
                        .and_then(|_| writer.flush());
                    if let Err(error) = answer {
                        terminate_and_reap_cloud_child(child.as_mut());
                        let _ = done_tx.send(());
                        return Err(ArgmaxError::service(
                            "CLOUD_LAUNCH_PTY_FAILED",
                            format!("Could not confirm Claude Cloud's checkout prompt: {error}"),
                        ));
                    }
                    trust_answered = true;
                }
                if output.len() > MAX_CLOUD_OUTPUT_BYTES {
                    output.drain(..output.len() - MAX_CLOUD_OUTPUT_BYTES);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let wait_result = child.wait();
    let _ = done_tx.send(());
    let status = wait_result.map_err(|error| {
        ArgmaxError::service(
            "CLOUD_LAUNCH_WAIT_FAILED",
            format!("Could not read Claude Cloud's exit status: {error}"),
        )
    })?;
    let output = strip_terminal_sequences(&String::from_utf8_lossy(&output));
    if let Some(url) = known_url.or_else(|| cloud_session_url(&output)) {
        return Ok(url);
    }
    if timed_out.load(Ordering::SeqCst) {
        let detail = safe_cloud_output_detail(&output)
            .map(|line| format!(" Last output: {line}"))
            .unwrap_or_default();
        return Err(ArgmaxError::service(
            "CLOUD_LAUNCH_DELIVERY_UNKNOWN",
            format!("Claude Cloud did not return a session link within 60 seconds.{detail} The task may have been created, so Argmax will not retry it automatically. Check claude.ai/code before trying again."),
        ));
    }
    let detail = output
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Claude exited before returning a cloud session link.");
    Err(ArgmaxError::service(
        "CLOUD_LAUNCH_DELIVERY_UNKNOWN",
        format!("Claude exited with {status} without returning a cloud session link ({detail}). The task may have been created, so Argmax will not retry it automatically."),
    ))
}

fn has_complete_osc_background_query(output: &[u8]) -> bool {
    output
        .windows(OSC_BACKGROUND_QUERY.len())
        .position(|window| window == OSC_BACKGROUND_QUERY)
        .is_some_and(|index| {
            let suffix = &output[index + OSC_BACKGROUND_QUERY.len()..];
            suffix.contains(&b'\x07') || suffix.windows(2).any(|window| window == b"\x1b\\")
        })
}

fn has_workspace_trust_prompt(output: &str) -> bool {
    let compact = output
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    compact.contains("Accessingworkspace:") && compact.contains("Yes,Itrustthisfolder")
}

fn safe_cloud_output_detail(output: &str) -> Option<String> {
    let line = output.lines().rev().find_map(|line| {
        let line = line.trim();
        (!line.is_empty()).then_some(line)
    })?;
    let lower = line.to_ascii_lowercase();
    if ["token", "authorization", "api key", "secret"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return Some("Provider output was redacted.".to_string());
    }
    let detail = line
        .chars()
        .filter(|character| !character.is_control())
        .take(240)
        .collect::<String>();
    (!detail.is_empty()).then_some(detail)
}

fn terminate_and_reap_cloud_child(child: &mut (dyn portable_pty::Child + Send + Sync)) {
    if let Some(process_id) = child.process_id() {
        let _ = signal_pty_session_term_and_kill_blocking(process_id, &[process_id]);
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn cloud_session_url(output: &str) -> Option<String> {
    let clean = strip_terminal_sequences(output);
    for line in clean.lines() {
        let line = line.trim();
        if let Some(view) = line.strip_prefix("View:") {
            let url = view.trim();
            if let Some(suffix) = url.strip_prefix("https://claude.ai/code/") {
                let end = suffix
                    .find(|character: char| {
                        character.is_whitespace()
                            || matches!(character, '?' | ')' | ']' | '"' | '\'')
                    })
                    .unwrap_or(suffix.len());
                let id = &suffix[..end];
                if valid_cloud_session_id(id) {
                    return Some(format!("https://claude.ai/code/{id}"));
                }
            }
        }
        if let Some(id) = line.strip_prefix("Resume with: claude --teleport ") {
            let id = id.trim();
            if valid_cloud_session_id(id) {
                return Some(format!("https://claude.ai/code/{id}"));
            }
        }
    }
    None
}

fn cloud_session_url_from_complete_lines(output: &str) -> Option<String> {
    let complete = output.rsplit_once('\n')?.0;
    cloud_session_url(complete)
}

fn valid_cloud_session_id(value: &str) -> bool {
    (value.starts_with("session_") || value.starts_with("cse_"))
        && value.len() > "cse_".len()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn strip_terminal_sequences(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else if character != '\r' {
            result.push(character);
        }
    }
    result
}

fn valid_environment_id(value: &str) -> bool {
    value.starts_with("env_")
        && value.len() > 4
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

pub async fn claude_binary_path(
    discovery: &super::discovery::ProviderDiscovery,
) -> ArgmaxResult<String> {
    discovery
        .discover(ProviderId::Claude)
        .await
        .binary_path
        .ok_or_else(|| {
            ArgmaxError::service(
                "CLOUD_CLAUDE_NOT_INSTALLED",
                "Claude Code is not installed.",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn cloud_session_links_accept_direct_urls_and_documented_session_ids() {
        assert_eq!(
            cloud_session_url("Created cloud session: session_wrong\r\n"),
            None
        );
        assert_eq!(
            cloud_session_url("Resume with: claude --teleport session_abc-123\r\n"),
            Some("https://claude.ai/code/session_abc-123".to_string())
        );
        assert_eq!(
            cloud_session_url("\u{1b}[32mResume with: claude --teleport cse_ABC_9\u{1b}[0m"),
            Some("https://claude.ai/code/cse_ABC_9".to_string())
        );
        assert_eq!(
            cloud_session_url("View: https://claude.ai/code/session_xyz?from=cli&m=0"),
            Some("https://claude.ai/code/session_xyz".to_string())
        );
        assert_eq!(
            cloud_session_url_from_complete_lines("View: https://claude.ai/code/session_partial"),
            None
        );
        assert_eq!(
            cloud_session_url_from_complete_lines(
                "View: https://claude.ai/code/session_complete123\nnext partial"
            ),
            Some("https://claude.ai/code/session_complete123".to_string())
        );
        assert_eq!(
            safe_cloud_output_detail("Authorization: Bearer private-value").as_deref(),
            Some("Provider output was redacted.")
        );
        assert!(!has_complete_osc_background_query(b"\x1b]11;?"));
        assert!(has_complete_osc_background_query(b"\x1b]11;?\x07"));
        assert!(has_complete_osc_background_query(b"\x1b]11;?\x1b\\"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cloud_launch_accepts_only_the_owned_clone_prompt_and_pins_environment() {
        let directory = tempfile::tempdir().expect("temporary fake Claude directory");
        let binary = directory.path().join("claude");
        let log = directory.path().join("invocation.log");
        let script = format!(
            r#"#!/bin/sh
{{
  printf 'CCR=%s\n' "$CCR_FORCE_BUNDLE"
  printf 'ARG=%s\n' "$@"
}} > '{}'
stty raw -echo min 1 time 0
printf '\033]11;'
sleep 0.05
printf '?\007'
dd bs=1 count=24 of=/dev/null 2>/dev/null
printf '\033[2GAccessing\033[12Gworkspace:\n  No, exit\n\033[4GYes,\033[9GI\033[11Gtrust\033[17Gthis\033[22Gfolder\n'
stty raw -echo min 0 time 2
early="$(dd bs=1 count=4 2>/dev/null)"
if [ -n "$early" ]; then printf 'trust answer arrived during guard\n'; exit 12; fi
stty min 1 time 0
dd bs=1 count=4 of=/dev/null 2>/dev/null
printf 'Created cloud session: Argmax fake handoff\n'
printf 'View: https://claude.ai/code/session_fake123?from=cli&m=0\n'
printf 'Resume with: claude --teleport session_fake123\n'
"#,
            log.display()
        );
        std::fs::write(&binary, script).expect("write fake Claude executable");
        let mut permissions = std::fs::metadata(&binary)
            .expect("fake Claude metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&binary, permissions).expect("make fake Claude executable");

        let url = launch(
            binary.to_str().expect("UTF-8 fake Claude path"),
            directory.path(),
            "env_selected123",
            "--version\nInspect the private repository.",
        )
        .await
        .expect("cloud handoff succeeds");

        assert_eq!(url, "https://claude.ai/code/session_fake123");
        let invocation = std::fs::read_to_string(log).expect("fake invocation log");
        assert!(invocation.contains("CCR=1"), "{invocation}");
        assert!(invocation.contains("ARG=--safe-mode"), "{invocation}");
        assert!(
            invocation.contains("ARG={\"remote\":{\"defaultEnvironmentId\":\"env_selected123\"}}"),
            "{invocation}"
        );
        assert!(invocation.contains("ARG=--cloud"), "{invocation}");
        assert!(
            invocation.contains("ARG=--cloud=--version\nInspect the private repository."),
            "{invocation}"
        );
        assert!(!invocation.contains("ARG=--ref"), "{invocation}");
    }

    #[cfg(unix)]
    #[test]
    fn cloud_launch_keeps_a_link_emitted_after_the_output_cap() {
        let directory = tempfile::tempdir().expect("temporary noisy Claude directory");
        let binary = directory.path().join("claude-noisy");
        std::fs::write(
            &binary,
            r#"#!/bin/sh
i=0
while [ "$i" -lt 800 ]; do
  printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n'
  i=$((i + 1))
done
printf 'View: https://claude.ai/code/session_aftercap123?from=cli&m=0\n'
"#,
        )
        .expect("write noisy fake Claude executable");
        let mut permissions = std::fs::metadata(&binary)
            .expect("noisy fake Claude metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&binary, permissions).expect("make noisy fake Claude executable");

        let url = launch_blocking(
            binary.to_str().expect("UTF-8 noisy Claude path"),
            directory.path(),
            "env_selected123",
            "Inspect the repository.",
            Duration::from_secs(5),
        )
        .expect("cloud link after output cap");

        assert_eq!(url, "https://claude.ai/code/session_aftercap123");
    }

    #[cfg(unix)]
    #[test]
    fn known_link_survives_timeout_when_cli_closes_pty_but_keeps_running() {
        let directory = tempfile::tempdir().expect("temporary hanging Claude directory");
        let binary = directory.path().join("claude-hangs");
        std::fs::write(
            &binary,
            r#"#!/bin/sh
trap '' HUP TERM
printf 'View: https://claude.ai/code/session_hanging123?from=cli&m=0\n'
exec >/dev/null 2>&1
while :; do
  sleep 1
done
"#,
        )
        .expect("write hanging fake Claude executable");
        let mut permissions = std::fs::metadata(&binary)
            .expect("hanging fake Claude metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&binary, permissions)
            .expect("make hanging fake Claude executable");

        let started = std::time::Instant::now();
        let url = launch_blocking(
            binary.to_str().expect("UTF-8 hanging Claude path"),
            directory.path(),
            "env_selected123",
            "Inspect the repository.",
            Duration::from_secs(2),
        )
        .expect("known cloud link survives timeout cleanup");

        assert_eq!(url, "https://claude.ai/code/session_hanging123");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "hanging CLI exceeded the bounded cleanup window: {:?}",
            started.elapsed()
        );
    }
}
