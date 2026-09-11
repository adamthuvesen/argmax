use std::ffi::OsString;

use super::client::read_bounded_stdin;
#[cfg(unix)]
use super::client::send_session_control;
use super::protocol::{
    LaunchAction, ListAction, MessageAction, MoveAction, SessionControlAction, SessionControlError,
};

#[derive(Debug, PartialEq)]
pub enum CliPrompt {
    Value(String),
    Stdin,
}

#[derive(Debug, PartialEq)]
pub enum SessionControlCliInput {
    Launch {
        project: Option<String>,
        prompt: CliPrompt,
        worktree: bool,
        path: Option<String>,
        branch: Option<String>,
    },
    Move {
        project: Option<String>,
        path: Option<String>,
        prompt: CliPrompt,
        worktree: bool,
        keep_source: bool,
    },
    List {
        project: Option<String>,
        all: bool,
    },
    Message {
        session_id: String,
        prompt: CliPrompt,
    },
}

impl SessionControlCliInput {
    /// Resolve `--prompt-stdin` and hand back the wire action. Parsing never
    /// reads stdin, so the argv shape and the protocol stay separate types.
    fn into_action(self) -> Result<SessionControlAction, SessionControlError> {
        Ok(match self {
            SessionControlCliInput::Launch {
                project,
                prompt,
                worktree,
                path,
                branch,
            } => SessionControlAction::Launch(LaunchAction {
                prompt: prompt.read()?,
                project,
                worktree,
                path,
                branch,
                ..LaunchAction::default()
            }),
            SessionControlCliInput::Move {
                project,
                path,
                prompt,
                worktree,
                keep_source,
            } => SessionControlAction::Move(MoveAction {
                project,
                path,
                prompt: prompt.read()?,
                worktree,
                keep_source,
            }),
            SessionControlCliInput::List { project, all } => {
                SessionControlAction::List(ListAction { project, all })
            }
            SessionControlCliInput::Message { session_id, prompt } => {
                SessionControlAction::Message(MessageAction {
                    session_id,
                    message: prompt.read()?,
                })
            }
        })
    }
}

impl CliPrompt {
    fn read(self) -> Result<String, SessionControlError> {
        match self {
            CliPrompt::Value(value) => Ok(value),
            CliPrompt::Stdin => read_bounded_stdin(),
        }
    }
}

pub fn try_run_session_control_cli<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) != Some("session") {
        return None;
    }
    let input = match parse_session_control_cli(&args) {
        Ok(input) => input,
        Err(message) => {
            eprintln!("argmax: {message}");
            return Some(2);
        }
    };
    Some(run_session_control_cli(input))
}

fn parse_session_control_cli(args: &[OsString]) -> Result<SessionControlCliInput, String> {
    match args.get(2).and_then(|value| value.to_str()) {
        Some("launch") => parse_session_launch_cli(args),
        Some("move") => parse_session_move_cli(args),
        Some("list") => parse_session_list_cli(args),
        Some("message") => parse_session_message_cli(args),
        _ => Err(session_control_usage()),
    }
}

fn parse_session_launch_cli(args: &[OsString]) -> Result<SessionControlCliInput, String> {
    let mut project = None;
    let mut prompt = None;
    let mut worktree = false;
    let mut path = None;
    let mut branch = None;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index]
            .to_str()
            .ok_or_else(|| "arguments must be valid UTF-8".to_string())?;
        match flag {
            "--project" => {
                if project.is_some() {
                    return Err("--project may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--project requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--project must not be empty".to_string());
                }
                project = Some(value.to_string());
            }
            "--worktree" => {
                if worktree {
                    return Err("--worktree may be provided only once".to_string());
                }
                worktree = true;
            }
            "--path" => {
                if path.is_some() {
                    return Err("--path may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--path requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--path must not be empty".to_string());
                }
                path = Some(value.to_string());
            }
            "--branch" => {
                if branch.is_some() {
                    return Err("--branch may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--branch requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--branch must not be empty".to_string());
                }
                branch = Some(value.to_string());
            }
            "--prompt" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--prompt requires a UTF-8 value".to_string())?;
                prompt = Some(CliPrompt::Value(value.to_string()));
            }
            "--prompt-stdin" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                prompt = Some(CliPrompt::Stdin);
            }
            _ => return Err(format!("unknown session launch argument '{flag}'")),
        }
        index += 1;
    }
    let prompt = prompt.ok_or_else(session_launch_usage)?;
    if worktree && path.is_some() {
        return Err(
            "worktree creates a new worktree; path launches into one that exists. Pass only one."
                .to_string(),
        );
    }
    Ok(SessionControlCliInput::Launch {
        project,
        prompt,
        worktree,
        path,
        branch,
    })
}

