pub mod adapters;
pub mod discovery;
pub mod environment;
pub mod flush_queue;
pub mod normalizer;
pub mod pricing;
pub mod runtime;
pub mod session_service;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use specta::Type;

pub use crate::ipc::validation::{AgentMode, PermissionMode, ProviderId, ReasoningEffort};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderMode {
    InteractivePty,
    StructuredJson,
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
    pub resume_conversation_id: Option<String>,
    pub mode: ProviderMode,
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
