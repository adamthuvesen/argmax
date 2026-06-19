use std::{process::Command, time::Duration};

use super::runtime::{signal_process, SignalKind};

#[derive(Debug, Clone)]
pub(super) struct RecoveredProviderSession {
    pub(super) id: String,
    pub(super) provider: String,
    pub(super) provider_conversation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProviderProcess {
    pid: u32,
    ppid: u32,
}

pub(super) fn terminate_orphaned_provider_processes(sessions: &[RecoveredProviderSession]) {
    if sessions.is_empty() {
        return;
    }
    let Ok(output) = Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
    else {
        tracing::warn!("failed to list processes while recovering provider sessions");
        return;
    };
    if !output.status.success() {
        tracing::warn!(
            exit_code = output.status.code(),
            "ps failed while recovering provider sessions"
        );
        return;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let current_pid = std::process::id();
    let mut matched = stdout
        .lines()
        .filter_map(parse_provider_process_line)
        .filter(|(process, command)| {
            // Only clean provider CLIs already reparented away from Argmax.
            // A second running app instance should keep its own children.
            process.pid != current_pid && process.ppid == 1 && {
                sessions
                    .iter()
                    .any(|session| provider_command_matches_session(command, session))
            }
        })
        .map(|(process, _)| process)
        .collect::<Vec<_>>();
    matched.sort_by_key(|process| process.pid);
    matched.dedup_by_key(|process| process.pid);

    if matched.is_empty() {
        return;
    }

    for process in &matched {
        signal_process(process.pid, SignalKind::Term);
    }
    std::thread::sleep(Duration::from_millis(250));
    for process in &matched {
        signal_process(process.pid, SignalKind::Kill);
    }
    tracing::warn!(
        process_count = matched.len(),
        "terminated orphaned provider processes during session recovery"
    );
}

fn parse_provider_process_line(line: &str) -> Option<(ProviderProcess, &str)> {
    let line = line.trim_start();
    let (pid, rest) = split_first_field(line)?;
    let (ppid, command) = split_first_field(rest.trim_start())?;
    Some((
        ProviderProcess {
            pid: pid.parse().ok()?,
            ppid: ppid.parse().ok()?,
        },
        command.trim_start(),
    ))
}

fn split_first_field(value: &str) -> Option<(&str, &str)> {
    let value = value.trim_start();
    let split_at = value.find(char::is_whitespace)?;
    Some((&value[..split_at], &value[split_at..]))
}

fn provider_command_matches_session(command: &str, session: &RecoveredProviderSession) -> bool {
    let mut args = command.split_whitespace();
    let Some(binary) = args.next() else {
        return false;
    };
    if provider_binary_name(binary) != Some(session.provider.as_str()) {
        return false;
    }
    let args = args.collect::<Vec<_>>();
    match session.provider.as_str() {
        "claude" => {
            has_flag_value(&args, "--session-id", &session.id)
                || session
                    .provider_conversation_id
                    .as_deref()
                    .is_some_and(|id| has_flag_value(&args, "--resume", id))
        }
        "cursor" => session
            .provider_conversation_id
            .as_deref()
            .is_some_and(|id| has_flag_value(&args, "--resume", id)),
        "codex" => session
            .provider_conversation_id
            .as_deref()
            .is_some_and(|id| {
                (args
                    .windows(2)
                    .any(|window| window[0] == "exec" && window[1] == "resume")
                    && args.contains(&id))
                    || args
                        .windows(2)
                        .any(|window| window[0] == "resume" && window[1] == id)
            }),
        _ => false,
    }
}

fn provider_binary_name(binary: &str) -> Option<&'static str> {
    let basename = std::path::Path::new(binary).file_name()?.to_str()?;
    match basename {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "cursor-agent" => Some("cursor"),
        _ => None,
    }
}

fn has_flag_value(args: &[&str], flag: &str, value: &str) -> bool {
    args.windows(2)
        .any(|window| window[0] == flag && window[1] == value)
        || args.iter().any(|arg| {
            arg.strip_prefix(flag)
                .and_then(|suffix| suffix.strip_prefix('='))
                == Some(value)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_process_matcher_finds_claude_session_and_resume_commands() {
        let session = RecoveredProviderSession {
            id: "session-1".to_owned(),
            provider: "claude".to_owned(),
            provider_conversation_id: Some("provider-1".to_owned()),
        };

        assert!(provider_command_matches_session(
            "/Users/me/.local/bin/claude -p --session-id session-1 --output-format stream-json hello",
            &session,
        ));
        assert!(provider_command_matches_session(
            "/Users/me/.local/bin/claude -p --resume provider-1 --output-format stream-json hello",
            &session,
        ));
        assert!(!provider_command_matches_session(
            "/Users/me/.local/bin/claude -p --resume other-session --output-format stream-json hello",
            &session,
        ));
        assert!(!provider_command_matches_session(
            "node ./script-that-mentions-claude --resume provider-1",
            &session,
        ));
    }

    #[test]
    fn recovery_process_matcher_finds_cursor_and_codex_resume_commands() {
        let cursor = RecoveredProviderSession {
            id: "argmax-session".to_owned(),
            provider: "cursor".to_owned(),
            provider_conversation_id: Some("cursor-session".to_owned()),
        };
        let codex = RecoveredProviderSession {
            id: "argmax-session".to_owned(),
            provider: "codex".to_owned(),
            provider_conversation_id: Some("codex-thread".to_owned()),
        };

        assert!(provider_command_matches_session(
            "/opt/bin/cursor-agent agent -p --resume cursor-session --output-format stream-json prompt",
            &cursor,
        ));
        assert!(provider_command_matches_session(
            "/opt/bin/codex exec resume --json --model gpt-5 codex-thread -",
            &codex,
        ));
        assert!(!provider_command_matches_session(
            "/opt/bin/codex exec --json --model gpt-5 -",
            &codex,
        ));
    }

    #[test]
    fn recovery_process_line_parser_reads_pid_ppid_and_command() {
        let parsed = parse_provider_process_line("  123  1 /usr/bin/claude -p --resume abc")
            .expect("parse ps row");

        assert_eq!(parsed.0.pid, 123);
        assert_eq!(parsed.0.ppid, 1);
        assert_eq!(parsed.1, "/usr/bin/claude -p --resume abc");
    }
}
