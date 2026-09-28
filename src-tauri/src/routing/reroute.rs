// Between-turn routing uses the entire next task. A follow-up moves up when
// Jev puts enough weight on the task needing more, and down when it is
// confident the whole next task needs less and, for a model switch, when the
// expected savings cover the cache the switch rebuilds. See docs/routing.md.

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
    providers::pricing::{cost_of, list_price, ModelPricing, UsageCounts},
};

/// Escalate only when the user is clearly unhappy with the work (failing,
/// disliked, or to be redone): those score 0.90+; a preference or "what
/// about…" scores 0.16 or less.
const CORRECTION_THRESHOLD: f64 = 0.85;
/// Evidence a move needs, as Jev's weight on the task's difficulty bucket.
/// Under-serving costs a wrong answer, so moving up asks for less than moving
/// down, and a model switch, which rebuilds the cache, asks for more than an
/// effort change on the same model.
const EFFORT_UP: f64 = 0.6;
const MODEL_UP: f64 = 0.7;
const EFFORT_DOWN: f64 = 0.75;
const MODEL_DOWN: f64 = 0.8;
/// A labeled earlier route is restored only on a near-certain match.
const RESUME_CONFIDENCE: f64 = 0.9;
/// Turns a model downgrade is credited with: the observed mean is two
/// follow-ups per routed chat (134 over 65 chats, 2026-09-28).
const EXPECTED_TURNS: f64 = 2.0;
/// The longest cache lifetime the providers document (Claude Code's one-hour
/// subscription TTL, OpenAI's one-hour ceiling). Within it the cache is taken
/// as warm.
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);
/// Past the TTL a prefix can still survive, so staying is not assumed to
/// rebuild the whole context.
const COLD_CACHE_SURVIVAL: f64 = 0.25;

use ReasoningEffort::{High, Low, Medium, Xhigh};

/// Escalation rungs per provider, weakest first. The Claude ladder ends on
/// Fable 5.1, which reads Opus 5.5's thinking blocks, so escalating keeps the
/// reasoning so far. Cursor climbs from Composer to Opus 5.5 inside the same
/// Cursor conversation. The Grok ladder ends by handing the chat to Opus 5.5
/// on Claude Code: a user still unhappy at Grok high needs a stronger model,
/// not more effort on a weak one. That last rung is the one automatic
/// provider switch; the chat continues from its visible transcript.
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
        ProviderId::Grok => &[
            (&table::GROK, Some(Low)),
            (&table::GROK, Some(Medium)),
            (&table::GROK, Some(High)),
            (&table::OPUS, Some(High)),
        ],
        // The grid never launches OpenCode, so no routed chat runs there.
        ProviderId::Opencode => &[],
        ProviderId::Cursor => &[
            (&table::COMPOSER, None),
            (&table::CURSOR_OPUS, Some(Medium)),
            (&table::CURSOR_OPUS, Some(High)),
        ],
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FollowUpState {
    pub tier: AutoTier,
    pub provider: ProviderId,
    pub model_id: String,
    pub effort: Option<ReasoningEffort>,
    /// Input-side tokens of the latest turn: what a switch has to re-read.
    pub context_tokens: u64,
    /// Last-turn observations only cap the next-turn forecast. A long prior
    /// investigation must not finance switching for a short finishing step.
    pub last_turn: UsageCounts,
    /// False when the request or relevant conversation/skill context is missing.
    pub downgrade_safe: bool,
    /// A bounded, same-provider route matched to the task being resumed.
    pub resume_target: Option<RoutedModel>,
    /// Time since the chat's last activity: how long its cache has sat idle.
    pub idle: Option<Duration>,
}

