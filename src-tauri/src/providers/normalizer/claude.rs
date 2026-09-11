use std::collections::HashSet;

use phf::phf_map;
use serde_json::{json, Map, Value};

use super::todo::{
    claude_task_create, claude_task_update, grok_todos_updated_result, is_todo_tool,
    parse_task_create_result, stamp_todo_surface, todo_event, todos_array_update, TodoUpdate,
};
use super::{
    array_value, classify_command_risk, number_value, object_value, string_value, timeline_event,
    NormalizedUsage, NormalizerSessionContext, PermissionGateInfo, ProviderOutputEvent,
    UsageCounts,
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
        // Claude's permission_denied envelope does not expose a separate
        // request id, but the tool invocation id is stable across replay and
        // is the closest provider-owned correlation key available.
        provider_request_id: string_value(payload.get("tool_use_id")).map(str::to_string),
    })
}

/// Claude's native subagent lifecycle is reported independently from the
/// `Task` / `SendMessage` tool result. Keep it as its own event so a delivered
/// SendMessage result cannot be mistaken for the child finishing its work.
pub fn native_agent_lifecycle_event(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    non_agent_task_ids: &mut HashSet<String>,
) -> Option<PersistTimelineEventInput> {
    if string_value(payload.get("type")) != Some("system") {
        return None;
    }
    let subtype = string_value(payload.get("subtype"))?;
    let child_id = string_value(payload.get("task_id"))?;
    let (event_type, default_message) = match subtype {
        "task_started" => match string_value(payload.get("task_type")) {
            Some("local_agent") | None => ("agent.started", "Agent started"),
            Some(_) => {
                non_agent_task_ids.insert(child_id.to_string());
                return None;
            }
        },
        // Claude omits `task_type` from notifications, so use the explicit
        // start classification rather than guessing from its opaque task id.
        "task_notification" if !non_agent_task_ids.contains(child_id) => {
            ("agent.completed", "Agent completed")
        }
        _ => return None,
    };
    let run_id = string_value(payload.get("tool_use_id"))?;
    let parent_conversation_id = string_value(payload.get("session_id"))?;
    let message = string_value(payload.get("summary"))
        .filter(|summary| !summary.trim().is_empty())
        .unwrap_or(default_message);
    let mut normalized = payload.clone();
    normalized.insert(
        "providerChildSessionId".to_string(),
        Value::String(child_id.to_string()),
    );
    normalized.insert(
        "providerParentConversationId".to_string(),
        Value::String(parent_conversation_id.to_string()),
    );
    normalized.insert("agentRunId".to_string(), Value::String(run_id.to_string()));
    Some(timeline_event(
        event,
        event_type,
        message,
        Value::Object(normalized),
    ))
}

/// Claude and Grok share this envelope, and publish plans differently: Grok
/// sends a whole `todos` array through `todo_write`, while Claude sends one
/// task per call through `TaskCreate` / `TaskUpdate`.
///
/// A `TaskCreate` produces no update here. Its subject is known but its id is
/// not — that arrives in the result prose — so the subject waits in the context
/// until `todo_update_from_tool_result` can pair the two.
fn todo_update_from_tool_use(
    tool_name: &str,
    block: &Map<String, Value>,
    context: &mut NormalizerSessionContext,
) -> Option<TodoUpdate> {
    let input = object_value(block.get("input"))?;
    if tool_name.eq_ignore_ascii_case("TaskCreate") {
        let (Some(id), Some(subject)) = (
            string_value(block.get("id")),
            string_value(input.get("subject")),
        ) else {
            return None;
        };
        context
            .claude_pending_task_creates
            .insert(id.to_string(), subject.to_string());
        return None;
    }
    if tool_name.eq_ignore_ascii_case("TaskUpdate") {
        return claude_task_update(input);
    }
    todos_array_update(input)
}

/// Pair a `TaskCreate` with the id in its result: `Task #5 created
/// successfully: <subject>`.
///
/// When that literal changes the task still reaches the card, keyed by the
/// tool-use id instead of the task id, and a warning names the text that did
/// not parse. The following `TaskUpdate` then arrives against an id the fold
/// cannot match and its row stops advancing — visible in the transcript within
/// one turn, which is the point. Silently dropping the item would hide the
/// break the way Codex's missing launch flag stayed hidden for two months.
fn todo_update_from_tool_result(
    block: &Map<String, Value>,
    context: &mut NormalizerSessionContext,
) -> Option<TodoUpdate> {
    let result = tool_result_text(block);
    // Grok over ACP announces its plan in the result rather than the call, and
    // the result is the only place the list appears at all.
    if let Some(update) = result.as_deref().and_then(grok_todos_updated_result) {
        return Some(update);
    }
    let tool_use_id = string_value(block.get("tool_use_id"))?;
    let subject = context.claude_pending_task_creates.remove(tool_use_id)?;
    match result.as_deref().and_then(parse_task_create_result) {
        Some((task_id, parsed_subject)) => Some(claude_task_create(
            &task_id,
            if parsed_subject.is_empty() {
                &subject
            } else {
                &parsed_subject
            },
        )),
        None => {
            tracing::warn!(
                target: "argmax::normalizer",
                tool_use_id,
                result = result.as_deref().unwrap_or("<no text>"),
                "TaskCreate result did not match `Task #<id> created successfully:`; \
                 keying the task by tool-use id, so later TaskUpdates will not match it"
            );
            Some(claude_task_create(tool_use_id, &subject))
        }
    }
}

