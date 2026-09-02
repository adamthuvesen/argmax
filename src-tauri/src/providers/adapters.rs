use super::{
    mcp_injection, AgentMode, ApprovalSupport, PermissionMode, ProviderId, ProviderLaunchInput,
    ReasoningEffort,
};
use crate::session_control::SessionLaunchProcessConfig;

const CLAUDE_BYPASS_PERMISSION_ARGS: &[&str] = &["--permission-mode", "bypassPermissions"];
const CODEX_BYPASS_PERMISSION_ARGS: &[&str] = &["--dangerously-bypass-approvals-and-sandbox"];
const CURSOR_BYPASS_PERMISSION_ARGS: &[&str] = &["--force", "--trust"];
const OPENCODE_BYPASS_PERMISSION_ARGS: &[&str] = &["--auto"];
const GROK_BYPASS_PERMISSION_ARGS: &[&str] = &["--always-approve"];

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
    pub structured_args:
        fn(&ProviderLaunchInput, Option<&SessionLaunchProcessConfig>) -> Vec<String>,
    pub structured_resume_args:
        fn(&ProviderLaunchInput, &str, Option<&SessionLaunchProcessConfig>) -> Vec<String>,
    pub structured_stdin: fn(&ProviderLaunchInput) -> Option<String>,
    pub approval_support: ApprovalSupport,
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

static PROVIDER_DEFINITIONS: [ProviderLaunchDefinition; 5] = [
    ProviderLaunchDefinition {
        id: ProviderId::Claude,
        display_name: "Claude Code",
        binary_name: "claude",
        status_args: &["auth", "status"],
        structured_args: claude_structured_args,
        structured_resume_args: claude_structured_resume_args,
        structured_stdin: |_| None,
        approval_support: ApprovalSupport::ObservableOnly,
    },
    ProviderLaunchDefinition {
        id: ProviderId::Codex,
        display_name: "Codex",
        binary_name: "codex",
        status_args: &["login", "status"],
        structured_args: codex_structured_args,
        structured_resume_args: codex_structured_resume_args,
        structured_stdin: codex_structured_stdin,
        approval_support: ApprovalSupport::ObservableOnly,
    },
    ProviderLaunchDefinition {
        id: ProviderId::Cursor,
        display_name: "Cursor",
        binary_name: "cursor-agent",
        status_args: &["status"],
        structured_args: cursor_structured_args,
        structured_resume_args: cursor_structured_resume_args,
        structured_stdin: |_| None,
        approval_support: ApprovalSupport::Unsupported,
    },
    ProviderLaunchDefinition {
        id: ProviderId::Opencode,
        display_name: "OpenCode",
        binary_name: "opencode",
        status_args: &["providers", "list"],
        structured_args: opencode_structured_args,
        structured_resume_args: opencode_structured_resume_args,
        structured_stdin: |_| None,
        approval_support: ApprovalSupport::Unsupported,
    },
    ProviderLaunchDefinition {
        id: ProviderId::Grok,
        display_name: "Grok Build",
        binary_name: "grok",
        // `models` exits 0 only once the CLI has credentials; it prints the
        // logged-in account on the first line.
        status_args: &["models"],
        structured_args: grok_structured_args,
        structured_resume_args: grok_structured_resume_args,
        structured_stdin: |_| None,
        approval_support: ApprovalSupport::ObservableOnly,
    },
];

fn claude_structured_args(
    input: &ProviderLaunchInput,
    mcp: Option<&SessionLaunchProcessConfig>,
) -> Vec<String> {
    let mut args = vec!["-p".to_string(), "--brief".to_string()];
    args.extend(claude_permission_args(input));
    args.extend(claude_reasoning_args(input));
    args.extend(claude_fast_mode_args(input));
    args.extend(mcp_injection::mcp_args(ProviderId::Claude, mcp));
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
        // Without this the CLI forwards a subagent's tool calls but not its
        // text or thinking, so a subagent that only writes (a report, a
        // review) leaves the Agents pane empty until its result lands.
        // Needs Claude Code 2.1.258 or newer.
        "--forward-subagent-text".to_string(),
        "--".to_string(),
        input.prompt.clone(),
    ]);
    args
}

fn claude_structured_resume_args(
    input: &ProviderLaunchInput,
    resume_conversation_id: &str,
    mcp: Option<&SessionLaunchProcessConfig>,
) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--brief".to_string(),
        "--resume".to_string(),
        resume_conversation_id.to_string(),
    ];
    // A forked session's first resume diverges into a new CLI session instead
    // of appending turns to the conversation it was copied from.
    if input.resume_fork {
        args.push("--fork-session".to_string());
    }
    args.extend(claude_permission_args(input));
    args.extend(claude_reasoning_args(input));
    args.extend(claude_fast_mode_args(input));
    args.extend(mcp_injection::mcp_args(ProviderId::Claude, mcp));
    args.extend([
        "--model".to_string(),
        input.model_id.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        // Keep partial-message streaming on for resumed turns too — otherwise
        // follow-ups regress to whole-message (non-streaming) output.
        "--include-partial-messages".to_string(),
        "--forward-subagent-text".to_string(),
        "--".to_string(),
        input.prompt.clone(),
    ]);
    args
}

fn codex_structured_args(
    input: &ProviderLaunchInput,
    mcp: Option<&SessionLaunchProcessConfig>,
) -> Vec<String> {
    let mut args = vec!["exec".to_string(), "--json".to_string()];
    args.extend(codex_permission_args(input));
    args.extend(["--model".to_string(), input.model_id.clone()]);
    args.extend(codex_reasoning_summary_args(input));
    args.extend(codex_reasoning_args(input));
    args.extend(codex_fast_mode_args(input));
    args.extend(mcp_injection::mcp_args(ProviderId::Codex, mcp));
    args.push("-".to_string());
    args
}

