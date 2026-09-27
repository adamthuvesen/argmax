// The Auto routing grid: task kind × column → model, and tier × difficulty →
// column · effort. Decided in docs/plan/auto-model-routing.md from measured
// per-turn cost (cache reads dominate, so Opus 5.5 is only 1.3x Sol) and
// task-completion time. Rust owns this table; the renderer only displays the
// routed result.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ipc::validation::{ProviderId, ReasoningEffort};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum AutoTier {
    Cost,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Column {
    Cheap,
    Value,
    Frontier,
}

/// A model the grid can route to, with the effort levels its CLI accepts
/// (mirrors `reasoningEffortsForModel` in src/shared/providerModels.ts for
/// these ids). Empty means the provider picks the effort itself.
#[derive(Debug, PartialEq, Eq)]
pub struct RouteModel {
    pub provider: ProviderId,
    pub model_id: &'static str,
    pub label: &'static str,
    efforts: &'static [ReasoningEffort],
}

use ReasoningEffort::{High, Low, Max, Medium, Ultra, Xhigh};

const CLAUDE_EFFORTS: &[ReasoningEffort] = &[Low, Medium, High, Xhigh, Max];
const CODEX_EFFORTS: &[ReasoningEffort] = &[Low, Medium, High, Xhigh, Max, Ultra];

pub const OPUS: RouteModel = RouteModel {
    provider: ProviderId::Claude,
    model_id: "claude-opus-5-5",
    label: "Opus 5.5",
    efforts: CLAUDE_EFFORTS,
};
pub const FABLE: RouteModel = RouteModel {
    provider: ProviderId::Claude,
    model_id: "claude-fable-5-1",
    label: "Fable 5.1",
    efforts: CLAUDE_EFFORTS,
};
pub const SOL: RouteModel = RouteModel {
    provider: ProviderId::Codex,
    model_id: "gpt-6-sol",
    label: "GPT-6 Sol",
    efforts: CODEX_EFFORTS,
};
pub const ASTRA: RouteModel = RouteModel {
    provider: ProviderId::Codex,
    model_id: "gpt-6-astra",
    label: "GPT-6 Astra",
    efforts: CODEX_EFFORTS,
};
pub const COMPOSER: RouteModel = RouteModel {
    provider: ProviderId::Cursor,
    model_id: "composer-2.5",
    label: "Composer 2.5 (Cursor)",
    efforts: &[],
};
/// Opus 5.5 served through Cursor: only the escalation steps for a chat that
/// started on Composer, so it can climb without leaving the Cursor
/// conversation. Cursor's ACP takes its effort as a config option
/// (docs/providers.md), low through max like Claude Code.
pub const CURSOR_OPUS: RouteModel = RouteModel {
    provider: ProviderId::Cursor,
    model_id: "claude-opus-5-5-medium",
    label: "Claude Opus 5.5 (Cursor)",
    efforts: CLAUDE_EFFORTS,
};
/// The CLI also takes `low`, but low measured no faster than high (88 s vs 87 s
/// over four tasks, 2026-09-27) while its intelligence score is only known at
/// max, so the router never goes below high.
pub const DEEPSEEK_FLASH: RouteModel = RouteModel {
    provider: ProviderId::Opencode,
    model_id: "opencode-go/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    efforts: &[High, Max],
};
pub const GROK: RouteModel = RouteModel {
    provider: ProviderId::Grok,
    model_id: "grok-4.7",
    label: "Grok 4.7",
    efforts: &[Low, Medium, High, Xhigh],
};

pub const ROUTE_MODELS: &[&RouteModel] = &[
    &OPUS,
    &FABLE,
    &SOL,
    &ASTRA,
    &COMPOSER,
    &CURSOR_OPUS,
    &DEEPSEEK_FLASH,
    &GROK,
];

/// A concrete launch target: model plus the effort it will run at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoutedModel {
    pub model: &'static RouteModel,
    pub effort: Option<ReasoningEffort>,
}

