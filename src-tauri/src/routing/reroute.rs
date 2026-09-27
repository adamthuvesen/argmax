// Between-turn routing uses the entire next task. Effort changes preserve
// the model where possible, with cache effects explicitly unverified. Model
// downgrades must cover a possible rebuild, without assuming cache eviction.

use std::time::Duration;

use super::{
    decision_from,
    jev::{Classification, FollowUpScope},
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
/// Reducing capability needs stronger evidence than increasing it.
const DOWNGRADE_CONFIDENCE: f64 = 0.9;
/// Anti-oscillation policy, unrelated to provider cache retention.
const SWITCH_COOLDOWN: Duration = Duration::from_secs(5 * 60);

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

    let mut candidate = table::follow_up_target(state.provider, state.tier, kind, difficulty);
    let resume_target = state.resume_target.filter(|target| {
        target.model.provider == state.provider
            && classification.follow_up_scope == Some(FollowUpScope::Continuation)
            && classification.scope_confidence.unwrap_or(0.0) >= DOWNGRADE_CONFIDENCE
            && classification.resume_confidence.unwrap_or(0.0) >= DOWNGRADE_CONFIDENCE
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
            && candidate.effort.zip(state.effort)
                .is_some_and(|(next, current)| table::rank(next) > table::rank(current))
        {
            candidate = RoutedModel {
                model: current_model,
                effort: candidate.effort.and_then(|effort| table::clamp_effort(effort, current_model)),
            };
        }
    }
    let mut reason = summary;
    if !notes.is_empty() {
        reason.push_str(&format!(" ({})", notes.join("; ")));
    }
    if candidate.model.model_id == state.model_id && candidate.effort == state.effort {
        return kept(state, classification, settled, reason);
    }
    let Some(current_strength) = strength(&state.model_id, state.effort) else {
        return kept(
            state,
            classification,
            settled,
            format!(
                "{reason}. Current model has no follow-up capability policy, staying"
            ),
        );
    };
    let candidate_strength = strength(candidate.model.model_id, candidate.effort)
        .expect("follow-up policy contains known models");
    let is_upgrade = candidate_strength > current_strength;
    if is_upgrade {
        if classification.kind_confidence >= UPGRADE_CONFIDENCE
            && classification.difficulty_confidence >= UPGRADE_CONFIDENCE
        {
            return decision_from(
                state.tier,
                candidate,
                Some(classification),
                settled,
                RouteDecisionKind::Reroute,
                if resume_target == Some(candidate) {
                    format!("{reason}. Restoring the route for the earlier task being resumed")
                } else {
                    format!("{reason}. Confident capability increase for the next task")
                },
            );
        }
        return kept(
            state,
            classification,
            settled,
            format!("{reason}. Unsure of increased capability needs, staying"),
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

    let confident_simpler = classification.kind_confidence >= DOWNGRADE_CONFIDENCE
        && classification.difficulty_confidence >= DOWNGRADE_CONFIDENCE
        && classification.follow_up_scope.is_some()
        && classification.scope_confidence.unwrap_or(0.0) >= DOWNGRADE_CONFIDENCE
        && classification.simpler_task.unwrap_or(0.0) >= DOWNGRADE_CONFIDENCE;
    if !confident_simpler {
        return kept(
            state,
            classification,
            settled,
            format!("{reason}. Entire next task is not confidently simpler, retaining capability"),
        );
    }
    let clear_task_change = matches!(
        classification.follow_up_scope,
        Some(FollowUpScope::NewTask | FollowUpScope::FinishingStep)
    );
    if !clear_task_change
        && state.since_last_switch.is_some_and(|since| since < SWITCH_COOLDOWN)
    {
        return kept(
            state,
            classification,
            settled,
            format!("{reason}. Recent switch and continuing scope, retaining capability"),
        );
    }
    // Preserve the current model first, including a stronger model retained
    // after an escalation. Effort is clamped to that model's supported levels.
    let current_model = table::route_model(&state.model_id).expect("known capability model");
    let lower_effort = table::clamp_effort(candidate.effort.unwrap_or(Low), current_model);
    let effort_only = lower_effort.zip(state.effort)
        .is_some_and(|(next, current)| table::rank(next) < table::rank(current));
    let (candidate, why) = if effort_only {
        (RoutedModel { model: current_model, effort: lower_effort },
         "Simpler next task, reduced effort on the same model. Cache effect unverified")
    } else if candidate.model.model_id == state.model_id {
        return kept(state, classification, settled, format!("{reason}. No supported effort reduction"));
    } else if switch_pays_back(state, candidate, classification) {
        (candidate, "Simpler next task. Conservative one-turn estimate covers a possible cache rebuild")
    } else {
        return kept(
            state,
            classification,
            settled,
            format!("{reason}. {} does not cover a possible cache rebuild with available next-turn evidence, retaining model", candidate.model.label),
        );
    };
    decision_from(
        state.tier,
        candidate,
        Some(classification),
        settled,
        RouteDecisionKind::Reroute,
        format!("{reason}. {why}"),
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
            let current = strength(model_id, effort)?;
            rungs
                .iter()
                .find(|(model, rung_effort)| strength(model.model_id, *rung_effort).is_some_and(|rank| rank > current))
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

/// A switch re-reads the whole context uncached on the new model (a cache
/// write, or plain input where the provider bills no separate write), where
/// staying would have read it from cache. This pessimistic estimate does not
/// claim the old cache is deleted, nor that switching back cannot reuse it.
fn switch_pays_back(state: &FollowUpState, candidate: RoutedModel, classification: &Classification) -> bool {
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
    // Claude can write a one-hour cache at 2x input. Do not underprice it
    // using the five-minute list rate when the billing path is unknown.
    let write_new = if state.provider == ProviderId::Claude {
        new.cache_write.max(2.0 * new.input)
    } else {
        new.cache_write.max(new.input)
    };
    let penalty = state.context_tokens as f64 * (write_new - new.cache_read).max(0.0) / 1_000_000.0;
    // Policy caps, not predicted token counts. No future turns or repeated
    // cache reads from a previous long investigation are credited.
    let (input_cap, output_cap) = if classification.follow_up_scope == Some(FollowUpScope::FinishingStep) {
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
    let saving = cost_of(forecast, &state.model_id)
        - cost_of(forecast, candidate.model.model_id);
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
            context_tokens: 168_000,
            last_turn: median_turn(),
            downgrade_safe: true,
            resume_target: None,
            since_last_switch: None,
        }
    }

    fn classified(kind: TaskKind, score: f64, confidence: f64) -> Classification {
        Classification {
            kind,
            kind_confidence: confidence,
            difficulty_score: score,
            difficulty_confidence: confidence,
            level_probabilities: None,
            correction: Some(0.2),
            follow_up_scope: Some(FollowUpScope::NewTask),
            scope_confidence: Some(confidence),
            simpler_task: Some(confidence),
            resume_route: None,
            resume_confidence: None,
        }
    }

    #[test]
    fn simpler_tasks_lower_effort_within_each_provider() {
        for (provider, model, old, expected) in [
            (ProviderId::Claude, "claude-opus-5-5", High, Low),
            (ProviderId::Codex, "gpt-6-astra", Xhigh, Low),
            (ProviderId::Cursor, "claude-opus-5-5-medium", High, Low),
            (ProviderId::Opencode, "opencode-go/deepseek-v4.1-flash", Max, High),
            (ProviderId::Grok, "grok-4.7", High, Low),
        ] {
            let decision = follow_up_route(
                &state(provider, model, Some(old)),
                &classified(TaskKind::Review, 0.5, 0.95),
            );
            assert_eq!(decision.decision, RouteDecisionKind::Reroute, "{provider:?}: {}", decision.reason);
            assert_eq!(decision.provider, provider);
            assert_eq!(decision.model_id, model);
            assert_eq!(decision.effort, Some(expected));
            assert!(decision.reason.contains("Cache effect unverified"));
        }
    }

    #[test]
    fn global_launch_provider_does_not_block_ordinary_simplification() {
        let decision = follow_up_route(
            &state(ProviderId::Claude, "claude-opus-5-5", Some(High)),
            &classified(TaskKind::Question, 0.0, 0.95),
        );
        assert_eq!(decision.provider, ProviderId::Claude);
        assert_eq!(decision.effort, Some(Low));
        assert_eq!(decision.decision, RouteDecisionKind::Reroute);
    }

    #[test]
    fn missing_context_or_uncertain_scope_cannot_reduce_capability() {
        let mut chat = state(ProviderId::Claude, "claude-opus-5-5", Some(High));
        let mut task = classified(TaskKind::Mechanical, 0.0, 0.95);
        chat.downgrade_safe = false;
        assert_eq!(follow_up_route(&chat, &task).decision, RouteDecisionKind::Kept);
        chat.downgrade_safe = true;
        task.simpler_task = Some(0.8);
        assert_eq!(follow_up_route(&chat, &task).decision, RouteDecisionKind::Kept);
        task.simpler_task = Some(0.95);
        task.scope_confidence = None;
        assert_eq!(follow_up_route(&chat, &task).decision, RouteDecisionKind::Kept);
    }

    #[test]
    fn continuation_inherits_hard_work_until_confidently_simpler() {
        let chat = state(ProviderId::Codex, "gpt-6-astra", Some(Xhigh));
        let mut task = classified(TaskKind::Coding, 2.0, 0.95);
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
    fn return_to_hard_task_restores_capability_despite_cooldown() {
        let mut chat = state(ProviderId::Codex, "gpt-6-sol", Some(Low));
        chat.since_last_switch = Some(MINUTE);
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
        chat.since_last_switch = Some(MINUTE);
        chat.resume_target = Some(RoutedModel { model: &table::ASTRA, effort: Some(Xhigh) });
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
    fn cooldown_only_yields_to_a_clear_task_change() {
        let mut chat = state(ProviderId::Claude, "claude-opus-5-5", Some(High));
        chat.since_last_switch = Some(MINUTE);
        let mut task = classified(TaskKind::Question, 0.0, 0.95);
        task.follow_up_scope = Some(FollowUpScope::Continuation);
        assert_eq!(follow_up_route(&chat, &task).decision, RouteDecisionKind::Kept);
        task.follow_up_scope = Some(FollowUpScope::NewTask);
        assert_eq!(follow_up_route(&chat, &task).decision, RouteDecisionKind::Reroute);
    }

    #[test]
    fn long_previous_turn_does_not_finance_a_short_finishing_switch() {
        let mut chat = state(ProviderId::Codex, "gpt-6-astra", Some(Low));
        chat.last_turn = UsageCounts { input: 1_000_000, output: 1_000_000, cache_read: 10_000_000, cache_write: 100_000 };
        let mut task = classified(TaskKind::Mechanical, 0.0, 0.95);
        task.follow_up_scope = Some(FollowUpScope::FinishingStep);
        let decision = follow_up_route(&chat, &task);
        assert_eq!(decision.decision, RouteDecisionKind::Kept);
        assert!(decision.reason.contains("possible cache rebuild"));
    }

    #[test]
    fn small_context_can_repay_a_model_switch_in_the_next_turn() {
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
        assert_eq!(follow_up_route(&cursor, &task).decision, RouteDecisionKind::Kept);
        let mut codex = state(ProviderId::Codex, "gpt-6-astra", Some(Low));
        codex.context_tokens = 0;
        assert_eq!(follow_up_route(&codex, &task).decision, RouteDecisionKind::Kept);
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