/// The decision for one follow-up. `decision` is `Reroute` or `Escalate` when
/// the chat should move to the returned model and effort, `Kept` otherwise.
pub fn follow_up_route(state: &FollowUpState, classification: &Classification) -> RouteDecision {
    let (kind, difficulty, notes) = settle(classification);
    let settled = Some((kind, difficulty));
    let mut summary = format!(
        "{} · {}",
        super::kind_label(kind),
        super::difficulty_label(difficulty)
    );
    if classification.is_ui() {
        summary.push_str(" · UI");
    }

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

    let mut reason = summary;
    if !notes.is_empty() {
        reason.push_str(&format!(" ({})", notes.join("; ")));
    }
    let Some(mut candidate) = table::follow_up_target(
        state.provider,
        state.tier,
        kind,
        difficulty,
        classification.is_ui(),
    ) else {
        return kept(
            state,
            classification,
            settled,
            format!("{reason}. Provider has no follow-up routing policy, staying"),
        );
    };
    let resume_target = state.resume_target.filter(|target| {
        target.model.provider == state.provider
            && classification.follow_up_scope == Some(super::jev::FollowUpScope::Continuation)
            && classification.scope_confidence.unwrap_or(0.0) >= RESUME_CONFIDENCE
            && classification.resume_confidence.unwrap_or(0.0) >= RESUME_CONFIDENCE
    });
    if let Some(target) = resume_target {
        if strength(target.model.model_id, target.effort)
            > strength(candidate.model.model_id, candidate.effort)
        {
            candidate = target;
        }
    }
    // A model retained through a simple interlude may be above the ordinary
    // provider target. Restore its effort without first reducing its model.
    if let Some(current_model) = table::route_model(&state.model_id) {
        if table::capability(&state.model_id) > table::capability(candidate.model.model_id)
            && candidate
                .effort
                .zip(state.effort)
                .is_some_and(|(next, current)| table::rank(next) > table::rank(current))
        {
            candidate = RoutedModel {
                model: current_model,
                effort: candidate
                    .effort
                    .and_then(|effort| table::clamp_effort(effort, current_model)),
            };
        }
    }
    if candidate.model.model_id == state.model_id && candidate.effort == state.effort {
        return kept(state, classification, settled, reason);
    }
    let Some(current_strength) = strength(&state.model_id, state.effort) else {
        return kept(
            state,
            classification,
            settled,
            format!("{reason}. Current model has no follow-up capability policy, staying"),
        );
    };
    let candidate_strength = strength(candidate.model.model_id, candidate.effort)
        .expect("follow-up policy contains known models");
    let same_model = candidate.model.model_id == state.model_id;

    if candidate_strength > current_strength {
        // Up goes straight to the target: a turn on too weak a model is the
        // expensive mistake.
        if resume_target == Some(candidate) {
            return reroute(
                state,
                candidate,
                classification,
                settled,
                format!("{reason}. Restoring the route for the earlier task being resumed"),
            );
        }
        let needed = if same_model { EFFORT_UP } else { MODEL_UP };
        let evidence = classification.probability_at_least_bucket(difficulty);
        if evidence >= needed {
            return reroute(
                state,
                candidate,
                classification,
                settled,
                format!(
                    "{reason}. Likely needs more ({}), moving up",
                    percent(evidence)
                ),
            );
        }
        return kept(
            state,
            classification,
            settled,
            format!(
                "{reason}. Not sure it needs more ({} < {}), staying",
                percent(evidence),
                percent(needed)
            ),
        );
    }

    if !state.downgrade_safe {
        return kept(
            state,
            classification,
            settled,
            format!("{reason}. Relevant context is missing or truncated, retaining capability"),
        );
    }
    // Down needs every signal: the kind (it sets the cap), the difficulty
    // bucket, and Jev's view that the whole next task is simpler.
    let evidence = classification
        .kind_confidence
        .min(classification.probability_at_most_bucket(difficulty))
        .min(classification.simpler_task.unwrap_or(0.0));
    if !same_model && evidence >= MODEL_DOWN && switch_pays_back(state, candidate, classification) {
        return reroute(
            state,
            candidate,
            classification,
            settled,
            format!("{reason}. Simpler next task, and the savings cover the cache rebuild"),
        );
    }
    // Otherwise lower effort on the current model, one level per follow-up so
    // a misread turn cannot drop a chat to the floor at once.
    let current_model = table::route_model(&state.model_id).expect("known capability model");
    let floor = table::clamp_effort(candidate.effort.unwrap_or(Low), current_model);
    let one_step = state.effort.zip(floor).and_then(|(current, floor)| {
        current_model
            .efforts()
            .iter()
            .copied()
            .filter(|effort| {
                table::rank(*effort) < table::rank(current)
                    && table::rank(*effort) >= table::rank(floor)
            })
            .max_by_key(|effort| table::rank(*effort))
    });
    let Some(lower) = one_step else {
        let why = if same_model {
            "No supported effort reduction".to_string()
        } else if state.provider == ProviderId::Cursor {
            "Cursor usage is unpriced, retaining model".to_string()
        } else if evidence < MODEL_DOWN {
            format!(
                "Not sure the next task is simpler enough to switch model ({} < {})",
                percent(evidence),
                percent(MODEL_DOWN)
            )
        } else {
            format!(
                "{} would not repay the cache it rebuilds, retaining model",
                candidate.model.label
            )
        };
        return kept(state, classification, settled, format!("{reason}. {why}"));
    };
    if evidence < EFFORT_DOWN {
        return kept(
            state,
            classification,
            settled,
            format!(
                "{reason}. Not sure the next task is simpler ({} < {}), retaining capability",
                percent(evidence),
                percent(EFFORT_DOWN)
            ),
        );
    }
    reroute(
        state,
        RoutedModel {
            model: current_model,
            effort: Some(lower),
        },
        classification,
        settled,
        format!("{reason}. Simpler next task, one effort level down on the same model"),
    )
}

