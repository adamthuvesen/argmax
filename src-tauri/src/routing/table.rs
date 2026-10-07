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
pub const LUNA: RouteModel = RouteModel {
    provider: ProviderId::Codex,
    model_id: "gpt-6-luna",
    label: "GPT-6 Luna",
    efforts: &[Low, Medium, High, Xhigh, Max],
};
pub const ASTRA: RouteModel = RouteModel {
    provider: ProviderId::Codex,
    model_id: "gpt-6-astra",
    label: "GPT-6 Astra",
    efforts: CODEX_EFFORTS,
};
/// Mechanical edits on every tier that used Composer. It runs on OpenCode
/// through OpenRouter. Its CLI takes low, high and max, so the medium that
/// mechanical work asks for clamps down to low.
pub const DEEPSEEK: RouteModel = RouteModel {
    provider: ProviderId::Opencode,
    model_id: "openrouter/deepseek/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    efforts: &[Low, High, Max],
};
/// No longer a grid cell. Kept for chats already on Cursor, which follow up and
/// escalate inside their own conversation.
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
    &LUNA,
    &ASTRA,
    &DEEPSEEK,
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
        // Renames stay on a cheap, fast model, since the work does not repay
        // Sonnet's price. DeepSeek V4.1 Flash replaced Composer here
        // (2026-10-04): 0.66 s to first token against Composer's 8.3 s through
        // its CLI, at $0.15 / $0.60 per million tokens. Only raw API speed is
        // measured; no agent-task quality comparison exists yet.
        (TaskKind::Mechanical, Column::Cheap | Column::Value) => &DEEPSEEK,
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
        (AutoTier::Economy, Difficulty::Light | Difficulty::Standard) => (Column::Cheap, Medium),
        (AutoTier::Economy, Difficulty::Heavy) => (Column::Value, High),
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

/// Effort that follows the task's difficulty: low → medium → high. A chat
/// already on Grok uses it (the launch grid no longer picks Grok), and so do
/// Sonnet reviews on Speed and Cost.
fn difficulty_effort(difficulty: Difficulty) -> ReasoningEffort {
    match difficulty {
        Difficulty::Light => Low,
        Difficulty::Standard => Medium,
        Difficulty::Heavy => High,
    }
}

/// When a cell in `cost_route` or `speed_route` changes, also update the tier
/// blurbs in `AUTO_TIER_DESCRIPTIONS` (`src/renderer/lib/models.ts`) and the
/// tables in `docs/routing.md`. Nothing checks them against this file.
///
/// Cost minimizes API-equivalent completion cost. Reviews run on Sonnet, half
/// Opus's per-token price; a reported-wrong review still climbs the Cost
/// ladder. Standard questions edit nothing, so they take Luna at 1/20 of
/// Sol's price. Mechanical edits stop at medium.
///
/// Luna came back from DeepSeek V4.1 Flash on 2026-10-06. Artificial Analysis
/// scores them alike (index 38 vs 39), but Luna costs $0.07 per index task
/// against DeepSeek's $0.27: DeepSeek writes more tokens, doubles its price at
/// peak hours, and OpenRouter's host choice moves its cache-read rate.
/// DeepSeek keeps the cells where its latency is the point, on Speed and Balance.
fn cost_route(kind: TaskKind, difficulty: Difficulty) -> RoutedModel {
    let (model, effort) = match (kind, difficulty) {
        (TaskKind::Review, _) => (&SONNET, difficulty_effort(difficulty)),
        (TaskKind::Mechanical, _)
        | (_, Difficulty::Light)
        | (TaskKind::Question, Difficulty::Standard) => (&LUNA, Medium),
        (_, Difficulty::Standard) => (&SOL, Medium),
        (_, Difficulty::Heavy) => (&SOL, High),
    };
    RoutedModel {
        model,
        effort: Some(effort),
    }
}

