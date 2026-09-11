//! What a transcript page sheds before it crosses the bridge.
//!
//! Measured 2026-09-11 over the bridge for the 25 most recent chats: 43 MB of
//! backfill, of which the renderer paints about a quarter. The rest is the
//! normalizer's `raw` copy of each provider line (9.5 MB), Codex's
//! `aggregated_output` (5.9 MB, read by nothing), base64 screenshots inside
//! tool results that no card draws (13 MB), and streaming deltas the
//! dashboard merge prunes on arrival because their completed answer is on the
//! same page (2.9 MB). None of it reaches a pixel on the phone, so the
//! dispatcher drops it here. The desktop IPC path is untouched: it reads the
//! same rows in-process, where the bytes are free.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::persistence::events::{SessionEventsSinceResult, TimelineEvent};

/// Slim a `session:events-since` page for the bridge: payload weight plus the
/// answer deltas the renderer would prune anyway.
pub fn trim_for_remote(result: &mut SessionEventsSinceResult) {
    trim_payloads_for_remote(result);
    drop_superseded_deltas(&mut result.events);
}

/// Payload weight only. The subagent peek (`session:agent-events`) renders
/// child prose the delta sweep deliberately skips, so it takes this half.
pub fn trim_payloads_for_remote(result: &mut SessionEventsSinceResult) {
    for event in &mut result.events {
        trim_payload(event);
    }
}

fn trim_payload(event: &mut TimelineEvent) {
    let Value::Object(payload) = &mut event.payload else {
        return;
    };
    // The renderer reads `raw` only as the boolean marking a stdout/stderr
    // line; the normalizer's object copy of the provider event is never read.
    if payload.get("raw").is_some_and(Value::is_object) {
        payload.remove("raw");
    }
    if event.r#type != "command.completed" {
        return;
    }
    payload.remove("aggregated_output");
    if let Some(Value::Array(blocks)) = payload.get_mut("content") {
        for block in blocks.iter_mut() {
            if is_inline_image_block(block) {
                *block = json!({ "type": "image", "omitted": true });
            }
        }
    }
}

fn is_inline_image_block(block: &Value) -> bool {
    block
        .get("source")
        .and_then(Value::as_object)
        .and_then(|source| source.get("data"))
        .is_some_and(Value::is_string)
}

/// The turn boundary after a delta, mirroring `turnBoundaries.ts`. Both the
/// desktop merge and the chat view model sweep with this classification; a
/// delta pruned here is one they would have pruned on arrival.
#[derive(Clone)]
enum TurnBoundary {
    Completed { completed_text: String },
    Tool { completed_text: String },
    User,
}

fn drop_superseded_deltas(events: &mut Vec<TimelineEvent>) {
    // Pages arrive oldest-first, but the sweep runs on cursor order so a
    // differently ordered page cannot invert what "after" means.
    let mut ascending: Vec<usize> = (0..events.len()).collect();
    ascending.sort_by(|&left, &right| {
        let l = &events[left];
        let r = &events[right];
        l.row_cursor
            .cmp(&r.row_cursor)
            .then_with(|| l.created_at.cmp(&r.created_at))
            .then(left.cmp(&right))
    });

    let mut next_boundary: HashMap<&str, TurnBoundary> = HashMap::new();
    let mut superseded = vec![false; events.len()];
    for &index in ascending.iter().rev() {
        let event = &events[index];
        let Some(payload) = event.payload.as_object() else {
            continue;
        };
        // Child-agent prose is neither a prune candidate nor a boundary: a
        // hidden child completion must not prune the parent's own answer.
        if is_sub_agent_prose(event, payload) {
            continue;
        }
        let boundary = next_boundary.get(event.session_id.as_str());
        if event.r#type == "message.delta" {
            if is_superseded_answer_delta(event, payload, boundary) {
                superseded[index] = true;
            }
            continue;
        }
        if let Some(advanced) = advance_turn_boundary(boundary, event, payload) {
            next_boundary.insert(event.session_id.as_str(), advanced);
        }
    }

    if !superseded.iter().any(|&dropped| dropped) {
        return;
    }
    let mut index = 0;
    events.retain(|_| {
        let keep = !superseded[index];
        index += 1;
        keep
    });
}

