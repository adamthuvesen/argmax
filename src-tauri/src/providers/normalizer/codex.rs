use std::path::{Path, PathBuf};

use phf::phf_map;
use serde_json::{Map, Value};

use super::{
    array_value, classify_command_risk, number_value, object_value, string_value, timeline_event,
    CodexCumulativeUsage, NormalizedUsage, NormalizerSessionContext, PermissionGateInfo,
    ProviderOutputEvent, UsageCounts,
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
        provider_request_id: payload
            .get("id")
            .and_then(value_as_string)
            .or_else(|| params.and_then(|params| params.get("id").and_then(value_as_string))),
    })
}

fn value_as_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_i64().map(|number| number.to_string()))
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
    if !is_tool_like_item(item, action, item_type) {
        return None;
    }
    // Codex collab items (`collab_tool_call`: spawn_agent / send_message_to_thread /
    // wait / close_agent) carry the tool under `tool`, not `name` — surface that
    // as the tool name so the renderer's agent bucket sees `spawn_agent`.
    let tool_name = string_value(item.get("name"))
        .or_else(|| string_value(item.get("tool")))
        .unwrap_or(item_type);
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

/// A Codex `error` item carries the only human-readable message for a stream
/// or turn failure — dropping it with the other non-tool items leaves the chat
/// blank while the session dies. Surface it as an `error` timeline event (the
/// chat surface renders `error` rows). Emitted on `item.completed` only so a
/// paired `item.started` can't double-post the same failure.
pub fn normalize_error_item(
    event: &ProviderOutputEvent,
    provider_type: Option<&str>,
    item: Option<&Map<String, Value>>,
    item_type: Option<&str>,
) -> Option<PersistTimelineEventInput> {
    if provider_type != Some("item.completed") || item_type != Some("error") {
        return None;
    }
    let item = item?;
    let message = string_value(item.get("message"))
        .or_else(|| string_value(item.get("text")))
        .unwrap_or("Codex reported an error.");
    Some(timeline_event(
        event,
        "error",
        message,
        Value::Object(item.clone()),
    ))
}

pub fn normalize_reasoning_item(
    event: &ProviderOutputEvent,
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
    item: Option<&Map<String, Value>>,
    item_type: Option<&str>,
) -> Option<PersistTimelineEventInput> {
    if provider_type != Some("item.completed") || item_type != Some("reasoning") {
        return None;
    }
    let item = item?;
    let text = string_value(item.get("text"))?;
    if text.trim().is_empty() {
        return None;
    }

    let mut thinking_payload = item.clone();
    thinking_payload.insert("thinking".to_string(), Value::Bool(true));
    thinking_payload.insert(
        "providerEventType".to_string(),
        Value::String("item.completed".to_string()),
    );
    thinking_payload.insert("raw".to_string(), Value::Object(payload.clone()));

    Some(timeline_event(
        event,
        "message.delta",
        text,
        Value::Object(thinking_payload),
    ))
}

fn is_tool_like_item(
    item: &Map<String, Value>,
    action: Option<&Map<String, Value>>,
    item_type: &str,
) -> bool {
    if matches!(item_type, "reasoning" | "todo_list" | "error") {
        return false;
    }
    if string_value(item.get("name")).is_some()
        || string_value(item.get("tool")).is_some()
        || action.is_some()
    {
        return true;
    }
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
        if value
            .filter(|value| !value.is_null() && value != &&Value::String(String::new()))
            .is_some()
        {
            return true;
        }
    }
    array_value(item.get("changes"))
        .or_else(|| action.and_then(|action| array_value(action.get("changes"))))
        .is_some()
}

/// Locate the Codex rollout file for a given thread_id under ~/.codex/sessions.
pub fn find_codex_rollout_path(thread_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let sessions_dir = home.join(".codex").join("sessions");
    find_rollout_in_dir(&sessions_dir, thread_id)
}

pub fn find_rollout_in_dir(sessions_dir: &Path, thread_id: &str) -> Option<PathBuf> {
    if !sessions_dir.is_dir() {
        return None;
    }
    let suffix = format!("{thread_id}.jsonl");
    let mut matching_paths = Vec::new();

    let mut stack = vec![sessions_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    if file_name.ends_with(&suffix) {
                        matching_paths.push(path);
                    }
                }
            }
        }
    }

    matching_paths.sort_by(|a, b| {
        let a_time = a.metadata().and_then(|m| m.modified()).ok();
        let b_time = b.metadata().and_then(|m| m.modified()).ok();
        b_time.cmp(&a_time)
    });

    matching_paths.into_iter().next()
}

