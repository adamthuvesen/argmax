use phf::phf_map;
use serde_json::{json, Map, Value};

use super::todo::{is_todo_tool, stamp_todo_surface, todo_event, todos_array_update};
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

pub fn normalize_thinking_delta(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
) -> Option<PersistTimelineEventInput> {
    if provider_type != Some("thinking") || string_value(payload.get("subtype")) != Some("delta") {
        return None;
    }
    let text = string_value(payload.get("text"))?;
    if text.trim().is_empty() {
        return None;
    }

    let mut thinking_payload = payload.clone();
    thinking_payload.insert("thinking".to_string(), Value::Bool(true));
    thinking_payload.insert(
        "providerEventType".to_string(),
        Value::String("thinking".to_string()),
    );

    Some(timeline_event(
        event,
        "message.delta",
        text,
        Value::Object(thinking_payload),
    ))
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

/// Cursor names most tools with the wrapper key — `readToolCall`,
/// `taskToolCall` — but falls back to a generic `other` wrapper that carries
/// the real name inside its own args as `_toolName`. Taking the key at face
/// value there loses the tool entirely: a subagent launch arrives as `other`,
/// buckets as "Used a tool" instead of "Started an agent", and drops its mark
/// and its link to the Agents pane.
fn resolve_tool_name<'a>(
    tool_kind: Option<&'a str>,
    tool_body: Option<&'a Map<String, Value>>,
) -> &'a str {
    let kind = tool_kind.unwrap_or("tool_call");
    if kind != "other" {
        return kind;
    }
    tool_body
        .and_then(|body| object_value(body.get("args")))
        .and_then(|args| string_value(args.get("_toolName")))
        .filter(|name| !name.is_empty())
        .unwrap_or(kind)
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
    let tool_name = resolve_tool_name(tool_kind, tool_body);
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
    if is_todo_tool(tool_name) {
        stamp_todo_surface(&mut flattened);
    }

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

/// Cursor's todo list arrives under four different tool names depending on the
/// model behind ACP, so the shape decides rather than the name. One of the
/// four, `updateTodos`, is stripped to `args: {"_toolName":"updateTodos"}`
/// before it reaches us — that carries no list, so it produces no update and
/// leaves whatever the card is already showing alone.
pub fn normalize_todo_call(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
) -> Option<PersistTimelineEventInput> {
    if provider_type != Some("tool_call") || string_value(payload.get("subtype")) != Some("started")
    {
        return None;
    }
    let wrapper = object_value(payload.get("tool_call"))?;
    let (tool_name, body) = wrapper
        .iter()
        .find_map(|(key, value)| object_value(Some(value)).map(|body| (key.as_str(), body)))?;
    if !is_todo_tool(tool_name) {
        return None;
    }
    let args = object_value(body.get("args"))?;
    let update = todos_array_update(args)?;
    Some(todo_event(
        event,
        &update,
        string_value(payload.get("call_id")),
    ))
}

/// Cursor's one-shot task tool assigns the authoritative child identity only
/// in the completed result. `args.agentId` is a request-side id and can differ
/// from the returned child, so it must never create a dock identity.
pub fn native_agent_lifecycle_events(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
) -> Vec<PersistTimelineEventInput> {
    if provider_type != Some("tool_call")
        || string_value(payload.get("subtype")) != Some("completed")
    {
        return Vec::new();
    }
    let task = object_value(payload.get("tool_call")).and_then(|tool_call| {
        tool_call
            .get("taskToolCall")
            .or_else(|| tool_call.get("task"))
            .and_then(|task| object_value(Some(task)))
    });
    let Some(task) = task else {
        return Vec::new();
    };
    let Some(child_id) = task
        .get("result")
        .and_then(|result| object_value(Some(result)))
        .and_then(|result| result.get("success"))
        .and_then(|success| object_value(Some(success)))
        .and_then(|success| string_value(success.get("agentId")))
        .filter(|id| !id.is_empty())
    else {
        return Vec::new();
    };
    let Some(parent_id) = string_value(payload.get("session_id")).filter(|id| !id.is_empty())
    else {
        return Vec::new();
    };
    let Some(run_id) = string_value(payload.get("call_id")).filter(|id| !id.is_empty()) else {
        return Vec::new();
    };

    let mut lifecycle_payload = payload.clone();
    lifecycle_payload.insert(
        "providerParentConversationId".to_string(),
        Value::String(parent_id.to_string()),
    );
    lifecycle_payload.insert(
        "providerChildSessionId".to_string(),
        Value::String(child_id.to_string()),
    );
    lifecycle_payload.insert("agentRunId".to_string(), Value::String(run_id.to_string()));
    lifecycle_payload.insert("status".to_string(), Value::String("completed".to_string()));

    let args = task.get("args").and_then(|args| object_value(Some(args)));
    let started_message = args
        .and_then(|args| string_value(args.get("description")))
        .filter(|description| !description.trim().is_empty())
        .unwrap_or("Agent started");
    let completed_message = task
        .get("result")
        .and_then(|result| object_value(Some(result)))
        .and_then(|result| result.get("success"))
        .and_then(|success| object_value(Some(success)))
        .and_then(cursor_task_result_summary)
        .unwrap_or("Agent completed");

    vec![
        timeline_event(
            event,
            "agent.started",
            started_message,
            Value::Object(lifecycle_payload.clone()),
        ),
        timeline_event(
            event,
            "agent.completed",
            completed_message,
            Value::Object(lifecycle_payload),
        ),
    ]
}

