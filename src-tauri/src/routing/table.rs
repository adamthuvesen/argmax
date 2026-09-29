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
/// Coding, research, and questions on Speed, plus Balance's lighter coding
/// and research and its larger mechanical edits. Weaker than Opus on purpose,
/// so a review or a wrong answer can still climb.
pub const SONNET: RouteModel = RouteModel {
    provider: ProviderId::Claude,
    model_id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
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
    model_id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
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
pub const GROK: RouteModel = RouteModel {
    provider: ProviderId::Grok,
    model_id: "grok-4.7",
    label: "Grok 4.7",
    efforts: &[Low, Medium, High, Xhigh],
};

pub const ROUTE_MODELS: &[&RouteModel] = &[
    &OPUS,
    &SONNET,
    &FABLE,
    &SOL,
    &ASTRA,
    &COMPOSER,
    &CURSOR_OPUS,
    &GROK,
];

impl RouteModel {
    pub fn efforts(&self) -> &'static [ReasoningEffort] {
        self.efforts
    }
}

/// A concrete launch target: model plus the effort it will run at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoutedModel {
    pub model: &'static RouteModel,
    pub effort: Option<ReasoningEffort>,
}

fn cell(kind: TaskKind, column: Column) -> &'static RouteModel {
    match (kind, column) {
        // Sonnet 5.5 replaced Composer on these cells (2026-09-29). On the
        // same two agent tasks it finished in 17.6 s against Composer's
        // 45.3 s, and CursorBench scores it 55.5% against 27.7%.
        (TaskKind::Coding, Column::Cheap) => &SONNET,
        (TaskKind::Coding, _) => &OPUS,
        // Renames stay on Composer: inside Argmax, with Cursor's warm ACP
        // pool, it finished four turns in 42 s against 58 s for Opus medium
        // (2026-09-27), and the work does not repay Sonnet's price.
        (TaskKind::Mechanical, Column::Cheap) => &COMPOSER,
        (TaskKind::Mechanical, Column::Value) => &COMPOSER,
        (TaskKind::Mechanical, Column::Frontier) => &OPUS,
        (TaskKind::Research, Column::Cheap) => &SONNET,
        (TaskKind::Research, _) => &OPUS,
        (TaskKind::Review, Column::Cheap) => &OPUS,
        // Sol measured 2.7x slower than Opus medium at a lower score for a
        // quarter less per turn; Frontier keeps Astra as the second family.
        (TaskKind::Review, Column::Value) => &OPUS,
        (TaskKind::Review, Column::Frontier) => &ASTRA,
        (TaskKind::Question, Column::Cheap) => &SONNET,
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

/// Grok's effort follows the task's difficulty, so a chat already on Grok
/// can climb low → medium → high. The launch grid no longer picks Grok.
fn grok_effort(difficulty: Difficulty) -> ReasoningEffort {
    match difficulty {
        Difficulty::Light => Low,
        Difficulty::Standard => Medium,
        Difficulty::Heavy => High,
    }
}

/// `ui` marks visual UI or design work. The Composer cell left on Balance is
/// light mechanical work, and that UI work goes to Opus 5.5 low: Composer's
/// UI tweaks were the chats most often reported wrong (3 of 22 escalated,
/// 2026-09-28).
pub fn route(tier: AutoTier, kind: TaskKind, difficulty: Difficulty, ui: bool) -> RoutedModel {
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
        // Frontier light is the value column, which is Composer for a
        // rename. A small mechanical edit there still gets Sonnet medium.
        (AutoTier::Intelligence, Difficulty::Light, TaskKind::Mechanical) => &SONNET,
        // Speed's heavy column is Opus. Sonnet medium finished the same two
        // small tasks faster than Opus medium and at about half the price
        // (2026-09-28). Reviews stay on Opus.
        (
            AutoTier::Cost,
            Difficulty::Heavy,
            TaskKind::Coding | TaskKind::Research | TaskKind::Question,
        ) => &SONNET,
        // Balance's mechanical value cell is Composer. Standard and heavy
        // edits go to Sonnet; light renames stay on Composer.
        (AutoTier::Balanced, Difficulty::Standard | Difficulty::Heavy, TaskKind::Mechanical) => {
            &SONNET
        }
        // Balance standard coding and research run Sonnet at high. The value
        // column would be Opus medium. Heavy stays on Opus high.
        (AutoTier::Balanced, Difficulty::Standard, TaskKind::Coding | TaskKind::Research) => {
            effort = High;
            &SONNET
        }
        _ => cell(kind, column),
    };
    let (model, effort) = if tier == AutoTier::Balanced && ui && model == &COMPOSER {
        (&OPUS, Low)
    } else {
        (model, effort)
    };
    RoutedModel {
        model,
        effort: clamp_effort(effort, model),
    }
}

