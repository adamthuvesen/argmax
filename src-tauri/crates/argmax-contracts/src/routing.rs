//! The Auto routing vocabulary. The grid that maps it to models lives in the
//! app; the store records a decision in these terms.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::validation::{ProviderId, ReasoningEffort};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum AutoTier {
    // Legacy wire value: Speed.
    Cost,
    Economy,
    Balanced,
    Intelligence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Coding,
    Mechanical,
    Research,
    Review,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Difficulty {
    Light,
    Standard,
    Heavy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum RouteDecisionKind {
    Launch,
    Reroute,
    Escalate,
    Kept,
    Fallback,
    /// The user picked a model and routing ended. Not a turn and not a
    /// switch: the row only closes the previous route's window.
    Pinned,
}

impl RouteDecisionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RouteDecisionKind::Launch => "launch",
            RouteDecisionKind::Reroute => "reroute",
            RouteDecisionKind::Escalate => "escalate",
            RouteDecisionKind::Kept => "kept",
            RouteDecisionKind::Fallback => "fallback",
            RouteDecisionKind::Pinned => "pinned",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RouteDecision {
    pub tier: AutoTier,
    pub provider: ProviderId,
    pub model_id: String,
    pub model_label: String,
    pub effort: Option<ReasoningEffort>,
    pub kind: Option<TaskKind>,
    pub difficulty: Option<Difficulty>,
    pub kind_confidence: Option<f64>,
    pub difficulty_confidence: Option<f64>,
    pub decision: RouteDecisionKind,
    pub reason: String,
    /// Jev's raw answers as JSON (`Classification::signals_json`), when it
    /// classified this decision.
    pub signals: Option<String>,
}

pub fn kind_label(kind: TaskKind) -> &'static str {
    match kind {
        TaskKind::Coding => "coding",
        TaskKind::Mechanical => "mechanical",
        TaskKind::Research => "research",
        TaskKind::Review => "review",
        TaskKind::Question => "question",
    }
}

pub fn difficulty_label(difficulty: Difficulty) -> &'static str {
    match difficulty {
        Difficulty::Light => "light",
        Difficulty::Standard => "standard",
        Difficulty::Heavy => "heavy",
    }
}

pub fn tier_label(tier: AutoTier) -> &'static str {
    match tier {
        AutoTier::Economy => "economy",
        AutoTier::Cost => "cost",
        AutoTier::Balanced => "balanced",
        AutoTier::Intelligence => "intelligence",
    }
}
