use serde::{Deserialize, Serialize};
use specta::Type;

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