/// A tool result's `content` is either a string or a list of text blocks.
fn tool_result_text(block: &Map<String, Value>) -> Option<String> {
    match block.get("content") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(parts)) => {
            let joined: String = parts
                .iter()
                .filter_map(|part| object_value(Some(part)))
                .filter_map(|part| string_value(part.get("text")))
                .collect::<Vec<_>>()
                .join("");
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

/// Grok stopped sending the whole `assistant` envelope under
/// `--include-partial-messages`: a turn is `stream_event` lines only, and a
/// tool call exists solely as a `content_block_start` whose `content_block`
/// already carries the finished `name` and `input`. Without this the session
/// persists tool *results* and no `command.started`, so the chat shows no tool
/// rows at all and a spawned sub-agent never gets its Agent card. Claude still
/// closes a turn with the full envelope, so this stays off its path and cannot
/// double-emit. Verified against grok 1.0.24.
pub fn streamed_tool_use_block(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    context: &mut NormalizerSessionContext,
) -> Option<Vec<PersistTimelineEventInput>> {
    let block = object_value(payload.get("content_block"))?;
    if string_value(block.get("type")) != Some("tool_use") {
        return None;
    }
    // A finished `input` on the opening block is what separates this shape from
    // the incremental one, where the block opens with `{}` and the arguments
    // arrive as `input_json_delta` fragments before a closing envelope. Emitting
    // there would persist an argument-less tool row and then duplicate it.
    if object_value(block.get("input")).is_none_or(Map::is_empty) {
        return None;
    }
    // Reuse the envelope flattener rather than restating the tool_use rules
    // (todo lifting, SendUserMessage, child stamping) a second time.
    let mut envelope = Map::new();
    envelope.insert(
        "content".to_string(),
        Value::Array(vec![Value::Object(block.clone())]),
    );
    if let Some(parent) = payload.get("parent_tool_use_id") {
        envelope.insert("parent_tool_use_id".to_string(), parent.clone());
    }
    extract_content_blocks(event, &envelope, context)
}

pub fn extract_content_blocks(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    context: &mut NormalizerSessionContext,
) -> Option<Vec<PersistTimelineEventInput>> {
    let content = object_value(payload.get("message"))
        .and_then(|message| array_value(message.get("content")))
        .or_else(|| array_value(payload.get("content")))?;

    let parent_tool_use_id = payload.get("parent_tool_use_id").and_then(Value::as_str);
    // A sub-agent runs its own model, and every child assistant envelope names
    // it. Stamped only on child rows — the parent session already stores its
    // own model, and the subagent header has nowhere else to read this from.
    let child_model_id = parent_tool_use_id.and_then(|_| {
        object_value(payload.get("message")).and_then(|message| string_value(message.get("model")))
    });

    // `parent_tool_use_id` lives on the outer assistant-message payload (a
    // sibling of `message`), but flattening the content blocks into per-block
    // events would drop it. Copy it onto every block so the renderer can nest a
    // sub-agent's rows under the Task that spawned them.
    let stamp_child = |block: &mut Map<String, Value>| {
        if let Some(parent) = parent_tool_use_id {
            block.insert(
                "parent_tool_use_id".to_string(),
                Value::String(parent.to_string()),
            );
        }
        if let Some(model_id) = child_model_id {
            block.insert(
                "agentModelId".to_string(),
                Value::String(model_id.to_string()),
            );
        }
    };

    let mut events = Vec::new();
    let mut pending_text: Option<(String, Map<String, Value>)> = None;
    let mut pending_thinking: Option<(String, Map<String, Value>)> = None;

    let flush_text = |pending: &mut Option<(String, Map<String, Value>)>,
                      events: &mut Vec<PersistTimelineEventInput>| {
        if let Some((text, mut text_payload)) = pending.take() {
            if !text.is_empty() {
                stamp_child(&mut text_payload);
                events.push(timeline_event(
                    event,
                    "message.completed",
                    text,
                    Value::Object(text_payload),
                ));
            }
        }
    };

    // Grok (and occasionally Claude) interleaves many tiny thinking and text
    // blocks in one assistant snapshot — think a phrase, speak a phrase, repeat.
    // Flushing text at each thinking block used to persist every phrase as its
    // own `message.completed`, which the chat then rendered as a new paragraph.
    // Accumulate both kinds and only flush at a tool boundary (or the end), so
    // the snapshot collapses to one Thought and one answer the way Claude's
    // [thinking, text, tools] envelope already does.
    let flush_thinking = |pending: &mut Option<(String, Map<String, Value>)>,
                          events: &mut Vec<PersistTimelineEventInput>| {
        if let Some((text, mut payload)) = pending.take() {
            if !text.trim().is_empty() {
                payload.insert("thinking".to_string(), Value::Bool(true));
                stamp_child(&mut payload);
                events.push(timeline_event(
                    event,
                    "message.delta",
                    text,
                    Value::Object(payload),
                ));
            }
        }
    };

    for block in content {
        let Some(block) = object_value(Some(block)) else {
            continue;
        };
        match string_value(block.get("type")) {
            Some("text") => {
                let text = string_value(block.get("text")).unwrap_or("");
                if !text.is_empty() {
                    if let Some((ref mut current_text, _)) = pending_text {
                        current_text.push_str(text);
                    } else {
                        pending_text = Some((text.to_string(), block.clone()));
                    }
                }
            }
            Some("tool_use") | Some("server_tool_use") => {
                flush_thinking(&mut pending_thinking, &mut events);
                flush_text(&mut pending_text, &mut events);
                if string_value(block.get("type")) == Some("tool_use") {
                    if let Some(text) = send_user_message_text(block) {
                        let mut payload = block.clone();
                        payload.insert(
                            "synthesizedFromTool".to_string(),
                            Value::String("SendUserMessage".to_string()),
                        );
                        stamp_child(&mut payload);
                        events.push(timeline_event(
                            event,
                            "message.completed",
                            text,
                            Value::Object(payload),
                        ));
                        continue;
                    }
                }
                let tool_name = string_value(block.get("name")).unwrap_or("tool_use");
                let mut tool_block = block.clone();
                stamp_child(&mut tool_block);
                let todo = is_todo_tool(tool_name)
                    .then(|| {
                        stamp_todo_surface(&mut tool_block);
                        todo_update_from_tool_use(tool_name, block, context)
                    })
                    .flatten();
                events.push(timeline_event(
                    event,
                    "command.started",
                    tool_name,
                    Value::Object(tool_block),
                ));
                if let Some(update) = todo {
                    events.push(todo_event(event, &update, string_value(block.get("id"))));
                }
            }
            Some("tool_result") | Some("web_search_tool_result") => {
                flush_thinking(&mut pending_thinking, &mut events);
                flush_text(&mut pending_text, &mut events);
                let mut result_block = block.clone();
                stamp_child(&mut result_block);
                let todo = todo_update_from_tool_result(block, context);
                if todo.is_some() {
                    stamp_todo_surface(&mut result_block);
                }
                events.push(timeline_event(
                    event,
                    "command.completed",
                    "tool_result",
                    Value::Object(result_block),
                ));
                if let Some(update) = todo {
                    events.push(todo_event(
                        event,
                        &update,
                        string_value(block.get("tool_use_id")),
                    ));
                }
            }
            Some("thinking") => {
                let text = string_value(block.get("thinking"))
                    .unwrap_or("")
                    .to_string();
                if !text.trim().is_empty() {
                    if let Some((ref mut current, _)) = pending_thinking {
                        current.push_str(&text);
                    } else {
                        pending_thinking = Some((text, block.clone()));
                    }
                }
            }
            _ => {}
        }
    }
    flush_thinking(&mut pending_thinking, &mut events);
    flush_text(&mut pending_text, &mut events);
    Some(events)
}

fn send_user_message_text(block: &Map<String, Value>) -> Option<String> {
    if string_value(block.get("name")) != Some("SendUserMessage") {
        return None;
    }
    let input = object_value(block.get("input"))?;
    ["message", "text", "content"]
        .iter()
        .filter_map(|key| string_value(input.get(*key)))
        .map(str::trim)
        .find(|text| !text.is_empty())
        .map(str::to_string)
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
    object_value(payload.get("delta")).and_then(|delta| string_value(delta.get("type")))
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
        context_tokens: Some(tokens.input + tokens.cache_read + tokens.cache_write),
        tokens,
        event_id: string_value(message.get("id")).map(str::to_string),
        // Claude doesn't report the window; the renderer uses a per-model table.
        context_window: None,
    })
}

