// The session lifecycle, owned in one place.
//
// Before this existed, a session's state was a `&str` threaded through ~15
// signatures and spelled out as a literal in a dozen files, and every writer
// had to remember to derive `attention` alongside it. A typo compiled; a
// forgotten attention update shipped a stale pill. Both are now compile
// errors: `SessionState` is the only spelling, and `SessionStateInput` can
// only be built through `transition`, which derives attention for you.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::attention::{compute_session_attention, AttentionState, SessionAttentionInput};

/// The seven states a session can hold. The wire spelling is the lowercase
/// variant name, which is what the `sessions.state` column and the renderer's
/// `SessionState` union have always carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Created,
    Running,
    Waiting,
    Blocked,
    Complete,
    Failed,
    Cancelled,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::Created => "created",
            SessionState::Running => "running",
            SessionState::Waiting => "waiting",
            SessionState::Blocked => "blocked",
            SessionState::Complete => "complete",
            SessionState::Failed => "failed",
            SessionState::Cancelled => "cancelled",
        }
    }

    /// Parse a persisted or provider-supplied spelling. `None` for anything
    /// outside the union — callers decide whether that is fatal or a warning.
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "created" => Some(SessionState::Created),
            "running" => Some(SessionState::Running),
            "waiting" => Some(SessionState::Waiting),
            "blocked" => Some(SessionState::Blocked),
            "complete" => Some(SessionState::Complete),
            "failed" => Some(SessionState::Failed),
            "cancelled" => Some(SessionState::Cancelled),
            _ => None,
        }
    }

    /// A turn is under way, counting the two ways it can be paused on the
    /// person: an approval to answer (`waiting`), or a refusal to work around
    /// (`blocked`). `created` is not here: no launch has happened, so there is
    /// nothing to wait on, stop, or drain.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            SessionState::Running | SessionState::Waiting | SessionState::Blocked
        )
    }

    /// The turn is over: nothing more arrives without a new launch. What
    /// `session_wait` waits for and what releases a queued follow-up.
    pub fn is_settled(self) -> bool {
        !self.is_active()
    }

    /// A provider process is expected to be producing output — `blocked` is
    /// not, which is why this is narrower than [`SessionState::is_active`].
    pub fn is_live(self) -> bool {
        matches!(self, SessionState::Running | SessionState::Waiting)
    }

    /// The attention pill this state implies on its own, before pending
    /// approvals are taken into account.
    pub fn attention(self) -> AttentionState {
        compute_session_attention(SessionAttentionInput {
            state: self,
            has_pending_approval: false,
            has_outstanding_question: false,
        })
    }
}

impl std::fmt::Display for SessionState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_spelling_round_trips() {
        for state in [
            SessionState::Created,
            SessionState::Running,
            SessionState::Waiting,
            SessionState::Blocked,
            SessionState::Complete,
            SessionState::Failed,
            SessionState::Cancelled,
        ] {
            assert_eq!(SessionState::from_wire(state.as_str()), Some(state));
            assert_eq!(
                serde_json::to_value(state).expect("serialize"),
                serde_json::Value::String(state.as_str().to_string()),
                "serde spelling must match as_str, the column value",
            );
        }
    }

    #[test]
    fn unknown_spelling_is_rejected() {
        assert_eq!(SessionState::from_wire("idle"), None);
        assert_eq!(SessionState::from_wire(""), None);
    }

    #[test]
    fn only_a_turn_in_flight_is_active() {
        for state in [
            SessionState::Created,
            SessionState::Complete,
            SessionState::Failed,
            SessionState::Cancelled,
        ] {
            assert!(state.is_settled(), "{state} should be settled");
            assert!(!state.is_active(), "{state} should not be active");
        }
        for state in [
            SessionState::Running,
            SessionState::Waiting,
            SessionState::Blocked,
        ] {
            assert!(state.is_active(), "{state} should still be active");
            assert!(!state.is_settled(), "{state} should not be settled");
        }
    }

    /// `blocked` is active — the work is not finished — but nothing is running,
    /// which is the distinction the approval and flush paths turn on.
    #[test]
    fn live_is_narrower_than_active() {
        assert!(SessionState::Running.is_live());
        assert!(SessionState::Waiting.is_live());
        assert!(!SessionState::Blocked.is_live());
        assert!(SessionState::Blocked.is_active());
        assert!(!SessionState::Created.is_live());
    }
}