/// Read the latest `token_count` event from a Codex rollout JSONL file.
pub fn read_latest_token_count_from_rollout(path: &Path) -> Option<(u64, u64)> {
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    use std::io::BufRead;

    let mut latest_context_tokens = None;
    let mut latest_context_window = None;

    for line in reader.lines().flatten() {
        if !line.contains("token_count") {
            continue;
        }
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&line) {
            let payload = object_value(map.get("payload"));
            let is_token_count = string_value(map.get("type")) == Some("token_count")
                || payload.and_then(|p| string_value(p.get("type"))) == Some("token_count");

            if is_token_count {
                let info = payload
                    .and_then(|p| object_value(p.get("info")))
                    .or_else(|| object_value(map.get("info")));

                if let Some(info) = info {
                    let window = number_value(info.get("model_context_window"));
                    if window > 0 {
                        latest_context_window = Some(window);
                    }
                    if let Some(raw_usage) = object_value(info.get("last_token_usage")) {
                        let input = number_value(raw_usage.get("input_tokens"));
                        if input > 0 {
                            latest_context_tokens = Some(input);
                        }
                    }
                }
            }
        }
    }

    match (latest_context_tokens, latest_context_window) {
        (Some(tokens), Some(window)) => Some((tokens, window)),
        (Some(tokens), None) => Some((tokens, 258_400)),
        (None, Some(window)) => Some((0, window)),
        (None, None) => None,
    }
}

pub fn extract_usage(
    payload: &Map<String, Value>,
    provider_type: Option<&str>,
    context: &mut NormalizerSessionContext,
) -> Option<NormalizedUsage> {
    // token_count events also carry the model's context window in `info`; capture
    // it so the session can show window occupancy. turn.completed has no window.
    let info = if provider_type == Some("event_msg") {
        object_value(payload.get("payload"))
            .filter(|inner| string_value(inner.get("type")) == Some("token_count"))
            .and_then(|inner| object_value(inner.get("info")))
    } else if provider_type == Some("token_count") {
        object_value(payload.get("info"))
    } else {
        None
    };
    let inline_context_window = info
        .map(|info| number_value(info.get("model_context_window")))
        .filter(|window| *window > 0);

    let from_token_count = info.is_some();
    let raw_usage = if let Some(info) = info {
        object_value(info.get("last_token_usage"))
    } else if provider_type == Some("turn.completed") {
        object_value(payload.get("usage"))
    } else {
        None
    }?;

    let cumulative_input = number_value(raw_usage.get("input_tokens"));
    let cumulative_cached = number_value(raw_usage.get("cached_input_tokens"));
    let cumulative_output = number_value(raw_usage.get("output_tokens"));
    if cumulative_input + cumulative_output + cumulative_cached == 0 {
        return None;
    }

    let (delta_input, delta_cached, delta_output) = if from_token_count {
        (cumulative_input, cumulative_cached, cumulative_output)
    } else {
        let prev = context.codex_cumulative_usage.as_ref().cloned();
        let (p_in, p_cached, p_out) = match prev {
            Some(ref p) => (p.input_tokens, p.cached_input_tokens, p.output_tokens),
            None => (cumulative_input, cumulative_cached, cumulative_output),
        };

        context.codex_cumulative_usage = Some(CodexCumulativeUsage {
            input_tokens: cumulative_input,
            cached_input_tokens: cumulative_cached,
            output_tokens: cumulative_output,
        });

        if prev.is_none() {
            // First turn of an unseeded resume: baseline established, no delta billing
            (0, 0, 0)
        } else {
            (
                cumulative_input.saturating_sub(p_in),
                cumulative_cached.saturating_sub(p_cached),
                cumulative_output.saturating_sub(p_out),
            )
        }
    };

    let delta_non_cached_input = delta_input.saturating_sub(delta_cached);

    let mut context_tokens = None;
    let mut context_window = inline_context_window;

    if from_token_count {
        context_tokens = Some(cumulative_input);
    } else {
        if context.codex_rollout_path.is_none() {
            if let Some(thread_id) = &context.codex_thread_id {
                context.codex_rollout_path = find_codex_rollout_path(thread_id);
            }
        }

        if let Some(rollout_path) = &context.codex_rollout_path {
            if let Some((occ, window)) = read_latest_token_count_from_rollout(rollout_path) {
                if occ > 0 {
                    context_tokens = Some(occ);
                }
                if context_window.is_none() {
                    context_window = Some(window);
                }
            }
        }

        if context_tokens.is_none() && delta_input > 0 {
            context_tokens = Some(delta_input);
        }
    }

    if delta_non_cached_input + delta_output + delta_cached == 0
        && context_tokens.is_none()
        && context_window.is_none()
    {
        return None;
    }

    let model_id = context
        .codex_current_model
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let tokens = UsageCounts {
        input: delta_non_cached_input,
        output: delta_output,
        cache_read: delta_cached,
        cache_write: 0,
    };
    Some(NormalizedUsage {
        cost_usd: cost_of(tokens.clone().into(), &model_id),
        model_id,
        context_tokens,
        tokens,
        event_id: None,
        context_window,
    })
}

