// Follow-up routing for Auto chats. A chat is routed once at launch; after
// that its model or effort changes only when the change is free or pays for
// itself, because every switch throws away the prompt cache (docs/routing.md).
// Crossing providers is never automatic — no CLI resumes another's
// conversation — so a candidate on another provider keeps the chat where it is.

use std::time::Duration;

use super::{
    decision_from,
    jev::Classification,
    settle,
    table::{self, AutoTier, RouteModel, RoutedModel},
    RouteDecision, RouteDecisionKind,
};
use crate::{
    ipc::validation::{ProviderId, ReasoningEffort},
    providers::pricing::{cost_of, list_price, UsageCounts},
};

/// Escalate only when the user is clearly unhappy with the work (failing,
/// disliked, or to be redone): those score 0.90+; a preference or "what
/// about…" scores 0.16 or less.
const CORRECTION_THRESHOLD: f64 = 0.85;
/// Confidence Jev needs before an upgrade may skip the break-even test.
const UPGRADE_CONFIDENCE: f64 = 0.7;
/// A downgrade must repay the cache it discards within this many turns: the
/// median chat ends after two.
const BREAK_EVEN_TURNS: f64 = 2.0;

use ReasoningEffort::{High, Low, Max, Medium, Xhigh};

/// Escalation rungs per provider, weakest first. The Claude ladder ends on
/// Fable 5.1, which reads Opus 5.5's thinking blocks, so escalating keeps the
/// reasoning so far. Cursor climbs from Composer to Opus 5.5 inside the same
/// Cursor conversation. The cheap OpenCode and Grok ladders end by handing the
/// chat to Opus 5.5 on Claude Code: those models fail most often, and a user
/// still unhappy at their top needs a stronger model, not more effort on a
/// weak one. That last rung is the one automatic provider switch; the chat
/// continues from its visible transcript.
fn ladder(provider: ProviderId) -> &'static [(&'static RouteModel, Option<ReasoningEffort>)] {
    match provider {
        ProviderId::Claude => &[
            (&table::OPUS, Some(Medium)),
            (&table::OPUS, Some(High)),
            // The user's preference: past Opus high, move to Fable rather than
            // pushing Opus to xhigh or max.
            (&table::FABLE, Some(High)),
            (&table::FABLE, Some(Xhigh)),
        ],
        ProviderId::Codex => &[
            (&table::SOL, Some(Medium)),
            (&table::SOL, Some(High)),
            (&table::ASTRA, Some(High)),
            (&table::ASTRA, Some(Xhigh)),
        ],
        // Grok's higher efforts measured slower (medium +26 s over four tasks)
        // with no quality evidence, so a failing Grok chat goes straight to Opus.
        ProviderId::Grok => &[(&table::GROK, Some(Low)), (&table::OPUS, Some(High))],
        ProviderId::Opencode => &[
            (&table::DEEPSEEK_FLASH, Some(High)),
            (&table::DEEPSEEK_FLASH, Some(Max)),
            (&table::OPUS, Some(High)),
        ],
        ProviderId::Cursor => &[
            (&table::COMPOSER, None),
            (&table::CURSOR_OPUS, Some(Medium)),
            (&table::CURSOR_OPUS, Some(High)),
        ],
    }
}