fn cursor_task_result_summary(success: &Map<String, Value>) -> Option<&str> {
    success
        .get("conversationSteps")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|step| {
            step.get("assistantMessage")
                .and_then(|message| object_value(Some(message)))
                .and_then(|message| string_value(message.get("text")))
                .filter(|text| !text.trim().is_empty())
        })
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
        // Result usage totals span model calls, not the current context.
        context_tokens: None,
        tokens,
        event_id: None,
        // Cursor exposes neither current occupancy nor the context window.
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

    // Captured from a live Cursor ACP session: a subagent launch arrives under
    // the generic `other` wrapper with its real name inside the args.
    #[test]
    fn a_generic_other_wrapper_recovers_the_tool_it_is_hiding() {
        let payload = json!({
            "type": "tool_call",
            "subtype": "started",
            "call_id": "tool_1",
            "tool_call": { "other": { "args": {
                "_toolName": "task",
                "description": "Sync docs with code changes"
            }}}
        });
        let event = normalize_tool_call(
            &output_event("{}"),
            payload.as_object().expect("payload"),
            Some("tool_call"),
        )
        .expect("tool event");
        assert_eq!(event.message, "task");
        assert_eq!(event.payload["name"], json!("task"));
    }

    #[test]
    fn an_other_wrapper_with_no_inner_name_keeps_the_key() {
        let payload = json!({
            "type": "tool_call", "subtype": "started", "call_id": "tool_2",
            "tool_call": { "other": { "args": {} } }
        });
        let event = normalize_tool_call(
            &output_event("{}"),
            payload.as_object().expect("payload"),
            Some("tool_call"),
        )
        .expect("tool event");
        assert_eq!(event.message, "other");
    }

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
    fn cursor_task_tool_call_surfaces_as_agent_launch() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(
                &json!({
                    "type": "tool_call",
                    "subtype": "started",
                    "call_id": "call_task",
                    "tool_call": {
                        "taskToolCall": {
                            "args": {
                                "description": "Map renderer surface",
                                "prompt": "Inspect the renderer files."
                            }
                        }
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "command.started");
        assert_eq!(result.events[0].message, "taskToolCall");
        assert_eq!(result.events[0].payload["call_id"], "call_task");
        assert_eq!(
            result.events[0].payload["input"]["description"],
            "Map renderer surface"
        );
    }

    #[test]
    fn cursor_task_lifecycle_uses_the_completed_result_agent_id() {
        let mut context = NormalizerSessionContext::default();
        let first = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(
                &json!({
                    "type": "tool_call",
                    "subtype": "completed",
                    "session_id": "parent-1",
                    "call_id": "call-first",
                    "model_call_id": "model-step-1",
                    "tool_call": {
                        "taskToolCall": {
                            "args": { "description": "Remember this", "agentId": "request-id" },
                            "result": { "success": {
                                "agentId": "child-1",
                                "conversationSteps": [{ "assistantMessage": { "text": "First result" } }]
                            }}
                        }
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(first.events.len(), 3);
        assert_eq!(first.events[1].r#type, "agent.started");
        assert_eq!(first.events[1].payload["providerChildSessionId"], "child-1");
        assert_eq!(first.events[1].payload["agentRunId"], "call-first");
        assert_eq!(first.events[2].message, "First result");
        assert_eq!(
            first.events[2].payload["tool_call"]["taskToolCall"]["args"]["agentId"],
            "request-id"
        );

        let second = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(
                &json!({
                    "type": "tool_call",
                    "subtype": "completed",
                    "session_id": "parent-1",
                    "call_id": "call-second",
                    "tool_call": {
                        "taskToolCall": {
                            "args": { "resume": "child-1", "agentId": "child-1" },
                            "result": { "success": { "agentId": "child-1" } }
                        }
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(
            second.events[1].payload["providerChildSessionId"],
            "child-1"
        );
        assert_eq!(second.events[1].payload["agentRunId"], "call-second");
    }

    #[test]
    fn cursor_acp_task_lifecycle_uses_the_completed_result_agent_id() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(
                &json!({
                    "type": "tool_call",
                    "subtype": "completed",
                    "session_id": "parent-acp",
                    "call_id": "call-acp",
                    "tool_call": {
                        "task": {
                            "args": { "description": "Review ACP" },
                            "result": { "success": {
                                "agentId": "child-acp",
                                "conversationSteps": [{ "assistantMessage": { "text": "ACP result" } }]
                            }}
                        }
                    }
                })
                .to_string(),
            ),
            &mut context,
        );

        assert_eq!(result.events.len(), 3);
        assert_eq!(result.events[0].message, "task");
        assert_eq!(result.events[1].r#type, "agent.started");
        assert_eq!(
            result.events[1].payload["providerChildSessionId"],
            "child-acp"
        );
        assert_eq!(result.events[2].r#type, "agent.completed");
        assert_eq!(result.events[2].message, "ACP result");
    }

    #[test]
    fn cursor_ask_user_question_args_flatten_for_question_card() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(
                &json!({
                    "type": "tool_call",
                    "subtype": "started",
                    "call_id": "call_q",
                    "tool_call": {
                        "askQuestionToolCall": {
                            "args": {
                                "questions": [
                                    {
                                        "question": "Which path?",
                                        "header": "Path",
                                        "multiSelect": false,
                                        "options": [{ "label": "Fast fix" }, { "label": "Deeper cleanup" }]
                                    }
                                ]
                            }
                        }
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "command.started");
        assert_eq!(result.events[0].message, "askQuestionToolCall");
        assert_eq!(result.events[0].payload["call_id"], "call_q");
        assert_eq!(
            result.events[0].payload["input"]["questions"][0]["question"],
            "Which path?"
        );
    }

    #[test]
    fn cursor_thinking_delta_becomes_thinking_message_delta() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(
                r#"{"type":"thinking","subtype":"delta","text":"Checking the repository"}"#,
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "message.delta");
        assert_eq!(result.events[0].message, "Checking the repository");
        assert_eq!(result.events[0].payload["thinking"], json!(true));
        assert_eq!(result.events[0].payload["providerEventType"], "thinking");
    }

    #[test]
    fn cursor_empty_thinking_delta_is_dropped() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"thinking","subtype":"delta","text":"   "}"#),
            &mut context,
        );
        assert!(result.events.is_empty());
    }

    #[test]
    fn cursor_thinking_completed_is_dropped() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(r#"{"type":"thinking","subtype":"completed"}"#),
            &mut context,
        );
        assert!(result.events.is_empty());
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
        let mut context =
            NormalizerSessionContext::for_provider(ProviderId::Cursor, "composer-2.5");
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(
                r#"{"type":"result","subtype":"success","usage":{"inputTokens":10,"outputTokens":20,"cacheReadTokens":0,"cacheWriteTokens":0}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.usages[0].model_id, "composer-2.5");
        assert_eq!(result.usages[0].tokens.input, 10);
        assert_eq!(result.usages[0].tokens.output, 20);
        assert_eq!(result.usages[0].context_tokens, None);
        assert_eq!(result.usages[0].context_window, None);
    }

    #[test]
    fn cursor_usage_without_a_seeded_model_is_unknown() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Cursor,
            &output_event(
                r#"{"type":"result","subtype":"success","usage":{"inputTokens":10,"outputTokens":20,"cacheReadTokens":0,"cacheWriteTokens":0}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.usages[0].model_id, "cursor-unknown");
    }
}
