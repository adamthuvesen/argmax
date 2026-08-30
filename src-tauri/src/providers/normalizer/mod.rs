mod claude;
mod codex;
mod cursor;
mod opencode;

pub use cursor::synthesize_message_completed_from_exit;

#[cfg(test)]
use std::collections::HashMap;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use specta::Type;
use uuid::Uuid;

use self::{
    claude::{
        compaction_marker as claude_compaction_marker,
        detect_permission_gate as detect_claude_permission_gate, event_type as claude_event_type,
        extract_delta_text as extract_claude_delta_text,
        extract_inline_tool_blocks as extract_claude_inline_tool_blocks,
        extract_message_content as extract_claude_message_content,
        extract_usage as extract_claude_usage,
        is_hidden_synthetic_body as is_claude_hidden_synthetic_body,
        is_thinking_delta_payload as is_claude_thinking_delta_payload,
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
    opencode::{
        extract_session_id as extract_opencode_session_id, extract_usage as extract_opencode_usage,
        normalize_event as normalize_opencode_event,
    },
};
use super::{adapters::get_provider_definition, ApprovalSupport, ProviderId};
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
    /// Input-side tokens occupying the current context. None when the provider
    /// reports only cumulative billing totals.
    pub context_tokens: Option<u64>,
    /// The model's context-window size when the provider reports it. Codex's
    /// token_count carries it. Other providers use a per-model renderer fallback.
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NormalizedProviderResult {
    pub events: Vec<PersistTimelineEventInput>,
    pub usages: Vec<NormalizedUsage>,
    pub approvals: Vec<NormalizedApprovalRequest>,
    pub permission_blocked: bool,
    pub provider_conversation_id: Option<String>,
}

/// Provider approval data kept separate from timeline events so persistence
/// can atomically create the pending row and move the session to waiting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedApprovalRequest {
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub provider: String,
    pub risk_level: String,
    /// Opaque provider correlation data. It is retained in the timeline
    /// payload, but Argmax does not pretend it can answer an unsupported CLI.
    pub provider_request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NormalizerSessionContext {
    pub codex_current_model: Option<String>,
    pub cursor_current_model: Option<String>,
    /// OpenCode usage rows carry no model id; seeded from the launched model
    /// so `step_finish` billing resolves against the pricing table.
    pub opencode_current_model: Option<String>,
    pub cursor_assistant_text: Option<String>,
    /// Set when Cursor emits `result/success` or we synthesize a turn-ending
    /// `message.completed` on process exit.
    pub cursor_turn_completed_emitted: bool,
    /// Set when Claude emits a `message.completed` for the current turn so a
    /// trailing `result` line does not synthesize a duplicate bubble.
    pub claude_turn_answer_emitted: bool,
    /// Set once OpenCode's `sessionID` has been reported for this launch.
    /// Every OpenCode envelope carries it, and each report costs a session
    /// UPDATE plus a re-read that ships a session row in the dashboard delta —
    /// pure churn after the first, since the id never changes mid-launch.
    pub opencode_conversation_id_emitted: bool,
}

impl NormalizerSessionContext {
    pub fn with_cursor_model(model_id: impl Into<String>) -> Self {
        Self {
            cursor_current_model: Some(model_id.into()),
            ..Self::default()
        }
    }

    /// Seed per-provider stream state from the session's launched model.
    /// Cursor usage events have no model id of their own, so leaving this
    /// defaulted prices every Cursor turn as `cursor-unknown`.
    pub fn for_provider(provider: ProviderId, model_id: impl Into<String>) -> Self {
        match provider {
            ProviderId::Cursor => Self::with_cursor_model(model_id),
            ProviderId::Opencode => Self {
                opencode_current_model: Some(model_id.into()),
                ..Self::default()
            },
            ProviderId::Claude | ProviderId::Codex => Self::default(),
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
    pub provider_request_id: Option<String>,
}

#[cfg(test)]
pub trait EventNormalizer {
    fn normalize(
        &mut self,
        provider: ProviderId,
        event: ProviderOutputEvent,
    ) -> NormalizedProviderResult;
}

#[cfg(test)]
#[derive(Debug, Default)]
pub struct Dispatcher {
    contexts: HashMap<String, NormalizerSessionContext>,
    line_buffers: HashMap<String, String>,
}

#[cfg(test)]
impl Dispatcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn context_mut(&mut self, session_id: &str) -> &mut NormalizerSessionContext {
        self.contexts.entry(session_id.to_string()).or_default()
    }
}

#[cfg(test)]
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
            result.approvals.extend(out.approvals);
            result.permission_blocked |= out.permission_blocked;
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
        result.approvals.extend(out.approvals);
        result.permission_blocked |= out.permission_blocked;
        if out.provider_conversation_id.is_some() {
            result.provider_conversation_id = out.provider_conversation_id;
        }
    }
    // A single unterminated blob that `lines()` never split can still be real
    // content, so retry it whole. A message that DID split must not be retried:
    // every one of its lines was already normalized, and a chunk whose lines
    // were all deliberately dropped (Claude's `system` status/hook/token rows)
    // would come back as one unparseable blob and surface as raw protocol JSON.
    let is_single_line = !event.message.contains('\n');
    if is_single_line
        && result.events.is_empty()
        && result.usages.is_empty()
        && result.approvals.is_empty()
        && !result.permission_blocked
        && !event.message.trim().is_empty()
    {
        let mut retried = normalize_line(provider, event, event.message.trim(), context);
        // The first pass may already have consumed a one-shot conversation id
        // (OpenCode reports its `sessionID` once per launch), so the retry
        // would come back empty-handed. Keep what the first pass found.
        if retried.provider_conversation_id.is_none() {
            retried.provider_conversation_id = result.provider_conversation_id;
        }
        return retried;
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
                    "stream": event.stream.as_str(),
                    "truncated": true,
                    "droppedBytes": line.len(),
                }),
            )],
            usages: Vec::new(),
            provider_conversation_id: None,
            ..NormalizedProviderResult::default()
        };
    }

    match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(payload)) => normalize_json_payload(provider, event, payload, context),
        // Parsed, but not an object: leftover protocol output (an array or a
        // bare scalar), not something a human wrote.
        Ok(_) => normalize_raw_line(event, line, true),
        Err(_) => normalize_raw_line(event, line, false),
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
        // A fresh Claude launch is handed `--session-id`, so its reported id
        // just echoes the one we chose. A FORKED resume is not: `--fork-session`
        // makes the CLI mint a new id, and without capturing it the fork keeps
        // its one-shot `resume_fork` flag forever, re-forking the *source*
        // snapshot on every turn and discarding its own history.
        ProviderId::Claude
            if matches!(
                (
                    provider_type.as_deref(),
                    string_value(payload.get("subtype"))
                ),
                (Some("system"), Some("init"))
            ) =>
        {
            string_value(payload.get("session_id")).map(str::to_string)
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
        ProviderId::Opencode if !context.opencode_conversation_id_emitted => {
            let session_id = extract_opencode_session_id(&payload);
            context.opencode_conversation_id_emitted = session_id.is_some();
            session_id
        }
        _ => None,
    };

    if provider == ProviderId::Opencode {
        return NormalizedProviderResult {
            events: normalize_opencode_event(event, &payload, provider_type.as_deref()),
            usages,
            provider_conversation_id,
            ..NormalizedProviderResult::default()
        };
    }

    if is_lifecycle_event(provider_type.as_deref(), item_type.as_deref()) {
        return NormalizedProviderResult {
            events: Vec::new(),
            usages,
            provider_conversation_id,
            ..NormalizedProviderResult::default()
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
                ..NormalizedProviderResult::default()
            };
        }
        if provider_type.as_deref() == Some("result")
            && string_value(payload.get("subtype")) == Some("success")
        {
            return NormalizedProviderResult {
                events: normalize_cursor_result_success(event, context),
                usages,
                provider_conversation_id,
                ..NormalizedProviderResult::default()
            };
        }
        return NormalizedProviderResult {
            events: Vec::new(),
            usages,
            provider_conversation_id,
            ..NormalizedProviderResult::default()
        };
    }

    let mut events = Vec::new();
    if let Some(gate) = detect_permission_gate(provider, &payload) {
        let mut gate_payload = json!({
            "command": gate.command.clone(),
            "reason": gate.reason.clone(),
            "riskLevel": gate.risk_level,
            "provider": provider.as_str(),
        });
        if let Value::Object(ref mut object) = gate_payload {
            insert_optional(object, "cwd", gate.cwd.clone());
            insert_optional(object, "toolName", gate.tool_name.clone());
            insert_optional(object, "toolUseId", gate.tool_use_id.clone());
            insert_optional(
                object,
                "providerRequestId",
                gate.provider_request_id.clone(),
            );
            if let Some(provider_type) = provider_type.as_deref() {
                object.insert(
                    "providerEventType".to_string(),
                    Value::String(provider_type.to_string()),
                );
            }
        }
        let approval_support = get_provider_definition(provider).approval_support;
        let event_type = if approval_support == ApprovalSupport::Respondable {
            "approval.requested"
        } else {
            "permission.blocked"
        };
        events.push(timeline_event(
            event,
            event_type,
            gate.command.clone(),
            gate_payload,
        ));
        return NormalizedProviderResult {
            events,
            usages,
            approvals: if approval_support == ApprovalSupport::Respondable {
                vec![NormalizedApprovalRequest {
                    session_id: event.session_id.clone(),
                    command: gate.command,
                    cwd: gate.cwd.unwrap_or_default(),
                    provider: provider.as_str().to_string(),
                    risk_level: gate.risk_level.to_string(),
                    provider_request_id: gate.provider_request_id,
                }]
            } else {
                Vec::new()
            },
            permission_blocked: approval_support != ApprovalSupport::Respondable,
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
                ..NormalizedProviderResult::default()
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
                ..NormalizedProviderResult::default()
            };
        }
        if let Some(error_event) =
            normalize_codex_error_item(event, provider_type.as_deref(), item, item_type.as_deref())
        {
            return NormalizedProviderResult {
                events: vec![error_event],
                usages,
                provider_conversation_id,
                ..NormalizedProviderResult::default()
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
                ..NormalizedProviderResult::default()
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
                ..NormalizedProviderResult::default()
            };
        }
    }

    if provider == ProviderId::Claude {
        if let Some(marker) = claude_compaction_marker(event, &payload) {
            return NormalizedProviderResult {
                events: vec![marker],
                usages,
                provider_conversation_id,
                ..NormalizedProviderResult::default()
            };
        }
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
                ..NormalizedProviderResult::default()
            };
        }
        if let Some(completed) = synthesize_claude_message_completed_from_result(event, &payload) {
            context.claude_turn_answer_emitted = true;
            return NormalizedProviderResult {
                events: vec![completed],
                usages,
                provider_conversation_id,
                ..NormalizedProviderResult::default()
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
            ..NormalizedProviderResult::default()
        };
    }
    if mapped_type.is_none() && text.is_none() {
        return NormalizedProviderResult {
            events,
            usages,
            provider_conversation_id,
            ..NormalizedProviderResult::default()
        };
    }
    if provider == ProviderId::Claude && is_claude_hidden_synthetic_body(&payload) {
        return NormalizedProviderResult {
            events,
            usages,
            provider_conversation_id,
            ..NormalizedProviderResult::default()
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
    if provider == ProviderId::Codex && item_type.as_deref() == Some("agent_message") {
        if let Value::Object(map) = &mut final_payload {
            map.insert(
                "item_type".to_string(),
                Value::String("agent_message".to_string()),
            );
            if let Some(provider_type) = provider_type.as_deref() {
                map.insert(
                    "providerEventType".to_string(),
                    Value::String(provider_type.to_string()),
                );
            }
            let copied_thread_fields = object_value(map.get("item"))
                .map(|item| {
                    ["thread_id", "sender_thread_id", "receiver_thread_ids"]
                        .iter()
                        .filter_map(|key| {
                            item.get(*key)
                                .cloned()
                                .map(|value| ((*key).to_string(), value))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for (key, value) in copied_thread_fields {
                map.insert(key, value);
            }
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
        ..NormalizedProviderResult::default()
    }
}

/// `is_protocol_json` marks a line that parsed as JSON but not as an object —
/// protocol leftovers rather than human-readable output. Only those carry
/// `raw: true`, because that flag is the chat's hide gate (`isConversationVisible`
/// drops any row with `payload.raw === true`). Stamping it on genuinely
/// non-JSON text is what kept provider auth errors out of the chat entirely.
fn normalize_raw_line(
    event: &ProviderOutputEvent,
    line: &str,
    is_protocol_json: bool,
) -> NormalizedProviderResult {
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
    let payload = if is_protocol_json {
        json!({ "raw": true, "stream": event.stream.as_str() })
    } else {
        json!({ "stream": event.stream.as_str() })
    };
    NormalizedProviderResult {
        events: vec![timeline_event(event, event_type, cleaned, payload)],
        usages: Vec::new(),
        provider_conversation_id: None,
        ..NormalizedProviderResult::default()
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
        // OpenCode payloads never reach here — normalize_json_payload returns
        // early with the opencode-specific mapping.
        ProviderId::Opencode => None,
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
        ProviderId::Cursor | ProviderId::Opencode => None,
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
        ProviderId::Opencode => extract_opencode_usage(payload, provider_type, context),
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

/// Severity label for a permission-gated command, shown on the approval row.
/// Delegates to the canonical approval classifier so the timeline and the
/// approval gate agree on what counts as risky — no second, weaker regex.
pub(crate) fn classify_command_risk(command: &str) -> &'static str {
    use crate::approvals::dangerous_action_policy::{classify_command_risk, CommandRiskLevel};
    match classify_command_risk(command).risk_level {
        CommandRiskLevel::High => "high",
        CommandRiskLevel::Medium => "medium",
        CommandRiskLevel::Low => "low",
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
        // `raw: true` is the chat's hide gate, so human-readable text must not
        // carry it — otherwise the row lands in SQLite and renders nowhere.
        assert_eq!(result.events[0].payload.get("raw"), None);
    }

    #[test]
    fn non_object_json_line_stays_flagged_as_protocol_noise() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event("[1, 2, 3]\n"),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].payload["raw"], json!(true));
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
        assert_eq!(result.events[0].payload.get("raw"), None);
    }

    #[test]
    fn opencode_reports_conversation_id_once_per_launch() {
        // Every OpenCode envelope carries `sessionID`; re-reporting it would
        // rewrite the same session row (and ship it in a delta) per chunk.
        let mut context = NormalizerSessionContext::default();
        let envelope = |kind: &str| {
            format!(
                "{{\"type\":\"{kind}\",\"sessionID\":\"ses_1\",\"part\":{{\"text\":\"hi\"}}}}\n"
            )
        };
        let first = normalize_provider_event(
            ProviderId::Opencode,
            &output_event(&envelope("text")),
            &mut context,
        );
        assert_eq!(first.provider_conversation_id.as_deref(), Some("ses_1"));

        let second = normalize_provider_event(
            ProviderId::Opencode,
            &output_event(&envelope("step_start")),
            &mut context,
        );
        assert_eq!(second.provider_conversation_id, None);
    }

    #[test]
    fn claude_reports_the_session_id_from_its_init_line() {
        // A forked resume runs `--resume <source> --fork-session`, so the CLI
        // mints a NEW session id and only the init line carries it. Without
        // capturing it the fork's one-shot `resume_fork` flag is never spent
        // (only `update_session_provider_conversation_id` clears it), and every
        // later turn re-forks the source snapshot, throwing away the fork's own
        // history and orphaning a CLI session per turn.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(r#"{"type":"system","subtype":"init","session_id":"claude-fork-1"}"#),
            &mut context,
        );
        assert_eq!(
            result.provider_conversation_id.as_deref(),
            Some("claude-fork-1")
        );

        // Ordinary turn traffic must not rewrite the session row.
        let assistant = normalize_provider_event(
            ProviderId::Claude,
            &output_event(r#"{"type":"system","subtype":"status","status":"compacting"}"#),
            &mut context,
        );
        assert_eq!(assistant.provider_conversation_id, None);
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
