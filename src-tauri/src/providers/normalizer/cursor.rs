use phf::phf_map;
use serde_json::{json, Map, Value};

use super::{
    number_value, object_value, string_value, timeline_event, NormalizedUsage,
    NormalizerSessionContext, ProviderOutputEvent, UsageCounts,
};
use crate::{persistence::events::PersistTimelineEventInput, providers::pricing::cost_of};

pub fn event_type(provider_type: &str) -> Option<&'static str> {
    static EVENT_MAP: phf::Map<&'static str, &'static str> = phf_map! {
        "error" => "error",
    };
    EVENT_MAP.get(provider_type).copied()
}

pub fn is_lifecycle_event(provider_type: Option<&str>, subtype: Option<&str>) -> bool {
    matches!(
        (provider_type, subtype),
        (Some("system"), Some("init")) | (Some("result"), Some("success"))
    ) || matches!(provider_type, Some("user" | "thinking"))
}

pub fn normalize_assistant_text(
    text: Option<String>,
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
    context: &mut NormalizerSessionContext,
) -> Option<String> {
    if provider_type != Some("assistant") {
        return text;
    }
    let text = text?;
    let has_timestamp = payload
        .get("timestamp_ms")
        .and_then(Value::as_f64)
        .is_some();
    if !has_timestamp {
        context.cursor_assistant_text = None;
        return Some(text);
    }
    let prior = context.cursor_assistant_text.take().unwrap_or_default();
    context.cursor_assistant_text = Some(text.clone());
    // Cursor normally emits cumulative deltas, so the new text starts
    // with the prior text and we emit only the suffix. When that
    // invariant breaks (revised earlier output, swapped tool/message
    // ordering, transient hiccup), fall back to emitting the full new
    // text rather than silently dropping the delta — silent drops cascade
    // because each subsequent prior is even longer.
    match text.strip_prefix(prior.as_str()) {
        Some(suffix) => Some(suffix.to_string()),
        None => Some(text),
    }
}

pub fn normalize_result_success(
    event: &ProviderOutputEvent,
    context: &mut NormalizerSessionContext,
) -> Vec<PersistTimelineEventInput> {
    let mut events = Vec::new();
    if let Some(completed) = synthesize_message_completed_from_result(event, context) {
        events.push(completed);
    }
    events.push(timeline_event(
        event,
        "session.completed",
        String::new(),
        json!({ "cursorResultSuccess": true }),
    ));
    context.cursor_turn_completed_emitted = true;
    events
}

pub fn synthesize_message_completed_from_exit(
    event: &ProviderOutputEvent,
    context: &mut NormalizerSessionContext,
) -> Option<PersistTimelineEventInput> {
    if context.cursor_turn_completed_emitted {
        return None;
    }
    let final_text = context.cursor_assistant_text.take()?;
    if final_text.trim().is_empty() {
        return None;
    }
    context.cursor_turn_completed_emitted = true;
    Some(timeline_event(
        event,
        "message.completed",
        final_text.clone(),
        json!({ "synthesizedFromExit": true, "text": final_text }),
    ))
}

pub fn synthesize_message_completed_from_result(
    event: &ProviderOutputEvent,
    context: &mut NormalizerSessionContext,
) -> Option<PersistTimelineEventInput> {
    let final_text = context.cursor_assistant_text.take()?;
    if final_text.trim().is_empty() {
        return None;
    }
    context.cursor_turn_completed_emitted = true;
    Some(timeline_event(
        event,
        "message.completed",
        final_text.clone(),
        json!({ "synthesizedFromResult": true, "text": final_text }),
    ))
}

pub fn normalize_tool_call(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
) -> Option<PersistTimelineEventInput> {
    if provider_type != Some("tool_call") {
        return None;
    }
    let subtype = string_value(payload.get("subtype"))?;
    if subtype != "started" && subtype != "completed" {
        return None;
    }

    let wrapper = object_value(payload.get("tool_call"));
    let mut tool_kind = None;
    let mut tool_body = None;
    if let Some(wrapper) = wrapper {
        for (key, value) in wrapper {
            if let Some(body) = object_value(Some(value)) {
                tool_kind = Some(key.as_str());
                tool_body = Some(body);
                break;
            }
        }
    }
    let tool_name = tool_kind.unwrap_or("tool_call");
    let args = tool_body
        .and_then(|body| object_value(body.get("args")))
        .cloned()
        .unwrap_or_default();
    let mut flattened = Map::new();
    flattened.insert("name".to_string(), Value::String(tool_name.to_string()));
    flattened.insert("input".to_string(), Value::Object(args));
    if let Some(result) = tool_body.and_then(|body| body.get("result")) {
        flattened.insert("result".to_string(), result.clone());
    }
    if let Some(call_id) = string_value(payload.get("call_id")) {
        flattened.insert("call_id".to_string(), Value::String(call_id.to_string()));
    }
    flattened.insert("raw".to_string(), Value::Object(payload.clone()));

    Some(timeline_event(
        event,
        if subtype == "started" {
            "command.started"
        } else {
            "command.completed"
        },
        tool_name,
        Value::Object(flattened),
    ))
}

