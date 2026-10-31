//! What a queued or delivered prompt carries besides its text.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::validation::{AttachmentMimeType, AttachmentPath, NonEmptyString, ATTACHMENT_BYTE_CAP};

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
pub struct AgentReference {
    pub name: NonEmptyString,
    pub provider_child_session_id: NonEmptyString,
    pub provider_parent_conversation_id: NonEmptyString,
}

/// Where a user turn came from, when it was not the person at the keyboard.
/// Written onto the `user.message` payload as `origin`, which is what the chat
/// renders as a "From <label>" bubble instead of an ordinary prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MessageOrigin {
    /// The session that wrote it.
    pub session_id: String,
    /// That session's sidebar task label, resolved once at send time so the
    /// bubble still names it after the sender is archived.
    pub label: String,
    /// `message` when another agent wrote here, `completion` when a session
    /// this one launched has finished.
    pub kind: String,
    /// The `session_messages` row this turn delivers, when there is one. The
    /// follow-up queue consults it at drain time so a message the recipient
    /// already collected mid-turn — through `inbox_read`, while the queue held
    /// it — is not also sent as a turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}
