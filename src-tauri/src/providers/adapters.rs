use super::{AgentMode, PermissionMode, ProviderId, ProviderLaunchInput, ReasoningEffort};

const CLAUDE_BYPASS_PERMISSION_ARGS: &[&str] = &["--permission-mode", "bypassPermissions"];
const CODEX_BYPASS_PERMISSION_ARGS: &[&str] = &["--dangerously-bypass-approvals-and-sandbox"];
const CURSOR_BYPASS_PERMISSION_ARGS: &[&str] = &["--force", "--trust"];

pub const PLAN_MODE_PROMPT_PREFIX: &str =
    "Plan mode: analyze the request and propose a plan only. Do not edit files, run mutating commands, or make changes.";

#[derive(Debug, Clone, Copy)]
pub struct ProviderLaunchDefinition {
    pub id: ProviderId,
    pub display_name: &'static str,
    pub binary_name: &'static str,
    /// Fast, non-interactive subcommand that reports auth/login status. Exit 0
    /// means authenticated. Used by discovery to tell "installed" from "ready".
    pub status_args: &'static [&'static str],
    pub structured_args: fn(&ProviderLaunchInput) -> Vec<String>,
    pub structured_resume_args: fn(&ProviderLaunchInput, &str) -> Vec<String>,
    pub structured_stdin: fn(&ProviderLaunchInput) -> Option<String>,
}

pub fn provider_definitions() -> &'static [ProviderLaunchDefinition] {
    &PROVIDER_DEFINITIONS
}

pub fn get_provider_definition(provider_id: ProviderId) -> &'static ProviderLaunchDefinition {
    provider_definitions()
        .iter()
        .find(|definition| definition.id == provider_id)
        .expect("all ProviderId variants have a launch definition")
}

static PROVIDER_DEFINITIONS: [ProviderLaunchDefinition; 3] = [
    ProviderLaunchDefinition {
        id: ProviderId::Claude,
        display_name: "Claude Code",
        binary_name: "claude",
        status_args: &["auth", "status"],
        structured_args: claude_structured_args,
        structured_resume_args: claude_structured_resume_args,
        structured_stdin: |_| None,
    },
    ProviderLaunchDefinition {
        id: ProviderId::Codex,
        display_name: "Codex",
        binary_name: "codex",
        status_args: &["login", "status"],
        structured_args: codex_structured_args,
        structured_resume_args: codex_structured_resume_args,
        structured_stdin: codex_structured_stdin,
    },
    ProviderLaunchDefinition {
        id: ProviderId::Cursor,
        display_name: "Cursor",
        binary_name: "cursor-agent",
        status_args: &["status"],
        structured_args: cursor_structured_args,
        structured_resume_args: cursor_structured_resume_args,
        structured_stdin: |_| None,
    },
];

fn claude_structured_args(input: &ProviderLaunchInput) -> Vec<String> {
    let mut args = vec!["-p".to_string()];
    args.extend(claude_permission_args(input));
    args.extend(claude_reasoning_args(input));
    args.extend(claude_fast_mode_args(input));
    args.extend([
        "--model".to_string(),
        input.model_id.clone(),
        "--session-id".to_string(),
        input.session_id.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        // Stream partial content blocks so the answer and extended-thinking
        // arrive token-by-token (content_block_delta) instead of as whole
        // assistant messages. See docs/runtime.md "Event delivery".
        "--include-partial-messages".to_string(),
        "--".to_string(),
        input.prompt.clone(),
    ]);
    args
}

fn claude_structured_resume_args(
    input: &ProviderLaunchInput,
    resume_conversation_id: &str,
) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--resume".to_string(),
        resume_conversation_id.to_string(),
    ];
    args.extend(claude_permission_args(input));
    args.extend(claude_reasoning_args(input));
    args.extend(claude_fast_mode_args(input));
    args.extend([
        "--model".to_string(),
        input.model_id.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        // Keep partial-message streaming on for resumed turns too — otherwise
        // follow-ups regress to whole-message (non-streaming) output.
        "--include-partial-messages".to_string(),
        "--".to_string(),
        input.prompt.clone(),
    ]);
    args
}