/// Opening text of the synthetic `user` rows Claude injects for the model to
/// read, not for the user to see:
///
/// - a skill activation carries the whole `SKILL.md` body, which would flash
///   the entire skill markdown into the chat before the turn settles. The
///   `Skill` tool row already marks the activation with the skill's name.
/// - a compaction carries the full replacement summary, often tens of KB of
///   "here is everything that happened so far". `compaction_marker` below
///   surfaces the same event as a one-line status row instead.
/// - reading an image emits the downscale note ("original 2086x1075, displayed
///   at 2000x1031…"), a coordinate-mapping hint for the model. The screenshot
///   itself never renders in chat, so the note reads as a stray line.
pub(crate) const HIDDEN_SYNTHETIC_PREFIXES: [&str; 3] = [
    "Base directory for this skill:",
    "This session is being continued from a previous conversation",
    "[Image:",
];

/// True when this payload is a model-facing synthetic `user` row: one flagged
/// `isSynthetic` that carries prose, or one opening with a
/// `HIDDEN_SYNTHETIC_PREFIXES` line. Those never render as chat.
///
/// Prefixes alone are not enough, because the CLI's own skills (`/schedule`,
/// `/loop`) inject their `SKILL.md` with no marker line — just the body, under
/// its own heading. So a flagged `user` row carrying text is hidden whatever it
/// says: the human's prompt reaches Claude through argv and never comes back
/// out of the stream, which leaves the CLI as the only author of user prose.
/// Tool results ride `user` rows too, and those still have to normalize.
///
/// The prefix gate stays for rows with no flag at all: it rides the stdout
/// stream only, and Claude's transcript store never writes it, so a synced
/// session matched on the flag alone would show whole `SKILL.md` bodies as
/// prose. A flagged row still counts whatever its `type`.
pub fn is_hidden_synthetic_body(payload: &Map<String, Value>) -> bool {
    let flagged = payload.get("isSynthetic") == Some(&Value::Bool(true));
    let user_row = string_value(payload.get("type")) == Some("user");
    if !flagged && !user_row {
        return false;
    }
    let Some(content) =
        object_value(payload.get("message")).and_then(|message| message.get("content"))
    else {
        return false;
    };
    if flagged && user_row && !has_tool_result(payload) && carries_text(content) {
        return true;
    }
    match content {
        // A transcript writes a one-shot body as a bare string; the stdout
        // stream always wraps it in content blocks.
        Value::String(text) => has_hidden_synthetic_prefix(text),
        Value::Array(blocks) => blocks
            .iter()
            .any(|block| string_value(block.get("text")).is_some_and(has_hidden_synthetic_prefix)),
        _ => false,
    }
}