fn cell(kind: TaskKind, column: Column) -> &'static RouteModel {
    match (kind, column) {
        (TaskKind::Coding, Column::Cheap) => &COMPOSER,
        (TaskKind::Coding, _) => &OPUS,
        // Speed weighs latency as much as cost. Inside Argmax, with Cursor's
        // warm ACP pool, Composer finished four turns in 42 s against 89 s for
        // DeepSeek V4.1 Flash and 58 s for Opus medium (2026-09-27), so the
        // cheap cells use Composer rather than the cheapest model.
        (TaskKind::Mechanical, Column::Cheap) => &COMPOSER,
        (TaskKind::Mechanical, Column::Value) => &COMPOSER,
        (TaskKind::Mechanical, Column::Frontier) => &OPUS,
        (TaskKind::Research, Column::Cheap) => &COMPOSER,
        (TaskKind::Research, _) => &OPUS,
        (TaskKind::Review, Column::Cheap) => &OPUS,
        // Sol measured 2.7x slower than Opus medium at a lower score for a
        // quarter less per turn; Frontier keeps Astra as the second family.
        (TaskKind::Review, Column::Value) => &OPUS,
        (TaskKind::Review, Column::Frontier) => &ASTRA,
        (TaskKind::Question, Column::Cheap) => &GROK,
        (TaskKind::Question, _) => &OPUS,
    }
}

/// A launch never runs above high: xhigh and max are reserved for escalation,
/// when the user has said the work is failing.
fn column_and_effort(tier: AutoTier, difficulty: Difficulty) -> (Column, ReasoningEffort) {
    match (tier, difficulty) {
        (AutoTier::Cost, Difficulty::Light) => (Column::Cheap, Low),
        (AutoTier::Cost, Difficulty::Standard) => (Column::Cheap, Medium),
        (AutoTier::Cost, Difficulty::Heavy) => (Column::Value, Medium),
        (AutoTier::Balanced, Difficulty::Light) => (Column::Cheap, Medium),
        (AutoTier::Balanced, Difficulty::Standard) => (Column::Value, Medium),
        (AutoTier::Balanced, Difficulty::Heavy) => (Column::Value, High),
        (AutoTier::Intelligence, Difficulty::Light) => (Column::Value, Medium),
        (AutoTier::Intelligence, Difficulty::Standard) => (Column::Frontier, High),
        (AutoTier::Intelligence, Difficulty::Heavy) => (Column::Frontier, High),
    }
}

pub fn route(tier: AutoTier, kind: TaskKind, difficulty: Difficulty) -> RoutedModel {
    let (column, mut effort) = column_and_effort(tier, difficulty);
    // Renames and bulk edits never repay more than medium, on any tier.
    if kind == TaskKind::Mechanical && rank(effort) > rank(Medium) {
        effort = Medium;
    }
    // A missed bug costs more than a slower review, so the cheap review cell is
    // Opus at low rather than Composer: on CursorBench 4.0 Opus low scores
    // 43.7% against Composer's 27.7% at about 1.7x the cost per task, and it
    // reviewed faster in-app (15 s vs 35 s, 2026-09-27).
    if kind == TaskKind::Review && column == Column::Cheap {
        effort = Low;
    }
    let model = match (tier, difficulty, kind) {
        // Frontier's heaviest work spreads across families, where latency no
        // longer counts: Astra takes deep investigations (and draws on the
        // Codex plan), Fable the big design and architecture questions.
        // Coding stays on Opus, which outscores Fable high on CursorBench
        // (56.0% vs 49.2%); Fable is the step after Opus high on its ladder.
        (AutoTier::Intelligence, Difficulty::Heavy, TaskKind::Research) => &ASTRA,
        (AutoTier::Intelligence, Difficulty::Heavy, TaskKind::Question) => &FABLE,
        _ => cell(kind, column),
    };
    RoutedModel {
        model,
        effort: clamp_effort(effort, model),
    }
}

