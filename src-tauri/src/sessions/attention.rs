// Attention is the renderer's "what does this session need from me right
// now?" pill. The policy is:
//   - any pending approval → approval-needed
//   - blocked / waiting    → blocked
//   - failed               → failed
//   - complete             → review-ready
//   - everything else      → normal

use serde::{Deserialize, Serialize};
use specta::Type;

use super::state::SessionState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum AttentionState {
    Normal,
    Blocked,
    Failed,
    ReviewReady,
    ApprovalNeeded,
}

impl AttentionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            AttentionState::Normal => "normal",
            AttentionState::Blocked => "blocked",
            AttentionState::Failed => "failed",
            AttentionState::ReviewReady => "review-ready",
            AttentionState::ApprovalNeeded => "approval-needed",
        }
    }

    /// Parse a persisted spelling. `None` for anything outside the union.
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "normal" => Some(AttentionState::Normal),
            "blocked" => Some(AttentionState::Blocked),
            "failed" => Some(AttentionState::Failed),
            "review-ready" => Some(AttentionState::ReviewReady),
            "approval-needed" => Some(AttentionState::ApprovalNeeded),
            _ => None,
        }
    }
}

/// Inputs needed to compute attention. `has_pending_approval` is the
/// `pendingApprovals?.some(approved=='pending')` shortcut from the TS.
pub struct SessionAttentionInput {
    pub state: SessionState,
    pub has_pending_approval: bool,
}

pub fn compute_session_attention(input: SessionAttentionInput) -> AttentionState {
    if input.has_pending_approval {
        return AttentionState::ApprovalNeeded;
    }
    match input.state {
        SessionState::Blocked | SessionState::Waiting => AttentionState::Blocked,
        SessionState::Failed => AttentionState::Failed,
        SessionState::Complete => AttentionState::ReviewReady,
        SessionState::Created | SessionState::Running | SessionState::Cancelled => {
            AttentionState::Normal
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_approval_takes_precedence() {
        let attention = compute_session_attention(SessionAttentionInput {
            state: SessionState::Complete,
            has_pending_approval: true,
        });
        assert_eq!(attention, AttentionState::ApprovalNeeded);
    }

    #[test]
    fn blocked_and_waiting_map_to_blocked() {
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Blocked,
                has_pending_approval: false,
            }),
            AttentionState::Blocked,
        );
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Waiting,
                has_pending_approval: false,
            }),
            AttentionState::Blocked,
        );
    }

    #[test]
    fn failed_complete_normal() {
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Failed,
                has_pending_approval: false
            }),
            AttentionState::Failed,
        );
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Complete,
                has_pending_approval: false,
            }),
            AttentionState::ReviewReady,
        );
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Running,
                has_pending_approval: false,
            }),
            AttentionState::Normal,
        );
    }

    #[test]
    fn wire_spelling_round_trips() {
        for attention in [
            AttentionState::Normal,
            AttentionState::Blocked,
            AttentionState::Failed,
            AttentionState::ReviewReady,
            AttentionState::ApprovalNeeded,
        ] {
            assert_eq!(
                AttentionState::from_wire(attention.as_str()),
                Some(attention)
            );
            assert_eq!(
                serde_json::to_value(attention).expect("serialize"),
                serde_json::Value::String(attention.as_str().to_string()),
            );
        }
        assert_eq!(AttentionState::from_wire("none"), None);
    }
}