/// Follow-ups stay within the native conversation's provider. This is a
/// capability policy, independent of list price and of the launch grid.
/// `None` for a provider the grid never launches (OpenCode).
pub fn follow_up_target(
    provider: ProviderId,
    tier: AutoTier,
    kind: TaskKind,
    difficulty: Difficulty,
    ui: bool,
) -> Option<RoutedModel> {
    let (_, mut effort) = column_and_effort(tier, difficulty);
    if difficulty == Difficulty::Light && tier != AutoTier::Intelligence {
        effort = Low;
    }
    if kind == TaskKind::Mechanical {
        effort = if difficulty == Difficulty::Light {
            Low
        } else {
            Medium
        };
    }
    let model = match provider {
        ProviderId::Claude => {
            if tier == AutoTier::Intelligence
                && difficulty == Difficulty::Heavy
                && kind == TaskKind::Question
            {
                &FABLE
            } else if tier == AutoTier::Cost && kind != TaskKind::Review {
                // A Speed chat launched on Sonnet stays there. A review is the
                // harder cell and moves to Opus, matching the launch grid.
                &SONNET
            } else {
                if tier == AutoTier::Cost
                    && kind == TaskKind::Review
                    && difficulty != Difficulty::Heavy
                {
                    effort = Low;
                }
                &OPUS
            }
        }
        // Astra is for heavy thinking, not heavy editing: coding follow-ups
        // run on Sol, so a chat launched on Astra for a review does not keep
        // paying Astra rates for the code that follows it.
        ProviderId::Codex => {
            if (difficulty == Difficulty::Heavy
                && !matches!(kind, TaskKind::Coding | TaskKind::Mechanical))
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
                || (tier == AutoTier::Balanced && ui)
            {
                &CURSOR_OPUS
            } else {
                &COMPOSER
            }
        }
        ProviderId::Opencode => return None,
        ProviderId::Grok => {
            effort = grok_effort(difficulty);
            &GROK
        }
    };
    Some(RoutedModel {
        model,
        effort: clamp_effort(effort, model),
    })
}

/// Only compares models in the router's explicit policy. Unknown models are
/// retained, never assigned a capability based on their price.
pub(crate) fn capability(model_id: &str) -> Option<usize> {
    match model_id {
        "composer-2.5" | "grok-4.7" | "claude-sonnet-5-5" => Some(0),
        "claude-opus-5-5" | "claude-opus-5-5-medium" | "gpt-6.1-sol" | "gpt-6-sol" => Some(1),
        "claude-fable-5-1" | "gpt-6-astra" => Some(2),
        _ => None,
    }
}

