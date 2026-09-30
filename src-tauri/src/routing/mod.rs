// Auto routing: pick provider, model and effort for a chat from its prompt.
// See docs/routing.md. `resolve_route` never fails — an unreachable or unsure
// classifier yields a recorded fallback, so a launch is never blocked on it.

pub mod api_key;
pub mod context;
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
/// An unsure kind still keeps Jev's top pick when coding trails it by more
/// than this: "Does this look right?" scored review 0.58, coding 0.04.
const CODING_MARGIN: f64 = 0.15;
/// Balance runs heavy work at high effort only when Jev puts this much weight
/// on hard or very hard; otherwise medium, and a follow-up can climb.
const BALANCED_HIGH_EFFORT: f64 = 0.6;

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

/// Provider order when the grid's pick is not installed. Matches the launcher.
const AVAILABLE_PROVIDER_ORDER: [ProviderId; 5] = [
    ProviderId::Claude,
    ProviderId::Codex,
    ProviderId::Cursor,
    ProviderId::Grok,
    ProviderId::Opencode,
];

/// Rewrites an Auto launch to the routed provider, model and effort. `None`
/// for an ordinary launch. Fast mode is dropped: the grid's cells never ask
/// for it. `available` is the providers whose CLI is installed and not known
/// to be logged out. An empty list means discovery learned nothing, so the
/// grid's pick is left alone.
pub async fn route_launch(
    input: &mut ProvidersLaunchInput,
    available: &[ProviderId],
) -> ArgmaxResult<Option<RouteDecision>> {
    let Some(tier) = input.auto_tier else {
        return Ok(None);
    };
    let api_key = require_api_key()?;
    let route = with_available_provider(
        resolve_route(input.prompt.as_str(), tier, &api_key).await,
        available,
    );
    input.provider = route.provider;
    input.model_label =
        NonEmptyString::try_from(route.model_label.clone()).map_err(ArgmaxError::invalid)?;
    input.model_id =
        NonEmptyString::try_from(route.model_id.clone()).map_err(ArgmaxError::invalid)?;
    input.reasoning_effort = route.effort;
    input.fast_mode = false;
    Ok(Some(route))
}

/// Moves a route onto an installed provider when the grid picked one that is
/// not. The same tier, kind and difficulty stay; only the provider's own
/// follow-up model changes. An empty `available` is "unknown", not "none".
pub(crate) fn with_available_provider(
    mut route: RouteDecision,
    available: &[ProviderId],
) -> RouteDecision {
    if available.is_empty() || available.contains(&route.provider) {
        return route;
    }
    let Some(provider) = AVAILABLE_PROVIDER_ORDER
        .into_iter()
        .find(|provider| available.contains(provider))
    else {
        return route;
    };
    let previous = route.provider;
    let target = if route.tier == AutoTier::Economy
        && provider == ProviderId::Claude
        && route.kind != Some(TaskKind::Review)
    {
        // Launch substitution has no native conversation to preserve. Use
        // Sonnet for budget work instead of the Opus follow-up target.
        let heavy =
            route.difficulty == Some(Difficulty::Heavy) && route.kind != Some(TaskKind::Mechanical);
        Some(RoutedModel {
            model: if heavy { &table::OPUS } else { &table::SONNET },
            effort: route.effort,
        })
    } else {
        route
            .kind
            .zip(route.difficulty)
            .and_then(|(kind, difficulty)| {
                table::follow_up_target(provider, route.tier, kind, difficulty, false)
            })
    };
    if let Some(routed) = target {
        route.provider = routed.model.provider;
        route.model_id = routed.model.model_id.to_string();
        route.model_label = routed.model.label.to_string();
        route.effort = routed.effort;
    }
    if route.provider == previous {
        let defaults = crate::provider_defaults(provider.as_str());
        route.provider = provider;
        route.model_id = defaults.model_id.to_string();
        route.model_label = defaults.model_label.to_string();
        route.effort = defaults
            .reasoning_effort
            .and_then(|value| serde_json::from_value(serde_json::json!(value)).ok());
    }
    route.reason = format!("{} ({} unavailable)", route.reason, previous.as_str());
    route
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
    let (kind, difficulty, mut notes) = settle(classification);
    let grid_difficulty = if tier == AutoTier::Balanced
        && difficulty == Difficulty::Heavy
        && classification.probability_at_least_bucket(Difficulty::Heavy) < BALANCED_HIGH_EFFORT
    {
        // Not confident it is heavy, so launch the standard cell at medium.
        // Standard coding and research are Sonnet at high on their own.
        notes.push("not sure it is hard, medium effort");
        Difficulty::Standard
    } else {
        difficulty
    };
    let mut routed = table::route(tier, kind, grid_difficulty, classification.is_ui());
    if grid_difficulty != difficulty
        && routed
            .effort
            .is_some_and(|effort| table::rank(effort) > table::rank(ReasoningEffort::Medium))
    {
        routed.effort = Some(ReasoningEffort::Medium);
    }
    let mut reason = format!("{} · {}", kind_label(kind), difficulty_label(difficulty));
    if classification.is_ui() {
        reason.push_str(" · UI");
    }
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
    let coding_trails = classification
        .kind_probability(TaskKind::Coding)
        .zip(classification.kind_probability(classification.kind))
        .is_some_and(|(coding, top)| top - coding > CODING_MARGIN);
    let kind = if classification.kind_confidence >= MIN_CONFIDENCE {
        classification.kind
    } else if coding_trails {
        notes.push("unsure of kind, kept the likeliest");
        classification.kind
    } else {
        notes.push("unsure of kind, treated as coding");
        TaskKind::Coding
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
        signals: classification.map(Classification::signals_json),
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
        AutoTier::Economy => "economy",
        AutoTier::Cost => "cost",
        AutoTier::Balanced => "balanced",
        AutoTier::Intelligence => "intelligence",
    }
}