/// `ui` marks visual UI or design work. The DeepSeek cell left on Balance is
/// light mechanical work, and that UI work goes to Opus 5.5 low: Composer's
/// UI tweaks (the model DeepSeek replaced) were the chats most often reported wrong (3 of 22 escalated,
/// 2026-09-28).
pub fn route(tier: AutoTier, kind: TaskKind, difficulty: Difficulty, ui: bool) -> RoutedModel {
    if tier == AutoTier::Economy {
        return cost_route(kind, difficulty);
    }
    let (column, mut effort) = column_and_effort(tier, difficulty);
    // Renames and bulk edits never repay more than medium, on any tier.
    if kind == TaskKind::Mechanical && rank(effort) > rank(Medium) {
        effort = Medium;
    }
    // A missed bug costs more than a slower review, so the cheap review cell is
    // Opus at low rather than a cheap model: on CursorBench 4.0 Opus low scores
    // 43.7% against Composer's 27.7% at about 1.7x the cost per task, and it
    // reviewed faster in-app (15 s vs 35 s, 2026-09-27).
    if kind == TaskKind::Review && column == Column::Cheap {
        effort = Low;
    }
    let model = match (tier, difficulty, kind) {
        // Frontier's heaviest thinking goes to Fable, where latency no longer
        // counts: deep investigations and the big design and architecture
        // questions. On research-style benchmarks Fable beats Astra (HLE 65.6
        // vs 57.2, GDPval 1735 vs 1542, 2026-10-06). Coding stays on Opus,
        // which outscores Fable high on CursorBench (56.0% vs 49.2%); Fable is
        // the step after Opus high on its ladder. Astra keeps Frontier reviews,
        // so a second model family checks the work.
        (AutoTier::Intelligence, Difficulty::Heavy, TaskKind::Research | TaskKind::Question) => {
            &FABLE
        }
        // Frontier light is the value column, which is DeepSeek for a
        // rename. A small mechanical edit there still gets Sonnet medium.
        (AutoTier::Intelligence, Difficulty::Light, TaskKind::Mechanical) => &SONNET,
        // Speed reviews run on Sonnet with effort by difficulty: Sonnet high
        // finishes about as fast as Opus low (17 s vs 19 s on Artificial
        // Analysis, 2026-10-02) at half the per-token price.
        (AutoTier::Cost, _, TaskKind::Review) => {
            effort = difficulty_effort(difficulty);
            &SONNET
        }
        // Light questions and research edit nothing, so a weak answer is cheap
        // to catch. DeepSeek V4.1 Flash answers first (0.66 s to first token
        // against Sonnet's 1.19 s, 2026-10-04). Light coding stays on Sonnet.
        (AutoTier::Cost, Difficulty::Light, TaskKind::Research | TaskKind::Question) => {
            effort = High;
            &DEEPSEEK
        }
        // Speed's heavy column is Opus. Sonnet medium finished the same two
        // small tasks faster than Opus medium and at about half the price
        // (2026-09-28).
        (
            AutoTier::Cost,
            Difficulty::Heavy,
            TaskKind::Coding | TaskKind::Research | TaskKind::Question,
        ) => &SONNET,
        // Balance's mechanical value cell is DeepSeek. Standard and heavy
        // edits go to Sonnet; light renames stay on DeepSeek.
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
    let (model, effort) = if tier == AutoTier::Balanced && ui && model == &DEEPSEEK {
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
/// `None` for OpenCode: a DeepSeek chat keeps its model on follow-ups.
pub fn follow_up_target(
    provider: ProviderId,
    tier: AutoTier,
    kind: TaskKind,
    difficulty: Difficulty,
    ui: bool,
) -> Option<RoutedModel> {
    if tier == AutoTier::Economy {
        let target = cost_route(kind, difficulty);
        match provider {
            ProviderId::Codex => {
                return Some(RoutedModel {
                    // Keep the native Codex conversation for a review. A reported
                    // wrong answer can cross to Opus through the Cost ladder.
                    model: if target.model.provider == ProviderId::Codex {
                        target.model
                    } else {
                        &SOL
                    },
                    effort: target.effort,
                });
            }
            ProviderId::Claude => {
                // Cost work on Claude stays on Sonnet, reviews included, as
                // the launch does; only heavy non-mechanical work takes Opus.
                let heavy = difficulty == Difficulty::Heavy
                    && !matches!(kind, TaskKind::Mechanical | TaskKind::Review);
                return Some(RoutedModel {
                    model: if heavy { &OPUS } else { &SONNET },
                    effort: target.effort,
                });
            }
            _ => {}
        }
    }
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
                && matches!(kind, TaskKind::Question | TaskKind::Research)
            {
                &FABLE
            } else if tier == AutoTier::Cost {
                // A Speed chat stays on Sonnet. A review takes its effort from
                // difficulty, matching the launch grid.
                if kind == TaskKind::Review {
                    effort = difficulty_effort(difficulty);
                }
                &SONNET
            } else {
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
            effort = difficulty_effort(difficulty);
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
        "composer-2.5"
        | "openrouter/deepseek/deepseek-v4.1-flash"
        | "grok-4.7"
        | "claude-sonnet-5-5"
        | "gpt-6-luna" => Some(0),
        "claude-opus-5-5" | "claude-opus-5-5-medium" | "gpt-6.1-sol" | "gpt-6-sol" => Some(1),
        "claude-fable-5-1" | "gpt-6-astra" => Some(2),
        _ => None,
    }
}

/// Used when Jev is unavailable: the tier's standard coding cell, so a
/// Speed chat lands on Sonnet medium rather than Opus.
pub fn fallback(tier: AutoTier) -> RoutedModel {
    match tier {
        AutoTier::Economy => RoutedModel {
            model: &SOL,
            effort: Some(Medium),
        },
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

/// The routable model for a stored id. A retired id resolves to its
/// successor, so a saved Auto chat on it keeps a known capability instead of
/// reaching the follow-up path's `expect`.
pub fn route_model(model_id: &str) -> Option<&'static RouteModel> {
    let model_id = match model_id {
        "gpt-6-sol" => "gpt-6.1-sol",
        other => other,
    };
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
                    "DeepSeek V4.1 Flash · low",
                    "DeepSeek V4.1 Flash · low",
                    "Sonnet 5.5 · medium",
                ],
            ),
            (
                Mechanical,
                Standard,
                [
                    "DeepSeek V4.1 Flash · low",
                    "Sonnet 5.5 · medium",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Mechanical,
                Heavy,
                [
                    "DeepSeek V4.1 Flash · low",
                    "Sonnet 5.5 · medium",
                    "Opus 5.5 · medium",
                ],
            ),
            (
                Research,
                Light,
                [
                    "DeepSeek V4.1 Flash · high",
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
                ["Sonnet 5.5 · medium", "Opus 5.5 · high", "Fable 5.1 · high"],
            ),
            (
                Review,
                Light,
                ["Sonnet 5.5 · low", "Opus 5.5 · low", "Opus 5.5 · medium"],
            ),
            (
                Review,
                Standard,
                [
                    "Sonnet 5.5 · medium",
                    "Opus 5.5 · medium",
                    "GPT-6 Astra · high",
                ],
            ),
            (
                Review,
                Heavy,
                ["Sonnet 5.5 · high", "Opus 5.5 · high", "GPT-6 Astra · high"],
            ),
            (
                Question,
                Light,
                [
                    "DeepSeek V4.1 Flash · high",
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
    fn cost_launches_match_the_budget_policy_without_changing_speed() {
        use Difficulty::{Heavy, Light, Standard};
        use TaskKind::{Coding, Mechanical, Question, Research, Review};
        for kind in [Coding, Research, Question] {
            let standard = if kind == Question {
                "GPT-6 Luna · medium"
            } else {
                "GPT-6.1 Sol · medium"
            };
            for (difficulty, expected) in [
                (Light, "GPT-6 Luna · medium"),
                (Standard, standard),
                (Heavy, "GPT-6.1 Sol · high"),
            ] {
                assert_eq!(
                    cell_text(route(AutoTier::Economy, kind, difficulty, false)),
                    expected
                );
            }
        }
        for (kind, difficulty, expected) in [
            (Mechanical, Light, "GPT-6 Luna · medium"),
            (Mechanical, Standard, "GPT-6 Luna · medium"),
            (Mechanical, Heavy, "GPT-6 Luna · medium"),
            (Review, Light, "Sonnet 5.5 · low"),
            (Review, Standard, "Sonnet 5.5 · medium"),
            (Review, Heavy, "Sonnet 5.5 · high"),
        ] {
            assert_eq!(
                cell_text(route(AutoTier::Economy, kind, difficulty, false)),
                expected
            );
            assert_eq!(
                route(AutoTier::Economy, kind, difficulty, true),
                route(AutoTier::Economy, kind, difficulty, false)
            );
        }
        assert_eq!(
            cell_text(fallback(AutoTier::Economy)),
            "GPT-6.1 Sol · medium"
        );
        assert_eq!(cell_text(fallback(AutoTier::Cost)), "Sonnet 5.5 · medium");
        assert_eq!(clamp_effort(Ultra, &LUNA), Some(Max));
    }

    #[test]
    fn cost_follow_ups_keep_the_native_provider_and_budget_models() {
        assert_eq!(
            cell_text(
                follow_up_target(
                    ProviderId::Codex,
                    AutoTier::Economy,
                    TaskKind::Coding,
                    Difficulty::Light,
                    false
                )
                .unwrap()
            ),
            "GPT-6 Luna · medium"
        );
        assert_eq!(
            cell_text(
                follow_up_target(
                    ProviderId::Codex,
                    AutoTier::Economy,
                    TaskKind::Mechanical,
                    Difficulty::Heavy,
                    false
                )
                .unwrap()
            ),
            "GPT-6 Luna · medium"
        );
        assert_eq!(
            cell_text(
                follow_up_target(
                    ProviderId::Codex,
                    AutoTier::Economy,
                    TaskKind::Review,
                    Difficulty::Heavy,
                    false
                )
                .unwrap()
            ),
            "GPT-6.1 Sol · high"
        );
        assert_eq!(
            cell_text(
                follow_up_target(
                    ProviderId::Claude,
                    AutoTier::Economy,
                    TaskKind::Review,
                    Difficulty::Heavy,
                    false
                )
                .unwrap()
            ),
            "Sonnet 5.5 · high"
        );
        // Work substituted onto Claude stays on Sonnet, as the launch does.
        for (kind, difficulty, expected) in [
            (TaskKind::Coding, Difficulty::Light, "Sonnet 5.5 · medium"),
            (
                TaskKind::Mechanical,
                Difficulty::Heavy,
                "Sonnet 5.5 · medium",
            ),
            (TaskKind::Research, Difficulty::Heavy, "Opus 5.5 · high"),
        ] {
            assert_eq!(
                cell_text(
                    follow_up_target(
                        ProviderId::Claude,
                        AutoTier::Economy,
                        kind,
                        difficulty,
                        false
                    )
                    .unwrap()
                ),
                expected,
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
        // Light mechanical is the DeepSeek cell left on Balance.
        assert_eq!(balanced(Mechanical, Light, true), "Opus 5.5 · low");
        assert_eq!(
            balanced(Mechanical, Light, false),
            "DeepSeek V4.1 Flash · low"
        );
        assert_eq!(balanced(Mechanical, Heavy, true), "Sonnet 5.5 · medium");
        assert_eq!(balanced(Coding, Light, true), "Sonnet 5.5 · medium");
        assert_eq!(balanced(Question, Light, true), "Sonnet 5.5 · medium");
        // Speed keeps DeepSeek for mechanical work, including UI work.
        assert_eq!(
            cell_text(route(AutoTier::Cost, Mechanical, Light, true)),
            "DeepSeek V4.1 Flash · low"
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
    fn speed_follow_ups_stay_on_sonnet() {
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
            Some("Sonnet 5.5 · medium")
        );
        assert_eq!(
            target(TaskKind::Review, Difficulty::Heavy).as_deref(),
            Some("Sonnet 5.5 · high")
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
}
