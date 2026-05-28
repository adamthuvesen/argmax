// Learning injector. Mirrors `src/main/memory/learningInjector.ts`.
//
// Prepends a project-knowledge preamble (top-K learnings) to a fresh
// session prompt. Caps total preamble at ~2000 chars so the injection
// doesn't dwarf the actual prompt.

use crate::persistence::learnings::Learning;

const TOP_K: usize = 5;
/// Rough cap on the preamble: ~500 tokens ≈ ~2000 chars at the usual ratio.
const MAX_PREAMBLE_CHARS: usize = 2000;

const PREAMBLE_HEADER: &str =
    "Project knowledge — facts captured from prior sessions in this project. Apply where relevant; ignore if not.\n";

pub struct InjectionResult {
    /// The original prompt with the preamble prepended, or unchanged if
    /// no learnings exist.
    pub augmented_prompt: String,
    /// Learnings actually included in the preamble — useful for bumping
    /// `hits`.
    pub injected_ids: Vec<String>,
}

pub fn compose_learning_preamble(learnings: &[Learning], original_prompt: &str) -> InjectionResult {
    if learnings.is_empty() {
        return InjectionResult {
            augmented_prompt: original_prompt.to_string(),
            injected_ids: Vec::new(),
        };
    }
    let mut lines = Vec::new();
    let mut injected_ids = Vec::new();
    let mut consumed = PREAMBLE_HEADER.len() + 2; // trailing "\n\n"
    for learning in learnings.iter().take(TOP_K) {
        let bullet = format!("- ({}) {}\n", learning.kind, learning.summary);
        if consumed + bullet.len() > MAX_PREAMBLE_CHARS {
            break;
        }
        consumed += bullet.len();
        lines.push(bullet);
        injected_ids.push(learning.id.clone());
    }
    if lines.is_empty() {
        return InjectionResult {
            augmented_prompt: original_prompt.to_string(),
            injected_ids: Vec::new(),
        };
    }
    let augmented = format!("{PREAMBLE_HEADER}{}\n{original_prompt}", lines.concat());
    InjectionResult {
        augmented_prompt: augmented,
        injected_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(id: &str, kind: &str, summary: &str) -> Learning {
        Learning {
            id: id.to_string(),
            project_id: "p1".to_string(),
            kind: kind.to_string(),
            summary: summary.to_string(),
            evidence_session_id: None,
            evidence_event_id: None,
            verified: false,
            hits: 0,
            created_at: "2026-05-24T00:00:00Z".to_string(),
            last_seen_at: "2026-05-24T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn returns_original_when_no_learnings() {
        let result = compose_learning_preamble(&[], "do the thing");
        assert_eq!(result.augmented_prompt, "do the thing");
        assert!(result.injected_ids.is_empty());
    }

    #[test]
    fn prepends_top_k_bullets() {
        let learnings = vec![
            fixture("l1", "pitfall", "avoid X"),
            fixture("l2", "convention", "we prefer Y"),
        ];
        let result = compose_learning_preamble(&learnings, "ship Z");
        assert!(result.augmented_prompt.contains("Project knowledge"));
        assert!(result.augmented_prompt.contains("- (pitfall) avoid X"));
        assert!(result
            .augmented_prompt
            .contains("- (convention) we prefer Y"));
        assert!(result.augmented_prompt.ends_with("ship Z"));
        assert_eq!(result.injected_ids, vec!["l1", "l2"]);
    }

    #[test]
    fn truncates_when_second_bullet_would_exceed_cap() {
        // First bullet fits comfortably; second is too big to add.
        let small = "ok".to_string();
        let big = "x".repeat(MAX_PREAMBLE_CHARS);
        let learnings = vec![
            fixture("l1", "pitfall", &small),
            fixture("l2", "pitfall", &big),
        ];
        let result = compose_learning_preamble(&learnings, "prompt");
        assert_eq!(result.injected_ids, vec!["l1"]);
    }

    #[test]
    fn returns_original_when_first_bullet_already_exceeds_cap() {
        let way_too_big = "x".repeat(MAX_PREAMBLE_CHARS * 4);
        let result = compose_learning_preamble(&[fixture("l1", "pitfall", &way_too_big)], "prompt");
        assert_eq!(result.augmented_prompt, "prompt");
        assert!(result.injected_ids.is_empty());
    }
}