/// Follow-ups stay within the native conversation's provider. This is a
/// capability policy, independent of list price and of the launch grid.
pub fn follow_up_target(
    provider: ProviderId,
    tier: AutoTier,
    kind: TaskKind,
    difficulty: Difficulty,
) -> RoutedModel {
    let (_, mut effort) = column_and_effort(tier, difficulty);
    if difficulty == Difficulty::Light && tier != AutoTier::Intelligence {
        effort = Low;
    }
    if kind == TaskKind::Mechanical {
        effort = if difficulty == Difficulty::Light { Low } else { Medium };
    }
    let model = match provider {
        ProviderId::Claude => {
            if tier == AutoTier::Intelligence
                && difficulty == Difficulty::Heavy
                && kind == TaskKind::Question
            {
                &FABLE
            } else {
                &OPUS
            }
        }
        ProviderId::Codex => {
            if (difficulty == Difficulty::Heavy && kind != TaskKind::Mechanical)
                || (tier == AutoTier::Intelligence
                    && difficulty == Difficulty::Standard
                    && matches!(kind, TaskKind::Review | TaskKind::Research))
            {
                &ASTRA
            } else {
                &SOL
            }
        }
        ProviderId::Cursor => {
            if kind == TaskKind::Review
                || difficulty == Difficulty::Heavy
                || (difficulty == Difficulty::Standard && tier != AutoTier::Cost)
                || tier == AutoTier::Intelligence
            {
                &CURSOR_OPUS
            } else {
                &COMPOSER
            }
        }
        ProviderId::Opencode => &DEEPSEEK_FLASH,
        // Higher Grok effort has no demonstrated quality benefit in the
        // routing evidence. Keep its established low-effort policy.
        ProviderId::Grok => {
            effort = Low;
            &GROK
        }
    };
    RoutedModel {
        model,
        effort: clamp_effort(effort, model),
    }
}

/// Only compares models in the router's explicit policy. Unknown models are
/// retained, never assigned a capability based on their price.
pub(crate) fn capability(model_id: &str) -> Option<usize> {
    match model_id {
        "composer-2.5" | "opencode-go/deepseek-v4.1-flash" | "grok-4.7" => Some(0),
        "claude-opus-5-5" | "claude-opus-5-5-medium" | "gpt-6-sol" => Some(1),
        "claude-fable-5-1" | "gpt-6-astra" => Some(2),
        _ => None,
    }
}

/// Used when Jev is unavailable: the tier's standard coding cell, so an
/// Speed chat stays cheap and fast (Composer) rather than landing on Opus.
pub fn fallback(tier: AutoTier) -> RoutedModel {
    match tier {
        AutoTier::Cost => RoutedModel {
            model: &COMPOSER,
            effort: None,
        },
        AutoTier::Balanced | AutoTier::Intelligence => RoutedModel {
            model: &OPUS,
            effort: Some(Medium),
        },
    }
}

pub fn route_model(model_id: &str) -> Option<&'static RouteModel> {
    ROUTE_MODELS
        .iter()
        .copied()
        .find(|model| model.model_id == model_id)
}

pub(crate) fn rank(effort: ReasoningEffort) -> usize {
    match effort {
        Low => 0,
        Medium => 1,
        High => 2,
        Xhigh => 3,
        Max => 4,
        Ultra => 5,
    }
}