fn reroute(
    state: &FollowUpState,
    target: RoutedModel,
    classification: &Classification,
    settled: Option<(table::TaskKind, table::Difficulty)>,
    reason: String,
) -> RouteDecision {
    decision_from(
        state.tier,
        target,
        Some(classification),
        settled,
        RouteDecisionKind::Reroute,
        reason,
    )
}

fn percent(probability: f64) -> String {
    format!("{:.0}%", probability * 100.0)
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
            let current = strength(model_id, effort)?;
            rungs.iter().find(|(model, rung_effort)| {
                strength(model.model_id, *rung_effort).is_some_and(|rank| rank > current)
            })
        }
    };
    next.map(|(model, effort)| RoutedModel {
        model,
        effort: *effort,
    })
}

fn strength(model_id: &str, effort: Option<ReasoningEffort>) -> Option<(usize, usize)> {
    Some((table::capability(model_id)?, effort.map_or(0, table::rank)))
}

/// What re-reading one token uncached costs over reading it from cache: a
/// cache write, or plain input where the provider bills no separate write.
/// Claude can write a one-hour cache at 2x input; the five-minute list rate
/// would underprice it when the billing path is unknown.
fn rebuild_rate(provider: ProviderId, price: &ModelPricing) -> f64 {
    let write = if provider == ProviderId::Claude {
        price.cache_write.max(2.0 * price.input)
    } else {
        price.cache_write.max(price.input)
    };
    (write - price.cache_read).max(0.0)
}

