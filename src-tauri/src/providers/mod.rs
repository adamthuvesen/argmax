pub mod acp;
pub mod adapters;
pub mod cursor_acp;
pub mod discovery;
pub mod environment;
pub mod flush_queue;
mod follow_up;
pub mod normalizer;
mod orphan_cleanup;
pub mod pricing;
pub mod runtime;
pub mod session_service;
pub mod subagent_trace;
pub mod title;

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