fn object_from_value(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Some(map.clone()),
        Some(Value::String(text)) => {
            serde_json::from_str::<Value>(text)
                .ok()
                .and_then(|parsed| match parsed {
                    Value::Object(map) => Some(map),
                    _ => None,
                })
        }
        _ => None,
    }
}

fn merge_input_object(input: &mut Map<String, Value>, source: Option<Map<String, Value>>) {
    let Some(source) = source else {
        return;
    };
    for (key, value) in source {
        if !value.is_null() {
            input.insert(key, value);
        }
    }
}

fn extract_tool_input(item: &Map<String, Value>, action: Option<&Map<String, Value>>) -> Value {
    let mut input = Map::new();
    for source in [
        action.and_then(|action| object_from_value(action.get("input"))),
        action.and_then(|action| object_from_value(action.get("parameters"))),
        action.and_then(|action| object_from_value(action.get("arguments"))),
        action.and_then(|action| object_from_value(action.get("args"))),
        object_from_value(item.get("input")),
        object_from_value(item.get("parameters")),
        object_from_value(item.get("arguments")),
        object_from_value(item.get("args")),
    ] {
        merge_input_object(&mut input, source);
    }
    for key in [
        "query",
        "queries",
        "url",
        "path",
        "file_path",
        "command",
        "cmd",
        "pattern",
        "question",
        "questions",
        "header",
        "options",
        "multiSelect",
        "multi_select",
        "plan",
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
    // Collab tool calls carry the sub-agent prompt and thread linkage at the
    // item level; copy them into `input` so the renderer's agent row can show
    // the prompt and receiver threads (`wait` sends `prompt: null` — skip it).
    for key in ["prompt", "sender_thread_id", "receiver_thread_ids"] {
        if let Some(value) = item.get(key).filter(|value| !value.is_null()) {
            input.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(input)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use crate::providers::normalizer::{
        normalize_provider_event, tests::output_event, CodexCumulativeUsage, Dispatcher,
        EventNormalizer, NormalizerSessionContext,
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
    fn codex_tool_arguments_populate_interactive_card_input() {
        let mut context = NormalizerSessionContext::default();
        let arguments = json!({
            "questions": [
                {
                    "question": "Which path?",
                    "header": "Path",
                    "multiSelect": false,
                    "options": [{ "label": "Fast fix" }, { "label": "Deeper cleanup" }]
                }
            ]
        })
        .to_string();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.started",
                    "item": {
                        "id": "item_q",
                        "type": "tool_call",
                        "name": "AskUserQuestion",
                        "arguments": arguments
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "command.started");
        assert_eq!(result.events[0].message, "AskUserQuestion");
        assert_eq!(
            result.events[0].payload["input"]["questions"][0]["question"],
            "Which path?"
        );
    }

    #[test]
    fn codex_file_change_item_captures_changed_paths() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.started",
                    "item": {
                        "id": "item_4",
                        "type": "file_change",
                        "changes": [{ "kind": "update", "path": "/repo/src/ModelSelector.tsx" }]
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events[0].r#type, "command.started");
        assert_eq!(result.events[0].message, "file_change");
        assert_eq!(
            result.events[0].payload["input"]["changes"][0]["path"],
            "/repo/src/ModelSelector.tsx"
        );
    }

    #[test]
    fn codex_collab_spawn_agent_item_becomes_agent_command_event() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.started",
                    "item": {
                        "id": "item_2",
                        "type": "collab_tool_call",
                        "tool": "spawn_agent",
                        "sender_thread_id": "019f2214-983b-7f43-958b-7f68e1dba989",
                        "receiver_thread_ids": [],
                        "prompt": "Do a quick repo reconnaissance. Read-only only.",
                        "agents_states": {},
                        "status": "in_progress"
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        let event = &result.events[0];
        assert_eq!(event.r#type, "command.started");
        assert_eq!(event.message, "spawn_agent");
        assert_eq!(event.payload["name"], "spawn_agent");
        assert_eq!(event.payload["id"], "item_2");
        assert_eq!(
            event.payload["input"]["prompt"],
            "Do a quick repo reconnaissance. Read-only only."
        );
    }

    #[test]
    fn codex_collab_item_completed_carries_receiver_thread_linkage() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.completed",
                    "item": {
                        "id": "item_2",
                        "type": "collab_tool_call",
                        "tool": "spawn_agent",
                        "sender_thread_id": "019f2214-983b-7f43-958b-7f68e1dba989",
                        "receiver_thread_ids": ["019f2214-c736-7f60-bb78-75b6ecff57a3"],
                        "prompt": "Do a quick repo reconnaissance. Read-only only.",
                        "agents_states": {},
                        "status": "in_progress"
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        let event = &result.events[0];
        assert_eq!(event.r#type, "command.completed");
        // The renderer correlates completion back to the started row via `id`.
        assert_eq!(event.payload["id"], "item_2");
        assert_eq!(
            event.payload["input"]["receiver_thread_ids"][0],
            "019f2214-c736-7f60-bb78-75b6ecff57a3"
        );
    }

    #[test]
    fn codex_agent_message_persists_thread_metadata() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.completed",
                    "item": {
                        "id": "agent_msg_1",
                        "type": "agent_message",
                        "thread_id": "019f2214-c736-7f60-bb78-75b6ecff57a3",
                        "text": "I found the renderer entry points."
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        let event = &result.events[0];
        assert_eq!(event.r#type, "message.completed");
        assert_eq!(event.message, "I found the renderer entry points.");
        assert_eq!(event.payload["item_type"], "agent_message");
        assert_eq!(
            event.payload["thread_id"],
            "019f2214-c736-7f60-bb78-75b6ecff57a3"
        );
    }

    #[test]
    fn codex_collab_wait_item_normalizes_without_prompt() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.started",
                    "item": {
                        "id": "item_14",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "sender_thread_id": "019f2214-983b-7f43-958b-7f68e1dba989",
                        "receiver_thread_ids": ["019f2214-c736-7f60-bb78-75b6ecff57a3"],
                        "prompt": null,
                        "agents_states": {},
                        "status": "in_progress"
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        let event = &result.events[0];
        assert_eq!(event.r#type, "command.started");
        assert_eq!(event.message, "wait");
        assert!(event.payload["input"].get("prompt").is_none());
        assert_eq!(
            event.payload["input"]["receiver_thread_ids"][0],
            "019f2214-c736-7f60-bb78-75b6ecff57a3"
        );
    }

    #[test]
    fn codex_named_item_wins_over_tool_field() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.started",
                    "item": { "type": "shell", "name": "shell", "tool": "ignored", "action": { "command": "npm test" } }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events[0].message, "shell");
        assert_eq!(result.events[0].payload["name"], "shell");
    }

    #[test]
    fn codex_todo_list_item_does_not_become_command_event() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.completed",
                    "item": { "id": "item_1", "type": "todo_list", "text": "not a tool call" }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert!(result.events.is_empty());
    }

    #[test]
    fn codex_reasoning_item_becomes_thinking_delta() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.completed",
                    "item": {
                        "id": "item_1",
                        "type": "reasoning",
                        "text": "**Checking the repo shape**"
                    }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "message.delta");
        assert_eq!(result.events[0].message, "**Checking the repo shape**");
        assert_eq!(result.events[0].payload["thinking"], json!(true));
        assert_eq!(
            result.events[0].payload["providerEventType"],
            "item.completed"
        );
        assert_eq!(result.events[0].payload["raw"]["type"], "item.completed");
    }

    #[test]
    fn codex_empty_reasoning_item_is_dropped() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.completed",
                    "item": { "id": "item_1", "type": "reasoning", "text": "   " }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert!(result.events.is_empty());
    }

    #[test]
    fn codex_error_item_surfaces_as_error_event() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.completed",
                    "item": { "id": "item_1", "type": "error", "message": "stream disconnected" }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].r#type, "error");
        assert_eq!(result.events[0].message, "stream disconnected");
    }

    #[test]
    fn codex_error_item_started_is_not_double_posted() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                &json!({
                    "type": "item.started",
                    "item": { "id": "item_1", "type": "error", "message": "stream disconnected" }
                })
                .to_string(),
            ),
            &mut context,
        );
        assert!(result.events.is_empty());
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
        assert_eq!(result.events[0].r#type, "permission.blocked");
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
        assert_eq!(result.usages[0].context_tokens, Some(100));
    }

    #[test]
    fn codex_token_count_captures_model_context_window() {
        let mut context = NormalizerSessionContext::default();
        let result = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                r#"{"type":"token_count","info":{"model_context_window":272000,"last_token_usage":{"input_tokens":100,"output_tokens":10}}}"#,
            ),
            &mut context,
        );
        assert_eq!(result.usages[0].context_window, Some(272_000));
    }

    /// `codex exec --json` stopped emitting `token_count`, so `turn.completed`
    /// is the only usage row a live session sees. Its `input_tokens` is the
    /// thread's running total — both occupancy and billing delta are calculated
    /// from the difference between cumulative totals.
    #[test]
    fn codex_turn_usage_reports_the_step_between_cumulative_totals() {
        let mut context =
            NormalizerSessionContext::for_provider(ProviderId::Codex, "gpt-5.6-terra");
        let first = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                r#"{"type":"turn.completed","usage":{"input_tokens":21130,"cached_input_tokens":6912,"output_tokens":5}}"#,
            ),
            &mut context,
        );
        assert_eq!(first.usages[0].context_tokens, Some(21_130));
        assert_eq!(first.usages[0].tokens.input, 14_218);
        assert_eq!(first.usages[0].tokens.cache_read, 6_912);
        assert_eq!(first.usages[0].tokens.output, 5);

        let second = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                r#"{"type":"turn.completed","usage":{"input_tokens":49129,"cached_input_tokens":27136,"output_tokens":10}}"#,
            ),
            &mut context,
        );
        assert_eq!(second.usages[0].context_tokens, Some(27_999));
        // Billing counts the turn delta, not the thread cumulative total.
        // Delta input = 49129 - 21130 = 27999.
        // Delta cached = 27136 - 6912 = 20224.
        // Delta non-cached input = 27999 - 20224 = 7775.
        assert_eq!(second.usages[0].tokens.input, 7_775);
        assert_eq!(second.usages[0].tokens.cache_read, 20_224);
        assert_eq!(second.usages[0].tokens.output, 5);
        assert_eq!(second.usages[0].context_window, None);
    }

    /// The counter lives on the Codex thread, not the process, so a resumed
    /// launch without seeded usage takes a baseline before reporting deltas and occupancy.
    #[test]
    fn codex_resumed_launch_takes_a_baseline_before_reporting_occupancy() {
        let mut context =
            NormalizerSessionContext::for_provider(ProviderId::Codex, "gpt-5.6-terra").resuming();
        let first = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                r#"{"type":"turn.completed","usage":{"input_tokens":501468,"cached_input_tokens":437504,"output_tokens":1234}}"#,
            ),
            &mut context,
        );
        assert!(first.usages.is_empty());

        let second = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                r#"{"type":"turn.completed","usage":{"input_tokens":531468,"cached_input_tokens":437504,"output_tokens":1244}}"#,
            ),
            &mut context,
        );
        assert_eq!(second.usages[0].context_tokens, Some(30_000));
        assert_eq!(second.usages[0].tokens.input, 30_000);
        assert_eq!(second.usages[0].tokens.output, 10);
    }

    #[test]
    fn codex_resumed_launch_with_seeded_usage_computes_delta_immediately() {
        let mut context =
            NormalizerSessionContext::for_provider(ProviderId::Codex, "gpt-5.6-terra")
                .resuming_codex(
                    Some("thread-xyz".to_string()),
                    Some(CodexCumulativeUsage {
                        input_tokens: 501468,
                        cached_input_tokens: 437504,
                        output_tokens: 1234,
                    }),
                );
        let first = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                r#"{"type":"turn.completed","usage":{"input_tokens":531468,"cached_input_tokens":437504,"output_tokens":1244}}"#,
            ),
            &mut context,
        );
        assert_eq!(first.usages[0].context_tokens, Some(30_000));
        assert_eq!(first.usages[0].tokens.input, 30_000);
        assert_eq!(first.usages[0].tokens.cache_read, 0);
        assert_eq!(first.usages[0].tokens.output, 10);
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
        assert_eq!(context.codex_thread_id.as_deref(), Some("thread-123"));
    }

    #[test]
    fn codex_turn_usage_reads_rollout_if_present() {
        let temp_dir = tempfile::tempdir().unwrap();
        let rollout_file = temp_dir
            .path()
            .join("rollout-2026-09-01T08-00-00-thread-test.jsonl");
        let rollout_content = r#"{"type":"session_meta","payload":{"id":"thread-test"}}
{"type":"event_msg","payload":{"type":"task_started","model_context_window":258400}}
{"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":258400,"last_token_usage":{"input_tokens":12345,"cached_input_tokens":4000,"output_tokens":50}}}}
"#;
        std::fs::write(&rollout_file, rollout_content).unwrap();

        let mut context =
            NormalizerSessionContext::for_provider(ProviderId::Codex, "gpt-5.6-terra");
        context.codex_thread_id = Some("thread-test".to_string());
        context.codex_rollout_path = Some(rollout_file);

        let event = normalize_provider_event(
            ProviderId::Codex,
            &output_event(
                r#"{"type":"turn.completed","usage":{"input_tokens":50000,"cached_input_tokens":20000,"output_tokens":100}}"#,
            ),
            &mut context,
        );

        assert_eq!(event.usages[0].context_tokens, Some(12345));
        assert_eq!(event.usages[0].context_window, Some(258400));
        assert_eq!(event.usages[0].tokens.input, 30000);
        assert_eq!(event.usages[0].tokens.cache_read, 20000);
        assert_eq!(event.usages[0].tokens.output, 100);
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
        assert_eq!(event.r#type, "permission.blocked");
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
        assert_eq!(event.r#type, "permission.blocked");
        assert_eq!(event.message, "Apply file changes");
        assert_eq!(event.payload["command"], "Apply file changes");
        assert_eq!(event.payload["reason"], "Apply generated patch");
        assert_eq!(event.payload["riskLevel"], "high");
    }

    /// Replays a real Codex multi-agent session's `collab_tool_call` lines
    /// (captured from raw_outputs, prompt trimmed and paths anonymized) so the
    /// spawn_agent tool row survives end-to-end through the dispatcher.
    #[test]
    fn codex_collab_spawn_agent_fixture_replays() {
        let fixture = include_str!("../../../tests/fixtures/codex/collab_spawn_agent.jsonl");
        let snapshot =
            include_str!("../../../tests/fixtures/codex/collab_spawn_agent.events.snapshot.json");
        let mut dispatcher = Dispatcher::new();
        let result = dispatcher.normalize(ProviderId::Codex, output_event(&format!("{fixture}\n")));
        assert_eq!(result.events.len(), 2);
        assert_eq!(
            stable_event_snapshot(&result.events),
            serde_json::from_str::<Value>(snapshot).expect("snapshot json")
        );
        let started = &result.events[0];
        assert_eq!(started.r#type, "command.started");
        assert_eq!(started.message, "spawn_agent");
        assert_eq!(started.payload["name"], "spawn_agent");
        let completed = &result.events[1];
        assert_eq!(completed.r#type, "command.completed");
        assert_eq!(completed.payload["id"], started.payload["id"]);
        assert_eq!(
            completed.payload["input"]["receiver_thread_ids"][0],
            "019f2214-c736-7f60-bb78-75b6ecff57a3"
        );
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