/// A switch rebuilds the context on the new model. Staying rebuilds it too
/// when the cache has gone cold, so only the difference is charged to the
/// switch. The savings are the price gap over the next `EXPECTED_TURNS` turns,
/// each capped by what the last turn used. Neither side assumes the old cache
/// is deleted or that switching back cannot reuse it.
fn switch_pays_back(
    state: &FollowUpState,
    candidate: RoutedModel,
    classification: &Classification,
) -> bool {
    if state.provider == ProviderId::Cursor || state.context_tokens == 0 {
        return false;
    }
    let (Some(old), Some(new)) = (
        list_price(&state.model_id),
        list_price(candidate.model.model_id),
    ) else {
        return false;
    };
    if old.input <= 0.0 || new.input <= 0.0 {
        return false;
    }
    let context = state.context_tokens as f64 / 1_000_000.0;
    let warm = match state.idle {
        Some(idle) if idle >= CACHE_TTL => COLD_CACHE_SURVIVAL,
        _ => 1.0,
    };
    let penalty = context * rebuild_rate(state.provider, &new)
        - (1.0 - warm) * context * rebuild_rate(state.provider, &old);
    // Policy caps, not predicted token counts.
    let (input_cap, output_cap) =
        if classification.follow_up_scope == Some(super::jev::FollowUpScope::FinishingStep) {
            (256, 256)
        } else if classification.difficulty() == table::Difficulty::Light {
            (1_000, 500)
        } else {
            (4_000, 2_000)
        };
    let forecast = UsageCounts {
        input: state.last_turn.input.min(input_cap),
        output: state.last_turn.output.min(output_cap),
        cache_read: state.last_turn.cache_read.min(state.context_tokens),
        cache_write: 0,
    };
    let saving = EXPECTED_TURNS
        * (cost_of(forecast, &state.model_id) - cost_of(forecast, candidate.model.model_id));
    saving > 0.0 && penalty <= saving
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
        signals: Some(classification.signals_json()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::{jev::FollowUpScope, table::TaskKind};

    const HOUR: Duration = Duration::from_secs(60 * 60);

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
            context_tokens: 168_000,
            last_turn: median_turn(),
            downgrade_safe: true,
            resume_target: None,
            idle: None,
        }
    }

    fn classified(kind: TaskKind, score: f64, confidence: f64) -> Classification {
        Classification {
            kind,
            kind_confidence: confidence,
            kind_probabilities: None,
            difficulty_score: score,
            difficulty_confidence: confidence,
            level_probabilities: None,
            correction: Some(0.2),
            follow_up_scope: Some(FollowUpScope::NewTask),
            scope_confidence: Some(confidence),
            simpler_task: Some(confidence),
            resume_route: None,
            resume_confidence: None,
            ui: None,
        }
    }

    fn with_levels(mut task: Classification, levels: [f64; 5]) -> Classification {
        task.level_probabilities = Some(levels);
        task
    }

    #[test]
    fn simpler_tasks_lower_effort_one_level_at_a_time() {
        for (provider, model, old, expected) in [
            (ProviderId::Claude, "claude-opus-5-5", High, Medium),
            (ProviderId::Codex, "gpt-6-astra", Xhigh, High),
            (ProviderId::Cursor, "claude-opus-5-5-medium", High, Medium),
            (ProviderId::Grok, "grok-4.7", High, Medium),
        ] {
            let decision = follow_up_route(
                &state(provider, model, Some(old)),
                &classified(TaskKind::Review, 0.5, 0.95),
            );
            assert_eq!(
                decision.decision,
                RouteDecisionKind::Reroute,
                "{provider:?}: {}",
                decision.reason
            );
            assert_eq!(decision.provider, provider);
            assert_eq!(decision.model_id, model);
            assert_eq!(decision.effort, Some(expected), "{provider:?}");
            assert!(
                decision.reason.contains("one effort level down"),
                "{}",
                decision.reason
            );
        }
    }

    #[test]
    fn missing_context_or_an_unsure_simpler_answer_cannot_reduce_capability() {
        let mut chat = state(ProviderId::Claude, "claude-opus-5-5", Some(High));
        let mut task = classified(TaskKind::Mechanical, 0.0, 0.95);
        chat.downgrade_safe = false;
        assert_eq!(
            follow_up_route(&chat, &task).decision,
            RouteDecisionKind::Kept
        );
        chat.downgrade_safe = true;
        task.simpler_task = Some(0.7);
        let decision = follow_up_route(&chat, &task);
        assert_eq!(decision.decision, RouteDecisionKind::Kept);
        assert!(decision.reason.contains("70% < 75%"), "{}", decision.reason);
        task.simpler_task = None;
        assert_eq!(
            follow_up_route(&chat, &task).decision,
            RouteDecisionKind::Kept
        );
    }

    #[test]
    fn continuation_inherits_hard_work_until_confidently_simpler() {
        let chat = state(ProviderId::Codex, "gpt-6-astra", Some(Xhigh));
        let mut task = classified(TaskKind::Research, 2.0, 0.95);
        task.follow_up_scope = Some(FollowUpScope::Continuation);
        task.simpler_task = Some(0.1);
        assert_eq!(follow_up_route(&chat, &task).effort, Some(Xhigh));
    }

    #[test]
    fn ship_with_unresolved_repairs_retains_capability() {
        let chat = state(ProviderId::Claude, "claude-fable-5-1", Some(Xhigh));
        let mut task = classified(TaskKind::Coding, 3.0, 0.95);
        task.follow_up_scope = Some(FollowUpScope::Continuation);
        task.simpler_task = Some(0.1);
        let decision = follow_up_route(&chat, &task);
        assert_eq!(decision.decision, RouteDecisionKind::Kept);
        assert_eq!(decision.effort, Some(Xhigh));
    }

    #[test]
    fn upgrades_read_the_difficulty_bucket_not_the_score_confidence() {
        // Jev's confidence in its exact score sits near 0.5 even when most of
        // its weight is on hard: that alone used to block every upgrade.
        let chat = state(ProviderId::Claude, "claude-opus-5-5", Some(Medium));
        let mut task = classified(TaskKind::Coding, 3.0, 0.45);
        task = with_levels(task, [0.0, 0.05, 0.3, 0.5, 0.15]);
        let decision = follow_up_route(&chat, &task);
        assert_eq!(
            decision.decision,
            RouteDecisionKind::Reroute,
            "{}",
            decision.reason
        );
        assert_eq!(decision.effort, Some(High));

        let unsure = with_levels(task, [0.0, 0.1, 0.35, 0.45, 0.1]);
        let decision = follow_up_route(&chat, &unsure);
        assert_eq!(decision.decision, RouteDecisionKind::Kept);
        assert!(decision.reason.contains("55% < 60%"), "{}", decision.reason);
    }

    #[test]
    fn a_model_upgrade_asks_for_more_than_an_effort_upgrade() {
        let chat = state(ProviderId::Cursor, "composer-2.5", None);
        let task = with_levels(
            classified(TaskKind::Coding, 2.0, 0.5),
            [0.0, 0.35, 0.5, 0.15, 0.0],
        );
        assert_eq!(
            follow_up_route(&chat, &task).decision,
            RouteDecisionKind::Kept
        );
        let sure = with_levels(task, [0.0, 0.25, 0.6, 0.15, 0.0]);
        let decision = follow_up_route(&chat, &sure);
        assert_eq!(decision.model_id, "claude-opus-5-5-medium");
        assert_eq!(decision.effort, Some(Medium));
    }

    #[test]
    fn a_grok_chat_climbs_its_effort_with_the_task() {
        let chat = state(ProviderId::Grok, "grok-4.7", Some(Low));
        let task = with_levels(
            classified(TaskKind::Coding, 2.0, 0.5),
            [0.0, 0.3, 0.6, 0.1, 0.0],
        );
        let decision = follow_up_route(&chat, &task);
        assert_eq!(
            decision.decision,
            RouteDecisionKind::Reroute,
            "{}",
            decision.reason
        );
        assert_eq!(
            (decision.model_id.as_str(), decision.effort),
            ("grok-4.7", Some(Medium))
        );
    }

    #[test]
    fn return_to_hard_task_restores_capability() {
        let chat = state(ProviderId::Codex, "gpt-6-sol", Some(Low));
        let mut task = classified(TaskKind::Research, 3.5, 0.95);
        task.follow_up_scope = Some(FollowUpScope::Continuation);
        task.simpler_task = Some(0.0);
        let decision = follow_up_route(&chat, &task);
        assert_eq!(decision.model_id, "gpt-6-astra");
        assert_eq!(decision.effort, Some(High));
        assert_eq!(decision.decision, RouteDecisionKind::Reroute);
    }

    #[test]
    fn matched_earlier_task_restores_its_escalated_effort() {
        let mut chat = state(ProviderId::Codex, "gpt-6-astra", Some(Low));
        chat.resume_target = Some(RoutedModel {
            model: &table::ASTRA,
            effort: Some(Xhigh),
        });
        let mut task = classified(TaskKind::Research, 2.0, 0.95);
        task.follow_up_scope = Some(FollowUpScope::Continuation);
        task.resume_route = Some("R2".to_string());
        task.resume_confidence = Some(0.95);
        task.simpler_task = Some(0.0);
        let decision = follow_up_route(&chat, &task);
        assert_eq!(decision.model_id, "gpt-6-astra");
        assert_eq!(decision.effort, Some(Xhigh));
        assert!(decision.reason.contains("Restoring"));
        task.follow_up_scope = Some(FollowUpScope::NewTask);
        let independent = follow_up_route(&chat, &task);
        assert_ne!(independent.effort, Some(Xhigh));
    }

    #[test]
    fn coding_after_an_astra_review_moves_to_sol_when_it_pays() {
        let chat = state(ProviderId::Codex, "gpt-6-astra", Some(High));
        let task = classified(TaskKind::Coding, 3.0, 0.95);
        let decision = follow_up_route(&chat, &task);
        assert_eq!(
            decision.decision,
            RouteDecisionKind::Reroute,
            "{}",
            decision.reason
        );
        assert_eq!(
            (decision.model_id.as_str(), decision.effort),
            ("gpt-6-sol", Some(High))
        );
        assert!(decision.reason.contains("cover the cache rebuild"));
    }

    #[test]
    fn a_cold_cache_lets_a_retained_fable_step_back_to_opus() {
        let mut chat = state(ProviderId::Claude, "claude-fable-5-1", Some(High));
        let task = classified(TaskKind::Question, 0.0, 0.95);
        // Warm: the Opus rebuild costs more than two turns save, so only the
        // effort comes down.
        let warm = follow_up_route(&chat, &task);
        assert_eq!(
            (warm.model_id.as_str(), warm.effort),
            ("claude-fable-5-1", Some(Medium))
        );
        // Cold: staying would rebuild Fable's cache anyway.
        chat.idle = Some(2 * HOUR);
        let cold = follow_up_route(&chat, &task);
        assert_eq!(
            (cold.model_id.as_str(), cold.effort),
            ("claude-opus-5-5", Some(Low))
        );
    }

    #[test]
    fn long_previous_turn_does_not_finance_a_short_finishing_switch() {
        let mut chat = state(ProviderId::Codex, "gpt-6-astra", Some(Low));
        chat.last_turn = UsageCounts {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 10_000_000,
            cache_write: 100_000,
        };
        let mut task = classified(TaskKind::Mechanical, 0.0, 0.95);
        task.follow_up_scope = Some(FollowUpScope::FinishingStep);
        let decision = follow_up_route(&chat, &task);
        assert_eq!(decision.decision, RouteDecisionKind::Kept);
        assert!(
            decision.reason.contains("would not repay the cache"),
            "{}",
            decision.reason
        );
    }

    #[test]
    fn small_context_can_repay_a_model_switch() {
        let mut chat = state(ProviderId::Codex, "gpt-6-astra", Some(Low));
        chat.context_tokens = 1_000;
        let task = classified(TaskKind::Mechanical, 0.0, 0.95);
        let decision = follow_up_route(&chat, &task);
        assert_eq!(decision.decision, RouteDecisionKind::Reroute);
        assert_eq!(decision.model_id, "gpt-6-sol");
    }

    #[test]
    fn cursor_prices_and_unknown_context_cannot_finance_model_switches() {
        let task = classified(TaskKind::Mechanical, 0.0, 0.95);
        let cursor = state(ProviderId::Cursor, "claude-opus-5-5-medium", Some(Low));
        let decision = follow_up_route(&cursor, &task);
        assert_eq!(decision.decision, RouteDecisionKind::Kept);
        assert!(decision.reason.contains("unpriced"), "{}", decision.reason);
        let mut codex = state(ProviderId::Codex, "gpt-6-astra", Some(Low));
        codex.context_tokens = 0;
        assert_eq!(
            follow_up_route(&codex, &task).decision,
            RouteDecisionKind::Kept
        );
    }

    #[test]
    fn a_provider_without_a_policy_keeps_its_route() {
        let chat = state(
            ProviderId::Opencode,
            "opencode-go/deepseek-v4.1-flash",
            Some(High),
        );
        let decision = follow_up_route(&chat, &classified(TaskKind::Coding, 3.0, 0.95));
        assert_eq!(decision.decision, RouteDecisionKind::Kept);
        assert!(decision.reason.contains("no follow-up routing policy"));
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
            ("grok-4.7", Some(Low), "grok-4.7", Some(Medium)),
            ("grok-4.7", Some(Medium), "grok-4.7", Some(High)),
            ("grok-4.7", Some(High), "claude-opus-5-5", Some(High)),
        ];
        for (model, effort, next_model, next_effort) in climbs {
            let provider = table::route_model(model).expect("grid model").provider;
            let decision = follow_up_route(&state(provider, model, effort), &correction);
            assert_eq!(decision.decision, RouteDecisionKind::Escalate, "{model}");
            assert_eq!(
                (decision.model_id.as_str(), decision.effort),
                (next_model, next_effort)
            );
            // Grok's last rung hands the chat to Claude Code.
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
