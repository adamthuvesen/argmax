// Auto routing: pick provider, model and effort for a chat from its prompt.
// See docs/routing.md. `resolve_route` never fails — an unreachable or unsure
// classifier yields a recorded fallback, so a launch is never blocked on it.

pub mod api_key;
pub mod cost;
pub mod jev;
pub mod project_check;
pub mod reroute;
pub mod table;

use serde::{Deserialize, Serialize};
use specta::Type;

use self::{
    jev::Classification,
    table::{AutoTier, Difficulty, RoutedModel, TaskKind},
};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    ipc::{
        inputs::ProvidersLaunchInput,
        validation::{NonEmptyString, ProviderId, ReasoningEffort},
    },
    persistence::{
        database::Database,
        sessions::{find_session_by_id, SessionSummary},
        turn_routes::record_route,
    },
};

/// Below this, Jev's pick is a coin toss; treat the task as coding (the kind
/// whose cells are safest to over-serve) and round difficulty up.
const MIN_CONFIDENCE: f64 = 0.5;

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
}

/// The saved Jev key, or the error an Auto request gets without one: Auto
/// routing is only on once a key is saved in Settings.
pub fn require_api_key() -> ArgmaxResult<String> {
    api_key::stored_key().ok_or_else(|| {
        ArgmaxError::service(
            "ROUTING_NOT_CONFIGURED",
            "Auto routing needs a Jev API key. Add one in Settings → Agents.",
        )
    })
}

pub async fn resolve_route(prompt: &str, tier: AutoTier, api_key: &str) -> RouteDecision {
    match jev::classify(prompt, api_key, false).await {
        Ok(classification) => decide(tier, &classification),
        Err(error) => {
            tracing::warn!(target: "argmax::routing", "Jev classification failed: {error}");
            fallback_decision(tier, &error.to_string())
        }
    }
}

/// Rewrites an Auto launch to the routed provider, model and effort. `None`
/// for an ordinary launch. Fast mode is dropped: the grid's cells never ask
/// for it.
pub async fn route_launch(input: &mut ProvidersLaunchInput) -> ArgmaxResult<Option<RouteDecision>> {
    let Some(tier) = input.auto_tier else {
        return Ok(None);
    };
    let api_key = require_api_key()?;
    let route = resolve_route(input.prompt.as_str(), tier, &api_key).await;
    input.provider = route.provider;
    input.model_label =
        NonEmptyString::try_from(route.model_label.clone()).map_err(ArgmaxError::invalid)?;
    input.model_id =
        NonEmptyString::try_from(route.model_id.clone()).map_err(ArgmaxError::invalid)?;
    input.reasoning_effort = route.effort;
    input.fast_mode = false;
    Ok(Some(route))
}

/// Stores a launch route and returns the session re-read with its Auto fields.
pub fn record_launch_route(
    database: &Database,
    session: SessionSummary,
    route: &RouteDecision,
) -> ArgmaxResult<SessionSummary> {
    let connection = database.connection();
    record_route(&connection, &session.id, route)?;
    find_session_by_id(&connection, &session.id)
}

pub(crate) fn decide(tier: AutoTier, classification: &Classification) -> RouteDecision {
    let (kind, difficulty, notes) = settle(classification);
    let routed = table::route(tier, kind, difficulty);
    let mut reason = format!("{} · {}", kind_label(kind), difficulty_label(difficulty));
    if !notes.is_empty() {
        reason.push_str(&format!(" ({})", notes.join("; ")));
    }
    decision_from(
        tier,
        routed,
        Some(classification),
        Some((kind, difficulty)),
        RouteDecisionKind::Launch,
        reason,
    )
}

/// Applies the confidence rules: an unsure kind becomes coding, an unsure
/// difficulty rounds up one level when the higher level holds half of Jev's
/// weight.
pub(crate) fn settle(classification: &Classification) -> (TaskKind, Difficulty, Vec<&'static str>) {
    let mut notes = Vec::new();
    let kind = if classification.kind_confidence < MIN_CONFIDENCE {
        notes.push("unsure of kind, treated as coding");
        TaskKind::Coding
    } else {
        classification.kind
    };
    let mut difficulty = classification.difficulty();
    if classification.difficulty_confidence < MIN_CONFIDENCE {
        let (rounded, lowest_level) = match difficulty {
            Difficulty::Light => (Difficulty::Standard, 2),
            Difficulty::Standard | Difficulty::Heavy => (Difficulty::Heavy, 3),
        };
        // Confidence alone swings across 0.5 between identical calls, so round
        // up only when Jev puts at least half its weight on the higher level.
        let upper_weight = classification.probability_at_least(lowest_level);
        if rounded != difficulty && upper_weight.is_none_or(|p| p >= MIN_CONFIDENCE) {
            notes.push("unsure of difficulty, rounded up");
            difficulty = rounded;
        }
    }
    (kind, difficulty, notes)
}

