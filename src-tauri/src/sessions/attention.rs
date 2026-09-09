// Attention is the renderer's "what does this session need from me right
// now?" pill. The policy is:
//   - any pending approval  → approval-needed
//   - an unanswered ask     → question-asked
//   - blocked / waiting     → blocked
//   - failed                → failed
//   - complete              → review-ready
//   - everything else       → normal
//
// `question-asked` sits directly under `approval-needed` because the agent
// asked for something and then *stopped*: the turn settled, so nothing else
// will arrive until the person answers. It has to outrank `review-ready`,
// which every completed turn earns whether or not it wants anything, or the
// two are indistinguishable on the row.

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
    QuestionAsked,
    ApprovalNeeded,
}

impl AttentionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            AttentionState::Normal => "normal",
            AttentionState::Blocked => "blocked",
            AttentionState::Failed => "failed",
            AttentionState::ReviewReady => "review-ready",
            AttentionState::QuestionAsked => "question-asked",
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
            "question-asked" => Some(AttentionState::QuestionAsked),
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
    /// An interactive ask (AskUserQuestion, ExitPlanMode) newer than the last
    /// thing the person said — see
    /// [`crate::persistence::events::has_outstanding_card_ask`].
    pub has_outstanding_question: bool,
}

pub fn compute_session_attention(input: SessionAttentionInput) -> AttentionState {
    if input.has_pending_approval {
        return AttentionState::ApprovalNeeded;
    }
    // Only once the turn has settled. Mid-turn the ask is on screen with its
    // own card and the row is already marked as working; `created` has nothing
    // to have asked yet, and a cancelled turn's question died with it.
    if input.has_outstanding_question
        && !matches!(
            input.state,
            SessionState::Created | SessionState::Running | SessionState::Cancelled
        )
    {
        return AttentionState::QuestionAsked;
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
            has_outstanding_question: false,
        });
        assert_eq!(attention, AttentionState::ApprovalNeeded);
    }

    #[test]
    fn blocked_and_waiting_map_to_blocked() {
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Blocked,
                has_pending_approval: false,
                has_outstanding_question: false,
            }),
            AttentionState::Blocked,
        );
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Waiting,
                has_pending_approval: false,
                has_outstanding_question: false,
            }),
            AttentionState::Blocked,
        );
    }

    #[test]
    fn failed_complete_normal() {
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Failed,
                has_pending_approval: false,
                has_outstanding_question: false,
            }),
            AttentionState::Failed,
        );
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Complete,
                has_pending_approval: false,
                has_outstanding_question: false,
            }),
            AttentionState::ReviewReady,
        );
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Running,
                has_pending_approval: false,
                has_outstanding_question: false,
            }),
            AttentionState::Normal,
        );
    }

    #[test]
    fn an_unanswered_question_ranks_under_an_approval_and_over_the_rest() {
        // The approval has the provider parked behind it; the question does
        // not, so it yields.
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Waiting,
                has_pending_approval: true,
                has_outstanding_question: true,
            }),
            AttentionState::ApprovalNeeded,
        );
        // Otherwise it wins, and in particular it must not read as
        // review-ready — every completed turn earns that.
        assert_eq!(
            compute_session_attention(SessionAttentionInput {
                state: SessionState::Complete,
                has_pending_approval: false,
                has_outstanding_question: true,
            }),
            AttentionState::QuestionAsked,
        );
    }

    #[test]
    fn a_question_only_counts_once_the_turn_has_settled() {
        // Mid-turn the ask is on screen with its own card and the row already
        // reads as working; a cancelled turn's question died with it.
        for state in [
            SessionState::Created,
            SessionState::Running,
            SessionState::Cancelled,
        ] {
            assert_eq!(
                compute_session_attention(SessionAttentionInput {
                    state,
                    has_pending_approval: false,
                    has_outstanding_question: true,
                }),
                AttentionState::Normal,
                "{state} should not show a question",
            );
        }
    }

    #[test]
    fn wire_spelling_round_trips() {
        for attention in [
            AttentionState::Normal,
            AttentionState::Blocked,
            AttentionState::Failed,
            AttentionState::ReviewReady,
            AttentionState::QuestionAsked,
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