fn codex_structured_args(input: &ProviderLaunchInput) -> Vec<String> {
    let mut args = vec!["exec".to_string(), "--json".to_string()];
    args.extend(codex_permission_args(input));
    args.extend(["--model".to_string(), input.model_id.clone()]);
    args.extend(codex_reasoning_summary_args(input));
    args.extend(codex_reasoning_args(input, true));
    args.extend(codex_fast_mode_args(input));
    args.push("-".to_string());
    args
}

fn codex_structured_resume_args(
    input: &ProviderLaunchInput,
    resume_conversation_id: &str,
) -> Vec<String> {
    let mut args = vec![
        "exec".to_string(),
        "resume".to_string(),
        "--json".to_string(),
    ];
    args.extend(codex_permission_args(input));
    args.extend(["--model".to_string(), input.model_id.clone()]);
    args.extend(codex_reasoning_summary_args(input));
    args.extend(codex_reasoning_args(input, true));
    args.extend(codex_fast_mode_args(input));
    args.extend([resume_conversation_id.to_string(), "-".to_string()]);
    args
}

fn codex_structured_stdin(input: &ProviderLaunchInput) -> Option<String> {
    Some(prompt_for_agent_mode(&input.prompt, input.agent_mode))
}

// Cursor's CLI has no separate reasoning-effort or fast-mode flag, so both are
// intentionally ignored here. The renderer hides Speed for Cursor models, and
// this keeps stale persisted fast-mode state from changing the model id.
fn cursor_structured_args(input: &ProviderLaunchInput) -> Vec<String> {
    let mut args = vec![
        "agent".to_string(),
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--stream-partial-output".to_string(),
    ];
    args.extend(cursor_agent_mode_args(input));
    args.extend(cursor_permission_args(input));
    args.extend([
        "--model".to_string(),
        input.model_id.clone(),
        "--".to_string(),
        input.prompt.clone(),
    ]);
    args
}

fn cursor_structured_resume_args(
    input: &ProviderLaunchInput,
    resume_conversation_id: &str,
) -> Vec<String> {
    let mut args = vec![
        "agent".to_string(),
        "-p".to_string(),
        "--resume".to_string(),
        resume_conversation_id.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--stream-partial-output".to_string(),
    ];
    args.extend(cursor_agent_mode_args(input));
    args.extend(cursor_permission_args(input));
    args.extend([
        "--model".to_string(),
        input.model_id.clone(),
        "--".to_string(),
        input.prompt.clone(),
    ]);
    args
}

fn claude_permission_args(input: &ProviderLaunchInput) -> Vec<String> {
    if input.agent_mode == AgentMode::Plan {
        return vec!["--permission-mode".to_string(), "plan".to_string()];
    }
    if input.permission_mode == PermissionMode::AutoApprove {
        owned(CLAUDE_BYPASS_PERMISSION_ARGS)
    } else {
        Vec::new()
    }
}

fn codex_permission_args(input: &ProviderLaunchInput) -> Vec<String> {
    // Plan mode is read-only planning (conveyed to Codex via the prompt prefix);
    // never hand it the approvals/sandbox bypass, the same way Claude doesn't.
    if input.agent_mode == AgentMode::Plan {
        return Vec::new();
    }
    if input.permission_mode == PermissionMode::AutoApprove {
        owned(CODEX_BYPASS_PERMISSION_ARGS)
    } else {
        Vec::new()
    }
}

fn cursor_permission_args(input: &ProviderLaunchInput) -> Vec<String> {
    // Plan mode (the `--plan` flag) is read-only; don't also pass --force/--trust.
    if input.agent_mode == AgentMode::Plan {
        return Vec::new();
    }
    if input.permission_mode == PermissionMode::AutoApprove {
        owned(CURSOR_BYPASS_PERMISSION_ARGS)
    } else {
        Vec::new()
    }
}

fn cursor_agent_mode_args(input: &ProviderLaunchInput) -> Vec<String> {
    if input.agent_mode == AgentMode::Plan {
        vec!["--plan".to_string()]
    } else {
        Vec::new()
    }
}

