use phf::phf_map;
use serde_json::{json, Map, Value};

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
            Some("tool_use") => {
                // `parent_tool_use_id` lives on the outer assistant-message
                // payload (a sibling of `message`), but flattening the content
                // blocks into per-tool `command.started` events would drop it.
                // Copy it onto the block so the renderer can nest a sub-agent's
                // tool calls under the Task that spawned them.
                let mut tool_block = block.clone();
                if let Some(parent) = payload.get("parent_tool_use_id") {
                    if parent.is_string() {
                        tool_block.insert("parent_tool_use_id".to_string(), parent.clone());
                    }
                }
                events.push(timeline_event(
                    event,
                    "command.started",
                    string_value(block.get("name")).unwrap_or("tool_use"),
                    Value::Object(tool_block),
                ));
            }
            Some("tool_result") => events.push(timeline_event(
                event,
                "command.completed",
                "tool_result",
                Value::Object(block.clone()),
            )),
            // Extended-thinking blocks. The terminal Claude CLI shows
            // these in a collapsed box; the Rust port used to drop them
            // entirely, leaving the chat on "Polishing…" for the full
            // thinking phase. Emit as a message.delta with a `thinking:
            // true` payload flag so the renderer can style or hide them
            // (default: render the text inline so the user sees activity).
            Some("thinking") => {
                let text = string_value(block.get("thinking")).unwrap_or("").to_string();
                if !text.trim().is_empty() {
                    let mut payload = block.clone();
                    payload.insert("thinking".to_string(), Value::Bool(true));
                    events.push(timeline_event(
                        event,
                        "message.delta",
                        text,
                        Value::Object(payload),
                    ));
                }
            }
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
    let delta = object_value(payload.get("delta"))?;
    match string_value(delta.get("type")) {
        // Extended-thinking streams as `thinking_delta` fragments — the text is
        // in `delta.thinking`, not `delta.text`. Surface it so reasoning streams
        // token-by-token; the dispatcher flags the timeline payload
        // `thinking: true` (see normalizer/mod.rs) so the renderer routes it to
        // the Thought block and keeps it past completion.
        Some("thinking_delta") => string_value(delta.get("thinking")).map(str::to_string),
        // `signature_delta` carries a base64 integrity blob, never user text.
        Some("signature_delta") => None,
        _ => string_value(delta.get("text")).map(str::to_string),
    }
}

/// True when this Claude payload is a `content_block_delta` carrying a
/// `thinking_delta` — its surfaced text is extended reasoning, not answer text.
pub fn is_thinking_delta_payload(payload: &Map<String, Value>) -> bool {
    object_value(payload.get("delta"))
        .and_then(|delta| string_value(delta.get("type")))
        == Some("thinking_delta")
}