fn advance_turn_boundary(
    previous: Option<&TurnBoundary>,
    event: &TimelineEvent,
    payload: &Map<String, Value>,
) -> Option<TurnBoundary> {
    match event.r#type.as_str() {
        "message.completed" => Some(TurnBoundary::Completed {
            completed_text: event.message.clone(),
        }),
        "command.started" => {
            if non_blank(payload.get("parent_tool_use_id")).is_some() {
                return None;
            }
            match previous {
                Some(TurnBoundary::Completed { completed_text }) => Some(TurnBoundary::Tool {
                    completed_text: completed_text.clone(),
                }),
                _ => None,
            }
        }
        "user.message" => {
            if payload.get("delivery").and_then(Value::as_str) == Some("steer") {
                None
            } else {
                Some(TurnBoundary::User)
            }
        }
        _ => None,
    }
}

fn is_superseded_answer_delta(
    event: &TimelineEvent,
    payload: &Map<String, Value>,
    boundary: Option<&TurnBoundary>,
) -> bool {
    // Thinking deltas are the only record of the reasoning step; they stay.
    if payload.get("thinking") == Some(&Value::Bool(true)) {
        return false;
    }
    match boundary {
        Some(TurnBoundary::Completed { .. }) => true,
        Some(TurnBoundary::Tool { completed_text }) => {
            // A tool ran between the delta and the completion, so the delta
            // may be real pre-tool narration. Prune only an early prefix of
            // the same final message.
            let delta = event.message.trim();
            delta.len() >= 3 && completed_text.trim().starts_with(delta)
        }
        Some(TurnBoundary::User) | None => false,
    }
}

fn is_sub_agent_prose(event: &TimelineEvent, payload: &Map<String, Value>) -> bool {
    if !matches!(event.r#type.as_str(), "message.delta" | "message.completed") {
        return false;
    }
    non_blank(payload.get("parent_tool_use_id")).is_some() || provider_thread_id(payload).is_some()
}

/// Live Codex child messages: `agent_message` payloads with thread linkage.
fn provider_thread_id(payload: &Map<String, Value>) -> Option<&str> {
    let item = payload.get("item").and_then(Value::as_object);
    let is_agent_message = payload.get("item_type").and_then(Value::as_str)
        == Some("agent_message")
        || item
            .and_then(|item| item.get("type"))
            .and_then(Value::as_str)
            == Some("agent_message");
    if !is_agent_message {
        return None;
    }
    non_blank(payload.get("thread_id"))
        .or_else(|| non_blank(payload.get("sender_thread_id")))
        .or_else(|| non_blank(item.and_then(|item| item.get("thread_id"))))
        .or_else(|| non_blank(item.and_then(|item| item.get("sender_thread_id"))))
}