/// Same rule as `clampEffort` in providerModels.ts: keep a supported level,
/// else the highest supported level below it, else the model's lowest.
pub(crate) fn clamp_effort(effort: ReasoningEffort, model: &RouteModel) -> Option<ReasoningEffort> {
    if model.efforts.is_empty() {
        return None;
    }
    if model.efforts.contains(&effort) {
        return Some(effort);
    }
    model
        .efforts
        .iter()
        .copied()
        .filter(|candidate| rank(*candidate) < rank(effort))
        .max_by_key(|candidate| rank(*candidate))
        .or_else(|| model.efforts.first().copied())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell_text(routed: RoutedModel) -> String {
        match routed.effort {
            Some(effort) => format!("{} · {}", routed.model.label, effort.as_str()),
            None => routed.model.label.to_string(),
        }
    }

    // The full grid from docs/plan/auto-model-routing.md, one row per
    // kind × difficulty, columns Cost / Balanced / Intelligence.
    #[test]
    fn grid_matches_the_decided_table() {
        use Difficulty::{Heavy, Light, Standard};
        use TaskKind::*;
        let expected: &[(TaskKind, Difficulty, [&str; 3])] = &[
            (
                Coding,
                Light,
                [
                    "Composer 2.5 (Cursor)",
                    "Composer 2.5 (Cursor)",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Coding,
                Standard,
                [
                    "Composer 2.5 (Cursor)",
                    "Opus 5.5 · medium",
                    "Opus 5.5 · high",
                ],
            ),
            (
                Coding,
                Heavy,
                ["Opus 5.5 · medium", "Opus 5.5 · high", "Opus 5.5 · high"],
            ),
            (
                Mechanical,
                Light,
                [
                    "Composer 2.5 (Cursor)",
                    "Composer 2.5 (Cursor)",
                    "Composer 2.5 (Cursor)",
                ],
            ),
            (
                Mechanical,
                Standard,
                [
                    "Composer 2.5 (Cursor)",
                    "Composer 2.5 (Cursor)",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Mechanical,
                Heavy,
                [
                    "Composer 2.5 (Cursor)",
                    "Composer 2.5 (Cursor)",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Research,
                Light,
                [
                    "Composer 2.5 (Cursor)",
                    "Composer 2.5 (Cursor)",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Research,
                Standard,
                [
                    "Composer 2.5 (Cursor)",
                    "Opus 5.5 · medium",
                    "Opus 5.5 · high",
                ],
            ),
            (
                Research,
                Heavy,
                ["Opus 5.5 · medium", "Opus 5.5 · high", "GPT-6 Astra · high"],
            ),
            (
                Review,
                Light,
                ["Opus 5.5 · low", "Opus 5.5 · low", "Opus 5.5 · medium"],
            ),
            (
                Review,
                Standard,
                ["Opus 5.5 · low", "Opus 5.5 · medium", "GPT-6 Astra · high"],
            ),
            (
                Review,
                Heavy,
                ["Opus 5.5 · medium", "Opus 5.5 · high", "GPT-6 Astra · high"],
            ),
            (
                Question,
                Light,
                ["Grok 4.7 · low", "Grok 4.7 · medium", "Opus 5.5 · medium"],
            ),
            (
                Question,
                Standard,
                ["Grok 4.7 · medium", "Opus 5.5 · medium", "Opus 5.5 · high"],
            ),
            (
                Question,
                Heavy,
                ["Opus 5.5 · medium", "Opus 5.5 · high", "Fable 5.1 · high"],
            ),
        ];
        for (kind, difficulty, cells) in expected {
            let actual = [AutoTier::Cost, AutoTier::Balanced, AutoTier::Intelligence]
                .map(|tier| cell_text(route(tier, *kind, *difficulty)));
            assert_eq!(
                &actual.each_ref().map(String::as_str),
                cells,
                "{kind:?} {difficulty:?}"
            );
        }
    }

    #[test]
    fn clamp_keeps_supported_levels_and_otherwise_steps_down() {
        assert_eq!(clamp_effort(Medium, &DEEPSEEK_FLASH), Some(High));
        assert_eq!(clamp_effort(Xhigh, &DEEPSEEK_FLASH), Some(High));
        assert_eq!(clamp_effort(Ultra, &OPUS), Some(Max));
        assert_eq!(clamp_effort(Max, &GROK), Some(Xhigh));
        assert_eq!(clamp_effort(High, &COMPOSER), None);
    }

    #[test]
    fn fallback_follows_the_tier() {
        assert_eq!(cell_text(fallback(AutoTier::Cost)), "Composer 2.5 (Cursor)");
        assert_eq!(cell_text(fallback(AutoTier::Balanced)), "Opus 5.5 · medium");
        assert_eq!(
            cell_text(fallback(AutoTier::Intelligence)),
            "Opus 5.5 · medium"
        );
    }
}