pub fn parse_tier(value: &str) -> Option<AutoTier> {
    match value {
        "economy" => Some(AutoTier::Economy),
        "cost" => Some(AutoTier::Cost),
        "balanced" => Some(AutoTier::Balanced),
        "intelligence" => Some(AutoTier::Intelligence),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_uses_sonnet_when_codex_is_unavailable() {
        let route = fallback_decision(AutoTier::Economy, "classifier unavailable");
        let route = with_available_provider(route, &[ProviderId::Claude]);
        assert_eq!(route.tier, AutoTier::Economy);
        assert_eq!(route.provider, ProviderId::Claude);
        assert_eq!(route.model_id, "claude-sonnet-5-5");
        assert_eq!(
            route.effort,
            Some(crate::ipc::validation::ReasoningEffort::Medium)
        );
    }

    #[test]
    fn tiers_round_trip_and_legacy_cost_keeps_speed() {
        for tier in [
            AutoTier::Cost,
            AutoTier::Economy,
            AutoTier::Balanced,
            AutoTier::Intelligence,
        ] {
            assert_eq!(parse_tier(tier_label(tier)), Some(tier));
            assert_eq!(serde_json::to_value(tier).unwrap(), tier_label(tier));
        }
        assert_eq!(parse_tier("cost"), Some(AutoTier::Cost));
        assert_eq!(parse_tier("economy"), Some(AutoTier::Economy));
    }

    #[test]
    fn an_uninstalled_grid_pick_moves_to_an_installed_provider() {
        // Light mechanical work is the Speed cell that still launches Cursor.
        let route = decide(
            AutoTier::Cost,
            &classification(TaskKind::Mechanical, 1.0, 0.2, 0.9),
        );
        assert_eq!(route.provider, ProviderId::Cursor);
        assert_eq!(route.model_id, "composer-2.5");
        let moved = with_available_provider(route, &[ProviderId::Claude]);
        assert_eq!(moved.provider, ProviderId::Claude);
        assert_eq!(moved.model_id, "claude-sonnet-5-5");
        assert!(moved.reason.contains("cursor unavailable"));
    }

    #[test]
    fn unknown_availability_keeps_the_grid_pick() {
        let route = fallback_decision(AutoTier::Cost, "test");
        let kept = with_available_provider(route.clone(), &[]);
        assert_eq!(kept, route);
    }

    fn classification(
        kind: TaskKind,
        kind_confidence: f64,
        score: f64,
        difficulty_confidence: f64,
    ) -> Classification {
        Classification {
            kind,
            kind_confidence,
            kind_probabilities: None,
            difficulty_score: score,
            difficulty_confidence,
            level_probabilities: None,
            correction: None,
            follow_up_scope: None,
            scope_confidence: None,
            simpler_task: None,
            resume_route: None,
            resume_confidence: None,
            ui: None,
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
        // coding · light → standard → Balance standard coding is Sonnet high.
        assert_eq!(decision.model_id, "claude-sonnet-5-5");
        assert_eq!(decision.effort, Some(ReasoningEffort::High));
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
        assert_eq!(decision.effort, Some(ReasoningEffort::High));
        assert_eq!(decision.reason, "coding · standard");

        let leaning_hard = Classification {
            level_probabilities: Some([0.0, 0.0, 0.35, 0.6, 0.05]),
            ..split
        };
        let decision = decide(AutoTier::Balanced, &leaning_hard);
        assert_eq!(decision.difficulty, Some(Difficulty::Heavy));
        assert_eq!(decision.effort, Some(ReasoningEffort::High));
    }

    #[test]
    fn unsure_kind_keeps_the_likeliest_when_coding_trails() {
        let review = Classification {
            kind_probabilities: Some([0.04, 0.0, 0.16, 0.58, 0.22]),
            ..classification(TaskKind::Review, 0.48, 2.0, 0.8)
        };
        assert_eq!(
            decide(AutoTier::Balanced, &review).kind,
            Some(TaskKind::Review)
        );
        let close = Classification {
            kind_probabilities: Some([0.40, 0.48, 0.0, 0.0, 0.12]),
            ..classification(TaskKind::Mechanical, 0.48, 1.0, 0.8)
        };
        assert_eq!(
            decide(AutoTier::Balanced, &close).kind,
            Some(TaskKind::Coding)
        );
    }

    #[test]
    fn balance_runs_heavy_work_high_only_when_jev_leans_hard() {
        let leaning = Classification {
            level_probabilities: Some([0.0, 0.05, 0.4, 0.45, 0.1]),
            ..classification(TaskKind::Coding, 1.0, 2.7, 0.45)
        };
        let decision = decide(AutoTier::Balanced, &leaning);
        assert_eq!(decision.difficulty, Some(Difficulty::Heavy));
        assert_eq!(decision.model_id, "claude-sonnet-5-5");
        assert_eq!(decision.effort, Some(ReasoningEffort::Medium));
        assert!(
            decision.reason.contains("medium effort"),
            "{}",
            decision.reason
        );
        let hard = Classification {
            level_probabilities: Some([0.0, 0.0, 0.2, 0.6, 0.2]),
            ..leaning.clone()
        };
        assert_eq!(
            decide(AutoTier::Balanced, &hard).effort,
            Some(ReasoningEffort::High)
        );
        // Frontier keeps high either way.
        assert_eq!(
            decide(AutoTier::Intelligence, &leaning).effort,
            Some(ReasoningEffort::High)
        );
    }

    #[test]
    fn balanced_ui_work_leaves_composer_and_records_its_signals() {
        let ui = Classification {
            ui: Some(0.97),
            ..classification(TaskKind::Mechanical, 1.0, 1.0, 0.8)
        };
        let decision = decide(AutoTier::Balanced, &ui);
        assert_eq!(decision.model_id, "claude-opus-5-5");
        assert_eq!(decision.effort, Some(ReasoningEffort::Low));
        assert_eq!(decision.reason, "mechanical · light · UI");
        let signals: serde_json::Value =
            serde_json::from_str(decision.signals.as_deref().expect("signals")).unwrap();
        assert_eq!(signals["ui"], 0.97);
    }

    #[test]
    fn fallback_is_recorded_as_unrouted_and_follows_the_tier() {
        let decision = fallback_decision(AutoTier::Cost, "Jev request failed");
        assert_eq!(decision.model_id, "claude-sonnet-5-5");
        assert_eq!(decision.effort, Some(ReasoningEffort::Medium));
        assert_eq!(decision.decision, RouteDecisionKind::Fallback);
        assert_eq!(decision.kind, None);
        assert_eq!(decision.reason, "unrouted: Jev request failed");
    }
}
