//! OpenCode `run --format json` events.
//!
//! Each stdout line is a typed envelope: `{"type": ..., "timestamp": ...,
//! "sessionID": "ses_...", "part": {...}}`. Parts arrive whole (no token
//! streaming): `text` is a complete assistant message, `reasoning` a complete
//! thinking block, and `tool_use` a single event whose `state` already carries
//! input and output. `step_finish` closes each model step with token counts
//! and a `reason` ("stop" ends the turn, "tool-calls" continues it).

use serde_json::{json, Map, Value};

use super::{
    number_value, object_value, string_value, timeline_event, NormalizedUsage,
    NormalizerSessionContext, ProviderOutputEvent, UsageCounts,
};
use crate::{persistence::events::PersistTimelineEventInput, providers::pricing::cost_of};

/// The `sessionID` envelope field is OpenCode's resume id (`run -s <id>`).
/// Every event carries it, so the first one seeds `provider_conversation_id`.
pub fn extract_session_id(payload: &Map<String, Value>) -> Option<String> {
    string_value(payload.get("sessionID")).map(str::to_string)
}

/// Maps one OpenCode envelope to timeline events. Returns an empty vec for
/// lifecycle rows (`step_start`, mid-turn `step_finish`) and unknown types —
/// OpenCode's protocol is fully typed, so an unrecognized JSON envelope is
/// protocol noise, never chat.
pub fn normalize_event(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
) -> Vec<PersistTimelineEventInput> {
    let part = object_value(payload.get("part"));
    match provider_type {
        Some("text") => normalize_text(event, payload, part).into_iter().collect(),
        Some("reasoning") => normalize_reasoning(event, payload, part)
            .into_iter()
            .collect(),
        Some("tool_use") => normalize_tool_use(event, part),
        Some("step_finish") => normalize_step_finish(event, part).into_iter().collect(),
        Some("error") => normalize_error(event, payload).into_iter().collect(),
        _ => Vec::new(),
    }
}

fn normalize_text(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    part: Option<&Map<String, Value>>,
) -> Option<PersistTimelineEventInput> {
    let text = string_value(part?.get("text"))?;
    if text.trim().is_empty() {
        return None;
    }
    Some(timeline_event(
        event,
        "message.completed",
        text,
        Value::Object(payload.clone()),
    ))
}

fn normalize_reasoning(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    part: Option<&Map<String, Value>>,
) -> Option<PersistTimelineEventInput> {
    let text = string_value(part?.get("text"))?;
    if text.trim().is_empty() {
        return None;
    }
    let mut thinking_payload = payload.clone();
    thinking_payload.insert("thinking".to_string(), Value::Bool(true));
    thinking_payload.insert(
        "providerEventType".to_string(),
        Value::String("reasoning".to_string()),
    );
    Some(timeline_event(
        event,
        "message.delta",
        text,
        Value::Object(thinking_payload),
    ))
}

/// A `tool_use` envelope arrives once, already completed, with input and
/// output in `part.state`. Emit a started/completed pair so the chat's
/// command row goes through its normal lifecycle.
fn normalize_tool_use(
    event: &ProviderOutputEvent,
    part: Option<&Map<String, Value>>,
) -> Vec<PersistTimelineEventInput> {
    let Some(part) = part else {
        return Vec::new();
    };
    let tool_name = string_value(part.get("tool")).unwrap_or("tool_use");
    let state = object_value(part.get("state"));
    let input = state
        .and_then(|state| object_value(state.get("input")))
        .cloned()
        .unwrap_or_default();

    let mut flattened = Map::new();
    flattened.insert("name".to_string(), Value::String(tool_name.to_string()));
    flattened.insert("input".to_string(), Value::Object(input));
    if let Some(call_id) = string_value(part.get("callID")) {
        flattened.insert("call_id".to_string(), Value::String(call_id.to_string()));
    }
    flattened.insert("raw".to_string(), Value::Object(part.clone()));

    let started = timeline_event(
        event,
        "command.started",
        tool_name,
        Value::Object(flattened.clone()),
    );

    let mut completed_payload = flattened;
    if let Some(output) = state.and_then(|state| state.get("output")) {
        completed_payload.insert("result".to_string(), output.clone());
    }
    if let Some(error) = state.and_then(|state| string_value(state.get("error"))) {
        completed_payload.insert("error".to_string(), Value::String(error.to_string()));
    }
    let completed = timeline_event(
        event,
        "command.completed",
        tool_name,
        Value::Object(completed_payload),
    );

    vec![started, completed]
}