fn parse_session_move_cli(args: &[OsString]) -> Result<SessionControlCliInput, String> {
    let mut project = None;
    let mut path = None;
    let mut prompt = None;
    let mut worktree = false;
    let mut keep_source = false;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index]
            .to_str()
            .ok_or_else(|| "arguments must be valid UTF-8".to_string())?;
        match flag {
            "--project" => {
                if project.is_some() {
                    return Err("--project may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--project requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--project must not be empty".to_string());
                }
                project = Some(value.to_string());
            }
            "--path" => {
                if path.is_some() {
                    return Err("--path may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--path requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--path must not be empty".to_string());
                }
                path = Some(value.to_string());
            }
            "--worktree" => {
                if worktree {
                    return Err("--worktree may be provided only once".to_string());
                }
                worktree = true;
            }
            "--keep-source" => {
                if keep_source {
                    return Err("--keep-source may be provided only once".to_string());
                }
                keep_source = true;
            }
            "--prompt" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--prompt requires a UTF-8 value".to_string())?;
                prompt = Some(CliPrompt::Value(value.to_string()));
            }
            "--prompt-stdin" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                prompt = Some(CliPrompt::Stdin);
            }
            _ => return Err(format!("unknown session move argument '{flag}'")),
        }
        index += 1;
    }
    if project.is_some() == path.is_some() {
        return Err("provide exactly one of --project or --path".to_string());
    }
    Ok(SessionControlCliInput::Move {
        project,
        path,
        prompt: prompt.ok_or_else(session_move_usage)?,
        worktree,
        keep_source,
    })
}

fn parse_session_list_cli(args: &[OsString]) -> Result<SessionControlCliInput, String> {
    let mut project = None;
    let mut all = false;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index]
            .to_str()
            .ok_or_else(|| "arguments must be valid UTF-8".to_string())?;
        match flag {
            "--project" => {
                if project.is_some() {
                    return Err("--project may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--project requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--project must not be empty".to_string());
                }
                project = Some(value.to_string());
            }
            "--all" => {
                if all {
                    return Err("--all may be provided only once".to_string());
                }
                all = true;
            }
            _ => return Err(format!("unknown session list argument '{flag}'")),
        }
        index += 1;
    }
    if all && project.is_some() {
        return Err("--all cannot be combined with --project".to_string());
    }
    Ok(SessionControlCliInput::List { project, all })
}

fn parse_session_message_cli(args: &[OsString]) -> Result<SessionControlCliInput, String> {
    let mut session_id = None;
    let mut prompt = None;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index]
            .to_str()
            .ok_or_else(|| "arguments must be valid UTF-8".to_string())?;
        match flag {
            "--session" => {
                if session_id.is_some() {
                    return Err("--session may be provided only once".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--session requires a value".to_string())?;
                if value.is_empty() {
                    return Err("--session must not be empty".to_string());
                }
                session_id = Some(value.to_string());
            }
            "--prompt" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "--prompt requires a UTF-8 value".to_string())?;
                prompt = Some(CliPrompt::Value(value.to_string()));
            }
            "--prompt-stdin" => {
                if prompt.is_some() {
                    return Err("provide exactly one of --prompt or --prompt-stdin".to_string());
                }
                prompt = Some(CliPrompt::Stdin);
            }
            _ => return Err(format!("unknown session message argument '{flag}'")),
        }
        index += 1;
    }
    Ok(SessionControlCliInput::Message {
        session_id: session_id.ok_or_else(session_message_usage)?,
        prompt: prompt.ok_or_else(session_message_usage)?,
    })
}