fn codex_structured_resume_args(
    input: &ProviderLaunchInput,
    resume_conversation_id: &str,
    mcp: Option<&SessionLaunchProcessConfig>,
) -> Vec<String> {
    // A forked session's first resume diverges into a new CLI session
    // (`exec fork`) instead of appending turns to the conversation it was
    // copied from. Same positional shape as `exec resume`: flags, then the
    // session id, then `-` for the stdin prompt.
    let subcommand = if input.resume_fork { "fork" } else { "resume" };
    let mut args = vec![
        "exec".to_string(),
        subcommand.to_string(),
        "--json".to_string(),
    ];
    args.extend(codex_permission_args(input));
    args.extend(["--model".to_string(), input.model_id.clone()]);
    args.extend(codex_reasoning_summary_args(input));
    args.extend(codex_reasoning_args(input));
    args.extend(codex_fast_mode_args(input));
    args.extend(mcp_injection::mcp_args(ProviderId::Codex, mcp));
    args.extend([resume_conversation_id.to_string(), "-".to_string()]);
    args
}

fn codex_structured_stdin(input: &ProviderLaunchInput) -> Option<String> {
    Some(prompt_for_agent_mode(&input.prompt, input.agent_mode))
}

// Cursor exposes both reasoning effort and fast serving as distinct model ids
// rather than flags, so both are folded into the --model value by
// cursor_model_for.
fn cursor_structured_args(
    input: &ProviderLaunchInput,
    mcp: Option<&SessionLaunchProcessConfig>,
) -> Vec<String> {
    let mut args = vec![
        "agent".to_string(),
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--stream-partial-output".to_string(),
    ];
    args.extend(cursor_agent_mode_args(input));
    args.extend(cursor_permission_args(input));
    args.extend(mcp_injection::mcp_args(ProviderId::Cursor, mcp));
    args.extend([
        "--model".to_string(),
        cursor_model_for(&input.model_id, input.reasoning_effort, input.fast_mode),
        "--".to_string(),
        input.prompt.clone(),
    ]);
    args
}

// Cursor picks reasoning effort and fast serving through the model id (e.g.
// gpt-5.6-sol-high, claude-opus-5-thinking-xhigh-fast). Effort: GPT-5.6
// Luna/Terra/Sol and Opus 5 Thinking are parameterized up to Max; Grok 4.6 and
// Gemini 3.8 Flash stop at High. Composer has no effort variant and passes
// through. Fast: append "-fast" after the effort suffix for every model that
// has a fast variant — all but Gemini 3.8 Flash. The renderer only enables the
// Speed toggle for those, so this mirrors it.
//
// Match the picker's exact base ids (see PROVIDER_MODELS in providerModels.ts,
// and the spellings from `cursor-agent --list-models`) rather than a prefix, so
// a future non-parameterized `gpt-5.6-*`/`claude-opus-5-*` model passes
// through untouched instead of being silently rewritten to a different model.
fn cursor_model_for(
    model_id: &str,
    reasoning_effort: Option<ReasoningEffort>,
    fast_mode: bool,
) -> String {
    let with_effort = match (model_id, reasoning_effort) {
        (
            "gpt-5.6-luna-medium"
            | "gpt-5.6-terra-medium"
            | "gpt-5.6-sol-medium"
            | "claude-opus-5-thinking-medium",
            Some(effort),
        ) => {
            let family = model_id.trim_end_matches("-medium");
            format!("{family}-{}", effort_suffix(effort))
        }
        (
            "cursor-grok-4.6-medium" | "cursor-grok-4.5-medium" | "gemini-3.8-flash-medium",
            Some(effort),
        ) => {
            let family = model_id.trim_end_matches("-medium");
            format!("{family}-{}", effort_suffix_capped_at_high(effort))
        }
        _ => model_id.to_string(),
    };
    if fast_mode && !model_id.starts_with("gemini-3.8-flash") {
        format!("{with_effort}-fast")
    } else {
        with_effort
    }
}

fn effort_suffix(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
        ReasoningEffort::Max | ReasoningEffort::Ultra => "max",
    }
}

fn effort_suffix_capped_at_high(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High
        | ReasoningEffort::Xhigh
        | ReasoningEffort::Max
        | ReasoningEffort::Ultra => "high",
    }
}

fn cursor_structured_resume_args(
    input: &ProviderLaunchInput,
    resume_conversation_id: &str,
    mcp: Option<&SessionLaunchProcessConfig>,
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
    args.extend(mcp_injection::mcp_args(ProviderId::Cursor, mcp));
    args.extend([
        "--model".to_string(),
        cursor_model_for(&input.model_id, input.reasoning_effort, input.fast_mode),
        "--".to_string(),
        input.prompt.clone(),
    ]);
    args
}

// OpenCode's `run --format json` streams typed part events (step_start, text,
// reasoning, tool_use, step_finish, error) and exits when the turn ends.
// `--thinking` surfaces reasoning parts for models that emit them. Some
// opencode-go models expose reasoning-effort `--variant` (low/high/max),
// folded in by opencode_variant_args. Fast mode has no CLI surface.
fn opencode_structured_args(
    input: &ProviderLaunchInput,
    _mcp: Option<&SessionLaunchProcessConfig>,
) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        // The session executes inside opencode's daemonized server, whose own
        // cwd is `/` — the client's current_dir never reaches it. `--dir` is
        // the only way to pin the session to the workspace checkout.
        "--dir".to_string(),
        input.workspace_path.to_string_lossy().into_owned(),
        "--format".to_string(),
        "json".to_string(),
        "--thinking".to_string(),
    ];
    args.extend(opencode_agent_mode_args(input));
    args.extend(opencode_permission_args(input));
    args.extend(opencode_variant_args(
        &input.model_id,
        input.reasoning_effort,
    ));
    args.extend([
        "-m".to_string(),
        input.model_id.clone(),
        "--".to_string(),
        input.prompt.clone(),
    ]);
    args
}