/// Used when Jev is unavailable: the tier's standard coding cell, so a
/// Speed chat lands on Sonnet medium rather than Opus.
pub fn fallback(tier: AutoTier) -> RoutedModel {
    match tier {
        AutoTier::Cost => RoutedModel {
            model: &SONNET,
            effort: Some(Medium),
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
                    "Sonnet 5.5 · low",
                    "Sonnet 5.5 · medium",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Coding,
                Standard,
                [
                    "Sonnet 5.5 · medium",
                    "Sonnet 5.5 · high",
                    "Opus 5.5 · high",
                ],
            ),
            (
                Coding,
                Heavy,
                ["Sonnet 5.5 · medium", "Opus 5.5 · high", "Opus 5.5 · high"],
            ),
            (
                Mechanical,
                Light,
                [
                    "Composer 2.5 (Cursor)",
                    "Composer 2.5 (Cursor)",
                    "Sonnet 5.5 · medium",
                ],
            ),
            (
                Mechanical,
                Standard,
                [
                    "Composer 2.5 (Cursor)",
                    "Sonnet 5.5 · medium",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Mechanical,
                Heavy,
                [
                    "Composer 2.5 (Cursor)",
                    "Sonnet 5.5 · medium",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Research,
                Light,
                [
                    "Sonnet 5.5 · low",
                    "Sonnet 5.5 · medium",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Research,
                Standard,
                [
                    "Sonnet 5.5 · medium",
                    "Sonnet 5.5 · high",
                    "Opus 5.5 · high",
                ],
            ),
            (
                Research,
                Heavy,
                [
                    "Sonnet 5.5 · medium",
                    "Opus 5.5 · high",
                    "GPT-6 Astra · high",
                ],
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
                [
                    "Sonnet 5.5 · low",
                    "Sonnet 5.5 · medium",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Question,
                Standard,
                [
                    "Sonnet 5.5 · medium",
                    "Opus 5.5 · medium",
                    "Opus 5.5 · high",
                ],
            ),
            (
                Question,
                Heavy,
                ["Sonnet 5.5 · medium", "Opus 5.5 · high", "Fable 5.1 · high"],
            ),
        ];
        for (kind, difficulty, cells) in expected {
            let actual = [AutoTier::Cost, AutoTier::Balanced, AutoTier::Intelligence]
                .map(|tier| cell_text(route(tier, *kind, *difficulty, false)));
            assert_eq!(
                &actual.each_ref().map(String::as_str),
                cells,
                "{kind:?} {difficulty:?}"
            );
        }
    }

    #[test]
    fn clamp_keeps_supported_levels_and_otherwise_steps_down() {
        assert_eq!(clamp_effort(Xhigh, &GROK), Some(Xhigh));
        assert_eq!(clamp_effort(Ultra, &OPUS), Some(Max));
        assert_eq!(clamp_effort(Max, &GROK), Some(Xhigh));
        assert_eq!(clamp_effort(High, &COMPOSER), None);
    }

    #[test]
    fn balance_sends_ui_work_off_composer_to_opus_low() {
        use Difficulty::{Heavy, Light};
        use TaskKind::{Coding, Mechanical, Question};
        let balanced =
            |kind, difficulty, ui| cell_text(route(AutoTier::Balanced, kind, difficulty, ui));
        // Light mechanical is the Composer cell left on Balance.
        assert_eq!(balanced(Mechanical, Light, true), "Opus 5.5 · low");
        assert_eq!(balanced(Mechanical, Light, false), "Composer 2.5 (Cursor)");
        assert_eq!(balanced(Mechanical, Heavy, true), "Sonnet 5.5 · medium");
        assert_eq!(balanced(Coding, Light, true), "Sonnet 5.5 · medium");
        assert_eq!(balanced(Question, Light, true), "Sonnet 5.5 · medium");
        // Speed keeps Composer for mechanical work, including UI work.
        assert_eq!(
            cell_text(route(AutoTier::Cost, Mechanical, Light, true)),
            "Composer 2.5 (Cursor)"
        );
        let cursor = follow_up_target(ProviderId::Cursor, AutoTier::Balanced, Coding, Light, true);
        assert_eq!(
            cursor.map(cell_text).as_deref(),
            Some("Claude Opus 5.5 (Cursor) · low")
        );
    }

    #[test]
    fn follow_ups_size_grok_effort_and_keep_codex_coding_on_sol() {
        let target = |provider, kind, difficulty| {
            follow_up_target(provider, AutoTier::Balanced, kind, difficulty, false).map(cell_text)
        };
        assert_eq!(
            target(ProviderId::Grok, TaskKind::Question, Difficulty::Light).as_deref(),
            Some("Grok 4.7 · low")
        );
        assert_eq!(
            target(ProviderId::Grok, TaskKind::Coding, Difficulty::Standard).as_deref(),
            Some("Grok 4.7 · medium")
        );
        assert_eq!(
            target(ProviderId::Grok, TaskKind::Coding, Difficulty::Heavy).as_deref(),
            Some("Grok 4.7 · high")
        );
        assert_eq!(
            target(ProviderId::Codex, TaskKind::Coding, Difficulty::Heavy).as_deref(),
            Some("GPT-6.1 Sol · high")
        );
        assert_eq!(
            target(ProviderId::Codex, TaskKind::Review, Difficulty::Heavy).as_deref(),
            Some("GPT-6 Astra · high")
        );
        assert_eq!(
            target(ProviderId::Opencode, TaskKind::Coding, Difficulty::Light),
            None
        );
    }

    #[test]
    fn speed_follow_ups_stay_on_sonnet_until_a_review() {
        let target = |kind, difficulty| {
            follow_up_target(ProviderId::Claude, AutoTier::Cost, kind, difficulty, false)
                .map(cell_text)
        };
        assert_eq!(
            target(TaskKind::Question, Difficulty::Light).as_deref(),
            Some("Sonnet 5.5 · low")
        );
        assert_eq!(
            target(TaskKind::Coding, Difficulty::Heavy).as_deref(),
            Some("Sonnet 5.5 · medium")
        );
        assert_eq!(
            target(TaskKind::Review, Difficulty::Standard).as_deref(),
            Some("Opus 5.5 · low")
        );
        assert_eq!(
            target(TaskKind::Review, Difficulty::Heavy).as_deref(),
            Some("Opus 5.5 · medium")
        );
        assert_eq!(
            follow_up_target(
                ProviderId::Claude,
                AutoTier::Balanced,
                TaskKind::Question,
                Difficulty::Light,
                false
            )
            .map(cell_text)
            .as_deref(),
            Some("Opus 5.5 · low")
        );
    }

    #[test]
    fn fallback_follows_the_tier() {
        assert_eq!(cell_text(fallback(AutoTier::Cost)), "Sonnet 5.5 · medium");
        assert_eq!(cell_text(fallback(AutoTier::Balanced)), "Opus 5.5 · medium");
        assert_eq!(
            cell_text(fallback(AutoTier::Intelligence)),
            "Opus 5.5 · medium"
        );
    }
}