fn non_blank(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(cursor: i64, kind: &str, message: &str, payload: Value) -> TimelineEvent {
        TimelineEvent {
            id: format!("event-{cursor}"),
            session_id: "session-1".to_owned(),
            r#type: kind.to_owned(),
            message: message.to_owned(),
            payload,
            created_at: format!("2026-09-11T00:00:{cursor:02}Z"),
            row_cursor: Some(cursor),
        }
    }

    fn page(events: Vec<TimelineEvent>) -> SessionEventsSinceResult {
        SessionEventsSinceResult {
            events,
            raw_outputs: Vec::new(),
            event_cursor: 0,
            raw_output_cursor: 0,
            change_cursor: None,
            deleted_event_ids: Vec::new(),
            deleted_raw_output_ids: Vec::new(),
            reset_required: false,
            has_more: false,
        }
    }

    fn ids(result: &SessionEventsSinceResult) -> Vec<&str> {
        result.events.iter().map(|e| e.id.as_str()).collect()
    }

    #[test]
    fn tool_results_shed_the_raw_copy_the_codex_duplicate_and_inline_images() {
        let mut result = page(vec![event(
            1,
            "command.completed",
            "tool_result",
            json!({
                "name": "Read",
                "raw": { "type": "item.completed", "item": { "big": "x".repeat(64) } },
                "aggregated_output": "x".repeat(64),
                "content": [
                    { "type": "text", "text": "kept" },
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBOR…" } }
                ]
            }),
        )]);
        trim_for_remote(&mut result);
        let payload = &result.events[0].payload;
        assert_eq!(payload.get("raw"), None);
        assert_eq!(payload.get("aggregated_output"), None);
        assert_eq!(
            payload["content"],
            json!([
                { "type": "text", "text": "kept" },
                { "type": "image", "omitted": true }
            ])
        );
        assert_eq!(payload["name"], "Read");
    }

    #[test]
    fn the_boolean_raw_marker_and_other_events_are_left_alone() {
        let mut result = page(vec![
            event(
                1,
                "message.delta",
                "line",
                json!({ "raw": true, "stream": "stdout" }),
            ),
            event(
                2,
                "command.started",
                "Bash",
                json!({ "raw": { "type": "item.started" }, "input": {} }),
            ),
        ]);
        trim_payloads_for_remote(&mut result);
        assert_eq!(result.events[0].payload["raw"], json!(true));
        assert_eq!(result.events[1].payload.get("raw"), None);
        assert_eq!(result.events[1].payload["input"], json!({}));
    }

    #[test]
    fn answer_deltas_before_their_completion_are_dropped() {
        let mut result = page(vec![
            event(1, "user.message", "hi", json!({})),
            event(2, "message.delta", "thinking", json!({ "thinking": true })),
            event(3, "message.delta", "Hel", json!({})),
            event(4, "message.delta", "Hello", json!({})),
            event(5, "message.completed", "Hello there", json!({})),
            event(6, "message.delta", "still streaming", json!({})),
        ]);
        trim_for_remote(&mut result);
        assert_eq!(
            ids(&result),
            vec!["event-1", "event-2", "event-5", "event-6"]
        );
    }

    #[test]
    fn a_tool_between_delta_and_completion_keeps_narration_but_not_a_prefix() {
        let mut result = page(vec![
            event(
                1,
                "message.delta",
                "Let me look at the file first.",
                json!({}),
            ),
            event(2, "message.delta", "Done. The", json!({})),
            event(3, "command.started", "Read", json!({ "input": {} })),
            event(4, "message.completed", "Done. The file is fine.", json!({})),
        ]);
        trim_for_remote(&mut result);
        assert_eq!(ids(&result), vec!["event-1", "event-3", "event-4"]);
    }

    #[test]
    fn child_agent_prose_is_neither_pruned_nor_a_boundary() {
        let mut result = page(vec![
            event(1, "message.delta", "parent narration", json!({})),
            event(
                2,
                "message.delta",
                "child",
                json!({ "parent_tool_use_id": "tool-1" }),
            ),
            event(
                3,
                "message.completed",
                "child done",
                json!({ "parent_tool_use_id": "tool-1" }),
            ),
            event(
                4,
                "message.completed",
                "codex child",
                json!({ "item_type": "agent_message", "thread_id": "t-1" }),
            ),
        ]);
        trim_for_remote(&mut result);
        assert_eq!(
            ids(&result),
            vec!["event-1", "event-2", "event-3", "event-4"]
        );
    }

    #[test]
    fn a_new_user_turn_keeps_the_answer_that_never_completed() {
        let mut result = page(vec![
            event(1, "message.delta", "partial", json!({})),
            event(2, "user.message", "next", json!({})),
            event(3, "message.completed", "answer", json!({})),
        ]);
        trim_for_remote(&mut result);
        assert_eq!(ids(&result), vec!["event-1", "event-2", "event-3"]);
    }

    #[test]
    fn a_newest_first_page_sweeps_in_cursor_order() {
        let mut result = page(vec![
            event(3, "message.completed", "Hello", json!({})),
            event(2, "message.delta", "Hel", json!({})),
            event(1, "user.message", "hi", json!({})),
        ]);
        trim_for_remote(&mut result);
        assert_eq!(ids(&result), vec!["event-3", "event-1"]);
    }
}