fn opencode_structured_resume_args(
    input: &ProviderLaunchInput,
    resume_conversation_id: &str,
    _mcp: Option<&SessionLaunchProcessConfig>,
) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        // Same server-side cwd pin as the fresh launch above.
        "--dir".to_string(),
        input.workspace_path.to_string_lossy().into_owned(),
        "--format".to_string(),
        "json".to_string(),
        "--thinking".to_string(),
        "-s".to_string(),
        resume_conversation_id.to_string(),
    ];
    // Fork-on-resume: `--fork` copies the session server-side before the
    // message lands, so the original conversation stays untouched.
    if input.resume_fork {
        args.push("--fork".to_string());
    }
    args.extend(opencode_agent_mode_args(input));
    args.extend(opencode_permission_args(input));
    args.extend(opencode_variant_args(
        &input.model_id,
        input.reasoning_effort,
    ));
    args.extend([
        "-m".to_string(),
        input.model_id.clone(),
        "--".to_string(),
        input.prompt.clone(),
    ]);
    args
}

// Reasoning-effort `--variant` for opencode-go models. Mirrors the variant map
// in reasoningEffortsForModel (providerModels.ts). Clamps unsupported efforts
// DOWN to the highest supported ≤ incoming; falls back to the lowest supported.
fn opencode_variant_args(model_id: &str, effort: Option<ReasoningEffort>) -> Vec<String> {
    let effort = match effort {
        Some(e) => e,
        None => return Vec::new(),
    };
    let supported = match model_id {
        "opencode-go/glm-5.3-flash" | "opencode-go/glm-5.3" | "opencode-go/deepseek-v4-flash" => &[
            ReasoningEffort::Low,
            ReasoningEffort::High,
            ReasoningEffort::Max,
        ][..],
        "opencode-go/qwen3.8-flash" | "opencode-go/deepseek-v4-pro" => {
            &[ReasoningEffort::High, ReasoningEffort::Max][..]
        }
        "opencode-go/kimi-k3" => &[ReasoningEffort::Max][..],
        _ => return Vec::new(),
    };
    if supported.contains(&effort) {
        return vec!["--variant".to_string(), effort.as_str().to_string()];
    }
    // Clamp down: highest supported whose rank ≤ incoming, else lowest.
    let incoming_rank = effort as u8;
    if let Some(&best) = supported.iter().rfind(|e| (**e as u8) <= incoming_rank) {
        vec!["--variant".to_string(), best.as_str().to_string()]
    } else {
        vec!["--variant".to_string(), supported[0].as_str().to_string()]
    }
}

// Grok Build's headless mode (`-p`) emits the same stream-json envelopes as
// Claude Code — `system/init`, Anthropic `stream_event` content blocks, a final
// `assistant` message, and a `result` line — so it reuses Claude's normalizer
// path rather than getting one of its own. `--cwd` is passed explicitly: with
// `[cli] use_leader` enabled the turn runs inside a shared leader process whose
// own cwd is not this child's, the same trap OpenCode's `--dir` covers.
fn grok_structured_args(
    input: &ProviderLaunchInput,
    _mcp: Option<&SessionLaunchProcessConfig>,
) -> Vec<String> {
    let mut args = vec![
        grok_prompt_arg(&input.prompt),
        "--cwd".to_string(),
        input.workspace_path.to_string_lossy().into_owned(),
        "--session-id".to_string(),
        input.session_id.clone(),
    ];
    args.extend(grok_common_args(input));
    args
}

fn grok_structured_resume_args(
    input: &ProviderLaunchInput,
    resume_conversation_id: &str,
    _mcp: Option<&SessionLaunchProcessConfig>,
) -> Vec<String> {
    let mut args = vec![
        grok_prompt_arg(&input.prompt),
        "--cwd".to_string(),
        input.workspace_path.to_string_lossy().into_owned(),
        "--resume".to_string(),
        resume_conversation_id.to_string(),
    ];
    // Diverge instead of appending. The CLI mints a fresh id for the fork,
    // which the normalizer captures off `system/init` — so no `--session-id`
    // here (the CLI rejects it without `--fork-session`, and naming it
    // ourselves would fight the id we then read back).
    if input.resume_fork {
        args.push("--fork-session".to_string());
    }
    args.extend(grok_common_args(input));
    args
}

// Flags shared by the fresh and resumed launches, in one place so a resumed
// turn can never quietly drop partial-message streaming or the model.
fn grok_common_args(input: &ProviderLaunchInput) -> Vec<String> {
    let mut args = vec![
        "--output-format".to_string(),
        "streaming-messages-json".to_string(),
        // Without this the turn arrives as whole assistant messages instead of
        // token-by-token `content_block_delta`s. Same contract as Claude's
        // --include-partial-messages.
        "--include-partial-messages".to_string(),
    ];
    args.extend(grok_agent_mode_args(input));
    args.extend(grok_permission_args(input));
    args.extend(grok_reasoning_args(input));
    args.extend(["--model".to_string(), input.model_id.clone()]);
    args
}

// Grok's headless prompt is a FLAG VALUE (`-p/--single <PROMPT>`), not the
// trailing positional Claude and Cursor take. Passed as two argv entries the
// CLI rejects any prompt starting with `-` outright ("Usage: grok ..."), which
// a pasted diff or a "- do this" bullet list trips immediately. The `--flag=value`
// form is the one clap always reads as a value, whatever it starts with.
fn grok_prompt_arg(prompt: &str) -> String {
    format!("--single={prompt}")
}

// Grok ships a bundled read-only `plan` agent (permission_mode: plan, no edit
// tools), so plan mode maps to it natively instead of a prompt prefix.
fn grok_agent_mode_args(input: &ProviderLaunchInput) -> Vec<String> {
    if input.agent_mode == AgentMode::Plan {
        vec!["--agent".to_string(), "plan".to_string()]
    } else {
        Vec::new()
    }
}