/// `reason: "stop"` is the turn's final step — surface it as the turn-ending
/// lifecycle row the way Claude/Codex map their `result` lines. `tool-calls`
/// steps continue the turn and stay hidden.
fn normalize_step_finish(
    event: &ProviderOutputEvent,
    part: Option<&Map<String, Value>>,
) -> Option<PersistTimelineEventInput> {
    if string_value(part?.get("reason")) != Some("stop") {
        return None;
    }
    Some(timeline_event(
        event,
        "session.completed",
        String::new(),
        json!({ "opencodeStepFinish": true }),
    ))
}

fn normalize_error(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
) -> Option<PersistTimelineEventInput> {
    let error = object_value(payload.get("error"));
    let message = error
        .and_then(|error| object_value(error.get("data")))
        .and_then(|data| string_value(data.get("message")))
        .or_else(|| error.and_then(|error| string_value(error.get("name"))))
        .unwrap_or("OpenCode reported an error");
    Some(timeline_event(
        event,
        "error",
        message,
        Value::Object(payload.clone()),
    ))
}

/// Token usage from every `step_finish`. OpenCode bills per step (each step
/// resubmits the context), so per-step usage rows sum to the turn's true cost.
pub fn extract_usage(
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
    context: &NormalizerSessionContext,
) -> Option<NormalizedUsage> {
    if provider_type != Some("step_finish") {
        return None;
    }
    let part = object_value(payload.get("part"))?;
    let raw_tokens = object_value(part.get("tokens"))?;
    let cache = object_value(raw_tokens.get("cache"));
    let tokens = UsageCounts {
        input: number_value(raw_tokens.get("input")),
        output: number_value(raw_tokens.get("output")),
        cache_read: number_value(cache.and_then(|cache| cache.get("read"))),
        cache_write: number_value(cache.and_then(|cache| cache.get("write"))),
    };
    if tokens.input + tokens.output + tokens.cache_read + tokens.cache_write == 0 {
        return None;
    }
    let model_id = context
        .opencode_current_model
        .clone()
        .unwrap_or_else(|| "opencode-unknown".to_string());
    // Trust the CLI's own cost figure when it reports one; the pricing table
    // (all $0 for the Zen free tier) is the fallback.
    let reported_cost = part.get("cost").and_then(Value::as_f64);
    Some(NormalizedUsage {
        cost_usd: reported_cost
            .filter(|cost| *cost > 0.0)
            .unwrap_or_else(|| cost_of(tokens.clone().into(), &model_id)),
        model_id,
        context_tokens: Some(tokens.input + tokens.cache_read + tokens.cache_write),
        tokens,
        event_id: None,
        // OpenCode doesn't report the window; the renderer uses a per-model table.
        context_window: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::normalizer::{
        normalize_provider_event, tests::output_event, NormalizerSessionContext,
    };
    use crate::providers::ProviderId;

    #[test]
    fn opencode_text_part_becomes_message_completed() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Opencode,
            &output_event(
                r#"{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"All done."}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "message.completed");
        assert_eq!(result.events[0].message, "All done.");
        assert_eq!(result.provider_conversation_id.as_deref(), Some("ses_1"));
    }

    #[test]
    fn opencode_reasoning_part_becomes_thinking_delta() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Opencode,
            &output_event(
                r#"{"type":"reasoning","sessionID":"ses_1","part":{"type":"reasoning","text":"Considering options"}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "message.delta");
        assert_eq!(result.events[0].message, "Considering options");
        assert_eq!(result.events[0].payload["thinking"], json!(true));
    }

    #[test]
    fn opencode_tool_use_emits_started_and_completed_pair() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Opencode,
            &output_event(
                &json!({
                    "type": "tool_use",
                    "sessionID": "ses_1",
                    "part": {
                        "type": "tool",
                        "tool": "bash",
                        "callID": "call_1",
                        "state": {
                            "status": "completed",
                            "input": { "command": "npm test" },
                            "output": "42 passing"
                        }
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 2);
        assert_eq!(result.events[0].r#type, "command.started");
        assert_eq!(result.events[0].message, "bash");
        assert_eq!(result.events[0].payload["input"]["command"], "npm test");
        assert_eq!(result.events[0].payload["call_id"], "call_1");
        assert_eq!(result.events[1].r#type, "command.completed");
        assert_eq!(result.events[1].payload["result"], "42 passing");
    }

    #[test]
    fn opencode_step_finish_reports_usage_and_stop_ends_the_turn() {
        let mut context =
            NormalizerSessionContext::for_provider(ProviderId::Opencode, "opencode/big-pickle");
        let result = normalize_provider_event(
            ProviderId::Opencode,
            &output_event(
                r#"{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","reason":"stop","tokens":{"total":110,"input":100,"output":10,"reasoning":0,"cache":{"write":5,"read":20}},"cost":0}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "session.completed");
        assert_eq!(result.usages.len(), 1);
        assert_eq!(result.usages[0].model_id, "opencode/big-pickle");
        assert_eq!(result.usages[0].tokens.input, 100);
        assert_eq!(result.usages[0].tokens.cache_read, 20);
        assert_eq!(result.usages[0].context_tokens, Some(125));
        assert_eq!(result.usages[0].cost_usd, 0.0);
    }

    #[test]
    fn opencode_tool_calls_step_finish_stays_hidden_but_still_bills() {
        let mut context =
            NormalizerSessionContext::for_provider(ProviderId::Opencode, "opencode/big-pickle");
        let result = normalize_provider_event(
            ProviderId::Opencode,
            &output_event(
                r#"{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":60,"input":50,"output":10,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}"#,
            ),
            &mut context,
        );
        assert!(result.events.is_empty());
        assert_eq!(result.usages.len(), 1);
    }

    #[test]
    fn opencode_step_start_is_lifecycle_noise() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Opencode,
            &output_event(
                r#"{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}"#,
            ),
            &mut context,
        );
        assert!(result.events.is_empty());
        assert_eq!(result.provider_conversation_id.as_deref(), Some("ses_1"));
    }

    #[test]
    fn opencode_error_surfaces_provider_message() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Opencode,
            &output_event(
                r#"{"type":"error","sessionID":"ses_1","error":{"name":"APIError","data":{"message":"Upstream request failed"}}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "error");
        assert_eq!(result.events[0].message, "Upstream request failed");
    }

    #[test]
    fn opencode_tool_turn_fixture_replays() {
        use crate::providers::normalizer::{Dispatcher, EventNormalizer};
        use serde_json::Value;

        let fixture = include_str!("../../../tests/fixtures/opencode/tool_turn.jsonl");
        let snapshot =
            include_str!("../../../tests/fixtures/opencode/tool_turn.events.snapshot.json");
        let mut dispatcher = Dispatcher::new();
        dispatcher.context_mut("session-1").opencode_current_model =
            Some("opencode/big-pickle".to_string());
        let result = dispatcher.normalize(ProviderId::Opencode, output_event(fixture));

        let stable = Value::Array(
            result
                .events
                .iter()
                .map(|event| {
                    json!({
                        "sessionId": event.session_id,
                        "type": event.r#type,
                        "message": event.message,
                        "payload": event.payload,
                        "createdAt": event.created_at,
                    })
                })
                .collect(),
        );
        assert_eq!(
            stable,
            serde_json::from_str::<Value>(snapshot).expect("snapshot json")
        );
        assert_eq!(result.usages.len(), 2);
        assert_eq!(result.usages[0].model_id, "opencode/big-pickle");
        assert_eq!(
            result.provider_conversation_id.as_deref(),
            Some("ses_fixture")
        );
    }

    #[test]
    fn opencode_usage_without_a_seeded_model_is_unknown() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Opencode,
            &output_event(
                r#"{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","reason":"stop","tokens":{"total":10,"input":10,"output":0,"reasoning":0,"cache":{"write":0,"read":0}}}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.usages[0].model_id, "opencode-unknown");
    }
}
