// A prompt can steer the router: "use astra high" on Frontier launches Astra
// at high. The router only honors a request for a model and effort its own
// grid can reach on that tier (`reachable`), so no prompt can start, say,
// DeepSeek on Frontier. A request outside the tier is ignored and the grid
// routes as usual; the reason records why.

use std::sync::LazyLock;

use regex::Regex;

use super::table::{self, AutoTier, Difficulty, RouteModel, RoutedModel, TaskKind};
use crate::ipc::validation::ReasoningEffort;

const KINDS: [TaskKind; 5] = [
    TaskKind::Coding,
    TaskKind::Mechanical,
    TaskKind::Research,
    TaskKind::Review,
    TaskKind::Question,
];
const DIFFICULTIES: [Difficulty; 3] = [Difficulty::Light, Difficulty::Standard, Difficulty::Heavy];

/// "use <model> [effort]" opening the prompt, or alone on its last line. A
/// mention deeper in the text ("the router should use Astra") is not a request.
static REQUEST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^\s*(?:please\s+)?use\s+(?:the\s+)?(?:gpt-?6(?:\.1)?\s+)?(deepseek|astra|sol|luna|opus|sonnet|fable)(?:\s+v?\d+(?:\.\d+)*)?(?:\s+flash)?(?:\s+(?:at\s+)?(low|medium|med|high|xhigh|max|ultra))?(?:\s+effort)?\b",
    )
    .expect("directive pattern")
});

#[derive(Debug, PartialEq, Eq)]
pub enum Directive {
    /// The prompt makes no request.
    None,
    /// A request the tier can serve.
    Route(RoutedModel),
    /// A request the tier cannot serve; the text says why.
    Refused(String),
}

pub fn parse(prompt: &str, tier: AutoTier) -> Directive {
    let Some((model_word, effort_word)) = find_request(prompt) else {
        return Directive::None;
    };
    let model = match model_word.as_str() {
        "deepseek" => &table::DEEPSEEK,
        "astra" => &table::ASTRA,
        "sol" => &table::SOL,
        "luna" => &table::LUNA,
        "opus" => &table::OPUS,
        "sonnet" => &table::SONNET,
        "fable" => &table::FABLE,
        other => unreachable!("directive pattern matched {other}"),
    };
    let efforts = reachable(tier, model);
    if efforts.is_empty() {
        return Directive::Refused(format!(
            "{} is not routable on {}",
            model.label,
            super::tier_label(tier)
        ));
    }
    let effort = match effort_word {
        Some(effort) if efforts.contains(&effort) => effort,
        Some(effort) => {
            return Directive::Refused(format!(
                "{} {} is not routable on {}",
                model.label,
                effort.as_str(),
                super::tier_label(tier)
            ))
        }
        None => default_effort(&efforts),
    };
    Directive::Route(RoutedModel {
        model,
        effort: Some(effort),
    })
}

fn find_request(prompt: &str) -> Option<(String, Option<ReasoningEffort>)> {
    let prompt = prompt.trim();
    let first_line = prompt.lines().next()?;
    let last_line = prompt.lines().next_back()?;
    let captures = REQUEST.captures(first_line).or_else(|| {
        let captures = REQUEST.captures(last_line)?;
        // On the last line the request is the whole line.
        let rest = &last_line[captures.get(0)?.end()..];
        rest.trim()
            .trim_matches(['.', '!'])
            .is_empty()
            .then_some(captures)
    })?;
    let effort = captures
        .get(2)
        .map(|word| match word.as_str().to_lowercase().as_str() {
            "low" => ReasoningEffort::Low,
            "medium" | "med" => ReasoningEffort::Medium,
            "high" => ReasoningEffort::High,
            "xhigh" => ReasoningEffort::Xhigh,
            "max" => ReasoningEffort::Max,
            _ => ReasoningEffort::Ultra,
        });
    Some((captures[1].to_lowercase(), effort))
}

/// The efforts at which the grid launches this model on this tier, over every
/// kind, difficulty and UI case. That set is what "wired up for the router"
/// means: a model or effort the grid never picks is not on offer.
fn reachable(tier: AutoTier, model: &RouteModel) -> Vec<ReasoningEffort> {
    let mut efforts: Vec<ReasoningEffort> = Vec::new();
    for kind in KINDS {
        for difficulty in DIFFICULTIES {
            for ui in [false, true] {
                let routed = table::route(tier, kind, difficulty, ui);
                if routed.model == model {
                    efforts.extend(routed.effort);
                }
            }
        }
    }
    efforts.sort_by_key(|effort| table::rank(*effort));
    efforts.dedup();
    efforts
}

/// No effort named: medium if the tier runs the model there, else the next
/// level up, else its strongest. `efforts` is non-empty and sorted.
fn default_effort(efforts: &[ReasoningEffort]) -> ReasoningEffort {
    let medium = table::rank(ReasoningEffort::Medium);
    efforts
        .iter()
        .copied()
        .find(|effort| table::rank(*effort) >= medium)
        .unwrap_or(efforts[efforts.len() - 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routed(directive: Directive) -> (&'static str, Option<ReasoningEffort>) {
        match directive {
            Directive::Route(route) => (route.model.model_id, route.effort),
            other => panic!("expected a route, got {other:?}"),
        }
    }

    #[test]
    fn frontier_honors_astra_high() {
        let directive = parse("use astra high. Review the diff", AutoTier::Intelligence);
        assert_eq!(
            routed(directive),
            ("gpt-6-astra", Some(ReasoningEffort::High))
        );
    }

    #[test]
    fn a_tier_cannot_be_steered_to_a_model_its_grid_never_picks() {
        let directive = parse("use deepseek v4.1 flash low", AutoTier::Intelligence);
        assert!(matches!(directive, Directive::Refused(_)));
        let directive = parse("use astra", AutoTier::Cost);
        assert!(matches!(directive, Directive::Refused(_)));
    }

    #[test]
    fn a_tier_cannot_be_steered_to_an_effort_its_grid_never_picks() {
        // Frontier reaches Astra only at high.
        let directive = parse("use astra max", AutoTier::Intelligence);
        assert!(matches!(directive, Directive::Refused(_)));
    }

    #[test]
    fn no_effort_takes_the_tiers_own_level() {
        let directive = parse("use astra", AutoTier::Intelligence);
        assert_eq!(
            routed(directive),
            ("gpt-6-astra", Some(ReasoningEffort::High))
        );
    }

    #[test]
    fn only_a_leading_or_closing_request_counts() {
        assert_eq!(
            parse(
                "make the router use astra high on Frontier",
                AutoTier::Intelligence
            ),
            Directive::None
        );
        assert_eq!(
            parse("What is a solution?", AutoTier::Intelligence),
            Directive::None
        );
        let directive = parse("Review this diff\nuse astra high.", AutoTier::Intelligence);
        assert_eq!(
            routed(directive),
            ("gpt-6-astra", Some(ReasoningEffort::High))
        );
    }
}
