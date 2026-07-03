mod claude;
mod codex;
mod cursor;

pub use cursor::synthesize_message_completed_from_exit;

use std::collections::HashMap;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use specta::Type;
use uuid::Uuid;

use self::{
    claude::{
        detect_permission_gate as detect_claude_permission_gate, event_type as claude_event_type,
        extract_delta_text as extract_claude_delta_text,
        extract_inline_tool_blocks as extract_claude_inline_tool_blocks,
        extract_message_content as extract_claude_message_content,
        extract_usage as extract_claude_usage,
        is_synthetic_skill_body as is_claude_synthetic_skill_body,
        is_thinking_delta_payload as is_claude_thinking_delta_payload, should_drop_sub_agent_prose,
        synthesize_message_completed_from_result as synthesize_claude_message_completed_from_result,
    },
    codex::{
        detect_permission_gate as detect_codex_permission_gate, event_type as codex_event_type,
        extract_usage as extract_codex_usage, normalize_error_item as normalize_codex_error_item,
        normalize_reasoning_item as normalize_codex_reasoning_item,
        normalize_tool_item as normalize_codex_tool_item,
        update_turn_context_model as update_codex_turn_context_model,
    },
    cursor::{
        event_type as cursor_event_type, extract_usage as extract_cursor_usage,
        is_lifecycle_event as is_cursor_lifecycle_event,
        normalize_assistant_text as normalize_cursor_assistant_text,
        normalize_result_success as normalize_cursor_result_success,
        normalize_thinking_delta as normalize_cursor_thinking_delta,
        normalize_tool_call as normalize_cursor_tool_call,
    },
};
use super::ProviderId;
use crate::persistence::events::PersistTimelineEventInput;

pub const JSON_PARSE_LINE_CAP: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProviderOutputStream {
    Stdout,
    Stderr,
    Pty,
    System,
}

impl ProviderOutputStream {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
            Self::Pty => "pty",
            Self::System => "system",
        }
    }
}