pub fn synthesize_message_completed_from_result(
    event: &super::ProviderOutputEvent,
    payload: &Map<String, Value>,
) -> Option<PersistTimelineEventInput> {
    if string_value(payload.get("subtype")) != Some("success") {
        return None;
    }
    let text = string_value(payload.get("result"))?.trim();
    if text.is_empty() {
        return None;
    }
    Some(timeline_event(
        event,
        "message.completed",
        text.to_string(),
        json!({ "synthesizedFromResult": true, "text": text }),
    ))
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
    use serde_json::{json, Value};

    use super::*;
    use crate::providers::normalizer::{
        normalize_provider_event, tests::output_event, Dispatcher, EventNormalizer,
        NormalizerSessionContext,
    };
    use crate::providers::ProviderId;

    #[test]
    fn claude_stream_event_unwraps_inner_text_delta() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "message.delta");
        assert_eq!(result.events[0].message, "Hi");
    }

    #[test]
    fn claude_success_result_synthesizes_message_completed() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"result","subtype":"success","result":"Fair call. What's up?"}"#,
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "message.completed");
        assert_eq!(result.events[0].message, "Fair call. What's up?");
    }

    #[test]
    fn claude_result_skipped_when_assistant_already_completed_turn() {
        let mut context = NormalizerSessionContext::default();
        let assistant = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"Hey!"}],"usage":{"input_tokens":1,"output_tokens":2}}}"#,
            ),
            &mut context,
        );
        assert_eq!(assistant.events.len(), 1);
        assert_eq!(assistant.events[0].r#type, "message.completed");
        assert!(context.claude_turn_answer_emitted);

        let trailing = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"result","subtype":"success","result":"Hey!"}"#,
            ),
            &mut context,
        );
        assert!(trailing.events.is_empty());
    }

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
    fn claude_tool_use_carries_parent_tool_use_id() {
        // A sub-agent's tool calls arrive as assistant messages tagged with
        // `parent_tool_use_id` (the spawning Task's id). That id must ride
        // along onto the flattened command.started so the UI can nest them.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "assistant",
                    "parent_tool_use_id": "toolu_parent_task",
                    "message": {
                        "content": [
                            { "type": "tool_use", "name": "Bash", "input": { "command": "ls" } }
                        ]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "command.started");
        assert_eq!(
            result.events[0].payload["parent_tool_use_id"],
            "toolu_parent_task"
        );
    }

    #[test]
    fn claude_assistant_thinking_only_block_surfaces_message_delta() {
        // Regression: claude-haiku-4-5 emits assistant messages whose
        // content is a single `{"type":"thinking","thinking":"…"}` block
        // with no text. Before this fix the normalizer produced zero
        // timeline events for the whole thinking phase, leaving the UI
        // on "Polishing…" for seconds. Should now emit a message.delta
        // with the thinking text and a `thinking: true` payload flag.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "assistant",
                    "message": {
                        "id": "msg_1",
                        "model": "claude-haiku-4-5-20251001",
                        "content": [
                            { "type": "thinking", "thinking": "user said hello, will ask which files" }
                        ],
                        "usage": { "input_tokens": 10, "output_tokens": 5 }
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert!(!result.events.is_empty(), "thinking blocks must surface events");
        assert_eq!(result.events[0].r#type, "message.delta");
        assert_eq!(
            result.events[0].message,
            "user said hello, will ask which files"
        );
        assert_eq!(result.events[0].payload["thinking"], json!(true));
    }

    #[test]
    fn extract_delta_text_surfaces_thinking_delta() {
        let payload = json!({ "delta": { "type": "thinking_delta", "thinking": "step one" } });
        assert_eq!(
            extract_delta_text(payload.as_object().unwrap()),
            Some("step one".to_string())
        );
    }

    #[test]
    fn extract_delta_text_drops_signature_delta() {
        // The base64 integrity blob is not user-visible reasoning.
        let payload = json!({ "delta": { "type": "signature_delta", "signature": "abc123" } });
        assert_eq!(extract_delta_text(payload.as_object().unwrap()), None);
    }

    #[test]
    fn claude_streamed_thinking_delta_flags_message_delta() {
        // With --include-partial-messages, reasoning streams as thinking_delta
        // fragments. Each must surface a message.delta carrying the fragment
        // text and the thinking:true flag so the renderer folds it into the
        // Thought block and keeps it past completion.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm let me think"}}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "message.delta");
        assert_eq!(result.events[0].message, "hmm let me think");
        assert_eq!(result.events[0].payload["thinking"], json!(true));
    }

    #[test]
    fn claude_partial_tool_use_blocks_emit_no_events() {
        // content_block_start / input_json_delta / content_block_stop for a
        // streamed tool_use carry no human text → no spurious message.delta.
        // The real command.started comes only from the final assistant message.
        let mut context = NormalizerSessionContext::default();
        for line in [
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
        ] {
            let result =
                normalize_provider_event(ProviderId::Claude, &output_event(line), &mut context);
            assert!(
                result.events.is_empty(),
                "partial tool_use line should emit no events: {line}"
            );
        }
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

    #[test]
    fn claude_permission_fixture_replays() {
        let fixture = include_str!("../../../tests/fixtures/claude/permission_denied.jsonl");
        let snapshot =
            include_str!("../../../tests/fixtures/claude/permission_denied.events.snapshot.json");
        let mut dispatcher = Dispatcher::new();
        let result =
            dispatcher.normalize(ProviderId::Claude, output_event(&format!("{fixture}\n")));
        assert_eq!(result.events.len(), 1);
        assert_eq!(
            stable_event_snapshot(&result.events),
            serde_json::from_str::<Value>(snapshot).expect("snapshot json")
        );
        let event = &result.events[0];
        assert_eq!(event.r#type, "approval.requested");
        assert_eq!(event.message, "rm -rf node_modules");
        assert_eq!(event.payload["command"], "rm -rf node_modules");
        assert_eq!(
            event.payload["reason"],
            "Ask mode requires user approval for Bash"
        );
        assert_eq!(event.payload["riskLevel"], "high");
        assert_eq!(event.payload["toolName"], "Bash");
        assert_eq!(event.payload["toolUseId"], "toolu_01ABC123");
    }

    fn stable_event_snapshot(events: &[PersistTimelineEventInput]) -> Value {
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