/// Whether a message body says anything at all. A row whose only blocks are
/// images or tool plumbing carries no prose to hide.
fn carries_text(content: &Value) -> bool {
    match content {
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(blocks) => blocks.iter().any(|block| {
            string_value(block.get("text")).is_some_and(|text| !text.trim().is_empty())
        }),
        _ => false,
    }
}

fn has_hidden_synthetic_prefix(text: &str) -> bool {
    let text = text.trim_start();
    HIDDEN_SYNTHETIC_PREFIXES
        .iter()
        .any(|prefix| text.starts_with(prefix))
}

/// What a `type:"user"` row means when the line comes from a transcript file
/// rather than from live stdout. Reading one takes a distinction the live
/// stream never needs: there a `user` line only ever carries a tool result,
/// because the human's prompt goes in via argv and never comes back out. A
/// transcript records both, so the replay has to tell them apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptUserRow {
    /// The human's own prompt, as typed.
    Prompt(String),
    /// A tool result, the same shape the live stream sends — so the shared
    /// content-block path normalizes it.
    ToolResult,
    /// Nothing for the chat: a compaction summary, a skill body, one of the
    /// CLI's own notes to the model, or a row with no text at all.
    Hidden,
}

/// Read a transcript `user` row. Only a replay reaches this (the sweep sets
/// `NormalizerSessionContext::replaying_transcript`); it is also the single
/// predicate for "did a human type this", so the imported session's title and
/// its timeline agree on what the first prompt was.
pub fn transcript_user_row(payload: &Map<String, Value>) -> TranscriptUserRow {
    if has_tool_result(payload) {
        return TranscriptUserRow::ToolResult;
    }
    // `isCompactSummary` marks the replacement summary body; the
    // `system/compact_boundary` row beside it is what marks the compaction.
    // `isMeta` marks the CLI's own notes to the model ("Caveat: the messages
    // below were generated while running local commands"), never chat.
    if flag(payload, "isCompactSummary")
        || flag(payload, "isMeta")
        || is_hidden_synthetic_body(payload)
    {
        return TranscriptUserRow::Hidden;
    }
    match transcript_user_text(payload) {
        Some(text) => TranscriptUserRow::Prompt(text),
        None => TranscriptUserRow::Hidden,
    }
}

fn has_tool_result(payload: &Map<String, Value>) -> bool {
    object_value(payload.get("message"))
        .and_then(|message| array_value(message.get("content")))
        .is_some_and(|blocks| {
            blocks
                .iter()
                .any(|block| string_value(block.get("type")) == Some("tool_result"))
        })
}

