//! Validated provider session commands shared across transports.

use crate::application::validation::{
    AgentMode, AttachmentMimeType, AttachmentPath, NonEmptyString, PermissionMode, Prompt,
    ProviderId, ReasoningEffort, SessionId, TerminalCols, TerminalRows, WorkspaceId,
    ATTACHMENT_BYTE_CAP,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// True when a prompt is exactly the `/compact` command. Claude and Grok run
/// it themselves when it arrives as prompt text. Codex and OpenCode have no
/// such command, so their adapters turn it into the protocol's compact call.
/// Arguments (`/compact focus on X`) are not forwarded: neither protocol takes
/// them, so those prompts stay ordinary text.
pub fn is_compact_command(prompt: &str) -> bool {
    prompt.trim().eq_ignore_ascii_case("/compact")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposerAttachmentInput {
    pub file_path: AttachmentPath,
    pub mime_type: AttachmentMimeType,
    pub size_bytes: AttachmentSizeBytes,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct AttachmentSizeBytes(u64);

impl<'de> Deserialize<'de> for AttachmentSizeBytes {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        if value == 0 || value as usize > ATTACHMENT_BYTE_CAP {
            Err(serde::de::Error::custom(format!(
                "sizeBytes must be in 1..={ATTACHMENT_BYTE_CAP}"
            )))
        } else {
            Ok(Self(value))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersLaunchInput {
    pub workspace_id: WorkspaceId,
    pub provider: ProviderId,
    pub prompt: Prompt,
    pub model_label: NonEmptyString,
    pub model_id: NonEmptyString,
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub fast_mode: bool,
    pub agent_mode: Option<AgentMode>,
    pub permission_mode: Option<PermissionMode>,
    pub cols: TerminalCols,
    pub rows: TerminalRows,
    pub attachments: Option<Vec<ComposerAttachmentInput>>,
    pub goal_condition: Option<String>,
    pub goal_max_turns: Option<u32>,
    /// The Arc this session is attached to. Checked against the Arc's caps
    /// and attached to the session row in the same write transaction as the
    /// insert, so concurrent launches can't each pass the cap check before
    /// either session existed to count against it. `None` for a launch with
    /// no Arc — every renderer-initiated launch, which is why this defaults
    /// rather than requiring every existing caller to pass it explicitly.
    #[serde(default)]
    pub arc_id: Option<String>,
    /// Skips the active-member and daily-launch-budget checks; `ARC_DONE`
    /// still applies. Only true for the one launch that must not count
    /// against the caps it would otherwise be checked against: the Arc's
    /// coordinator launching itself.
    #[serde(default)]
    pub arc_is_coordinator_launch: bool,
    /// Let the router pick provider, model and effort from the prompt. The
    /// provider/model/effort fields above are then only the fallback the
    /// router overwrites. See docs/routing.md.
    #[serde(default)]
    pub auto_tier: Option<crate::routing::table::AutoTier>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersSendInput {
    pub session_id: SessionId,
    pub input: Prompt,
    /// Provider override for the next turn. When it differs from the session's
    /// current provider, an idle follow-up relaunches under the new provider and
    /// rebuilds context from the visible transcript — the native resume id is
    /// dropped because Claude/Codex/Cursor ids don't translate. Requires
    /// `model_label`/`model_id` for the new provider. While a turn runs the
    /// message queues with the provider, model, effort and fast mode it picked,
    /// and the switch happens when it drains. A send that needs a model and has
    /// none is refused when it is queued, not when it drains.
    #[serde(default)]
    pub provider: Option<ProviderId>,
    pub model_label: Option<NonEmptyString>,
    pub model_id: Option<NonEmptyString>,
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub fast_mode: bool,
    pub agent_mode: Option<AgentMode>,
    pub attachments: Option<Vec<ComposerAttachmentInput>>,
    #[serde(default)]
    pub agent_references: Option<Vec<AgentReference>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentReference {
    pub name: NonEmptyString,
    pub provider_child_session_id: NonEmptyString,
    pub provider_parent_conversation_id: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersResizeInput {
    pub session_id: SessionId,
    pub cols: TerminalCols,
    pub rows: TerminalRows,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersTerminateInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersCancelQueuedMessageInput {
    pub session_id: SessionId,
    pub message_id: NonEmptyString,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersSendQueuedMessageNowInput {
    pub session_id: SessionId,
    pub message_id: NonEmptyString,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<QueuedMessageDelivery>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QueuedMessageDelivery {
    Interrupt,
    Steer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionClearInput {
    pub session_id: SessionId,
}

#[cfg(test)]
mod compact_command_tests {
    use super::is_compact_command;

    #[test]
    fn only_the_bare_command_is_compact() {
        assert!(is_compact_command("/compact"));
        assert!(is_compact_command("  /Compact \n"));
        assert!(!is_compact_command("/compact focus on tests"));
        assert!(!is_compact_command("please /compact"));
    }
}