fn grok_permission_args(input: &ProviderLaunchInput) -> Vec<String> {
    // Plan mode rides the read-only plan agent; never stack the bypass on it.
    if input.agent_mode == AgentMode::Plan {
        return Vec::new();
    }
    if input.permission_mode == PermissionMode::AutoApprove {
        owned(GROK_BYPASS_PERMISSION_ARGS)
    } else {
        Vec::new()
    }
}

// `--reasoning-effort` tops out at xhigh: the CLI rejects anything else with
// "unknown effort level ...; use one of: xhigh, high, medium, low". Clamp Max
// and Ultra down rather than letting a provider switch or resume fail the
// launch outright.
fn grok_reasoning_args(input: &ProviderLaunchInput) -> Vec<String> {
    let Some(reasoning_effort) = input.reasoning_effort else {
        return Vec::new();
    };
    let effort = match reasoning_effort {
        ReasoningEffort::Max | ReasoningEffort::Ultra => "xhigh",
        other => other.as_str(),
    };
    vec!["--reasoning-effort".to_string(), effort.to_string()]
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

// OpenCode's built-in `plan` agent is read-only (edits denied), so plan mode
// maps to it natively instead of a prompt prefix.
fn opencode_agent_mode_args(input: &ProviderLaunchInput) -> Vec<String> {
    if input.agent_mode == AgentMode::Plan {
        vec!["--agent".to_string(), "plan".to_string()]
    } else {
        Vec::new()
    }
}

fn opencode_permission_args(input: &ProviderLaunchInput) -> Vec<String> {
    // Plan mode rides the read-only plan agent; never add the auto-approve
    // bypass on top of it.
    if input.agent_mode == AgentMode::Plan {
        return Vec::new();
    }
    if input.permission_mode == PermissionMode::AutoApprove {
        owned(OPENCODE_BYPASS_PERMISSION_ARGS)
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
        ReasoningEffort::Max => {
            "Think as hard as you can. Reason exhaustively from first principles: enumerate every alternative, edge case, and failure mode, argue against your own conclusions, and verify each step before acting. Do not shortcut the analysis."
        }
        ReasoningEffort::Ultra => {
            "Ultrathink. Use your maximum reasoning budget on this task. Exhaustively decompose the problem, enumerate and evaluate every alternative and edge case, adversarially challenge each conclusion, and re-derive and verify your answer before acting. Spare no thinking."
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

fn codex_reasoning_args(input: &ProviderLaunchInput) -> Vec<String> {
    let Some(reasoning_effort) = input.reasoning_effort else {
        return Vec::new();
    };
    let effort = codex_effort_value(&input.model_id, reasoning_effort);
    vec![
        "-c".to_string(),
        format!("model_reasoning_effort=\"{effort}\""),
    ]
}

// Mirrors reasoningEffortsForModel (providerModels.ts). Sol/Terra accept the
// full low→ultra list. Luna stops at max. Unknown/legacy models stop at xhigh.
// Clamp is a backstop for provider-switch and resume paths that skip the picker.
fn codex_effort_value(model_id: &str, effort: ReasoningEffort) -> &'static str {
    match model_id {
        "gpt-5.6-sol" | "gpt-5.6-terra" => effort.as_str(),
        "gpt-5.6-luna" => match effort {
            ReasoningEffort::Ultra => "max",
            other => other.as_str(),
        },
        _ => match effort {
            ReasoningEffort::Max | ReasoningEffort::Ultra => "xhigh",
            other => other.as_str(),
        },
    }
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

    #[test]
    fn claude_structured_args_match_main_stream_json() {
        let input = launch_input(ProviderId::Claude);
        let definition = get_provider_definition(ProviderId::Claude);

        assert_eq!(
            (definition.structured_args)(&input, None),
            vec![
                "-p",
                "--brief",
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
                "--forward-subagent-text",
                "--",
                "Implement the task",
            ]
        );
        assert_eq!((definition.structured_stdin)(&input), None);
    }

    #[test]
    fn claude_forked_resume_adds_fork_session_flag() {
        let mut input = launch_input(ProviderId::Claude);
        input.resume_fork = true;
        let definition = get_provider_definition(ProviderId::Claude);
        let args = (definition.structured_resume_args)(&input, "conv-7", None);
        assert_eq!(
            args[..5],
            ["-p", "--brief", "--resume", "conv-7", "--fork-session"]
        );

        input.resume_fork = false;
        let args = (definition.structured_resume_args)(&input, "conv-7", None);
        assert!(!args.contains(&"--fork-session".to_string()));
    }

    #[test]
    fn codex_forked_resume_swaps_to_exec_fork() {
        let mut input = launch_input(ProviderId::Codex);
        input.resume_fork = true;
        let definition = get_provider_definition(ProviderId::Codex);
        let args = (definition.structured_resume_args)(&input, "conv-7", None);
        assert_eq!(args[..3], ["exec", "fork", "--json"]);
        assert!(args.contains(&"conv-7".to_string()));

        input.resume_fork = false;
        let args = (definition.structured_resume_args)(&input, "conv-7", None);
        assert_eq!(args[..3], ["exec", "resume", "--json"]);
    }

    #[test]
    fn opencode_forked_resume_adds_fork_flag() {
        let mut input = launch_input(ProviderId::Opencode);
        input.resume_fork = true;
        let definition = get_provider_definition(ProviderId::Opencode);
        let args = (definition.structured_resume_args)(&input, "ses_7", None);
        let session_flag = args.iter().position(|a| a == "-s").unwrap();
        assert_eq!(args[session_flag + 1], "ses_7");
        assert_eq!(args[session_flag + 2], "--fork");

        input.resume_fork = false;
        let args = (definition.structured_resume_args)(&input, "ses_7", None);
        assert!(!args.contains(&"--fork".to_string()));
    }

    #[test]
    fn claude_resume_args_keep_partial_message_streaming() {
        let input = launch_input(ProviderId::Claude);
        let definition = get_provider_definition(ProviderId::Claude);

        assert_eq!(
            (definition.structured_resume_args)(&input, "conv-7", None),
            vec![
                "-p",
                "--brief",
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
                "--forward-subagent-text",
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
        let args = (get_provider_definition(ProviderId::Claude).structured_args)(&input, None);
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
        let args = (get_provider_definition(ProviderId::Claude).structured_args)(&input, None);
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
        let args = (get_provider_definition(ProviderId::Claude).structured_args)(&input, None);
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
            (definition.structured_args)(&input, None),
            vec![
                "exec",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-5.6-sol",
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
    fn codex_structured_without_reasoning_uses_user_config() {
        let input = ProviderLaunchInput {
            reasoning_effort: None,
            ..launch_input(ProviderId::Codex)
        };
        let args = (get_provider_definition(ProviderId::Codex).structured_args)(&input, None);
        assert!(!args.iter().any(|arg| arg == "--ignore-user-config"));
    }

    #[test]
    fn codex_passes_max_and_ultra_for_sol_and_terra() {
        for model_id in ["gpt-5.6-sol", "gpt-5.6-terra"] {
            for (effort, expected) in [
                (ReasoningEffort::Max, "model_reasoning_effort=\"max\""),
                (ReasoningEffort::Ultra, "model_reasoning_effort=\"ultra\""),
            ] {
                let input = ProviderLaunchInput {
                    model_id: model_id.to_string(),
                    reasoning_effort: Some(effort),
                    ..launch_input(ProviderId::Codex)
                };
                let args =
                    (get_provider_definition(ProviderId::Codex).structured_args)(&input, None);
                assert!(
                    args.iter().any(|arg| arg == expected),
                    "{model_id} {effort:?} should send {expected}, got {args:?}"
                );
            }
        }
    }

    #[test]
    fn codex_luna_clamps_ultra_to_max() {
        let input = ProviderLaunchInput {
            model_id: "gpt-5.6-luna".to_string(),
            reasoning_effort: Some(ReasoningEffort::Ultra),
            ..launch_input(ProviderId::Codex)
        };
        let args = (get_provider_definition(ProviderId::Codex).structured_args)(&input, None);
        assert!(
            args.iter()
                .any(|arg| arg == "model_reasoning_effort=\"max\""),
            "luna ultra should clamp to max, got {args:?}"
        );

        let max = ProviderLaunchInput {
            model_id: "gpt-5.6-luna".to_string(),
            reasoning_effort: Some(ReasoningEffort::Max),
            ..launch_input(ProviderId::Codex)
        };
        let max_args = (get_provider_definition(ProviderId::Codex).structured_args)(&max, None);
        assert!(
            max_args
                .iter()
                .any(|arg| arg == "model_reasoning_effort=\"max\""),
            "luna max should pass through, got {max_args:?}"
        );
    }

    #[test]
    fn codex_unknown_model_clamps_max_and_ultra_to_xhigh() {
        for effort in [ReasoningEffort::Max, ReasoningEffort::Ultra] {
            let input = ProviderLaunchInput {
                model_id: "gpt-5.4".to_string(),
                reasoning_effort: Some(effort),
                ..launch_input(ProviderId::Codex)
            };
            let args = (get_provider_definition(ProviderId::Codex).structured_args)(&input, None);
            assert!(
                args.iter()
                    .any(|arg| arg == "model_reasoning_effort=\"xhigh\""),
                "effort {effort:?} on an unknown model should clamp to xhigh, got {args:?}"
            );
        }
    }

    #[test]
    fn codex_fast_mode_is_carried_by_service_tier_override() {
        let input = ProviderLaunchInput {
            fast_mode: true,
            ..launch_input(ProviderId::Codex)
        };
        let args = (get_provider_definition(ProviderId::Codex).structured_args)(&input, None);
        assert!(args
            .windows(2)
            .any(|window| window == ["-c", r#"service_tier="priority""#]));

        let resume_args = (get_provider_definition(ProviderId::Codex).structured_resume_args)(
            &input, "thread-1", None,
        );
        assert!(resume_args
            .windows(2)
            .any(|window| window == ["-c", r#"service_tier="priority""#]));

        let off = launch_input(ProviderId::Codex);
        let off_args = (get_provider_definition(ProviderId::Codex).structured_args)(&off, None);
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
            (definition.structured_resume_args)(&input, "thread-1", None),
            vec![
                "exec",
                "resume",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-5.6-sol",
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
            (definition.structured_args)(&input, None),
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
    fn a_cursor_launch_with_the_agent_tools_approves_them() {
        // The server spec is a file in the workspace, but an entry cursor-agent
        // has not approved is listed and never started, so the model reports
        // the namespace as missing. Both arg builders must pass the flag.
        let input = launch_input(ProviderId::Cursor);
        let definition = get_provider_definition(ProviderId::Cursor);
        let mcp = SessionLaunchProcessConfig::for_tests(
            "/tmp/argmax/launch.sock",
            "token-123",
            "/Applications/Argmax.app/Contents/MacOS/argmax",
        );

        for args in [
            (definition.structured_args)(&input, Some(&mcp)),
            (definition.structured_resume_args)(&input, "c1", Some(&mcp)),
        ] {
            assert!(
                args.iter().any(|arg| arg == "--approve-mcps"),
                "cursor needs --approve-mcps to start the server it was given: {args:?}"
            );
        }
        // No credential, no flag: nothing was injected to approve.
        assert!(!(definition.structured_args)(&input, None)
            .iter()
            .any(|arg| arg == "--approve-mcps"));
    }

    #[test]
    fn cursor_plan_mode_adds_plan_flag() {
        let input = ProviderLaunchInput {
            agent_mode: AgentMode::Plan,
            ..launch_input(ProviderId::Cursor)
        };
        let args = (get_provider_definition(ProviderId::Cursor).structured_args)(&input, None);
        assert!(args.iter().any(|arg| arg == "--plan"));
    }

    #[test]
    fn cursor_fast_mode_appends_fast_variant_after_effort() {
        let cases = [
            ("composer-2.5", None, "composer-2.5-fast"),
            (
                "gpt-5.6-sol-medium",
                Some(ReasoningEffort::High),
                "gpt-5.6-sol-high-fast",
            ),
            (
                "claude-opus-5-thinking-medium",
                Some(ReasoningEffort::Xhigh),
                "claude-opus-5-thinking-xhigh-fast",
            ),
            // Fast on an effort-capable model with no effort set keeps the base
            // -medium alias and just appends -fast.
            ("gpt-5.6-luna-medium", None, "gpt-5.6-luna-medium-fast"),
        ];
        for (model_id, effort, expected) in cases {
            let input = ProviderLaunchInput {
                model_id: model_id.to_string(),
                reasoning_effort: effort,
                fast_mode: true,
                ..launch_input(ProviderId::Cursor)
            };
            let args = (get_provider_definition(ProviderId::Cursor).structured_args)(&input, None);
            let i = args
                .iter()
                .position(|a| a == "--model")
                .expect("model flag");
            assert_eq!(args[i + 1], expected, "{model_id} fast");
        }
    }

    #[test]
    fn cursor_resume_applies_the_same_effort_fast_mapping() {
        // The resume arg builder shares cursor_model_for, so effort/fast fold
        // into --model on resume exactly as on launch.
        let input = ProviderLaunchInput {
            model_id: "claude-opus-5-thinking-medium".to_string(),
            reasoning_effort: Some(ReasoningEffort::Max),
            fast_mode: true,
            ..launch_input(ProviderId::Cursor)
        };
        let args = (get_provider_definition(ProviderId::Cursor).structured_resume_args)(
            &input, "conv-1", None,
        );
        let i = args
            .iter()
            .position(|a| a == "--model")
            .expect("model flag");
        assert_eq!(args[i + 1], "claude-opus-5-thinking-max-fast");
    }

    #[test]
    fn cursor_gemini_has_no_fast_variant() {
        // Gemini 3.8 Flash has no -fast model, so fast mode is a no-op for it.
        let input = ProviderLaunchInput {
            model_id: "gemini-3.8-flash-medium".to_string(),
            reasoning_effort: Some(ReasoningEffort::High),
            fast_mode: true,
            ..launch_input(ProviderId::Cursor)
        };
        let args = (get_provider_definition(ProviderId::Cursor).structured_args)(&input, None);
        let i = args
            .iter()
            .position(|a| a == "--model")
            .expect("model flag");
        assert_eq!(args[i + 1], "gemini-3.8-flash-high");
    }

    #[test]
    fn cursor_grok_effort_maps_to_variant_capped_at_high() {
        let cases = [
            (ReasoningEffort::Low, "cursor-grok-4.6-low"),
            (ReasoningEffort::Medium, "cursor-grok-4.6-medium"),
            (ReasoningEffort::High, "cursor-grok-4.6-high"),
            (ReasoningEffort::Xhigh, "cursor-grok-4.6-high"),
            (ReasoningEffort::Max, "cursor-grok-4.6-high"),
        ];
        for (effort, expected) in cases {
            let input = ProviderLaunchInput {
                model_id: "cursor-grok-4.6-medium".to_string(),
                reasoning_effort: Some(effort),
                ..launch_input(ProviderId::Cursor)
            };
            let args = (get_provider_definition(ProviderId::Cursor).structured_args)(&input, None);
            let i = args
                .iter()
                .position(|a| a == "--model")
                .expect("model flag");
            assert_eq!(args[i + 1], expected, "grok effort {effort:?}");
        }
    }

    #[test]
    fn cursor_grok_45_stored_id_still_folds_effort() {
        let input = ProviderLaunchInput {
            model_id: "cursor-grok-4.5-medium".to_string(),
            reasoning_effort: Some(ReasoningEffort::High),
            ..launch_input(ProviderId::Cursor)
        };
        let args = (get_provider_definition(ProviderId::Cursor).structured_args)(&input, None);
        let i = args
            .iter()
            .position(|a| a == "--model")
            .expect("model flag");
        assert_eq!(args[i + 1], "cursor-grok-4.5-high");
    }

    #[test]
    fn cursor_gpt56_effort_maps_to_model_variant() {
        let cases = [
            (ReasoningEffort::Low, "gpt-5.6-sol-low"),
            (ReasoningEffort::Medium, "gpt-5.6-sol-medium"),
            (ReasoningEffort::High, "gpt-5.6-sol-high"),
            (ReasoningEffort::Xhigh, "gpt-5.6-sol-xhigh"),
            (ReasoningEffort::Max, "gpt-5.6-sol-max"),
            (ReasoningEffort::Ultra, "gpt-5.6-sol-max"),
        ];
        for (effort, expected) in cases {
            let input = ProviderLaunchInput {
                model_id: "gpt-5.6-sol-medium".to_string(),
                reasoning_effort: Some(effort),
                ..launch_input(ProviderId::Cursor)
            };
            let args = (get_provider_definition(ProviderId::Cursor).structured_args)(&input, None);
            let i = args
                .iter()
                .position(|a| a == "--model")
                .expect("model flag");
            assert_eq!(args[i + 1], expected, "gpt-5.6-sol effort {effort:?}");
        }
    }

    #[test]
    fn cursor_opus_effort_maps_to_thinking_variant_capped_at_max() {
        let cases = [
            (ReasoningEffort::Low, "claude-opus-5-thinking-low"),
            (ReasoningEffort::High, "claude-opus-5-thinking-high"),
            (ReasoningEffort::Xhigh, "claude-opus-5-thinking-xhigh"),
            (ReasoningEffort::Max, "claude-opus-5-thinking-max"),
            (ReasoningEffort::Ultra, "claude-opus-5-thinking-max"),
        ];
        for (effort, expected) in cases {
            let input = ProviderLaunchInput {
                model_id: "claude-opus-5-thinking-medium".to_string(),
                reasoning_effort: Some(effort),
                ..launch_input(ProviderId::Cursor)
            };
            let args = (get_provider_definition(ProviderId::Cursor).structured_args)(&input, None);
            let i = args
                .iter()
                .position(|a| a == "--model")
                .expect("model flag");
            assert_eq!(args[i + 1], expected, "opus effort {effort:?}");
        }
    }

    #[test]
    fn cursor_non_parameterized_models_ignore_effort() {
        // Composer/Gemini have no effort variants — pass the id through untouched.
        let input = ProviderLaunchInput {
            model_id: "composer-2.5".to_string(),
            reasoning_effort: Some(ReasoningEffort::High),
            ..launch_input(ProviderId::Cursor)
        };
        let args = (get_provider_definition(ProviderId::Cursor).structured_args)(&input, None);
        let i = args
            .iter()
            .position(|a| a == "--model")
            .expect("model flag");
        assert_eq!(args[i + 1], "composer-2.5");
    }

    #[test]
    fn opencode_structured_args_match_runtime_contract() {
        let input = launch_input(ProviderId::Opencode);
        let definition = get_provider_definition(ProviderId::Opencode);

        assert_eq!(
            (definition.structured_args)(&input, None),
            vec![
                "run",
                "--dir",
                "/repo/worktree",
                "--format",
                "json",
                "--thinking",
                "--auto",
                "-m",
                "opencode/big-pickle",
                "--",
                "Implement the task",
            ]
        );
        assert_eq!((definition.structured_stdin)(&input), None);
    }

    #[test]
    fn opencode_resume_args_continue_the_session() {
        let input = launch_input(ProviderId::Opencode);
        let definition = get_provider_definition(ProviderId::Opencode);

        assert_eq!(
            (definition.structured_resume_args)(&input, "ses_123", None),
            vec![
                "run",
                "--dir",
                "/repo/worktree",
                "--format",
                "json",
                "--thinking",
                "-s",
                "ses_123",
                "--auto",
                "-m",
                "opencode/big-pickle",
                "--",
                "Implement the task",
            ]
        );
    }

    #[test]
    fn opencode_plan_mode_uses_read_only_plan_agent() {
        let input = ProviderLaunchInput {
            agent_mode: AgentMode::Plan,
            ..launch_input(ProviderId::Opencode)
        };
        let args = (get_provider_definition(ProviderId::Opencode).structured_args)(&input, None);
        assert!(args.windows(2).any(|window| window == ["--agent", "plan"]));
        assert!(!args.iter().any(|arg| arg == "--auto"));
    }

    #[test]
    fn multiline_and_dash_prefixed_prompts_are_kept_safe() {
        for provider_id in [
            ProviderId::Claude,
            ProviderId::Codex,
            ProviderId::Cursor,
            ProviderId::Opencode,
        ] {
            let input = ProviderLaunchInput {
                prompt: "- read this\nthen implement".to_string(),
                ..launch_input(provider_id)
            };
            let definition = get_provider_definition(provider_id);
            let args = (definition.structured_args)(&input, None);
            match provider_id {
                ProviderId::Codex => {
                    assert!(!args.contains(&input.prompt));
                    assert_eq!(
                        (definition.structured_stdin)(&input),
                        Some("- read this\nthen implement".to_string())
                    );
                }
                ProviderId::Claude | ProviderId::Cursor | ProviderId::Opencode => {
                    let prompt_index = args
                        .iter()
                        .position(|arg| arg == &input.prompt)
                        .expect("prompt carried as argv");
                    assert_eq!(args[prompt_index - 1], "--");
                }
                // Grok takes the prompt as a flag value, so `--` never appears;
                // the `=` form is what keeps a leading dash out of clap's way.
                ProviderId::Grok => {
                    assert_eq!(args[0], format!("--single={}", input.prompt));
                    assert!(!args.contains(&"--".to_string()));
                }
            }
        }
    }

    #[test]
    fn ask_each_time_drops_provider_bypass_flags() {
        for provider_id in [
            ProviderId::Claude,
            ProviderId::Codex,
            ProviderId::Cursor,
            ProviderId::Opencode,
        ] {
            let input = ProviderLaunchInput {
                permission_mode: PermissionMode::AskEachTime,
                ..launch_input(provider_id)
            };
            let args = (get_provider_definition(provider_id).structured_args)(&input, None);
            assert!(!args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "bypassPermissions"
                        | "--dangerously-bypass-approvals-and-sandbox"
                        | "--force"
                        | "--trust"
                        | "--auto"
                )
            }));
        }
    }

    #[test]
    fn plan_mode_never_bypasses_for_any_provider() {
        // Plan mode is read-only; no provider should receive an approvals/sandbox
        // bypass flag even when permission mode is AutoApprove.
        for provider_id in [
            ProviderId::Claude,
            ProviderId::Codex,
            ProviderId::Cursor,
            ProviderId::Opencode,
        ] {
            let input = ProviderLaunchInput {
                permission_mode: PermissionMode::AutoApprove,
                agent_mode: AgentMode::Plan,
                ..launch_input(provider_id)
            };
            let args = (get_provider_definition(provider_id).structured_args)(&input, None);
            assert!(
                !args.iter().any(|arg| {
                    matches!(
                        arg.as_str(),
                        "bypassPermissions"
                            | "--dangerously-bypass-approvals-and-sandbox"
                            | "--force"
                            | "--trust"
                            | "--auto"
                    )
                }),
                "{provider_id:?} leaked a bypass flag in plan mode: {args:?}"
            );
        }
    }

    #[test]
    fn grok_structured_args_match_claude_stream_json_shape() {
        let input = launch_input(ProviderId::Grok);
        let definition = get_provider_definition(ProviderId::Grok);

        assert_eq!(
            (definition.structured_args)(&input, None),
            vec![
                "--single=Implement the task",
                "--cwd",
                "/repo/worktree",
                "--session-id",
                "session-1",
                "--output-format",
                "streaming-messages-json",
                "--include-partial-messages",
                "--always-approve",
                "--model",
                "grok-4.6",
            ]
        );
        assert_eq!((definition.structured_stdin)(&input), None);
    }

    // -p takes the prompt as its VALUE, unlike Claude's trailing `-- <prompt>`.
    // A prompt that looks like a flag must still land as the -p argument.
    // Verified against grok 1.0.13: `grok -p "--x"` exits with a usage error,
    // while `grok "--single=--x"` runs. A prompt is arbitrary user text, so the
    // form that tolerates a leading dash is the only correct one.
    #[test]
    fn grok_prompt_survives_a_leading_dash() {
        let mut input = launch_input(ProviderId::Grok);
        input.prompt = "--not-a-flag\nsecond line".to_string();
        for args in [
            (get_provider_definition(ProviderId::Grok).structured_args)(&input, None),
            (get_provider_definition(ProviderId::Grok).structured_resume_args)(&input, "c1", None),
        ] {
            assert_eq!(args[0], "--single=--not-a-flag\nsecond line");
            assert!(!args.iter().any(|arg| arg == "-p"));
            assert!(!args.contains(&"--".to_string()));
        }
    }

    #[test]
    fn grok_resume_passes_conversation_id_and_keeps_partial_streaming() {
        let mut input = launch_input(ProviderId::Grok);
        let definition = get_provider_definition(ProviderId::Grok);

        let args = (definition.structured_resume_args)(&input, "conv-7", None);
        assert_eq!(args[3], "--resume");
        assert_eq!(args[4], "conv-7");
        assert!(!args.contains(&"--fork-session".to_string()));
        assert!(args.contains(&"--include-partial-messages".to_string()));
        // The CLI rejects --session-id alongside --resume without --fork-session.
        assert!(!args.contains(&"--session-id".to_string()));

        input.resume_fork = true;
        let args = (definition.structured_resume_args)(&input, "conv-7", None);
        assert_eq!(args[5], "--fork-session");
        assert!(!args.contains(&"--session-id".to_string()));
    }

    // `--reasoning-effort` accepts only low/medium/high/xhigh; the CLI errors on
    // anything else, so Max and Ultra clamp instead of failing the launch.
    #[test]
    fn grok_reasoning_effort_clamps_above_xhigh() {
        for (effort, expected) in [
            (ReasoningEffort::Low, "low"),
            (ReasoningEffort::Medium, "medium"),
            (ReasoningEffort::High, "high"),
            (ReasoningEffort::Xhigh, "xhigh"),
            (ReasoningEffort::Max, "xhigh"),
            (ReasoningEffort::Ultra, "xhigh"),
        ] {
            let input = ProviderLaunchInput {
                reasoning_effort: Some(effort),
                ..launch_input(ProviderId::Grok)
            };
            let args = (get_provider_definition(ProviderId::Grok).structured_args)(&input, None);
            let index = args
                .iter()
                .position(|arg| arg == "--reasoning-effort")
                .expect("effort flag");
            assert_eq!(args[index + 1], expected, "effort {effort:?}");
        }
    }

    #[test]
    fn grok_plan_mode_uses_the_read_only_plan_agent_without_bypass() {
        let input = ProviderLaunchInput {
            agent_mode: AgentMode::Plan,
            ..launch_input(ProviderId::Grok)
        };
        let args = (get_provider_definition(ProviderId::Grok).structured_args)(&input, None);
        assert!(args.windows(2).any(|w| w[0] == "--agent" && w[1] == "plan"));
        assert!(!args.contains(&"--always-approve".to_string()));

        // And the same on a resumed turn.
        let args =
            (get_provider_definition(ProviderId::Grok).structured_resume_args)(&input, "c1", None);
        assert!(args.windows(2).any(|w| w[0] == "--agent" && w[1] == "plan"));
        assert!(!args.contains(&"--always-approve".to_string()));
    }

    #[test]
    fn grok_ask_each_time_omits_the_bypass_flag() {
        let input = ProviderLaunchInput {
            permission_mode: PermissionMode::AskEachTime,
            ..launch_input(ProviderId::Grok)
        };
        let args = (get_provider_definition(ProviderId::Grok).structured_args)(&input, None);
        assert!(!args.contains(&"--always-approve".to_string()));
    }

    // Grok has no fast-mode surface; the toggle must not leak a flag.
    #[test]
    fn grok_ignores_fast_mode() {
        let input = ProviderLaunchInput {
            fast_mode: true,
            ..launch_input(ProviderId::Grok)
        };
        let on = (get_provider_definition(ProviderId::Grok).structured_args)(&input, None);
        let off = (get_provider_definition(ProviderId::Grok).structured_args)(
            &launch_input(ProviderId::Grok),
            None,
        );
        assert_eq!(on, off);
    }

    fn launch_input(provider_id: ProviderId) -> ProviderLaunchInput {
        let (model_label, model_id, reasoning_effort) = match provider_id {
            ProviderId::Claude => ("Claude Haiku", "haiku", None),
            ProviderId::Codex => ("GPT-5.6 Sol Low", "gpt-5.6-sol", Some(ReasoningEffort::Low)),
            ProviderId::Cursor => ("Composer 2.5 (Cursor)", "composer-2.5", None),
            ProviderId::Opencode => ("Big Pickle", "opencode/big-pickle", None),
            ProviderId::Grok => ("Grok 4.6", "grok-4.6", None),
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
            resume_fork: false,
            permission_mode: PermissionMode::AutoApprove,
            agent_mode: AgentMode::Auto,
            cols: 100,
            rows: 30,
        }
    }
}