/// A `user` row's own text. A transcript writes a one-shot prompt as a bare
/// string and anything richer as content blocks.
fn transcript_user_text(payload: &Map<String, Value>) -> Option<String> {
    let content = object_value(payload.get("message"))?.get("content")?;
    let text = match content {
        Value::String(text) => text.clone(),
        _ => extract_message_content(payload)?,
    };
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn flag(payload: &Map<String, Value>, key: &str) -> bool {
    payload.get(key) == Some(&Value::Bool(true))
}

/// Timeline row for a context-compaction phase, or `None` for any other
/// payload. Claude brackets a compaction with
/// `system/status status:"compacting"` and a `system/compact_boundary` row
/// carrying the token counts. The run between them is silent and can take
/// minutes, so the chat shows a live "compacting" marker that settles into a
/// finished one rather than a two-minute unexplained gap.
pub fn compaction_marker(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
) -> Option<PersistTimelineEventInput> {
    if string_value(payload.get("type")) != Some("system") {
        return None;
    }
    match string_value(payload.get("subtype")) {
        Some("status") if string_value(payload.get("status")) == Some("compacting") => Some(
            timeline_event(event, "session.compacting", "Compacting context", json!({})),
        ),
        Some("compact_boundary") => {
            // Live stream-json uses snake_case; the JSONL transcript uses camelCase.
            let metadata = object_value(payload.get("compact_metadata"))
                .or_else(|| object_value(payload.get("compactMetadata")));
            Some(timeline_event(
                event,
                "session.compacted",
                "Compacted context",
                json!({
                    "trigger": metadata.and_then(|data| string_value(data.get("trigger"))),
                    "preTokens": metadata.map(|data| {
                        number_value(data.get("pre_tokens").or_else(|| data.get("preTokens")))
                    }),
                    "postTokens": metadata.map(|data| {
                        number_value(data.get("post_tokens").or_else(|| data.get("postTokens")))
                    }),
                }),
            ))
        }
        _ => None,
    }
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
                r#"{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"Hey!"}],"usage":{"input_tokens":1,"output_tokens":2}}}"#,
            ),
            &mut context,
        );
        assert_eq!(assistant.events.len(), 1);
        assert_eq!(assistant.events[0].r#type, "message.completed");
        assert!(context.claude_turn_answer_emitted);

        let trailing = normalize_provider_event(
            ProviderId::Claude,
            &output_event(r#"{"type":"result","subtype":"success","result":"Hey!"}"#),
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
    fn claude_synthetic_skill_body_is_dropped() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(&json!({
                "type": "user",
                "isSynthetic": true,
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "Base directory for this skill: /repo/.claude/skills/brain-curate\n\n# Brain Curate\n\nUse this skill when…"
                        }
                    ]
                }
            }).to_string()),
            &mut context,
        );
        assert!(
            result.events.is_empty(),
            "synthetic skill body should not surface as a chat message"
        );
    }

    #[test]
    fn a_skill_body_without_a_marker_line_is_dropped() {
        // The CLI's own skills (`/schedule`, `/loop`) inject the `SKILL.md`
        // bare — no "Base directory" line, just the body. Eleven KB of it used
        // to land in the chat as an answer.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "user",
                    "isSynthetic": true,
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "# Schedule Cloud Agents\n\nYou are helping the user schedule…"
                            }
                        ]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert!(
            result.events.is_empty(),
            "a marker-less skill body should not surface as a chat message: {:#?}",
            result.events
        );
    }

    #[test]
    fn a_flagged_tool_result_row_still_normalizes() {
        // Tool results ride `user` rows; hiding flagged user prose must not
        // take the Skill card itself with it.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "user",
                    "isSynthetic": true,
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "toolu_01",
                                "content": "Launching skill: schedule"
                            }
                        ]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert!(
            result
                .events
                .iter()
                .any(|event| event.r#type == "command.completed"),
            "a tool result should still normalize: {:#?}",
            result.events
        );
    }

    #[test]
    fn a_skill_body_without_the_synthetic_flag_is_still_dropped() {
        // Claude's transcript store writes no `isSynthetic`, so a synced
        // session's skill activations reach the normalizer bare.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "user",
                    "isSidechain": false,
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "Base directory for this skill: /repo/.claude/skills/brain-curate\n\n# Brain Curate"
                            }
                        ]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert!(
            result.events.is_empty(),
            "an unflagged skill body should not surface as a chat message: {:#?}",
            result.events
        );
    }

    #[test]
    fn an_unflagged_string_body_is_dropped_too() {
        // Transcript rows carry a one-shot body as a bare string rather than
        // content blocks.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": "This session is being continued from a previous conversation that ran out of context…"
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert!(
            result.events.is_empty(),
            "an unflagged compaction summary should not surface as a chat message: {:#?}",
            result.events
        );
    }

    #[test]
    fn an_ordinary_assistant_message_is_not_mistaken_for_a_synthetic_body() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "model": "claude-opus-5",
                        "content": [{ "type": "text", "text": "Base directory for this skill: is a phrase I am quoting." }]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert!(
            result
                .events
                .iter()
                .any(|event| event.message.contains("I am quoting")),
            "only `user` rows are model-facing bodies: {:#?}",
            result.events
        );
    }

    #[test]
    fn claude_image_downscale_note_is_dropped() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(&json!({
                "type": "user",
                "isSynthetic": true,
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "[Image: original 2086x1075, displayed at 2000x1031. Multiply coordinates by 1.04 to map to original image.]"
                        }
                    ]
                }
            }).to_string()),
            &mut context,
        );
        assert!(
            result.events.is_empty(),
            "image downscale note should not surface as a chat message"
        );
    }

    #[test]
    fn claude_compaction_brackets_become_status_markers() {
        let mut context = NormalizerSessionContext::default();
        let started = normalize_provider_event(
            ProviderId::Claude,
            &output_event(r#"{"type":"system","subtype":"status","status":"compacting"}"#),
            &mut context,
        );
        assert_eq!(started.events.len(), 1);
        assert_eq!(started.events[0].r#type, "session.compacting");

        let finished = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":470664,"post_tokens":10703}}"#,
            ),
            &mut context,
        );
        assert_eq!(finished.events.len(), 1);
        assert_eq!(finished.events[0].r#type, "session.compacted");
        assert_eq!(finished.events[0].payload["trigger"], "auto");
        assert_eq!(finished.events[0].payload["preTokens"], 470_664);
        assert_eq!(finished.events[0].payload["postTokens"], 10_703);
    }

    #[test]
    fn claude_transcript_compaction_reads_camel_case_metadata() {
        let mut context = NormalizerSessionContext::default();
        let finished = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":468447,"postTokens":10703}}"#,
            ),
            &mut context,
        );
        assert_eq!(finished.events.len(), 1);
        assert_eq!(finished.events[0].r#type, "session.compacted");
        assert_eq!(finished.events[0].payload["trigger"], "auto");
        assert_eq!(finished.events[0].payload["preTokens"], 468_447);
        assert_eq!(finished.events[0].payload["postTokens"], 10_703);
    }

    #[test]
    fn claude_compaction_summary_is_dropped() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(&json!({
                "type": "user",
                "isSynthetic": true,
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n…"
                        }
                    ]
                }
            }).to_string()),
            &mut context,
        );
        assert!(
            result.events.is_empty(),
            "compaction summary should surface as a status marker, not as chat text"
        );
    }

    #[test]
    fn claude_dropped_system_rows_do_not_resurface_as_raw_text() {
        // A chunk whose lines are ALL deliberately dropped must stay dropped.
        // Retrying it as one blob turned Claude's hook/status/token rows into
        // raw protocol JSON in the transcript.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(concat!(
                r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart:resume"}"#,
                "\r\n",
                r#"{"type":"system","subtype":"thinking_tokens","estimated_tokens":50}"#,
                "\r\n"
            )),
            &mut context,
        );
        assert!(result.events.is_empty(), "{:?}", result.events);
    }

    #[test]
    fn claude_permission_denied_becomes_permission_blocked_event() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"system","subtype":"permission_denied","tool_name":"Bash","message":"User approval required to run: rm -rf dist","decision_reason":"danger","tool_use_id":"toolu_1"}"#,
            ),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "permission.blocked");
        assert_eq!(result.events[0].message, "rm -rf dist");
        assert_eq!(result.events[0].payload["riskLevel"], "high");
    }

    #[test]
    fn claude_assistant_message_preserves_content_block_order_with_narration_before_tools() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(&json!({
                "type": "assistant",
                "message": {
                    "content": [
                        { "type": "thinking", "thinking": "Let me reason first." },
                        { "type": "text", "text": "I will inspect the PR." },
                        { "type": "tool_use", "name": "read_file", "input": { "target_file": "PR.md" } }
                    ]
                }
            }).to_string()),
            &mut context,
        );
        assert_eq!(result.events.len(), 3);
        assert_eq!(result.events[0].r#type, "message.delta");
        assert_eq!(result.events[0].message, "Let me reason first.");
        assert_eq!(result.events[0].payload["thinking"], json!(true));

        assert_eq!(result.events[1].r#type, "message.completed");
        assert_eq!(result.events[1].message, "I will inspect the PR.");

        assert_eq!(result.events[2].r#type, "command.started");
        assert_eq!(result.events[2].message, "read_file");
        assert_eq!(result.events[2].payload["input"]["target_file"], "PR.md");
    }

    #[test]
    fn interleaved_thinking_and_text_blocks_coalesce_into_one_answer() {
        // Captured from grok 4.6 `--output-format streaming-messages-json
        // --include-partial-messages`: one assistant snapshot with dozens of
        // tiny thinking/text pairs (think a phrase, speak a phrase). Each text
        // block used to become its own message.completed, so the chat rendered
        // every word as a new paragraph.
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Grok,
            &output_event(
                &json!({
                    "type": "assistant",
                    "message": {
                        "content": [
                            { "type": "thinking", "thinking": "Good progress. Let me fetch " },
                            { "type": "text", "text": "I" },
                            { "type": "thinking", "thinking": "docs next." },
                            { "type": "text", "text": " have the bundled" },
                            { "type": "thinking", "thinking": " Then tools." },
                            { "type": "text", "text": " user-guide." },
                            { "type": "tool_use", "id": "call-1", "name": "read_file", "input": { "target_file": "note.txt" } }
                        ]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 3, "{:?}", result.events);
        assert_eq!(result.events[0].r#type, "message.delta");
        assert_eq!(
            result.events[0].message,
            "Good progress. Let me fetch docs next. Then tools."
        );
        assert_eq!(result.events[0].payload["thinking"], json!(true));
        assert_eq!(result.events[1].r#type, "message.completed");
        assert_eq!(result.events[1].message, "I have the bundled user-guide.");
        assert_eq!(result.events[2].r#type, "command.started");
        assert_eq!(result.events[2].message, "read_file");
    }

    #[test]
    fn server_tool_use_is_a_tool_boundary_not_silent_glue() {
        // Grok's built-in web_search arrives as server_tool_use /
        // web_search_tool_result inside the same assistant snapshot. Ignoring
        // those blocks concatenated the surrounding narration into one mashed
        // sentence ("sessions.The local code").
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Grok,
            &output_event(
                &json!({
                    "type": "assistant",
                    "message": {
                        "content": [
                            { "type": "text", "text": "comparing that to Argmax sessions." },
                            {
                                "type": "server_tool_use",
                                "id": "ws_1",
                                "name": "web_search",
                                "input": { "query": "persistent subagents" }
                            },
                            {
                                "type": "web_search_tool_result",
                                "tool_use_id": "ws_1",
                                "content": [{ "type": "web_search_result", "url": "https://example.com" }]
                            },
                            { "type": "text", "text": "The local code already hints." }
                        ]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 4, "{:?}", result.events);
        assert_eq!(result.events[0].r#type, "message.completed");
        assert_eq!(
            result.events[0].message,
            "comparing that to Argmax sessions."
        );
        assert_eq!(result.events[1].r#type, "command.started");
        assert_eq!(result.events[1].message, "web_search");
        assert_eq!(result.events[1].payload["id"], "ws_1");
        assert_eq!(result.events[2].r#type, "command.completed");
        assert_eq!(result.events[2].payload["tool_use_id"], "ws_1");
        assert_eq!(result.events[3].r#type, "message.completed");
        assert_eq!(result.events[3].message, "The local code already hints.");
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
    fn claude_send_user_message_tool_surfaces_as_assistant_message() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "assistant",
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_msg",
                                "name": "SendUserMessage",
                                "input": { "message": "Which path should I take?" }
                            }
                        ]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "message.completed");
        assert_eq!(result.events[0].message, "Which path should I take?");
        assert_eq!(
            result.events[0].payload["synthesizedFromTool"],
            "SendUserMessage"
        );
        assert!(context.claude_turn_answer_emitted);

        let trailing = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"result","subtype":"success","result":"Which path should I take?"}"#,
            ),
            &mut context,
        );
        assert!(trailing.events.is_empty());
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
    fn claude_native_agent_lifecycle_is_separate_from_tool_delivery() {
        let mut context = NormalizerSessionContext::default();
        let started = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"system","subtype":"task_started","task_id":"agent-a7","tool_use_id":"toolu_task","task_type":"local_agent","session_id":"parent-6b","subagent_type":"general-purpose","description":"Inspect persistence"}"#,
            ),
            &mut context,
        );
        assert_eq!(started.events.len(), 1);
        assert_eq!(started.events[0].r#type, "agent.started");
        assert_eq!(
            started.events[0].payload["providerChildSessionId"],
            "agent-a7"
        );
        assert_eq!(
            started.events[0].payload["providerParentConversationId"],
            "parent-6b"
        );
        assert_eq!(started.events[0].payload["agentRunId"], "toolu_task");

        let completed = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                r#"{"type":"system","subtype":"task_notification","task_id":"agent-a7","tool_use_id":"toolu_message","session_id":"parent-6b","status":"completed","summary":"Follow-up finished"}"#,
            ),
            &mut context,
        );
        assert_eq!(completed.events.len(), 1);
        assert_eq!(completed.events[0].r#type, "agent.completed");
        assert_eq!(completed.events[0].payload["agentRunId"], "toolu_message");
        assert_eq!(completed.events[0].message, "Follow-up finished");
    }

    #[test]
    fn claude_background_bash_lifecycle_is_not_an_agent() {
        let mut context = NormalizerSessionContext::default();
        for payload in [
            r#"{"type":"system","subtype":"task_started","task_id":"b8c01gzk0","tool_use_id":"toolu_bash","task_type":"local_bash","session_id":"parent-6b","description":"cargo check lib"}"#,
            r#"{"type":"system","subtype":"task_notification","task_id":"b8c01gzk0","tool_use_id":"toolu_bash","session_id":"parent-6b","status":"completed","summary":"cargo check lib"}"#,
        ] {
            let normalized =
                normalize_provider_event(ProviderId::Claude, &output_event(payload), &mut context);
            assert!(normalized.events.is_empty());
        }
    }

    #[test]
    fn claude_sub_agent_prose_is_persisted_with_parent_tool_use_id() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "assistant",
                    "parent_tool_use_id": "toolu_parent_task",
                    "message": {
                        "content": [
                            { "type": "text", "text": "I checked the renderer surface." }
                        ]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "message.completed");
        assert_eq!(result.events[0].message, "I checked the renderer surface.");
        assert_eq!(
            result.events[0].payload["parent_tool_use_id"],
            "toolu_parent_task"
        );
    }

    #[test]
    fn claude_child_rows_carry_the_model_the_subagent_ran_on() {
        // The subagent's own model rides on every child assistant envelope; the
        // parent's rows must not gain the key, since the session already stores
        // its own model.
        let mut context = NormalizerSessionContext::default();
        let child = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "assistant",
                    "parent_tool_use_id": "toolu_parent_task",
                    "message": {
                        "model": "claude-opus-5",
                        "content": [{ "type": "text", "text": "Mapped the renderer." }]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(child.events[0].payload["agentModelId"], "claude-opus-5");

        let parent = normalize_provider_event(
            ProviderId::Claude,
            &output_event(
                &json!({
                    "type": "assistant",
                    "message": {
                        "model": "claude-opus-5",
                        "content": [{ "type": "text", "text": "I will delegate this." }]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert!(parent.events[0].payload.get("agentModelId").is_none());
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
        assert!(
            !result.events.is_empty(),
            "thinking blocks must surface events"
        );
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
        assert_eq!(usage.context_tokens, Some(1_000_000));
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
        assert_eq!(event.r#type, "permission.blocked");
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

    /// Transcript `user` lines, in the shapes Claude's transcript store
    /// actually writes. None of them carries `isSynthetic` — that flag rides
    /// the stdout stream only.
    const TRANSCRIPT_STRING_PROMPT: &str =
        r#"{"type":"user","message":{"role":"user","content":"Fix the flaky test"}}"#;
    const TRANSCRIPT_BLOCK_PROMPT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"And also this"}]}}"#;
    const TRANSCRIPT_TOOL_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"done"}]}}"#;
    const TRANSCRIPT_SKILL_BODY: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: /repo/.claude/skills/review"}]}}"#;
    const TRANSCRIPT_META_NOTE: &str = r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: the messages below were generated while running local commands."}}"#;
    const TRANSCRIPT_COMPACT_SUMMARY: &str = r#"{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"Everything that happened so far…"}}"#;

    fn replay(line: &str) -> Vec<PersistTimelineEventInput> {
        let mut context = NormalizerSessionContext::for_transcript_replay();
        normalize_provider_event(ProviderId::Claude, &output_event(line), &mut context).events
    }

    #[test]
    fn a_replayed_prompt_is_a_user_message_whatever_shape_its_content_has() {
        for (line, text) in [
            (TRANSCRIPT_STRING_PROMPT, "Fix the flaky test"),
            (TRANSCRIPT_BLOCK_PROMPT, "And also this"),
        ] {
            let events = replay(line);
            assert_eq!(events.len(), 1, "{line}");
            assert_eq!(events[0].r#type, "user.message");
            assert_eq!(events[0].message, text);
            // The renderer reads this to tell an imported prompt from a typed one.
            assert_eq!(events[0].payload["source"], "sync");
        }
    }

    #[test]
    fn a_replayed_tool_result_is_not_a_prompt() {
        let events = replay(TRANSCRIPT_TOOL_RESULT);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].r#type, "command.completed");
    }

    #[test]
    fn replayed_model_facing_bodies_never_reach_the_timeline() {
        // The skill body and the CLI's own note are written for the model; the
        // compaction summary is the body the `system/compact_boundary` row
        // beside it already marks.
        for line in [
            TRANSCRIPT_SKILL_BODY,
            TRANSCRIPT_META_NOTE,
            TRANSCRIPT_COMPACT_SUMMARY,
        ] {
            assert!(replay(line).is_empty(), "{line}");
        }
    }

    #[test]
    fn a_live_user_line_never_becomes_a_user_message() {
        // Live stdout carries the human's prompt nowhere — it goes in via argv
        // — so a `type:"user"` line off the wire is tool traffic, whatever it
        // looks like. Only a transcript replay may read one as chat.
        let mut context = NormalizerSessionContext::default();
        for line in [TRANSCRIPT_STRING_PROMPT, TRANSCRIPT_BLOCK_PROMPT] {
            let result =
                normalize_provider_event(ProviderId::Claude, &output_event(line), &mut context);
            assert!(
                result
                    .events
                    .iter()
                    .all(|event| event.r#type != "user.message"),
                "{line}: {:#?}",
                result.events
            );
        }
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