impl From<&ProviderOutputStream> for String {
    fn from(value: &ProviderOutputStream) -> Self {
        value.as_str().to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOutputEvent {
    pub session_id: String,
    pub stream: ProviderOutputStream,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageCounts {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl From<UsageCounts> for crate::providers::pricing::UsageCounts {
    fn from(value: UsageCounts) -> Self {
        Self {
            input: value.input,
            output: value.output,
            cache_read: value.cache_read,
            cache_write: value.cache_write,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedUsage {
    pub model_id: String,
    pub tokens: UsageCounts,
    pub cost_usd: f64,
    pub event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NormalizedProviderResult {
    pub events: Vec<PersistTimelineEventInput>,
    pub usages: Vec<NormalizedUsage>,
    pub provider_conversation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NormalizerSessionContext {
    pub codex_current_model: Option<String>,
    pub cursor_current_model: Option<String>,
    pub cursor_assistant_text: Option<String>,
    /// Set when Cursor emits `result/success` or we synthesize a turn-ending
    /// `message.completed` on process exit.
    pub cursor_turn_completed_emitted: bool,
    /// Set when Claude emits a `message.completed` for the current turn so a
    /// trailing `result` line does not synthesize a duplicate bubble.
    pub claude_turn_answer_emitted: bool,
}

impl NormalizerSessionContext {
    pub fn with_cursor_model(model_id: impl Into<String>) -> Self {
        Self {
            cursor_current_model: Some(model_id.into()),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionGateInfo {
    pub command: String,
    pub reason: String,
    pub risk_level: &'static str,
    pub cwd: Option<String>,
    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
}

pub trait EventNormalizer {
    fn normalize(
        &mut self,
        provider: ProviderId,
        event: ProviderOutputEvent,
    ) -> NormalizedProviderResult;
}

#[derive(Debug, Default)]
pub struct Dispatcher {
    contexts: HashMap<String, NormalizerSessionContext>,
    line_buffers: HashMap<String, String>,
}

impl Dispatcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn context_mut(&mut self, session_id: &str) -> &mut NormalizerSessionContext {
        self.contexts.entry(session_id.to_string()).or_default()
    }

    pub fn set_context(
        &mut self,
        session_id: impl Into<String>,
        context: NormalizerSessionContext,
    ) {
        self.contexts.insert(session_id.into(), context);
    }

    pub fn flush_session(
        &mut self,
        provider: ProviderId,
        session_id: &str,
        created_at: &str,
    ) -> NormalizedProviderResult {
        let Some(line) = self.line_buffers.remove(session_id) else {
            return NormalizedProviderResult::default();
        };
        if line.trim().is_empty() {
            return NormalizedProviderResult::default();
        }
        let event = ProviderOutputEvent {
            session_id: session_id.to_string(),
            stream: ProviderOutputStream::Stdout,
            message: String::new(),
            created_at: created_at.to_string(),
        };
        normalize_line(provider, &event, line.trim(), self.context_mut(session_id))
    }
}

impl EventNormalizer for Dispatcher {
    fn normalize(
        &mut self,
        provider: ProviderId,
        event: ProviderOutputEvent,
    ) -> NormalizedProviderResult {
        if event.message.is_empty() {
            return NormalizedProviderResult::default();
        }

        let buffer = self
            .line_buffers
            .entry(event.session_id.clone())
            .or_default();
        buffer.push_str(&event.message);

        let has_complete_line = buffer.contains('\n') || buffer.contains('\r');
        if !has_complete_line {
            return NormalizedProviderResult::default();
        }

        let complete_up_to = buffer
            .rfind(['\n', '\r'])
            .map(|index| index + 1)
            .expect("complete line");
        let trailing = buffer.split_off(complete_up_to);
        let completed = std::mem::replace(buffer, trailing);

        let context = self.context_mut(&event.session_id);
        let mut result = NormalizedProviderResult::default();
        for raw_line in completed.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            let out = normalize_line(provider, &event, line, context);
            result.events.extend(out.events);
            result.usages.extend(out.usages);
            if out.provider_conversation_id.is_some() {
                result.provider_conversation_id = out.provider_conversation_id;
            }
        }
        result
    }
}

pub fn normalize_provider_event(
    provider: ProviderId,
    event: &ProviderOutputEvent,
    context: &mut NormalizerSessionContext,
) -> NormalizedProviderResult {
    let mut result = NormalizedProviderResult::default();
    for raw_line in event.message.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let out = normalize_line(provider, event, line, context);
        result.events.extend(out.events);
        result.usages.extend(out.usages);
        if out.provider_conversation_id.is_some() {
            result.provider_conversation_id = out.provider_conversation_id;
        }
    }
    if result.events.is_empty() && result.usages.is_empty() && !event.message.trim().is_empty() {
        return normalize_line(provider, event, event.message.trim(), context);
    }
    result
}

fn normalize_line(
    provider: ProviderId,
    event: &ProviderOutputEvent,
    line: &str,
    context: &mut NormalizerSessionContext,
) -> NormalizedProviderResult {
    if line.len() > JSON_PARSE_LINE_CAP {
        return NormalizedProviderResult {
            events: vec![timeline_event(
                event,
                "error",
                format!(
                    "[argmax: skipped {}-byte line (> {} bytes); too large to parse]",
                    line.len(),
                    JSON_PARSE_LINE_CAP
                ),
                json!({
                    "raw": true,
                    "stream": event.stream.as_str(),
                    "truncated": true,
                    "droppedBytes": line.len(),
                }),
            )],
            usages: Vec::new(),
            provider_conversation_id: None,
        };
    }

    match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(payload)) => normalize_json_payload(provider, event, payload, context),
        Ok(_) | Err(_) => normalize_raw_line(event, line),
    }
}

fn normalize_json_payload(
    provider: ProviderId,
    event: &ProviderOutputEvent,
    payload: Map<String, Value>,
    context: &mut NormalizerSessionContext,
) -> NormalizedProviderResult {
    let provider_type = string_value(payload.get("type")).map(str::to_string);

    if provider == ProviderId::Claude && provider_type.as_deref() == Some("stream_event") {
        if let Some(inner) = object_value(payload.get("event")).cloned() {
            return normalize_json_payload(provider, event, inner, context);
        }
        return NormalizedProviderResult::default();
    }

    let item = object_value(payload.get("item"));
    let item_type = item
        .and_then(|item| string_value(item.get("type")))
        .map(str::to_string);

    if provider == ProviderId::Codex && provider_type.as_deref() == Some("turn_context") {
        update_codex_turn_context_model(&payload, context);
    }

    let usage = extract_usage_from_payload(provider, &payload, provider_type.as_deref(), context);
    let usages = usage.into_iter().collect::<Vec<_>>();
    let provider_conversation_id = match provider {
        ProviderId::Codex if provider_type.as_deref() == Some("thread.started") => {
            string_value(payload.get("thread_id"))
                .or_else(|| {
                    object_value(payload.get("thread"))
                        .and_then(|thread| string_value(thread.get("id")))
                })
                .map(str::to_string)
        }
        ProviderId::Cursor
            if matches!(
                (
                    provider_type.as_deref(),
                    string_value(payload.get("subtype"))
                ),
                (Some("system"), Some("init")) | (Some("result"), Some("success"))
            ) =>
        {
            string_value(payload.get("session_id")).map(str::to_string)
        }
        _ => None,
    };

    if is_lifecycle_event(provider_type.as_deref(), item_type.as_deref()) {
        return NormalizedProviderResult {
            events: Vec::new(),
            usages,
            provider_conversation_id,
        };
    }

    if provider == ProviderId::Cursor
        && is_cursor_lifecycle_event(
            provider_type.as_deref(),
            string_value(payload.get("subtype")),
        )
    {
        if let Some(thinking_event) =
            normalize_cursor_thinking_delta(event, &payload, provider_type.as_deref())
        {
            return NormalizedProviderResult {
                events: vec![thinking_event],
                usages,
                provider_conversation_id,
            };
        }
        if provider_type.as_deref() == Some("result")
            && string_value(payload.get("subtype")) == Some("success")
        {
            return NormalizedProviderResult {
                events: normalize_cursor_result_success(event, context),
                usages,
                provider_conversation_id,
            };
        }
        return NormalizedProviderResult {
            events: Vec::new(),
            usages,
            provider_conversation_id,
        };
    }

    let mut events = Vec::new();
    if let Some(gate) = detect_permission_gate(provider, &payload) {
        let mut gate_payload = json!({
            "command": gate.command,
            "reason": gate.reason,
            "riskLevel": gate.risk_level,
        });
        if let Value::Object(ref mut object) = gate_payload {
            insert_optional(object, "cwd", gate.cwd);
            insert_optional(object, "toolName", gate.tool_name);
            insert_optional(object, "toolUseId", gate.tool_use_id);
            if let Some(provider_type) = provider_type.as_deref() {
                object.insert(
                    "providerEventType".to_string(),
                    Value::String(provider_type.to_string()),
                );
            }
        }
        events.push(timeline_event(
            event,
            "approval.requested",
            gate.command,
            gate_payload,
        ));
        return NormalizedProviderResult {
            events,
            usages,
            provider_conversation_id,
        };
    }

    if provider == ProviderId::Codex {
        if let Some(reasoning_event) = normalize_codex_reasoning_item(
            event,
            &payload,
            provider_type.as_deref(),
            item,
            item_type.as_deref(),
        ) {
            return NormalizedProviderResult {
                events: vec![reasoning_event],
                usages,
                provider_conversation_id,
            };
        }
        if let Some(tool_event) = normalize_codex_tool_item(
            event,
            &payload,
            provider_type.as_deref(),
            item,
            item_type.as_deref(),
        ) {
            return NormalizedProviderResult {
                events: vec![tool_event],
                usages,
                provider_conversation_id,
            };
        }
        if let Some(error_event) =
            normalize_codex_error_item(event, provider_type.as_deref(), item, item_type.as_deref())
        {
            return NormalizedProviderResult {
                events: vec![error_event],
                usages,
                provider_conversation_id,
            };
        }
        if matches!(
            provider_type.as_deref(),
            Some("item.started" | "item.completed")
        ) && item_type.as_deref() != Some("agent_message")
        {
            return NormalizedProviderResult {
                events,
                usages,
                provider_conversation_id,
            };
        }
    }

    if provider == ProviderId::Cursor {
        if let Some(tool_event) =
            normalize_cursor_tool_call(event, &payload, provider_type.as_deref())
        {
            return NormalizedProviderResult {
                events: vec![tool_event],
                usages,
                provider_conversation_id,
            };
        }
    }

    if provider == ProviderId::Claude {
        events.extend(extract_claude_inline_tool_blocks(event, &payload));
        if events
            .iter()
            .any(|event| event.r#type == "message.completed")
        {
            context.claude_turn_answer_emitted = true;
        }
    }

    if provider == ProviderId::Claude && provider_type.as_deref() == Some("result") {
        if context.claude_turn_answer_emitted {
            return NormalizedProviderResult {
                events: Vec::new(),
                usages,
                provider_conversation_id,
            };
        }
        if let Some(completed) = synthesize_claude_message_completed_from_result(event, &payload) {
            context.claude_turn_answer_emitted = true;
            return NormalizedProviderResult {
                events: vec![completed],
                usages,
                provider_conversation_id,
            };
        }
    }

    let raw_text = extract_message_text(&payload, item);
    let text = if provider == ProviderId::Cursor {
        normalize_cursor_assistant_text(raw_text, &payload, provider_type.as_deref(), context)
    } else {
        raw_text
    };
    let mapped_type = map_provider_type(
        provider,
        provider_type.as_deref(),
        item_type.as_deref(),
        &payload,
    );

    if is_message_event(mapped_type) && text.is_none() {
        return NormalizedProviderResult {
            events,
            usages,
            provider_conversation_id,
        };
    }
    if mapped_type.is_none() && text.is_none() {
        return NormalizedProviderResult {
            events,
            usages,
            provider_conversation_id,
        };
    }
    if provider == ProviderId::Claude && should_drop_sub_agent_prose(&payload) {
        return NormalizedProviderResult {
            events,
            usages,
            provider_conversation_id,
        };
    }
    if provider == ProviderId::Claude && is_claude_synthetic_skill_body(&payload) {
        return NormalizedProviderResult {
            events,
            usages,
            provider_conversation_id,
        };
    }

    // Compute before `payload` is moved into `final_payload` below.
    let is_claude_thinking_delta =
        provider == ProviderId::Claude && is_claude_thinking_delta_payload(&payload);
    let mut final_payload = if mapped_type.is_some() {
        Value::Object(payload)
    } else {
        let mut payload = payload;
        if let Some(provider_type) = provider_type.as_deref() {
            payload.insert(
                "unknownType".to_string(),
                Value::String(provider_type.to_string()),
            );
        }
        Value::Object(payload)
    };
    let timeline_type = mapped_type.unwrap_or("message.delta");
    if provider == ProviderId::Claude && timeline_type == "message.completed" {
        context.claude_turn_answer_emitted = true;
    }
    // Flag streamed extended-thinking deltas so the renderer routes them to the
    // Thought block and keeps them past completion — same `thinking: true`
    // contract the complete-block path stamps in
    // claude.rs::extract_inline_tool_blocks.
    if is_claude_thinking_delta && timeline_type == "message.delta" {
        if let Value::Object(map) = &mut final_payload {
            map.insert("thinking".to_string(), Value::Bool(true));
        }
    }
    events.push(timeline_event(
        event,
        timeline_type,
        text.unwrap_or_else(|| provider_type.unwrap_or_else(|| "Provider event".to_string())),
        final_payload,
    ));

    NormalizedProviderResult {
        events,
        usages,
        provider_conversation_id,
    }
}

fn normalize_raw_line(event: &ProviderOutputEvent, line: &str) -> NormalizedProviderResult {
    let cleaned = strip_terminal_controls(line).trim().to_string();
    if cleaned.is_empty() {
        return NormalizedProviderResult::default();
    }

    // Provider runtimes spawn the CLI under a PTY so stdout stays
    // line-buffered (Stdio::piped causes block-buffering and the chat
    // looks hung). PTY merges stdout/stderr into one stream, so any
    // non-JSON line that survives ANSI stripping is real content —
    // typically an auth/error message — that must surface to the user.
    let event_type = if event.stream == ProviderOutputStream::Stderr {
        "error"
    } else {
        "message.delta"
    };
    NormalizedProviderResult {
        events: vec![timeline_event(
            event,
            event_type,
            cleaned,
            json!({ "raw": true, "stream": event.stream.as_str() }),
        )],
        usages: Vec::new(),
        provider_conversation_id: None,
    }
}

fn map_provider_type(
    provider: ProviderId,
    provider_type: Option<&str>,
    item_type: Option<&str>,
    payload: &Map<String, Value>,
) -> Option<&'static str> {
    if item_type == Some("agent_message") {
        return Some("message.completed");
    }
    let provider_type = provider_type?;
    match provider {
        ProviderId::Claude => claude_event_type(provider_type),
        ProviderId::Codex => codex_event_type(provider_type),
        ProviderId::Cursor => {
            if provider_type == "assistant" {
                if payload
                    .get("timestamp_ms")
                    .and_then(Value::as_f64)
                    .is_some()
                {
                    Some("message.delta")
                } else {
                    Some("message.completed")
                }
            } else {
                cursor_event_type(provider_type)
            }
        }
    }
}

fn extract_message_text(
    payload: &Map<String, Value>,
    item: Option<&Map<String, Value>>,
) -> Option<String> {
    item.and_then(|item| string_value(item.get("text")).map(str::to_string))
        .or_else(|| string_value(payload.get("text")).map(str::to_string))
        .or_else(|| string_value(payload.get("message")).map(str::to_string))
        .or_else(|| extract_claude_message_content(payload))
        .or_else(|| extract_claude_delta_text(payload))
}

fn detect_permission_gate(
    provider: ProviderId,
    payload: &Map<String, Value>,
) -> Option<PermissionGateInfo> {
    match provider {
        ProviderId::Claude => detect_claude_permission_gate(payload),
        ProviderId::Codex => detect_codex_permission_gate(payload),
        ProviderId::Cursor => None,
    }
}

fn extract_usage_from_payload(
    provider: ProviderId,
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
    context: &NormalizerSessionContext,
) -> Option<NormalizedUsage> {
    match provider {
        ProviderId::Claude => extract_claude_usage(payload, provider_type),
        ProviderId::Codex => extract_codex_usage(payload, provider_type, context),
        ProviderId::Cursor => extract_cursor_usage(payload, provider_type, context),
    }
}

pub(crate) fn timeline_event(
    event: &ProviderOutputEvent,
    event_type: impl Into<String>,
    message: impl Into<String>,
    payload: Value,
) -> PersistTimelineEventInput {
    PersistTimelineEventInput {
        id: Uuid::new_v4().to_string(),
        session_id: event.session_id.clone(),
        r#type: event_type.into(),
        message: message.into(),
        payload,
        created_at: Some(event.created_at.clone()),
    }
}

pub(crate) fn string_value(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

pub(crate) fn object_value(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

pub(crate) fn array_value(value: Option<&Value>) -> Option<&Vec<Value>> {
    value.and_then(Value::as_array)
}

pub(crate) fn number_value(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

pub(crate) fn classify_command_risk(command: &str) -> &'static str {
    static HIGH_RISK_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = HIGH_RISK_RE.get_or_init(|| {
        Regex::new(r"(?i)\b(rm\b|sudo\b|dd\b|mkfs|chmod\s+0?7|chown\s)").expect("risk regex")
    });
    if re.is_match(command) {
        "high"
    } else {
        "medium"
    }
}

fn is_lifecycle_event(provider_type: Option<&str>, item_type: Option<&str>) -> bool {
    item_type != Some("agent_message")
        && matches!(
            provider_type,
            Some("thread.started" | "turn.started" | "turn.completed" | "session.started")
        )
}

fn is_message_event(event_type: Option<&str>) -> bool {
    matches!(event_type, Some("message.delta" | "message.completed"))
}

fn insert_optional(object: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        object.insert(key.to_string(), Value::String(value));
    }
}

fn strip_terminal_controls(value: &str) -> String {
    static ANSI_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = ANSI_RE.get_or_init(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").expect("ansi regex"));
    re.replace_all(value, "").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatcher_buffers_partial_lines_per_session() {
        let mut dispatcher = Dispatcher::new();
        let first = dispatcher.normalize(
            ProviderId::Claude,
            output_event("{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hel"),
        );
        assert!(first.events.is_empty());

        let second = dispatcher.normalize(ProviderId::Claude, output_event("lo\"}}\n"));
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.events[0].r#type, "message.delta");
        assert_eq!(second.events[0].message, "Hello");
    }

    #[test]
    fn raw_stdout_becomes_message_delta_and_stderr_becomes_error() {
        let mut context = NormalizerSessionContext::default();
        let stdout = normalize_provider_event(
            ProviderId::Claude,
            &output_event("\x1b[31mhello\x1b[0m\n"),
            &mut context,
        );
        assert_eq!(stdout.events[0].r#type, "message.delta");
        assert_eq!(stdout.events[0].message, "hello");

        let stderr = normalize_provider_event(
            ProviderId::Claude,
            &ProviderOutputEvent {
                stream: ProviderOutputStream::Stderr,
                ..output_event("warning\n")
            },
            &mut context,
        );
        assert_eq!(stderr.events[0].r#type, "error");
    }

    #[test]
    fn pty_raw_output_surfaces_as_message_delta() {
        // Provider runtimes spawn CLIs under a PTY so stdout stays
        // line-buffered. Non-JSON lines that survive ANSI stripping are
        // visible content (auth/error messages, banners) — dropping them
        // silently hid critical errors from the chat.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &ProviderOutputEvent {
                stream: ProviderOutputStream::Pty,
                ..output_event("could not authenticate; run `claude login`\n")
            },
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "message.delta");
        assert_eq!(
            result.events[0].message,
            "could not authenticate; run `claude login`"
        );
    }

    #[test]
    fn oversized_json_line_emits_visible_error() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(&format!("{}\n", "x".repeat(JSON_PARSE_LINE_CAP + 1))),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "error");
        assert!(result.events[0].message.contains("too large to parse"));
    }

    pub(crate) fn output_event(message: &str) -> ProviderOutputEvent {
        ProviderOutputEvent {
            session_id: "session-1".to_string(),
            stream: ProviderOutputStream::Stdout,
            message: message.to_string(),
            created_at: "2026-05-24T12:00:00.000Z".to_string(),
        }
    }
}
