use phf::phf_map;
use serde_json::{Map, Value};

use super::{
    array_value, classify_command_risk, number_value, object_value, string_value, timeline_event,
    NormalizedUsage, NormalizerSessionContext, PermissionGateInfo, ProviderOutputEvent,
    UsageCounts,
};
use crate::{persistence::events::PersistTimelineEventInput, providers::pricing::cost_of};

pub fn event_type(provider_type: &str) -> Option<&'static str> {
    static EVENT_MAP: phf::Map<&'static str, &'static str> = phf_map! {
        "message.delta" => "message.delta",
        "assistant" => "message.completed",
        "message.completed" => "message.completed",
        "tool_call" => "command.started",
        "command.started" => "command.started",
        "command.output" => "command.output",
        "command.completed" => "command.completed",
        "approval.requested" => "approval.requested",
        "approval.resolved" => "approval.resolved",
        "file.changed" => "file.changed",
        "check.started" => "check.started",
        "check.completed" => "check.completed",
        "result" => "session.completed",
        "error" => "error",
    };
    EVENT_MAP.get(provider_type).copied()
}

pub fn detect_permission_gate(payload: &Map<String, Value>) -> Option<PermissionGateInfo> {
    let method = string_value(payload.get("method"))?;
    if !method.ends_with("/requestApproval")
        && method != "applyPatchApproval"
        && method != "execCommandApproval"
    {
        return None;
    }

    let params = object_value(payload.get("params"));
    let is_file_change = method.contains("fileChange")
        || method == "applyPatchApproval"
        || params
            .and_then(|params| params.get("fileChanges"))
            .is_some();
    let command = params
        .and_then(|params| array_value(params.get("command")))
        .map(|command| {
            command
                .iter()
                .map(|value| string_value(Some(value)).unwrap_or(""))
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_string()
        })
        .or_else(|| {
            params.and_then(|params| string_value(params.get("command")).map(str::to_string))
        })
        .filter(|command| !command.is_empty())
        .unwrap_or_else(|| {
            if is_file_change {
                "Apply file changes".to_string()
            } else {
                "Execute command".to_string()
            }
        });
    let reason = params
        .and_then(|params| string_value(params.get("reason")))
        .unwrap_or("Approval required")
        .to_string();
    Some(PermissionGateInfo {
        risk_level: if is_file_change {
            "high"
        } else {
            classify_command_risk(&command)
        },
        command,
        reason,
        cwd: params.and_then(|params| string_value(params.get("cwd")).map(str::to_string)),
        tool_name: None,
        tool_use_id: None,
    })
}

pub fn update_turn_context_model(
    payload: &Map<String, Value>,
    context: &mut NormalizerSessionContext,
) {
    let model = string_value(payload.get("model")).or_else(|| {
        object_value(payload.get("payload")).and_then(|payload| string_value(payload.get("model")))
    });
    if let Some(model) = model {
        context.codex_current_model = Some(model.to_string());
    }
}

pub fn normalize_tool_item(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
    item: Option<&Map<String, Value>>,
    item_type: Option<&str>,
) -> Option<PersistTimelineEventInput> {
    let item = item?;
    let item_type = item_type?;
    if item_type == "agent_message"
        || !matches!(provider_type, Some("item.started" | "item.completed"))
    {
        return None;
    }

    let action = object_value(item.get("action"));
    let tool_name = string_value(item.get("name")).unwrap_or(item_type);
    let mut tool_payload = item.clone();
    tool_payload.insert("type".to_string(), Value::String(tool_name.to_string()));
    tool_payload.insert("name".to_string(), Value::String(tool_name.to_string()));
    tool_payload.insert("input".to_string(), extract_tool_input(item, action));
    if let Some(provider_type) = provider_type {
        tool_payload.insert(
            "providerEventType".to_string(),
            Value::String(provider_type.to_string()),
        );
    }
    tool_payload.insert("raw".to_string(), Value::Object(payload.clone()));

    Some(timeline_event(
        event,
        if provider_type == Some("item.started") {
            "command.started"
        } else {
            "command.completed"
        },
        tool_name,
        Value::Object(tool_payload),
    ))
}

pub fn extract_usage(
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
    context: &NormalizerSessionContext,
) -> Option<NormalizedUsage> {
    let raw_usage = if provider_type == Some("event_msg") {
        let inner = object_value(payload.get("payload"))?;
        if string_value(inner.get("type")) == Some("token_count") {
            object_value(inner.get("info"))
                .and_then(|info| object_value(info.get("last_token_usage")))
        } else {
            None
        }
    } else if provider_type == Some("token_count") {
        object_value(payload.get("info"))
            .and_then(|info| object_value(info.get("last_token_usage")))
    } else if provider_type == Some("turn.completed") {
        object_value(payload.get("usage"))
    } else {
        None
    }?;

    let input_tokens = number_value(raw_usage.get("input_tokens"));
    let cached_input = number_value(raw_usage.get("cached_input_tokens"));
    let output_tokens = number_value(raw_usage.get("output_tokens"));
    if input_tokens + output_tokens + cached_input == 0 {
        return None;
    }
    let non_cached_input = input_tokens.saturating_sub(cached_input);
    let model_id = context
        .codex_current_model
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let tokens = UsageCounts {
        input: non_cached_input,
        output: output_tokens,
        cache_read: cached_input,
        cache_write: 0,
    };
    Some(NormalizedUsage {
        cost_usd: cost_of(tokens.clone().into(), &model_id),
        model_id,
        tokens,
        event_id: None,
    })
}