fn session_launch_usage() -> String {
    "usage: argmax session launch [--project VALUE] [--worktree] [--path VALUE] [--branch VALUE] (--prompt VALUE | --prompt-stdin)"
        .to_string()
}

fn session_move_usage() -> String {
    "usage: argmax session move (--project VALUE | --path VALUE) (--prompt VALUE | --prompt-stdin) [--worktree] [--keep-source]"
        .to_string()
}

fn session_message_usage() -> String {
    "usage: argmax session message --session VALUE (--prompt VALUE | --prompt-stdin)".to_string()
}

fn session_control_usage() -> String {
    "usage: argmax session <launch|move|list|message> [arguments]".to_string()
}

fn run_session_control_cli(input: SessionControlCliInput) -> i32 {
    #[cfg(not(unix))]
    {
        let _ = input;
        eprintln!("argmax: session launching is not supported on this platform");
        return 1;
    }
    #[cfg(unix)]
    {
        match input.into_action().and_then(send_session_control) {
            Ok(response) => {
                println!(
                    "{}",
                    serde_json::to_string(&response)
                        .unwrap_or_else(|_| "{\"ok\":true}".to_string())
                );
                0
            }
            Err(error) => {
                eprintln!("argmax: {}: {}", error.code, error.message);
                1
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_parser_accepts_prompt_value_and_stdin_forms() {
        let args = [
            "argmax",
            "session",
            "launch",
            "--project",
            "Argmax",
            "--worktree",
            "--prompt",
            "Review this",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_session_launch_cli(&args).unwrap(),
            SessionControlCliInput::Launch {
                project: Some("Argmax".to_string()),
                prompt: CliPrompt::Value("Review this".to_string()),
                worktree: true,
                path: None,
                branch: None,
            }
        );

        let stdin_args = ["argmax", "session", "launch", "--prompt-stdin"].map(OsString::from);
        assert_eq!(
            parse_session_launch_cli(&stdin_args).unwrap(),
            SessionControlCliInput::Launch {
                project: None,
                prompt: CliPrompt::Stdin,
                worktree: false,
                path: None,
                branch: None,
            }
        );
    }

    #[test]
    fn cli_parser_takes_a_launch_checkout_path_and_branch() {
        let args = [
            "argmax",
            "session",
            "launch",
            "--path",
            "/repo/worktrees/feature",
            "--branch",
            "feature",
            "--prompt",
            "Review this",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_session_launch_cli(&args).unwrap(),
            SessionControlCliInput::Launch {
                project: None,
                prompt: CliPrompt::Value("Review this".to_string()),
                worktree: false,
                path: Some("/repo/worktrees/feature".to_string()),
                branch: Some("feature".to_string()),
            }
        );

        let both = [
            "argmax",
            "session",
            "launch",
            "--worktree",
            "--path",
            "/repo/worktrees/feature",
            "--prompt",
            "Review this",
        ]
        .map(OsString::from);
        assert!(parse_session_launch_cli(&both).is_err());
    }

    #[test]
    fn cli_parser_takes_a_checkout_path_and_rejects_two_destinations() {
        let args = [
            "argmax",
            "session",
            "move",
            "--path",
            "/repo/worktrees/feature",
            "--prompt",
            "Carry on here",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&args).unwrap(),
            SessionControlCliInput::Move {
                project: None,
                path: Some("/repo/worktrees/feature".to_string()),
                prompt: CliPrompt::Value("Carry on here".to_string()),
                worktree: false,
                keep_source: false,
            }
        );

        // Naming both destinations is a mistake worth reporting: silently
        // preferring one would move the chat somewhere the caller did not ask.
        let both = [
            "argmax",
            "session",
            "move",
            "--project",
            "Other",
            "--path",
            "/repo/worktrees/feature",
            "--prompt",
            "Carry on here",
        ]
        .map(OsString::from);
        assert!(parse_session_control_cli(&both).is_err());
    }

    #[test]
    fn cli_parser_accepts_move_flags_and_requires_project() {
        let args = [
            "argmax",
            "session",
            "move",
            "--project",
            "Other",
            "--prompt",
            "Port the fix here",
            "--worktree",
            "--keep-source",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&args).unwrap(),
            SessionControlCliInput::Move {
                project: Some("Other".to_string()),
                path: None,
                prompt: CliPrompt::Value("Port the fix here".to_string()),
                worktree: true,
                keep_source: true,
            }
        );

        for args in [
            vec!["argmax", "session", "move"],
            // A move without a prompt would land the chat in the destination
            // with nothing to work on.
            vec!["argmax", "session", "move", "--project", "Other"],
            vec![
                "argmax",
                "session",
                "move",
                "--project",
                "Other",
                "--prompt",
                "here",
                "--wat",
            ],
        ] {
            let args = args.into_iter().map(OsString::from).collect::<Vec<_>>();
            assert!(parse_session_control_cli(&args).is_err());
        }
    }

    #[test]
    fn cli_parser_rejects_missing_duplicate_and_unknown_arguments() {
        for args in [
            vec!["argmax", "session", "launch"],
            vec![
                "argmax",
                "session",
                "launch",
                "--prompt",
                "one",
                "--prompt-stdin",
            ],
            vec!["argmax", "session", "launch", "--wat"],
        ] {
            let args = args.into_iter().map(OsString::from).collect::<Vec<_>>();
            assert!(parse_session_launch_cli(&args).is_err());
        }
    }

    #[test]
    fn the_cli_resolves_its_prompt_into_one_wire_action() {
        let action = SessionControlCliInput::Launch {
            project: Some("Argmax".to_string()),
            prompt: CliPrompt::Value("Ship it".to_string()),
            worktree: true,
            path: None,
            branch: None,
        }
        .into_action()
        .expect("action");
        assert_eq!(
            action,
            SessionControlAction::Launch(LaunchAction {
                prompt: "Ship it".to_string(),
                project: Some("Argmax".to_string()),
                worktree: true,
                path: None,
                branch: None,
                provider: None,
                model: None,
                task_label: None,
                reasoning: None,
                permission_mode: None,
            })
        );

        let message = SessionControlCliInput::Message {
            session_id: "abc".to_string(),
            prompt: CliPrompt::Value("Ping".to_string()),
        }
        .into_action()
        .expect("action");
        assert_eq!(
            message,
            SessionControlAction::Message(MessageAction {
                session_id: "abc".to_string(),
                message: "Ping".to_string(),
            })
        );
    }

    #[test]
    fn cli_parser_accepts_list_flags_and_rejects_all_with_project() {
        let args = ["argmax", "session", "list", "--project", "Argmax"].map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&args).unwrap(),
            SessionControlCliInput::List {
                project: Some("Argmax".to_string()),
                all: false,
            }
        );

        let all_args = ["argmax", "session", "list", "--all"].map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&all_args).unwrap(),
            SessionControlCliInput::List {
                project: None,
                all: true,
            }
        );

        let bare_args = ["argmax", "session", "list"].map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&bare_args).unwrap(),
            SessionControlCliInput::List {
                project: None,
                all: false,
            }
        );

        let conflicting =
            ["argmax", "session", "list", "--all", "--project", "Argmax"].map(OsString::from);
        assert!(parse_session_control_cli(&conflicting).is_err());
    }

    #[test]
    fn cli_parser_accepts_message_flags_and_requires_session_and_prompt() {
        let args = [
            "argmax",
            "session",
            "message",
            "--session",
            "abc123",
            "--prompt",
            "Ping",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_session_control_cli(&args).unwrap(),
            SessionControlCliInput::Message {
                session_id: "abc123".to_string(),
                prompt: CliPrompt::Value("Ping".to_string()),
            }
        );

        for args in [
            vec!["argmax", "session", "message", "--prompt", "Ping"],
            vec!["argmax", "session", "message", "--session", "abc123"],
            vec![
                "argmax",
                "session",
                "message",
                "--session",
                "abc123",
                "--prompt",
                "one",
                "--prompt-stdin",
            ],
        ] {
            let args = args.into_iter().map(OsString::from).collect::<Vec<_>>();
            assert!(parse_session_control_cli(&args).is_err());
        }
    }
}
