//! A Goal is one free-text completion condition attached to a chat.
//!
//! After every turn a small, cheap model reads the transcript tail and returns
//! one of three verdicts: the condition holds, it does not hold yet, or it
//! cannot be met. "Not yet" feeds its reason back as guidance and the chat
//! takes another turn on its own. The evaluator runs without tools, so it
//! judges only what the agent actually surfaced in the conversation — it
//! cannot go looking for evidence the agent never showed.

pub mod service;

use serde::{Deserialize, Serialize};
use specta::Type;

/// Turn ceiling when the caller does not pick one. A goal that has not landed
/// in twenty turns is not one more turn away from landing.
pub const DEFAULT_MAX_TURNS: u32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum GoalState {
    Active,
    Achieved,
    Impossible,
    Stopped,
}

impl GoalState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Achieved => "achieved",
            Self::Impossible => "impossible",
            Self::Stopped => "stopped",
        }
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "achieved" => Some(Self::Achieved),
            "impossible" => Some(Self::Impossible),
            "stopped" => Some(Self::Stopped),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub workspace_id: String,
    pub session_id: String,
    /// The whole configuration: one free-text completion condition.
    pub condition: String,
    pub state: GoalState,
    /// Turns the evaluator has judged.
    pub turns: u32,
    /// Enforced ceiling; the goal stops and hands back when reached.
    pub max_turns: u32,
    /// The evaluator's most recent reason, shown in the UI.
    pub last_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// What the evaluator decided about one turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalVerdict {
    Met,
    NotYet,
    Impossible,
}