fn extract_tool_input(item: &Map<String, Value>, action: Option<&Map<String, Value>>) -> Value {
    let mut input = Map::new();
    for key in [
        "query",
        "queries",
        "url",
        "path",
        "file_path",
        "command",
        "cmd",
        "pattern",
    ] {
        let value = item
            .get(key)
            .or_else(|| action.and_then(|action| action.get(key)));
        if let Some(value) =
            value.filter(|value| !value.is_null() && value != &&Value::String(String::new()))
        {
            input.insert(key.to_string(), value.clone());
        }
    }
    let changes = array_value(item.get("changes"))
        .or_else(|| action.and_then(|action| array_value(action.get("changes"))));
    if let Some(changes) = changes {
        input.insert("changes".to_string(), Value::Array(changes.clone()));
    }
    Value::Object(input)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use crate::providers::normalizer::{
        normalize_provider_event, tests::output_event, Dispatcher, EventNormalizer,
        NormalizerSessionContext,
    };
    use crate::providers::ProviderId;

    #[test]
    fn codex_item_events_become_command_events() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.started",
                    "item": { "type": "shell", "name": "shell", "action": { "command": "npm test" } }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "command.started");
        assert_eq!(result.events[0].payload["input"]["command"], "npm test");
    }

    #[test]
    fn codex_approval_request_is_normalized() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "method": "execCommandApproval",
                    "params": { "command": ["rm", "-rf", "dist"], "reason": "danger", "cwd": "/repo" }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "approval.requested");
        assert_eq!(result.events[0].payload["cwd"], "/repo");
        assert_eq!(result.events[0].payload["riskLevel"], "high");
    }

    #[test]
    fn codex_usage_uses_last_turn_context_model() {
        let mut context = NormalizerSessionContext::default();
        normalize_provider_event(
            ProviderId::Codex,
            &output_event(r#"{"type":"turn_context","model":"gpt-5.5"}"#),
            &mut context,
        );
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                r#"{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.usages[0].model_id, "gpt-5.5");
        assert_eq!(result.usages[0].tokens.input, 60);
        assert_eq!(result.usages[0].tokens.cache_read, 40);
    }

    #[test]
    fn codex_thread_started_captures_provider_conversation_id() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(r#"{"type":"thread.started","thread_id":"thread-123"}"#),
            &mut context,
        );
        assert!(result.events.is_empty());
        assert_eq!(
            result.provider_conversation_id.as_deref(),
            Some("thread-123")
        );
    }

    #[test]
    fn codex_command_approval_fixture_replays() {
        let fixture = include_str!("../../../tests/fixtures/codex/command_approval_request.jsonl");
        let snapshot = include_str!(
            "../../../tests/fixtures/codex/command_approval_request.events.snapshot.json"
        );
        let mut dispatcher = Dispatcher::new();
        let result = dispatcher.normalize(ProviderId::Codex, output_event(&format!("{fixture}\n")));
        assert_eq!(result.events.len(), 1);
        assert_eq!(
            stable_event_snapshot(&result.events),
            serde_json::from_str::<Value>(snapshot).expect("snapshot json")
        );
        let event = &result.events[0];
        assert_eq!(event.r#type, "approval.requested");
        assert_eq!(event.message, "rm -rf /tmp/build");
        assert_eq!(event.payload["command"], "rm -rf /tmp/build");
        assert_eq!(event.payload["reason"], "Clean build artifacts");
        assert_eq!(event.payload["riskLevel"], "high");
        assert_eq!(event.payload["cwd"], "/Users/me/project");
    }

    #[test]
    fn codex_file_change_approval_fixture_replays() {
        let fixture =
            include_str!("../../../tests/fixtures/codex/file_change_approval_request.jsonl");
        let snapshot = include_str!(
            "../../../tests/fixtures/codex/file_change_approval_request.events.snapshot.json"
        );
        let mut dispatcher = Dispatcher::new();
        let result = dispatcher.normalize(ProviderId::Codex, output_event(&format!("{fixture}\n")));
        assert_eq!(result.events.len(), 1);
        assert_eq!(
            stable_event_snapshot(&result.events),
            serde_json::from_str::<Value>(snapshot).expect("snapshot json")
        );
        let event = &result.events[0];
        assert_eq!(event.r#type, "approval.requested");
        assert_eq!(event.message, "Apply file changes");
        assert_eq!(event.payload["command"], "Apply file changes");
        assert_eq!(event.payload["reason"], "Apply generated patch");
        assert_eq!(event.payload["riskLevel"], "high");
    }

    fn stable_event_snapshot(
        events: &[crate::persistence::events::PersistTimelineEventInput],
    ) -> Value {
        Value::Array(
            events
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
        )
    }
}
