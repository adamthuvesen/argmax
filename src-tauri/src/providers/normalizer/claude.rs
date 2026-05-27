use phf::phf_map;
use serde_json::{Map, Value};

use super::{
    array_value, classify_command_risk, number_value, object_value, string_value, timeline_event,
    NormalizedUsage, PermissionGateInfo, ProviderOutputEvent, UsageCounts,
};
use crate::{persistence::events::PersistTimelineEventInput, providers::pricing::cost_of};

pub fn event_type(provider_type: &str) -> Option<&'static str> {
    static EVENT_MAP: phf::Map<&'static str, &'static str> = phf_map! {
        "init" => "session.started",
        "message_start" => "message.delta",
        "content_block_start" => "message.delta",
        "content_block_delta" => "message.delta",
        "assistant_text_delta" => "message.delta",
        "content_block_stop" => "message.delta",
        "message_delta" => "message.delta",
        "message_stop" => "message.completed",
        "message_completed" => "message.completed",
        "assistant" => "message.completed",
        "tool_use" => "command.started",
        "command_started" => "command.started",
        "command_output" => "command.output",
        "tool_result" => "command.completed",
        "command_completed" => "command.completed",
        "error" => "error",
        "result" => "session.completed",
    };
    EVENT_MAP.get(provider_type).copied()
}

pub fn detect_permission_gate(payload: &Map<String, Value>) -> Option<PermissionGateInfo> {
    if string_value(payload.get("type")) != Some("system")
        || string_value(payload.get("subtype")) != Some("permission_denied")
    {
        return None;
    }

    let tool = string_value(payload.get("tool_name")).unwrap_or("tool");
    let message = string_value(payload.get("message"));
    let command = command_from_permission_message(message).unwrap_or_else(|| tool.to_string());
    let reason = string_value(payload.get("decision_reason"))
        .or(message)
        .unwrap_or("permission denied")
        .to_string();
    let risk_level = if command == tool {
        classify_tool_risk(tool)
    } else {
        classify_command_risk(&command)
    };

    Some(PermissionGateInfo {
        command,
        reason,
        risk_level,
        cwd: None,
        tool_name: (command_from_permission_message(message).is_some()).then(|| tool.to_string()),
        tool_use_id: string_value(payload.get("tool_use_id")).map(str::to_string),
    })
}

pub fn extract_inline_tool_blocks(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
) -> Vec<PersistTimelineEventInput> {
    let content = object_value(payload.get("message"))
        .and_then(|message| array_value(message.get("content")))
        .or_else(|| array_value(payload.get("content")));
    let Some(content) = content else {
        return Vec::new();
    };

    let mut events = Vec::new();
    for block in content {
        let Some(block) = object_value(Some(block)) else {
            continue;
        };
        match string_value(block.get("type")) {
            Some("tool_use") => events.push(timeline_event(
                event,
                "command.started",
                string_value(block.get("name")).unwrap_or("tool_use"),
                Value::Object(block.clone()),
            )),
            Some("tool_result") => events.push(timeline_event(
                event,
                "command.completed",
                "tool_result",
                Value::Object(block.clone()),
            )),
            _ => {}
        }
    }
    events
}

pub fn extract_message_content(payload: &Map<String, Value>) -> Option<String> {
    let content = object_value(payload.get("message"))
        .and_then(|message| array_value(message.get("content")))
        .or_else(|| array_value(payload.get("content")))?;
    let text = content
        .iter()
        .filter_map(|entry| object_value(Some(entry)))
        .filter_map(|entry| string_value(entry.get("text")))
        .collect::<String>();
    (!text.is_empty()).then_some(text)
}

pub fn extract_delta_text(payload: &Map<String, Value>) -> Option<String> {
    object_value(payload.get("delta"))
        .and_then(|delta| string_value(delta.get("text")))
        .map(str::to_string)
}

pub fn extract_usage(
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
) -> Option<NormalizedUsage> {
    if provider_type != Some("assistant") {
        return None;
    }
    let message = object_value(payload.get("message"))?;
    let usage = object_value(message.get("usage"))?;
    let model_id = string_value(message.get("model"))?;
    let tokens = UsageCounts {
        input: number_value(usage.get("input_tokens")),
        output: number_value(usage.get("output_tokens")),
        cache_read: number_value(usage.get("cache_read_input_tokens")),
        cache_write: number_value(usage.get("cache_creation_input_tokens")),
    };
    if tokens.input + tokens.output + tokens.cache_read + tokens.cache_write == 0 {
        return None;
    }
    Some(NormalizedUsage {
        model_id: model_id.to_string(),
        cost_usd: cost_of(tokens.clone().into(), model_id),
        tokens,
        event_id: string_value(message.get("id")).map(str::to_string),
    })
}

pub fn should_drop_sub_agent_prose(payload: &Map<String, Value>) -> bool {
    string_value(payload.get("parent_tool_use_id")).is_some()
}

fn command_from_permission_message(message: Option<&str>) -> Option<String> {
    let message = message?;
    let command = message
        .strip_prefix("User approval required to run:")?
        .trim();
    (!command.is_empty()).then(|| command.to_string())
}

fn classify_tool_risk(tool: &str) -> &'static str {
    match tool {
        "Bash" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => "high",
        _ => "medium",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::providers::normalizer::{
        normalize_provider_event, tests::output_event, NormalizerSessionContext,
    };
    use crate::providers::ProviderId;

    #[test]
    fn claude_delta_maps_to_message_delta() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(r#"{"type":"content_block_delta","delta":{"text":"done"}}"#),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "message.delta");
        assert_eq!(result.events[0].message, "done");
    }

    #[test]
    fn claude_permission_denied_becomes_approval_request() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"system","subtype":"permission_denied","tool_name":"Bash","message":"User approval required to run: rm -rf dist","decision_reason":"danger","tool_use_id":"toolu_1"}"#,
            ),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "approval.requested");
        assert_eq!(result.events[0].message, "rm -rf dist");
        assert_eq!(result.events[0].payload["riskLevel"], "high");
    }

    #[test]
    fn claude_inline_tool_blocks_emit_command_events() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(&json!({
                "type": "assistant",
                "message": {
                    "content": [
                        { "type": "tool_use", "name": "Bash", "input": { "command": "npm test" } },
                        { "type": "tool_result", "content": "ok" }
                    ]
                }
            }).to_string()),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "command.started");
        assert_eq!(result.events[1].r#type, "command.completed");
    }

    #[test]
    fn claude_usage_extracts_cost() {
        let usage = extract_usage(
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "model": "claude-haiku-4-5",
                    "usage": {
                        "input_tokens": 1_000_000,
                        "output_tokens": 1_000_000,
                        "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0
                    }
                }
            })
            .as_object()
            .expect("object"),
            Some("assistant"),
        )
        .expect("usage");
        assert_eq!(usage.cost_usd, 6.0);
        assert_eq!(usage.event_id.as_deref(), Some("msg_1"));
    }
}