pub fn extract_usage(
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
    context: &NormalizerSessionContext,
) -> Option<NormalizedUsage> {
    if provider_type != Some("result") || string_value(payload.get("subtype")) != Some("success") {
        return None;
    }
    let usage = object_value(payload.get("usage"))?;
    let tokens = UsageCounts {
        input: number_value(usage.get("inputTokens")),
        output: number_value(usage.get("outputTokens")),
        cache_read: number_value(usage.get("cacheReadTokens")),
        cache_write: number_value(usage.get("cacheWriteTokens")),
    };
    if tokens.input + tokens.output + tokens.cache_read + tokens.cache_write == 0 {
        return None;
    }
    let model_id = context
        .cursor_current_model
        .clone()
        .unwrap_or_else(|| "cursor-unknown".to_string());
    Some(NormalizedUsage {
        cost_usd: cost_of(tokens.clone().into(), &model_id),
        model_id,
        tokens,
        event_id: None,
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
    fn cursor_cumulative_partials_emit_suffix_deltas() {
        let mut context = NormalizerSessionContext::default();
        let first = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"assistant","message":"Expl","timestamp_ms":1}"#),
            &mut context,
        );
        let second = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"assistant","message":"Exploring","timestamp_ms":2}"#),
            &mut context,
        );
        assert_eq!(first.events[0].message, "Expl");
        assert_eq!(second.events[0].message, "oring");
    }

    #[test]
    fn cursor_success_result_synthesizes_completion_from_running_text() {
        let mut context = NormalizerSessionContext::default();
        normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"assistant","message":"Done","timestamp_ms":1}"#),
            &mut context,
        );
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"result","subtype":"success"}"#),
            &mut context,
        );
        assert_eq!(result.events.len(), 2);
        assert_eq!(result.events[0].r#type, "message.completed");
        assert_eq!(result.events[0].message, "Done");
        assert_eq!(result.events[1].r#type, "session.completed");
        assert_eq!(
            result.events[1].payload.get("cursorResultSuccess"),
            Some(&json!(true))
        );
    }

    #[test]
    fn cursor_success_result_without_assistant_text_still_emits_session_completed() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"result","subtype":"success"}"#),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "session.completed");
    }

    #[test]
    fn cursor_exit_synthesizes_message_completed_from_buffered_assistant_text() {
        let mut context = NormalizerSessionContext::default();
        normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"assistant","message":"Partial summary","timestamp_ms":1}"#),
            &mut context,
        );
        let synthesized = synthesize_message_completed_from_exit(&output_event(""), &mut context);
        assert_eq!(
            synthesized.as_ref().map(|event| event.message.as_str()),
            Some("Partial summary")
        );
    }

    #[test]
    fn cursor_system_init_captures_provider_conversation_id() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"system","subtype":"init","session_id":"cursor-session-1"}"#),
            &mut context,
        );
        assert!(result.events.is_empty());
        assert_eq!(
            result.provider_conversation_id.as_deref(),
            Some("cursor-session-1")
        );
    }

    #[test]
    fn cursor_tool_calls_flatten_wrapper() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(
                &json!({
                    "type": "tool_call",
                    "subtype": "started",
                    "call_id": "call_1",
                    "tool_call": { "shell": { "args": { "command": "npm test" } } }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "command.started");
        assert_eq!(result.events[0].payload["input"]["command"], "npm test");
    }

    #[test]
    fn cursor_partial_without_prior_prefix_emits_full_text_not_empty() {
        let mut context = NormalizerSessionContext::default();
        normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"assistant","message":"Hello","timestamp_ms":1}"#),
            &mut context,
        );
        // Cursor revises earlier output — new text does NOT have prior as prefix.
        let revised = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"assistant","message":"Goodbye","timestamp_ms":2}"#),
            &mut context,
        );
        assert_eq!(revised.events.len(), 1);
        assert_eq!(revised.events[0].message, "Goodbye");
        // Subsequent cumulative deltas anchor against the revised text.
        let extended = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"assistant","message":"Goodbye, world","timestamp_ms":3}"#),
            &mut context,
        );
        assert_eq!(extended.events[0].message, ", world");
    }

    #[test]
    fn cursor_usage_uses_context_model() {
        let mut context = NormalizerSessionContext::with_cursor_model("composer-2.5");
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(
                r#"{"type":"result","subtype":"success","usage":{"inputTokens":10,"outputTokens":20,"cacheReadTokens":0,"cacheWriteTokens":0}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.usages[0].model_id, "composer-2.5");
    }
}
