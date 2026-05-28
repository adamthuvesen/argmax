// Learning extractor. Mirrors `src/main/memory/learningExtractor.ts`.
//
// v1 heuristic: any tool / command that produced an error in
// MIN_REPETITIONS+ events becomes a "pitfall" learning. The earliest
// matching event is recorded as evidence so a future UI can deep-link.
// Deliberately conservative — synthesizing too many low-signal learnings
// would dilute the project knowledge surface.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::persistence::events::TimelineEvent;

const MAX_CANDIDATES_PER_SESSION: usize = 3;
const MIN_REPETITIONS: usize = 2;
const MAX_SUMMARY_LENGTH: usize = 240;
const COMMAND_KEY_PREFIX_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningCandidate {
    pub kind: String,
    pub summary: String,
    pub evidence_session_id: Option<String>,
    pub evidence_event_id: Option<String>,
}

/// Extract up to MAX_CANDIDATES_PER_SESSION candidates from a session's
/// timeline events. Highest-frequency buckets win the cap, not first-seen
/// — the cap intends to keep the strongest signal.
pub fn extract_learning_candidates(events: &[TimelineEvent]) -> Vec<LearningCandidate> {
    let mut buckets: HashMap<String, Bucket> = HashMap::new();
    let mut insertion_order: Vec<String> = Vec::new();
    for event in events {
        let Some(key) = extract_command_key(event) else {
            continue;
        };
        if let Some(bucket) = buckets.get_mut(&key) {
            bucket.count += 1;
        } else {
            insertion_order.push(key.clone());
            buckets.insert(
                key,
                Bucket {
                    count: 1,
                    first_event_id: event.id.clone(),
                    first_session_id: event.session_id.clone(),
                },
            );
        }
    }
    let mut sorted: Vec<(String, Bucket)> = insertion_order
        .into_iter()
        .filter_map(|key| buckets.remove(&key).map(|bucket| (key, bucket)))
        .collect();
    sorted.sort_by_key(|(_, bucket)| std::cmp::Reverse(bucket.count));

    let mut candidates = Vec::new();
    for (key, bucket) in sorted {
        if bucket.count < MIN_REPETITIONS {
            continue;
        }
        candidates.push(LearningCandidate {
            kind: "pitfall".to_string(),
            summary: format!("Recurring failure: {key} (×{})", bucket.count),
            evidence_session_id: Some(bucket.first_session_id),
            evidence_event_id: Some(bucket.first_event_id),
        });
        if candidates.len() >= MAX_CANDIDATES_PER_SESSION {
            break;
        }
    }
    candidates
}

struct Bucket {
    count: usize,
    first_event_id: String,
    first_session_id: String,
}

fn extract_command_key(event: &TimelineEvent) -> Option<String> {
    if event.r#type != "command.completed" {
        return None;
    }
    if !detect_error(&event.payload) {
        return None;
    }
    let tool_name = event
        .payload
        .get("tool_name")
        .and_then(|value| value.as_str())
        .map(|s| s.to_string());
    let message = event.message.trim().to_string();
    let source = tool_name.unwrap_or(message);
    if source.is_empty() {
        return None;
    }
    if source.chars().count() <= COMMAND_KEY_PREFIX_CHARS {
        return Some(truncate_chars(&source, MAX_SUMMARY_LENGTH));
    }
    let prefix: String = source.chars().take(COMMAND_KEY_PREFIX_CHARS).collect();
    let tail: String = source.chars().skip(COMMAND_KEY_PREFIX_CHARS).collect();
    let mut hasher = Sha256::new();
    hasher.update(tail.as_bytes());
    let digest = hasher.finalize();
    let tail_hash: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    Some(truncate_chars(
        &format!("{prefix}#{tail_hash}"),
        MAX_SUMMARY_LENGTH,
    ))
}

fn detect_error(payload: &serde_json::Value) -> bool {
    if payload.get("is_error").and_then(|v| v.as_bool()) == Some(true) {
        return true;
    }
    if let Some(s) = payload.get("error").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            return true;
        }
    }
    if let Some(code) = payload.get("exitCode").and_then(|v| v.as_i64()) {
        if code != 0 {
            return true;
        }
    }
    false
}

fn truncate_chars(value: &str, max: usize) -> String {
    let mut out = String::with_capacity(value.len().min(max));
    for (idx, ch) in value.chars().enumerate() {
        if idx >= max {
            break;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(id: &str, r#type: &str, message: &str, payload: serde_json::Value) -> TimelineEvent {
        TimelineEvent {
            id: id.to_string(),
            session_id: "s1".to_string(),
            r#type: r#type.to_string(),
            message: message.to_string(),
            payload,
            created_at: "2026-05-24T00:00:00Z".to_string(),
            row_cursor: None,
        }
    }

    #[test]
    fn returns_empty_when_no_recurring_failures() {
        let events = vec![event(
            "e1",
            "command.completed",
            "ls",
            json!({"is_error": false}),
        )];
        assert!(extract_learning_candidates(&events).is_empty());
    }

    #[test]
    fn flags_recurring_failure_at_min_repetitions() {
        let events = vec![
            event("e1", "command.completed", "tsc", json!({"is_error": true})),
            event("e2", "command.completed", "tsc", json!({"is_error": true})),
        ];
        let candidates = extract_learning_candidates(&events);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].kind, "pitfall");
        assert!(candidates[0].summary.contains("tsc"));
        assert_eq!(candidates[0].evidence_event_id.as_deref(), Some("e1"));
    }

    #[test]
    fn highest_frequency_bucket_wins_cap() {
        let mut events = Vec::new();
        // 4 of "tsc" first
        for i in 0..4 {
            events.push(event(
                &format!("a{i}"),
                "command.completed",
                "tsc",
                json!({"is_error": true}),
            ));
        }
        for kind in ["b", "c", "d", "e"] {
            for i in 0..2 {
                events.push(event(
                    &format!("{kind}{i}"),
                    "command.completed",
                    kind,
                    json!({"is_error": true}),
                ));
            }
        }
        let candidates = extract_learning_candidates(&events);
        assert_eq!(candidates.len(), 3);
        assert!(candidates[0].summary.starts_with("Recurring failure: tsc"));
    }

    #[test]
    fn long_source_hashes_tail_to_keep_buckets_distinct() {
        let long = "x".repeat(300);
        let other = format!("{long}DIFFERENT");
        let events = vec![
            event("e1", "command.completed", &long, json!({"is_error": true})),
            event("e2", "command.completed", &long, json!({"is_error": true})),
            event("e3", "command.completed", &other, json!({"is_error": true})),
            event("e4", "command.completed", &other, json!({"is_error": true})),
        ];
        let candidates = extract_learning_candidates(&events);
        assert_eq!(candidates.len(), 2, "buckets should not collapse");
    }
}