fn claude_reasoning_args(input: &ProviderLaunchInput) -> Vec<String> {
    let Some(reasoning_effort) = input.reasoning_effort else {
        return Vec::new();
    };
    let prompt = match reasoning_effort {
        ReasoningEffort::Low => "Reason step by step through this task before acting.",
        ReasoningEffort::Medium => {
            "Reason carefully through this task. Consider edge cases and trade-offs before acting."
        }
        ReasoningEffort::High => {
            "Reason deeply through this task. Explore alternatives, consider edge cases, and weigh trade-offs before acting."
        }
        ReasoningEffort::Xhigh => {
            "Reason exhaustively through this task. Enumerate every alternative, edge case, and trade-off, and verify your conclusions before acting. Take as much thinking as the problem demands."
        }
    };
    vec!["--append-system-prompt".to_string(), prompt.to_string()]
}

fn claude_fast_mode_args(input: &ProviderLaunchInput) -> Vec<String> {
    vec![
        "--settings".to_string(),
        format!(r#"{{"fastMode":{}}}"#, input.fast_mode),
    ]
}

// Codex "fast mode" is the priority service tier (1.5× speed), set as a TOML
// config override like the reasoning effort above — the value needs quotes to
// parse as a TOML string. Omitted when off so the account default applies.
fn codex_fast_mode_args(input: &ProviderLaunchInput) -> Vec<String> {
    if input.fast_mode {
        vec!["-c".to_string(), r#"service_tier="priority""#.to_string()]
    } else {
        Vec::new()
    }
}

fn codex_reasoning_args(input: &ProviderLaunchInput, structured: bool) -> Vec<String> {
    let Some(reasoning_effort) = input.reasoning_effort else {
        return if structured {
            vec!["--ignore-user-config".to_string()]
        } else {
            Vec::new()
        };
    };

    vec![
        "-c".to_string(),
        format!("model_reasoning_effort=\"{}\"", reasoning_effort.as_str()),
    ]
}

fn codex_reasoning_summary_args(_input: &ProviderLaunchInput) -> Vec<String> {
    vec![
        "-c".to_string(),
        r#"model_reasoning_summary="auto""#.to_string(),
    ]
}

pub(super) fn prompt_for_agent_mode(prompt: &str, agent_mode: AgentMode) -> String {
    if agent_mode == AgentMode::Plan {
        format!("{PLAN_MODE_PROMPT_PREFIX}\n\n{prompt}")
    } else {
        prompt.to_string()
    }
}

fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_string()).collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::providers::ProviderMode;

    #[test]
    fn claude_structured_args_match_main_stream_json() {
        let input = launch_input(ProviderId::Claude);
        let definition = get_provider_definition(ProviderId::Claude);

        assert_eq!(
            (definition.structured_args)(&input),
            vec![
                "-p",
                "--permission-mode",
                "bypassPermissions",
                "--settings",
                r#"{"fastMode":false}"#,
                "--model",
                "haiku",
                "--session-id",
                "session-1",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--",
                "Implement the task",
            ]
        );
        assert_eq!((definition.structured_stdin)(&input), None);
    }

    #[test]
    fn claude_resume_args_keep_partial_message_streaming() {
        let input = launch_input(ProviderId::Claude);
        let definition = get_provider_definition(ProviderId::Claude);

        assert_eq!(
            (definition.structured_resume_args)(&input, "conv-7"),
            vec![
                "-p",
                "--resume",
                "conv-7",
                "--permission-mode",
                "bypassPermissions",
                "--settings",
                r#"{"fastMode":false}"#,
                "--model",
                "haiku",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--",
                "Implement the task",
            ]
        );
    }

    #[test]
    fn claude_plan_mode_uses_plan_permission() {
        let input = ProviderLaunchInput {
            agent_mode: AgentMode::Plan,
            ..launch_input(ProviderId::Claude)
        };
        let args = (get_provider_definition(ProviderId::Claude).structured_args)(&input);
        assert!(args
            .windows(2)
            .any(|window| window == ["--permission-mode", "plan"]));
        assert!(!args.iter().any(|arg| arg == "bypassPermissions"));
    }

    #[test]
    fn claude_reasoning_prompt_is_carried_by_append_system_prompt() {
        let input = ProviderLaunchInput {
            reasoning_effort: Some(ReasoningEffort::High),
            ..launch_input(ProviderId::Claude)
        };
        let args = (get_provider_definition(ProviderId::Claude).structured_args)(&input);
        let index = args
            .iter()
            .position(|arg| arg == "--append-system-prompt")
            .expect("append system prompt flag");
        assert!(args[index + 1].contains("Reason deeply"));
    }

    #[test]
    fn claude_fast_mode_is_carried_by_settings_json() {
        let input = ProviderLaunchInput {
            fast_mode: true,
            ..launch_input(ProviderId::Claude)
        };
        let args = (get_provider_definition(ProviderId::Claude).structured_args)(&input);
        let index = args
            .iter()
            .position(|arg| arg == "--settings")
            .expect("settings flag");
        assert_eq!(args[index + 1], r#"{"fastMode":true}"#);
    }

    #[test]
    fn codex_structured_args_match_runtime_contract() {
        let input = launch_input(ProviderId::Codex);
        let definition = get_provider_definition(ProviderId::Codex);

        assert_eq!(
            (definition.structured_args)(&input),
            vec![
                "exec",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-5.5",
                "-c",
                "model_reasoning_summary=\"auto\"",
                "-c",
                "model_reasoning_effort=\"low\"",
                "-",
            ]
        );
        assert_eq!(
            (definition.structured_stdin)(&input),
            Some("Implement the task".to_string())
        );
    }

    #[test]
    fn codex_structured_without_reasoning_ignores_user_config() {
        let input = ProviderLaunchInput {
            reasoning_effort: None,
            ..launch_input(ProviderId::Codex)
        };
        let args = (get_provider_definition(ProviderId::Codex).structured_args)(&input);
        assert!(args.iter().any(|arg| arg == "--ignore-user-config"));
    }

    #[test]
    fn codex_fast_mode_is_carried_by_service_tier_override() {
        let input = ProviderLaunchInput {
            fast_mode: true,
            ..launch_input(ProviderId::Codex)
        };
        let args = (get_provider_definition(ProviderId::Codex).structured_args)(&input);
        assert!(args
            .windows(2)
            .any(|window| window == ["-c", r#"service_tier="priority""#]));

        let resume_args =
            (get_provider_definition(ProviderId::Codex).structured_resume_args)(&input, "thread-1");
        assert!(resume_args
            .windows(2)
            .any(|window| window == ["-c", r#"service_tier="priority""#]));

        let off = launch_input(ProviderId::Codex);
        let off_args = (get_provider_definition(ProviderId::Codex).structured_args)(&off);
        assert!(!off_args.iter().any(|arg| arg.starts_with("service_tier")));
    }

    #[test]
    fn codex_plan_mode_prefixes_stdin_prompt() {
        let input = ProviderLaunchInput {
            agent_mode: AgentMode::Plan,
            ..launch_input(ProviderId::Codex)
        };
        let stdin =
            (get_provider_definition(ProviderId::Codex).structured_stdin)(&input).expect("stdin");
        assert!(stdin.contains("Plan mode:"));
        assert!(stdin.contains("Implement the task"));
    }

    #[test]
    fn codex_resume_args_match_runtime_contract() {
        let input = launch_input(ProviderId::Codex);
        let definition = get_provider_definition(ProviderId::Codex);

        assert_eq!(
            (definition.structured_resume_args)(&input, "thread-1"),
            vec![
                "exec",
                "resume",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-5.5",
                "-c",
                "model_reasoning_summary=\"auto\"",
                "-c",
                "model_reasoning_effort=\"low\"",
                "thread-1",
                "-",
            ]
        );
    }

    #[test]
    fn cursor_structured_args_match_runtime_contract() {
        let input = launch_input(ProviderId::Cursor);
        let definition = get_provider_definition(ProviderId::Cursor);

        assert_eq!(
            (definition.structured_args)(&input),
            vec![
                "agent",
                "-p",
                "--output-format",
                "stream-json",
                "--stream-partial-output",
                "--force",
                "--trust",
                "--model",
                "composer-2.5",
                "--",
                "Implement the task",
            ]
        );
        assert_eq!((definition.structured_stdin)(&input), None);
    }

    #[test]
    fn cursor_plan_mode_adds_plan_flag() {
        let input = ProviderLaunchInput {
            agent_mode: AgentMode::Plan,
            ..launch_input(ProviderId::Cursor)
        };
        let args = (get_provider_definition(ProviderId::Cursor).structured_args)(&input);
        assert!(args.iter().any(|arg| arg == "--plan"));
    }

    #[test]
    fn cursor_fast_mode_does_not_change_model_id() {
        let input = ProviderLaunchInput {
            model_id: "claude-opus-4-8[context=1m,fast=false,effort=high]".to_string(),
            fast_mode: true,
            ..launch_input(ProviderId::Cursor)
        };
        let args = (get_provider_definition(ProviderId::Cursor).structured_args)(&input);
        let index = args
            .iter()
            .position(|arg| arg == "--model")
            .expect("model flag");
        assert_eq!(args[index + 1], "claude-opus-4-8[context=1m,fast=false,effort=high]");
    }

    #[test]
    fn multiline_and_dash_prefixed_prompts_are_kept_safe() {
        for provider_id in [ProviderId::Claude, ProviderId::Codex, ProviderId::Cursor] {
            let input = ProviderLaunchInput {
                prompt: "- read this\nthen implement".to_string(),
                ..launch_input(provider_id)
            };
            let definition = get_provider_definition(provider_id);
            let args = (definition.structured_args)(&input);
            match provider_id {
                ProviderId::Codex => {
                    assert!(!args.contains(&input.prompt));
                    assert_eq!(
                        (definition.structured_stdin)(&input),
                        Some("- read this\nthen implement".to_string())
                    );
                }
                ProviderId::Claude | ProviderId::Cursor => {
                    let prompt_index = args
                        .iter()
                        .position(|arg| arg == &input.prompt)
                        .expect("prompt carried as argv");
                    assert_eq!(args[prompt_index - 1], "--");
                }
            }
        }
    }

    #[test]
    fn ask_each_time_drops_provider_bypass_flags() {
        for provider_id in [ProviderId::Claude, ProviderId::Codex, ProviderId::Cursor] {
            let input = ProviderLaunchInput {
                permission_mode: PermissionMode::AskEachTime,
                ..launch_input(provider_id)
            };
            let args = (get_provider_definition(provider_id).structured_args)(&input);
            assert!(!args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "bypassPermissions"
                        | "--dangerously-bypass-approvals-and-sandbox"
                        | "--force"
                        | "--trust"
                )
            }));
        }
    }

    #[test]
    fn plan_mode_never_bypasses_for_any_provider() {
        // Plan mode is read-only; no provider should receive an approvals/sandbox
        // bypass flag even when permission mode is AutoApprove.
        for provider_id in [ProviderId::Claude, ProviderId::Codex, ProviderId::Cursor] {
            let input = ProviderLaunchInput {
                permission_mode: PermissionMode::AutoApprove,
                agent_mode: AgentMode::Plan,
                ..launch_input(provider_id)
            };
            let args = (get_provider_definition(provider_id).structured_args)(&input);
            assert!(
                !args.iter().any(|arg| {
                    matches!(
                        arg.as_str(),
                        "bypassPermissions"
                            | "--dangerously-bypass-approvals-and-sandbox"
                            | "--force"
                            | "--trust"
                    )
                }),
                "{provider_id:?} leaked a bypass flag in plan mode: {args:?}"
            );
        }
    }

    fn launch_input(provider_id: ProviderId) -> ProviderLaunchInput {
        let (model_label, model_id, reasoning_effort, mode) = match provider_id {
            ProviderId::Claude => ("Claude Haiku", "haiku", None, ProviderMode::StructuredJson),
            ProviderId::Codex => (
                "GPT-5.5 Low",
                "gpt-5.5",
                Some(ReasoningEffort::Low),
                ProviderMode::StructuredJson,
            ),
            ProviderId::Cursor => (
                "Composer 2.5 (Cursor)",
                "composer-2.5",
                None,
                ProviderMode::StructuredJson,
            ),
        };

        ProviderLaunchInput {
            provider: provider_id,
            session_id: "session-1".to_string(),
            workspace_path: PathBuf::from("/repo/worktree"),
            prompt: "Implement the task".to_string(),
            model_label: model_label.to_string(),
            model_id: model_id.to_string(),
            reasoning_effort,
            fast_mode: false,
            resume_conversation_id: None,
            mode,
            permission_mode: PermissionMode::AutoApprove,
            agent_mode: AgentMode::Auto,
            cols: 100,
            rows: 30,
        }
    }
}