pub(crate) fn fallback_decision(tier: AutoTier, why: &str) -> RouteDecision {
    decision_from(
        tier,
        table::fallback(tier),
        None,
        None,
        RouteDecisionKind::Fallback,
        format!("unrouted: {why}"),
    )
}

pub(crate) fn decision_from(
    tier: AutoTier,
    routed: RoutedModel,
    classification: Option<&Classification>,
    settled: Option<(TaskKind, Difficulty)>,
    decision: RouteDecisionKind,
    reason: String,
) -> RouteDecision {
    RouteDecision {
        tier,
        provider: routed.model.provider,
        model_id: routed.model.model_id.to_string(),
        model_label: routed.model.label.to_string(),
        effort: routed.effort,
        kind: settled.map(|(kind, _)| kind),
        difficulty: settled.map(|(_, difficulty)| difficulty),
        kind_confidence: classification.map(|c| c.kind_confidence),
        difficulty_confidence: classification.map(|c| c.difficulty_confidence),
        decision,
        reason,
    }
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
        AutoTier::Cost => "cost",
        AutoTier::Balanced => "balanced",
        AutoTier::Intelligence => "intelligence",
    }
}

pub fn parse_tier(value: &str) -> Option<AutoTier> {
    match value {
        "cost" => Some(AutoTier::Cost),
        "balanced" => Some(AutoTier::Balanced),
        "intelligence" => Some(AutoTier::Intelligence),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classification(
        kind: TaskKind,
        kind_confidence: f64,
        score: f64,
        difficulty_confidence: f64,
    ) -> Classification {
        Classification {
            kind,
            kind_confidence,
            difficulty_score: score,
            difficulty_confidence,
            level_probabilities: None,
            correction: None,
        }
    }

    #[test]
    fn confident_classification_routes_its_own_cell() {
        let decision = decide(
            AutoTier::Intelligence,
            &classification(TaskKind::Review, 0.9, 2.0, 0.8),
        );
        assert_eq!(decision.model_id, "gpt-6-astra");
        assert_eq!(decision.effort, Some(ReasoningEffort::High));
        assert_eq!(decision.decision, RouteDecisionKind::Launch);
        assert_eq!(decision.reason, "review · standard");
    }

    #[test]
    fn unsure_kind_is_treated_as_coding_and_unsure_difficulty_rounds_up() {
        let decision = decide(
            AutoTier::Balanced,
            &classification(TaskKind::Question, 0.4, 1.0, 0.3),
        );
        // coding · light → standard → Balanced Value cell.
        assert_eq!(decision.model_id, "claude-opus-5-5");
        assert_eq!(decision.kind, Some(TaskKind::Coding));
        assert_eq!(decision.difficulty, Some(Difficulty::Standard));
        assert!(
            decision.reason.contains("treated as coding"),
            "{}",
            decision.reason
        );
        assert!(
            decision.reason.contains("rounded up"),
            "{}",
            decision.reason
        );
    }

    #[test]
    fn unsure_difficulty_rounds_up_only_when_the_higher_level_holds_half_the_weight() {
        // Split measured on "implement the translucent sidebar for the full
        // app" (2026-09-27): moderate 0.48, hard 0.41.
        let split = Classification {
            level_probabilities: Some([0.0, 0.11, 0.48, 0.41, 0.0]),
            ..classification(TaskKind::Coding, 1.0, 2.3, 0.45)
        };
        let decision = decide(AutoTier::Balanced, &split);
        assert_eq!(decision.difficulty, Some(Difficulty::Standard));
        assert_eq!(decision.effort, Some(ReasoningEffort::Medium));
        assert_eq!(decision.reason, "coding · standard");

        let leaning_hard = Classification {
            level_probabilities: Some([0.0, 0.05, 0.4, 0.5, 0.05]),
            ..split
        };
        let decision = decide(AutoTier::Balanced, &leaning_hard);
        assert_eq!(decision.difficulty, Some(Difficulty::Heavy));
        assert_eq!(decision.effort, Some(ReasoningEffort::High));
    }

    #[test]
    fn fallback_is_recorded_as_unrouted_and_follows_the_tier() {
        let decision = fallback_decision(AutoTier::Cost, "Jev request failed");
        assert_eq!(decision.model_id, "composer-2.5");
        assert_eq!(decision.effort, None);
        assert_eq!(decision.decision, RouteDecisionKind::Fallback);
        assert_eq!(decision.kind, None);
        assert_eq!(decision.reason, "unrouted: Jev request failed");
    }
}