/// How long a provider keeps a prompt cache warm. Past this a switch costs
/// nothing the chat still has.
pub fn cache_ttl(provider: ProviderId) -> Duration {
    match provider {
        ProviderId::Codex => Duration::from_secs(30 * 60),
        _ => Duration::from_secs(5 * 60),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FollowUpState {
    pub tier: AutoTier,
    pub provider: ProviderId,
    pub model_id: String,
    pub effort: Option<ReasoningEffort>,
    /// Time since the chat's last activity, read before this follow-up
    /// touches the row.
    pub idle: Duration,
    /// Input-side tokens of the latest turn: what a switch has to re-read.
    pub context_tokens: u64,
    /// Everything the chat's latest turn billed, used to price a turn on the
    /// candidate model.
    pub last_turn: UsageCounts,
    /// Time since the router last changed this chat's model or effort.
    pub since_last_switch: Option<Duration>,
}

/// The decision for one follow-up. `decision` is `Reroute` or `Escalate` when
/// the chat should move to the returned model and effort, `Kept` otherwise.
pub fn follow_up_route(state: &FollowUpState, classification: &Classification) -> RouteDecision {
    let (kind, difficulty, notes) = settle(classification);
    let settled = Some((kind, difficulty));
    let summary = format!(
        "{} · {}",
        super::kind_label(kind),
        super::difficulty_label(difficulty)
    );

    if classification.correction.unwrap_or(0.0) >= CORRECTION_THRESHOLD {
        return match next_rung(state.provider, &state.model_id, state.effort) {
            Some(rung) => decision_from(
                state.tier,
                rung,
                Some(classification),
                settled,
                RouteDecisionKind::Escalate,
                format!("{summary} (escalated: the last answer was reported wrong)"),
            ),
            None => kept(
                state,
                classification,
                settled,
                format!(
                    "{summary} (the last answer was reported wrong, but this is the top of the {} ladder)",
                    state.provider.as_str()
                ),
            ),
        };
    }

    let candidate = table::route(state.tier, kind, difficulty);
    let mut reason = summary;
    if !notes.is_empty() {
        reason.push_str(&format!(" ({})", notes.join("; ")));
    }
    if candidate.model.model_id == state.model_id && candidate.effort == state.effort {
        return kept(state, classification, settled, reason);
    }
    if candidate.model.provider != state.provider {
        return kept(
            state,
            classification,
            settled,
            format!(
                "{reason}; routes to {} on another provider, staying",
                candidate.model.label
            ),
        );
    }
    if state.provider == ProviderId::Cursor {
        return kept(
            state,
            classification,
            settled,
            format!("{reason}; Cursor usage is unpriced, staying"),
        );
    }
    let ttl = cache_ttl(state.provider);
    if state.since_last_switch.is_some_and(|since| since < ttl) {
        return kept(
            state,
            classification,
            settled,
            format!("{reason}; switched within the cache window, staying"),
        );
    }

    let cache_is_cold = state.idle >= ttl;
    let is_upgrade = strength(candidate.model.model_id, candidate.effort)
        > strength(&state.model_id, state.effort);
    let confident_upgrade = is_upgrade
        && classification.kind_confidence >= UPGRADE_CONFIDENCE
        && classification.difficulty_confidence >= UPGRADE_CONFIDENCE;
    let pays_back = switch_pays_back(state, candidate);
    let why = if cache_is_cold {
        "cache already expired"
    } else if confident_upgrade {
        "confident upgrade"
    } else if pays_back {
        "the switch pays back within two turns"
    } else {
        return kept(
            state,
            classification,
            settled,
            format!(
                "{reason}; {} would not repay the cache it discards, staying",
                candidate.model.label
            ),
        );
    };
    decision_from(
        state.tier,
        candidate,
        Some(classification),
        settled,
        RouteDecisionKind::Reroute,
        format!("{reason}; {why}"),
    )
}

/// Escalates a chat one rung for a reason outside the classifier, such as a
/// Goal that keeps coming back "not yet". `None` at the top of the ladder.
pub fn escalate(
    tier: AutoTier,
    provider: ProviderId,
    model_id: &str,
    effort: Option<ReasoningEffort>,
    reason: &str,
) -> Option<RouteDecision> {
    next_rung(provider, model_id, effort).map(|rung| {
        decision_from(
            tier,
            rung,
            None,
            None,
            RouteDecisionKind::Escalate,
            reason.to_string(),
        )
    })
}

/// The next rung up a provider's ladder above the given model and effort. A
/// chat on a rung climbs to the one after it; a chat that is not on the ladder
/// (a hand-routed effort, say) goes to the first stronger rung. Position, not
/// price, orders a ladder: Cursor's models carry no price in Argmax, so price
/// alone would call Composer and Opus equal.
pub fn next_rung(
    provider: ProviderId,
    model_id: &str,
    effort: Option<ReasoningEffort>,
) -> Option<RoutedModel> {
    let rungs = ladder(provider);
    let next = match rungs
        .iter()
        .position(|(model, rung_effort)| model.model_id == model_id && *rung_effort == effort)
    {
        Some(index) => rungs.get(index + 1),
        None => {
            let current = strength(model_id, effort);
            rungs
                .iter()
                .find(|(model, rung_effort)| strength(model.model_id, *rung_effort) > current)
        }
    };
    next.map(|(model, effort)| RoutedModel {
        model,
        effort: *effort,
    })
}

/// Orders models by list output price, then effort — the order the ladders
/// climb in.
fn strength(model_id: &str, effort: Option<ReasoningEffort>) -> (u64, usize) {
    let price = list_price(model_id).map_or(0, |price| (price.output * 1000.0) as u64);
    (price, effort.map_or(0, table::rank))
}

/// A switch re-reads the whole context uncached on the new model (a cache
/// write, or plain input where the provider bills no separate write), where
/// staying would have read it from cache. It pays back when the candidate's
/// cheaper turns repay that within `BREAK_EVEN_TURNS`.
fn switch_pays_back(state: &FollowUpState, candidate: RoutedModel) -> bool {
    let (Some(old), Some(new)) = (
        list_price(&state.model_id),
        list_price(candidate.model.model_id),
    ) else {
        return false;
    };
    let write_new = if new.cache_write > 0.0 {
        new.cache_write
    } else {
        new.input
    };
    let penalty = state.context_tokens as f64 * (write_new - old.cache_read) / 1_000_000.0;
    let saving = cost_of(state.last_turn, &state.model_id)
        - cost_of(state.last_turn, candidate.model.model_id);
    penalty <= BREAK_EVEN_TURNS * saving
}

fn kept(
    state: &FollowUpState,
    classification: &Classification,
    settled: Option<(table::TaskKind, table::Difficulty)>,
    reason: String,
) -> RouteDecision {
    RouteDecision {
        tier: state.tier,
        provider: state.provider,
        model_id: state.model_id.clone(),
        model_label: table::route_model(&state.model_id)
            .map_or_else(|| state.model_id.clone(), |model| model.label.to_string()),
        effort: state.effort,
        kind: settled.map(|(kind, _)| kind),
        difficulty: settled.map(|(_, difficulty)| difficulty),
        kind_confidence: Some(classification.kind_confidence),
        difficulty_confidence: Some(classification.difficulty_confidence),
        decision: RouteDecisionKind::Kept,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::table::TaskKind;

    const MINUTE: Duration = Duration::from_secs(60);

    // The median real Opus 5.5 turn: 4 calls, 737k cache reads, 14k written.
    fn median_turn() -> UsageCounts {
        UsageCounts {
            input: 2_000,
            output: 2_500,
            cache_read: 737_000,
            cache_write: 14_000,
        }
    }

    fn state(
        provider: ProviderId,
        model_id: &str,
        effort: Option<ReasoningEffort>,
    ) -> FollowUpState {
        FollowUpState {
            tier: AutoTier::Balanced,
            provider,
            model_id: model_id.to_string(),
            effort,
            idle: MINUTE,
            context_tokens: 168_000,
            last_turn: median_turn(),
            since_last_switch: None,
        }
    }

    fn classified(kind: TaskKind, score: f64, confidence: f64) -> Classification {
        Classification {
            kind,
            kind_confidence: confidence,
            difficulty_score: score,
            difficulty_confidence: confidence,
            correction: Some(0.2),
        }
    }

    #[test]
    fn a_cold_cache_makes_any_same_provider_switch_free() {
        // Balanced coding · standard → Opus medium; the chat runs Opus high,
        // idle past Claude's five-minute cache.
        let mut cold = state(ProviderId::Claude, "claude-opus-5-5", Some(High));
        cold.idle = 6 * MINUTE;
        let decision = follow_up_route(&cold, &classified(TaskKind::Coding, 2.0, 0.6));
        assert_eq!(
            decision.decision,
            RouteDecisionKind::Reroute,
            "{}",
            decision.reason
        );
        assert_eq!(decision.effort, Some(Medium));
        assert!(
            decision.reason.contains("cache already expired"),
            "{}",
            decision.reason
        );
    }

    #[test]
    fn a_much_cheaper_model_pays_back_at_median_context_and_an_equal_one_does_not() {
        let chat = state(ProviderId::Codex, "gpt-6-astra", Some(High));
        let sol = RoutedModel {
            model: &table::SOL,
            effort: Some(Medium),
        };
        assert!(switch_pays_back(&chat, sol));
        let opus = state(ProviderId::Claude, "claude-opus-5-5", Some(High));
        let same_model = RoutedModel {
            model: &table::OPUS,
            effort: Some(Medium),
        };
        assert!(!switch_pays_back(&opus, same_model));
    }

    #[test]
    fn an_effort_only_downgrade_on_a_warm_cache_is_refused() {
        // Balanced coding · standard → Opus medium; the chat runs Opus high.
        let chat = state(ProviderId::Claude, "claude-opus-5-5", Some(High));
        let decision = follow_up_route(&chat, &classified(TaskKind::Coding, 2.0, 0.6));
        assert_eq!(
            decision.decision,
            RouteDecisionKind::Kept,
            "{}",
            decision.reason
        );
        assert_eq!(decision.effort, Some(High));
        assert!(
            decision.reason.contains("would not repay"),
            "{}",
            decision.reason
        );
    }

    #[test]
    fn a_confident_upgrade_skips_the_break_even_test() {
        // Balanced coding · heavy → Opus high; the chat runs Opus medium.
        let chat = state(ProviderId::Claude, "claude-opus-5-5", Some(Medium));
        let decision = follow_up_route(&chat, &classified(TaskKind::Coding, 3.4, 0.9));
        assert_eq!(
            decision.decision,
            RouteDecisionKind::Reroute,
            "{}",
            decision.reason
        );
        assert_eq!(decision.effort, Some(High));
    }

    #[test]
    fn a_candidate_on_another_provider_keeps_the_chat() {
        // Balanced question · light → Grok; the chat is on Claude.
        let chat = state(ProviderId::Claude, "claude-opus-5-5", Some(Medium));
        let decision = follow_up_route(&chat, &classified(TaskKind::Question, 0.0, 0.9));
        assert_eq!(decision.decision, RouteDecisionKind::Kept);
        assert_eq!(decision.model_id, "claude-opus-5-5");
        assert!(
            decision.reason.contains("another provider"),
            "{}",
            decision.reason
        );
    }

    #[test]
    fn a_recent_switch_blocks_another_within_the_cache_window() {
        let mut chat = state(ProviderId::Claude, "claude-opus-5-5", Some(High));
        chat.idle = 6 * MINUTE;
        chat.since_last_switch = Some(2 * MINUTE);
        let decision = follow_up_route(&chat, &classified(TaskKind::Coding, 2.0, 0.6));
        assert_eq!(decision.decision, RouteDecisionKind::Kept);
        assert!(
            decision.reason.contains("cache window"),
            "{}",
            decision.reason
        );
    }

    #[test]
    fn a_reported_wrong_answer_climbs_one_rung_and_stops_at_the_top() {
        let mut correction = classified(TaskKind::Coding, 2.0, 0.9);
        correction.correction = Some(0.85);

        let climbs = [
            (
                "claude-opus-5-5",
                Some(High),
                "claude-fable-5-1",
                Some(High),
            ),
            (
                "claude-fable-5-1",
                Some(High),
                "claude-fable-5-1",
                Some(Xhigh),
            ),
            (
                "claude-opus-5-5",
                Some(Medium),
                "claude-opus-5-5",
                Some(High),
            ),
            ("gpt-6-sol", Some(High), "gpt-6-astra", Some(High)),
            ("composer-2.5", None, "claude-opus-5-5-medium", Some(Medium)),
            (
                "claude-opus-5-5-medium",
                Some(Medium),
                "claude-opus-5-5-medium",
                Some(High),
            ),
            (
                "opencode-go/deepseek-v4.1-flash",
                Some(High),
                "opencode-go/deepseek-v4.1-flash",
                Some(Max),
            ),
            (
                "opencode-go/deepseek-v4.1-flash",
                Some(Max),
                "claude-opus-5-5",
                Some(High),
            ),
            ("grok-4.7", Some(Low), "claude-opus-5-5", Some(High)),
            ("grok-4.7", Some(Medium), "claude-opus-5-5", Some(High)),
        ];
        for (model, effort, next_model, next_effort) in climbs {
            let provider = table::route_model(model).expect("grid model").provider;
            let decision = follow_up_route(&state(provider, model, effort), &correction);
            assert_eq!(decision.decision, RouteDecisionKind::Escalate, "{model}");
            assert_eq!(
                (decision.model_id.as_str(), decision.effort),
                (next_model, next_effort)
            );
            // A cheap ladder's last rung hands the chat to Claude Code.
            let next_provider = table::route_model(next_model).expect("grid model").provider;
            assert_eq!(decision.provider, next_provider, "{model} -> {next_model}");
        }

        let top = follow_up_route(
            &state(ProviderId::Claude, "claude-fable-5-1", Some(Xhigh)),
            &correction,
        );
        assert_eq!(top.decision, RouteDecisionKind::Kept);
        assert!(
            top.reason.contains("top of the claude ladder"),
            "{}",
            top.reason
        );

        let cursor_top = follow_up_route(
            &state(ProviderId::Cursor, "claude-opus-5-5-medium", Some(High)),
            &correction,
        );
        assert_eq!(cursor_top.decision, RouteDecisionKind::Kept);
        assert!(
            cursor_top.reason.contains("top of the cursor ladder"),
            "{}",
            cursor_top.reason
        );
    }
}
