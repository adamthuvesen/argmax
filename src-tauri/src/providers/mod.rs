pub mod acp;
pub mod adapters;
pub mod claude_control;
pub mod codex_app_server;
pub mod cursor_acp;
pub mod discovery;
pub mod environment;
pub mod flush_queue;
mod follow_up;
pub mod grok_acp;
pub mod grok_trust;
pub mod mcp_injection;
pub mod measured_diffs;
pub mod normalizer;
pub mod one_shot;
mod opencode_isolation;
pub mod opencode_server;
mod orphan_cleanup;
pub mod pricing;
pub mod runtime;
pub mod session_service;
pub mod subagent_trace;
pub mod unified_diff;
pub mod verification;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use specta::Type;

pub use crate::ipc::validation::{AgentMode, PermissionMode, ProviderId, ReasoningEffort};

/// What Argmax can truthfully do with a provider's native permission gate.
/// Observable-only means the CLI can emit a request, but this runtime does not
/// have the provider-owned transport needed to answer that exact request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalSupport {
    Unsupported,
    ObservableOnly,
    Respondable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLaunchInput {
    pub provider: ProviderId,
    pub session_id: String,
    pub workspace_path: PathBuf,
    pub prompt: String,
    pub model_label: String,
    pub model_id: String,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub fast_mode: bool,
    pub resume_conversation_id: Option<String>,
    /// Diverge instead of continuing: the resumed launch starts a NEW provider
    /// conversation seeded with the old history (`--fork-session` on Claude).
    /// Set on sessions created by `sessions:fork`; spent once a fresh
    /// conversation id is persisted.
    pub resume_fork: bool,
    pub permission_mode: PermissionMode,
    pub agent_mode: AgentMode,
    pub cols: u16,
    pub rows: u16,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Claude => "claude",
            ProviderId::Codex => "codex",
            ProviderId::Cursor => "cursor",
            ProviderId::Opencode => "opencode",
            ProviderId::Grok => "grok",
        }
    }
}

impl ReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            ReasoningEffort::Low => "low",
            ReasoningEffort::Medium => "medium",
            ReasoningEffort::High => "high",
            ReasoningEffort::Xhigh => "xhigh",
            ReasoningEffort::Max => "max",
            ReasoningEffort::Ultra => "ultra",
        }
    }
}

impl AgentMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentMode::Auto => "auto",
            AgentMode::Plan => "plan",
        }
    }
}

/// Whether a tool call reaches the user as chat content rather than a tool row:
/// an interactive card they answer, or — for `SendUserMessage` — prose the
/// normalizer rewrites into a plain message. A card is drawn from the call
/// itself and answered with its own button, which terminates the turn and sends
/// the answer as a new message, so the tool result is discarded either way.
/// Gating one asks permission to show the user a question already in front of
/// them, and gating a message asks permission to say something, so neither is
/// ever sent to the approval broker.
///
/// Kept in step with `isAskUserQuestionToolName` / `isExitPlanModeToolName` in
/// [src/renderer/lib/turnInteractiveCards.ts]; the normalization is the same
/// lowercase-alphanumeric fold, so `ExitPlanMode` and `exit_plan_mode` are one
/// name.
pub fn renders_as_interactive_card(tool_name: &str) -> bool {
    let normalized: String = tool_name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect();
    matches!(
        normalized.as_str(),
        "askuserquestion" | "askquestiontoolcall" | "sendusermessage" | "exitplanmode"
    )
}

#[cfg(test)]
mod tests {
    use super::renders_as_interactive_card;

    #[test]
    fn card_tool_names_match_the_renderers_fold() {
        for name in [
            "AskUserQuestion",
            "ask_user_question",
            "askQuestionToolCall",
            "SendUserMessage",
            "ExitPlanMode",
            "exit_plan_mode",
        ] {
            assert!(renders_as_interactive_card(name), "{name}");
        }
        for name in ["Bash", "Edit", "Write", "askQuestion", "plan"] {
            assert!(!renders_as_interactive_card(name), "{name}");
        }
    }
}
