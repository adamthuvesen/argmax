// Session-attention computation. Mirrors
// `src/main/sessions/sessionAttention.ts`.
//
// Attention is the renderer's "what does this session need from me right
// now?" pill. The policy is:
//   - any pending approval → approval-needed
//   - blocked / waiting    → blocked
//   - failed               → failed
//   - complete             → review-ready
//   - everything else      → normal

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
}

/// Inputs needed to compute attention. `has_pending_approval` is the
/// `pendingApprovals?.some(approved=='pending')` shortcut from the TS.
pub struct SessionAttentionInput<'a> {
    pub state: &'a str,
    pub has_pending_approval: bool,
}

pub fn compute_session_attention(input: SessionAttentionInput<'_>) -> AttentionState {
    if input.has_pending_approval {
        return AttentionState::ApprovalNeeded;
    }
    match input.state {
        "blocked" | "waiting" => AttentionState::Blocked,
        "failed" => AttentionState::Failed,
        "complete" => AttentionState::ReviewReady,
        _ => AttentionState::Normal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_approval_takes_precedence() {
        let attention = compute_session_attention(SessionAttentionInput {
            state: "complete",
            has_pending_approval: true,
        });
        assert_eq!(attention, AttentionState::ApprovalNeeded);
    }

    #[test]
    fn blocked_and_waiting_map_to_blocked() {
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: "blocked",
                has_pending_approval: false,
            }),
            AttentionState::Blocked,
        );
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: "waiting",
                has_pending_approval: false,
            }),
            AttentionState::Blocked,
        );
    }

    #[test]
    fn failed_complete_normal() {
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: "failed",
                has_pending_approval: false
            }),
            AttentionState::Failed,
        );
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: "complete",
                has_pending_approval: false,
            }),
            AttentionState::ReviewReady,
        );
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: "running",
                has_pending_approval: false,
            }),
            AttentionState::Normal,
        );
    }
}
