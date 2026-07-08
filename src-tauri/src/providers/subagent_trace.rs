use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader},
    path::Component,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Datelike, Duration, Utc};
use rusqlite::Connection;
use serde_json::{Map, Value};
use walkdir::WalkDir;

use super::normalizer::JSON_PARSE_LINE_CAP;
use crate::{
    error::ArgmaxResult,
    persistence::{
        database::Database,
        events::{
            list_session_agent_events, persist_timeline_event_if_absent,
            upgrade_trace_no_output_completion, PersistTimelineEventInput,
        },
        sessions::find_session_by_id,
        workspaces::find_workspace_by_id,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TraceProvider {
    Codex,
    Cursor,
}

impl TraceProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }
}

#[derive(Debug, Clone)]
struct AgentTraceContext {
    provider: TraceProvider,
    session_id: String,
    parent_tool_use_id: String,
    parent_created_at: String,
    provider_conversation_id: Option<String>,
    workspace_path: Option<String>,
    cursor_prompt: Option<String>,
    child_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct CursorTraceFile {
    child_id: String,
    path: PathBuf,
}

#[derive(Debug, Clone)]
struct TraceLine {
    value: Value,
    timestamp: Option<String>,
}

pub fn import_subagent_trace_events(
    database: &Database,
    session_id: &str,
    parent_tool_use_id: &str,
) -> ArgmaxResult<usize> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Ok(0);
    };
    import_subagent_trace_events_from_home_database(database, session_id, parent_tool_use_id, &home)
}

fn import_subagent_trace_events_from_home_database(
    database: &Database,
    session_id: &str,
    parent_tool_use_id: &str,
    home: &Path,
) -> ArgmaxResult<usize> {
    let Some(context) = ({
        let connection = database.connection();
        agent_trace_context(&connection, session_id, parent_tool_use_id)?
    }) else {
        return Ok(0);
    };

    let events = trace_events_from_home(home, &context);
    let connection = database.connection();
    persist_trace_events(&connection, events)
}

#[cfg(test)]
fn import_subagent_trace_events_from_home(
    connection: &Connection,
    session_id: &str,
    parent_tool_use_id: &str,
    home: &Path,
) -> ArgmaxResult<usize> {
    let Some(context) = agent_trace_context(connection, session_id, parent_tool_use_id)? else {
        return Ok(0);
    };
    let events = trace_events_from_home(home, &context);
    persist_trace_events(connection, events)
}

fn trace_events_from_home(
    home: &Path,
    context: &AgentTraceContext,
) -> Vec<PersistTimelineEventInput> {
    match context.provider {
        TraceProvider::Codex => codex_trace_events(home, context),
        TraceProvider::Cursor => cursor_trace_events(home, context),
    }
}

fn persist_trace_events(
    connection: &Connection,
    events: Vec<PersistTimelineEventInput>,
) -> ArgmaxResult<usize> {
    let mut inserted = 0;
    for event in events {
        if persist_timeline_event_if_absent(connection, &event)?
            || upgrade_trace_no_output_completion(connection, &event)?
        {
            inserted += 1;
        }
    }
    Ok(inserted)
}

fn agent_trace_context(
    connection: &Connection,
    session_id: &str,
    parent_tool_use_id: &str,
) -> ArgmaxResult<Option<AgentTraceContext>> {
    let session = find_session_by_id(connection, session_id)?;
    let workspace_path = find_workspace_by_id(connection, &session.workspace_id)
        .ok()
        .map(|workspace| workspace.path);
    let provider = match session.provider.as_str() {
        "codex" => TraceProvider::Codex,
        "cursor" => TraceProvider::Cursor,
        _ => return Ok(None),
    };
    let tail = list_session_agent_events(connection, session_id, parent_tool_use_id)?;
    let mut parent_created_at = None;
    let mut cursor_prompt = None;
    let mut child_ids = Vec::new();
    for row in &tail.events {
        let is_parent_start = row.r#type == "command.started"
            && payload_tool_id(&row.payload) == Some(parent_tool_use_id);
        let is_parent_completion = row.r#type == "command.completed"
            && payload_completion_id(&row.payload) == Some(parent_tool_use_id);
        if !is_parent_start && !is_parent_completion {
            continue;
        }
        if parent_created_at.is_none() {
            parent_created_at = Some(row.created_at.clone());
        }
        match provider {
            TraceProvider::Codex => {
                for child_id in receiver_thread_ids(&row.payload) {
                    push_unique(&mut child_ids, child_id);
                }
            }
            TraceProvider::Cursor => {
                if cursor_prompt.is_none() {
                    cursor_prompt = cursor_task_prompt(&row.payload);
                }
                for child_id in cursor_child_agent_ids(&row.payload) {
                    push_unique(&mut child_ids, child_id);
                }
            }
        }
    }

    let Some(parent_created_at) = parent_created_at else {
        return Ok(None);
    };
    if child_ids.is_empty()
        && !(provider == TraceProvider::Cursor && cursor_prompt.as_deref().is_some())
    {
        return Ok(None);
    }
    Ok(Some(AgentTraceContext {
        provider,
        session_id: session_id.to_string(),
        parent_tool_use_id: parent_tool_use_id.to_string(),
        parent_created_at,
        provider_conversation_id: session.provider_conversation_id,
        workspace_path,
        cursor_prompt,
        child_ids,
    }))
}

fn codex_trace_events(home: &Path, context: &AgentTraceContext) -> Vec<PersistTimelineEventInput> {
    let mut events = Vec::new();
    for child_id in &context.child_ids {
        let Some(path) = find_codex_trace_file(
            home,
            child_id,
            context.provider_conversation_id.as_deref(),
            &context.parent_created_at,
        ) else {
            continue;
        };
        let source = path.to_string_lossy().into_owned();
        let lines = read_trace_lines(&path);
        let mut seen_messages = HashSet::new();
        let mut seen_thinking = HashSet::new();
        // Event IDs include the child id, so the sequence must be per child.
        // Otherwise a growing child trace shifts later siblings' IDs and
        // re-imports duplicate rows.
        let mut sequence = 0;
        for line in lines {
            let Some(object) = line.value.as_object() else {
                continue;
            };
            let Some((kind, message, mut payload)) = codex_trace_event_payload(object) else {
                continue;
            };
            if (kind == "message.delta" && is_duplicate_text(&mut seen_thinking, &message))
                || (kind == "message.completed" && is_duplicate_text(&mut seen_messages, &message))
            {
                continue;
            }
            let event_sequence = sequence;
            sequence += 1;
            stamp_trace_payload(&mut payload, context, child_id, &source, event_sequence);
            events.push(trace_event(
                context,
                child_id,
                event_sequence,
                kind,
                message,
                payload,
                line.timestamp,
            ));
        }
    }
    events
}

fn cursor_trace_events(home: &Path, context: &AgentTraceContext) -> Vec<PersistTimelineEventInput> {
    let mut events = Vec::new();
    for trace_file in find_cursor_trace_files(home, context) {
        let child_id = trace_file.child_id.as_str();
        let path = trace_file.path;
        let source = path.to_string_lossy().into_owned();
        let lines = read_trace_lines(&path);
        let real_result_ids = cursor_real_result_ids(&lines);
        let mut seen_messages = HashSet::new();
        // Keep imported IDs stable when another child transcript grows.
        let mut sequence = 0;
        // Sequence slot reserved for each tool's completion, so a real result
        // appended on a later poll lands under the same deterministic id the
        // synthetic no-output completion used and cannot shift later slots.
        let mut completion_slots: HashMap<String, usize> = HashMap::new();
        for line in lines {
            let Some(object) = line.value.as_object() else {
                continue;
            };
            // Assistant rows carry the child's text/thinking/tool_use blocks;
            // tool results ride whatever role Cursor writes them under.
            let is_assistant = object.get("role").and_then(Value::as_str) == Some("assistant");
            let content = object
                .get("message")
                .and_then(Value::as_object)
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for block in content {
                let Some(block_object) = block.as_object() else {
                    continue;
                };
                let block_type = block_object.get("type").and_then(Value::as_str);
                match block_type {
                    Some("text") if is_assistant => {
                        let Some(text) = block_object
                            .get("text")
                            .and_then(Value::as_str)
                            .and_then(clean_cursor_text)
                        else {
                            continue;
                        };
                        if is_duplicate_text(&mut seen_messages, &text) {
                            continue;
                        }
                        let event_sequence = sequence;
                        sequence += 1;
                        let mut payload = Map::new();
                        stamp_trace_payload(
                            &mut payload,
                            context,
                            child_id,
                            &source,
                            event_sequence,
                        );
                        events.push(trace_event(
                            context,
                            child_id,
                            event_sequence,
                            "message.completed",
                            text,
                            payload,
                            line.timestamp.clone(),
                        ));
                    }
                    Some("thinking") | Some("thinking_delta") if is_assistant => {
                        let Some(text) = block_object
                            .get("text")
                            .or_else(|| block_object.get("thinking"))
                            .and_then(Value::as_str)
                            .filter(|text| !text.trim().is_empty())
                            .map(str::to_string)
                        else {
                            continue;
                        };
                        let event_sequence = sequence;
                        sequence += 1;
                        let mut payload = Map::new();
                        payload.insert("thinking".to_string(), Value::Bool(true));
                        stamp_trace_payload(
                            &mut payload,
                            context,
                            child_id,
                            &source,
                            event_sequence,
                        );
                        events.push(trace_event(
                            context,
                            child_id,
                            event_sequence,
                            "message.delta",
                            text,
                            payload,
                            line.timestamp.clone(),
                        ));
                    }
                    Some("tool_use") if is_assistant => {
                        let event_sequence = sequence;
                        sequence += 1;
                        let tool_id = cursor_tool_id(block_object, child_id, event_sequence);
                        let tool_name = block_object
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        let input = block_object
                            .get("input")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        let mut payload = Map::new();
                        payload.insert("id".to_string(), Value::String(tool_id.clone()));
                        payload.insert("name".to_string(), Value::String(tool_name.to_string()));
                        payload.insert("type".to_string(), Value::String(tool_name.to_string()));
                        payload.insert("input".to_string(), Value::Object(input));
                        stamp_trace_payload(
                            &mut payload,
                            context,
                            child_id,
                            &source,
                            event_sequence,
                        );
                        events.push(trace_event(
                            context,
                            child_id,
                            event_sequence,
                            "command.started",
                            tool_name.to_string(),
                            payload,
                            line.timestamp.clone(),
                        ));
                        // Burn the completion slot whether or not the real
                        // result has arrived yet, so its appearance on a
                        // later poll never shifts the sequences behind it.
                        let completion_sequence = sequence;
                        sequence += 1;
                        completion_slots.insert(tool_id.clone(), completion_sequence);
                        if !real_result_ids.contains(&tool_id) {
                            let mut completion = Map::new();
                            completion.insert("id".to_string(), Value::String(tool_id));
                            completion.insert("traceNoOutput".to_string(), Value::Bool(true));
                            stamp_trace_payload(
                                &mut completion,
                                context,
                                child_id,
                                &source,
                                completion_sequence,
                            );
                            events.push(trace_event(
                                context,
                                child_id,
                                completion_sequence,
                                "command.completed",
                                "tool_result",
                                completion,
                                line.timestamp.clone(),
                            ));
                        }
                    }
                    Some("tool_result") | Some("tool_output") => {
                        let Some(tool_id) = block_object
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .or_else(|| block_object.get("id").and_then(Value::as_str))
                        else {
                            continue;
                        };
                        let event_sequence = match completion_slots.get(tool_id) {
                            Some(slot) => *slot,
                            None => {
                                let next = sequence;
                                sequence += 1;
                                next
                            }
                        };
                        let mut payload = Map::new();
                        payload.insert("id".to_string(), Value::String(tool_id.to_string()));
                        if let Some(content) = block_object.get("content").cloned() {
                            payload.insert("content".to_string(), content);
                        }
                        if let Some(output) = block_object.get("output").cloned() {
                            payload.insert("output".to_string(), output);
                        }
                        stamp_trace_payload(
                            &mut payload,
                            context,
                            child_id,
                            &source,
                            event_sequence,
                        );
                        events.push(trace_event(
                            context,
                            child_id,
                            event_sequence,
                            "command.completed",
                            "tool_result",
                            payload,
                            line.timestamp.clone(),
                        ));
                    }
                    _ => {}
                }
            }
        }
    }
    events
}

fn codex_trace_event_payload(
    object: &Map<String, Value>,
) -> Option<(&'static str, String, Map<String, Value>)> {
    let trace_type = object.get("type").and_then(Value::as_str);
    let payload = object.get("payload").and_then(Value::as_object);
    match (trace_type, payload) {
        (Some("event_msg"), Some(payload)) => match payload.get("type").and_then(Value::as_str) {
            Some("agent_reasoning") => {
                let text = payload
                    .get("text")
                    .and_then(Value::as_str)?
                    .trim()
                    .to_string();
                if text.is_empty() {
                    return None;
                }
                let mut out = Map::new();
                out.insert("thinking".to_string(), Value::Bool(true));
                Some(("message.delta", text, out))
            }
            Some("agent_message") => {
                let text = payload
                    .get("message")
                    .or_else(|| payload.get("text"))
                    .and_then(Value::as_str)?
                    .trim()
                    .to_string();
                if text.is_empty() {
                    return None;
                }
                Some(("message.completed", text, Map::new()))
            }
            _ => None,
        },
        (Some("response_item"), Some(payload)) => match payload.get("type").and_then(Value::as_str)
        {
            Some("reasoning") => {
                let text = codex_reasoning_text(payload)?;
                let mut out = Map::new();
                out.insert("thinking".to_string(), Value::Bool(true));
                Some(("message.delta", text, out))
            }
            Some("function_call") => {
                let tool_name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let call_id = payload
                    .get("call_id")
                    .or_else(|| payload.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("trace-tool")
                    .to_string();
                let mut out = Map::new();
                out.insert("id".to_string(), Value::String(call_id.clone()));
                out.insert("call_id".to_string(), Value::String(call_id));
                out.insert("name".to_string(), Value::String(tool_name.clone()));
                out.insert("type".to_string(), Value::String(tool_name.clone()));
                out.insert(
                    "input".to_string(),
                    Value::Object(codex_function_call_input(payload)),
                );
                Some(("command.started", tool_name, out))
            }
            Some("function_call_output") => {
                let call_id = payload
                    .get("call_id")
                    .or_else(|| payload.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("trace-tool")
                    .to_string();
                let mut out = Map::new();
                out.insert("id".to_string(), Value::String(call_id.clone()));
                out.insert("call_id".to_string(), Value::String(call_id));
                if let Some(output) = payload.get("output") {
                    out.insert("output".to_string(), value_as_output(output));
                }
                Some(("command.completed", "tool_result".to_string(), out))
            }
            Some("message") => {
                let text = codex_message_text(payload)?;
                Some(("message.completed", text, Map::new()))
            }
            _ => None,
        },
        _ => None,
    }
}

fn codex_reasoning_text(payload: &Map<String, Value>) -> Option<String> {
    if let Some(text) = payload.get("text").and_then(Value::as_str) {
        let text = text.trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    let text = payload
        .get("summary")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|item| {
            item.as_object()
                .and_then(|item| item.get("text"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn codex_message_text(payload: &Map<String, Value>) -> Option<String> {
    if payload.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let text = payload
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|item| {
            item.as_object()
                .and_then(|item| item.get("text"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn codex_function_call_input(payload: &Map<String, Value>) -> Map<String, Value> {
    if let Some(arguments) = payload.get("arguments") {
        if let Some(object) = arguments.as_object() {
            return object.clone();
        }
        if let Some(text) = arguments.as_str() {
            if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(text) {
                return object;
            }
            let mut out = Map::new();
            out.insert("arguments".to_string(), Value::String(text.to_string()));
            return out;
        }
    }
    Map::new()
}

fn value_as_output(value: &Value) -> Value {
    match value {
        Value::String(_) => value.clone(),
        _ => Value::String(value.to_string()),
    }
}

fn find_codex_trace_file(
    home: &Path,
    child_thread_id: &str,
    parent_thread_id: Option<&str>,
    parent_created_at: &str,
) -> Option<PathBuf> {
    for (root, max_depth) in codex_trace_roots(home, parent_created_at) {
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(&root)
            .follow_links(false)
            .max_depth(max_depth)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
        {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !name.ends_with(".jsonl") || !name.contains(child_thread_id) {
                continue;
            }
            if codex_trace_file_matches(path, child_thread_id, parent_thread_id) {
                return Some(path.to_path_buf());
            }
        }
    }
    None
}

fn codex_trace_roots(home: &Path, parent_created_at: &str) -> Vec<(PathBuf, usize)> {
    let sessions = home.join(".codex/sessions");
    let archived = home.join(".codex/archived_sessions");
    let Some(parent_time) = DateTime::parse_from_rfc3339(parent_created_at)
        .ok()
        .map(|time| time.with_timezone(&Utc))
    else {
        return vec![(sessions, usize::MAX), (archived, 1)];
    };

    let mut roots = Vec::new();
    for day_offset in [-1, 0, 1] {
        let day = parent_time + Duration::days(day_offset);
        roots.push((
            sessions
                .join(format!("{:04}", day.year()))
                .join(format!("{:02}", day.month()))
                .join(format!("{:02}", day.day())),
            1,
        ));
    }
    roots.push((archived, 1));
    roots
}

fn codex_trace_file_matches(
    path: &Path,
    child_thread_id: &str,
    parent_thread_id: Option<&str>,
) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(Value::Object(object)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let Some(payload) = object.get("payload").and_then(Value::as_object) else {
            continue;
        };
        let child_matches = payload.get("id").and_then(Value::as_str) == Some(child_thread_id);
        if !child_matches {
            return false;
        }
        if let Some(expected_parent) = parent_thread_id {
            let parent = payload
                .get("parent_thread_id")
                .and_then(Value::as_str)
                .or_else(|| {
                    payload
                        .get("source")
                        .and_then(Value::as_object)
                        .and_then(|source| source.get("subagent"))
                        .and_then(Value::as_object)
                        .and_then(|subagent| subagent.get("thread_spawn"))
                        .and_then(Value::as_object)
                        .and_then(|thread_spawn| thread_spawn.get("parent_thread_id"))
                        .and_then(Value::as_str)
                });
            if parent.is_some_and(|parent| parent != expected_parent) {
                return false;
            }
        }
        return true;
    }
    false
}

fn find_cursor_trace_files(home: &Path, context: &AgentTraceContext) -> Vec<CursorTraceFile> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for child_id in &context.child_ids {
        for path in find_cursor_trace_files_by_id(home, context.workspace_path.as_deref(), child_id)
        {
            push_cursor_trace_file(&mut files, &mut seen, child_id.to_string(), path);
        }
    }
    if let Some(prompt) = context.cursor_prompt.as_deref() {
        for path in find_cursor_trace_files_by_prompt(
            home,
            context.workspace_path.as_deref(),
            prompt,
            &context.parent_created_at,
        ) {
            if let Some(child_id) = cursor_child_id_from_trace_path(&path) {
                push_cursor_trace_file(&mut files, &mut seen, child_id, path);
            }
        }
    }
    files
}

fn push_cursor_trace_file(
    files: &mut Vec<CursorTraceFile>,
    seen: &mut HashSet<PathBuf>,
    child_id: String,
    path: PathBuf,
) {
    if seen.insert(path.clone()) {
        files.push(CursorTraceFile { child_id, path });
    }
}

fn find_cursor_trace_files_by_id(
    home: &Path,
    workspace_path: Option<&str>,
    child_agent_id: &str,
) -> Vec<PathBuf> {
    // Agent ids come from provider JSON payloads and are joined into paths
    // under ~/.cursor/projects — never let one carry a path separator or `..`.
    if !child_agent_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        tracing::warn!(
            child_agent_id,
            "rejected cursor child agent id with unsafe path characters"
        );
        return Vec::new();
    }
    let mut files = Vec::new();
    for project in cursor_project_roots(home, workspace_path) {
        let direct = project
            .join("agent-transcripts")
            .join(child_agent_id)
            .join(format!("{child_agent_id}.jsonl"));
        if direct.is_file() {
            files.push(direct);
        }
        let transcripts = project.join("agent-transcripts");
        let Ok(entries) = fs::read_dir(transcripts) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let nested = entry
                .path()
                .join("subagents")
                .join(format!("{child_agent_id}.jsonl"));
            if nested.is_file() {
                files.push(nested);
            }
        }
    }
    files
}

fn find_cursor_trace_files_by_prompt(
    home: &Path,
    workspace_path: Option<&str>,
    prompt: &str,
    parent_created_at: &str,
) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let parent_time = DateTime::parse_from_rfc3339(parent_created_at)
        .ok()
        .map(|time| time.with_timezone(&Utc));
    let cutoff = parent_time.map(|time| time - Duration::minutes(1));
    for project in cursor_prompt_project_roots(home, workspace_path) {
        let transcripts = project.join("agent-transcripts");
        if !transcripts.exists() {
            continue;
        }
        for entry in WalkDir::new(transcripts)
            .follow_links(false)
            .max_depth(4)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
        {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(cutoff) = cutoff {
                if cursor_file_modified_utc(path).is_some_and(|modified| modified < cutoff) {
                    continue;
                }
            }
            if cursor_trace_file_prompt_matches(path, prompt) {
                files.push(path.to_path_buf());
            }
        }
    }
    files.sort_by_key(|path| {
        let Some(parent_time) = parent_time else {
            return i64::MAX;
        };
        cursor_file_modified_utc(path)
            .map(|modified| (modified - parent_time).num_milliseconds().abs())
            .unwrap_or(i64::MAX)
    });
    files.into_iter().take(1).collect()
}

fn cursor_prompt_project_roots(home: &Path, workspace_path: Option<&str>) -> Vec<PathBuf> {
    if let Some(preferred) = workspace_path
        .and_then(cursor_project_slug)
        .map(|slug| home.join(".cursor/projects").join(slug))
        .filter(|path| path.is_dir())
    {
        return vec![preferred];
    }
    cursor_project_roots(home, None)
}

fn cursor_project_roots(home: &Path, workspace_path: Option<&str>) -> Vec<PathBuf> {
    let projects = home.join(".cursor/projects");
    let Ok(entries) = fs::read_dir(projects) else {
        return Vec::new();
    };
    let preferred = workspace_path
        .and_then(cursor_project_slug)
        .map(|slug| home.join(".cursor/projects").join(slug));
    let mut roots = Vec::new();
    if let Some(path) = preferred.filter(|path| path.is_dir()) {
        roots.push(path);
    }
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() && !roots.contains(&path) {
            roots.push(path);
        }
    }
    roots
}

fn cursor_project_slug(workspace_path: &str) -> Option<String> {
    let slug = Path::new(workspace_path)
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    (!slug.is_empty()).then_some(slug)
}

fn cursor_trace_file_prompt_matches(path: &Path, prompt: &str) -> bool {
    let needle = normalize_cursor_match_text(prompt);
    if needle.is_empty() {
        return false;
    }
    cursor_first_user_text(path)
        .map(|text| normalize_cursor_match_text(&text).contains(&needle))
        .unwrap_or(false)
}

fn cursor_first_user_text(path: &Path) -> Option<String> {
    for line in read_trace_lines(path) {
        let Some(object) = line.value.as_object() else {
            continue;
        };
        if object.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let text = object
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| message.get("content"))
            .and_then(cursor_content_text)
            .or_else(|| {
                object
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        if text.as_deref().is_some_and(|text| !text.trim().is_empty()) {
            return text;
        }
    }
    None
}

fn cursor_content_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let text = value
        .as_array()?
        .iter()
        .filter_map(|block| {
            block
                .as_object()
                .and_then(|block| block.get("text").or_else(|| block.get("content")))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn normalize_cursor_match_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cursor_child_id_from_trace_path(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .map(str::to_string)
}

fn cursor_file_modified_utc(path: &Path) -> Option<DateTime<Utc>> {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .map(DateTime::<Utc>::from)
}

fn read_trace_lines(path: &Path) -> Vec<TraceLine> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && line.len() <= JSON_PARSE_LINE_CAP)
        .filter_map(|line| {
            let value = serde_json::from_str::<Value>(&line).ok()?;
            let timestamp = value
                .as_object()
                .and_then(|object| object.get("timestamp"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            Some(TraceLine { value, timestamp })
        })
        .collect()
}

fn cursor_real_result_ids(lines: &[TraceLine]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for line in lines {
        let Some(object) = line.value.as_object() else {
            continue;
        };
        let content = object
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for block in content {
            let Some(block) = block.as_object() else {
                continue;
            };
            if !matches!(
                block.get("type").and_then(Value::as_str),
                Some("tool_result" | "tool_output")
            ) {
                continue;
            }
            if let Some(id) = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .or_else(|| block.get("id").and_then(Value::as_str))
            {
                ids.insert(id.to_string());
            }
        }
    }
    ids
}

fn clean_cursor_text(text: &str) -> Option<String> {
    let cleaned = text
        .lines()
        .filter(|line| line.trim() != "[REDACTED]")
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn cursor_tool_id(block: &Map<String, Value>, child_id: &str, sequence: usize) -> String {
    // The fallback id is keyed session-wide by the renderer's tool-call map,
    // so it must carry the child id — a per-file sequence alone collides
    // across children in the same session.
    block
        .get("id")
        .or_else(|| block.get("tool_use_id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("trace-cursor-tool-{child_id}-{sequence}"))
}

fn stamp_trace_payload(
    payload: &mut Map<String, Value>,
    context: &AgentTraceContext,
    child_id: &str,
    source: &str,
    sequence: usize,
) {
    payload.insert(
        "parent_tool_use_id".to_string(),
        Value::String(context.parent_tool_use_id.clone()),
    );
    payload.insert(
        "providerChildSessionId".to_string(),
        Value::String(child_id.to_string()),
    );
    payload.insert("traceImported".to_string(), Value::Bool(true));
    payload.insert("traceSource".to_string(), Value::String(source.to_string()));
    payload.insert(
        "traceSequence".to_string(),
        Value::Number(serde_json::Number::from(sequence as u64)),
    );
}

fn trace_event(
    context: &AgentTraceContext,
    child_id: &str,
    sequence: usize,
    event_type: &str,
    message: impl Into<String>,
    payload: Map<String, Value>,
    source_timestamp: Option<String>,
) -> PersistTimelineEventInput {
    PersistTimelineEventInput {
        id: format!(
            "trace:{}:{}:{}:{}:{}:{}",
            context.provider.as_str(),
            context.session_id,
            context.parent_tool_use_id,
            child_id,
            sequence,
            event_type
        ),
        session_id: context.session_id.clone(),
        r#type: event_type.to_string(),
        message: message.into(),
        payload: Value::Object(payload),
        created_at: Some(
            source_timestamp
                .unwrap_or_else(|| fallback_timestamp(&context.parent_created_at, sequence)),
        ),
    }
}

fn fallback_timestamp(parent_created_at: &str, sequence: usize) -> String {
    DateTime::parse_from_rfc3339(parent_created_at)
        .map(|time| {
            (time.with_timezone(&Utc) + Duration::milliseconds(sequence as i64 + 1))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .unwrap_or_else(|_| parent_created_at.to_string())
}

fn payload_tool_id(payload: &Value) -> Option<&str> {
    payload
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| payload.get("call_id").and_then(Value::as_str))
}

fn payload_completion_id(payload: &Value) -> Option<&str> {
    payload
        .get("tool_use_id")
        .and_then(Value::as_str)
        .or_else(|| payload.get("id").and_then(Value::as_str))
        .or_else(|| payload.get("call_id").and_then(Value::as_str))
}

fn receiver_thread_ids(payload: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for value in [
        payload.get("receiver_thread_ids"),
        payload
            .get("input")
            .and_then(Value::as_object)
            .and_then(|input| input.get("receiver_thread_ids")),
    ] {
        if let Some(array) = value.and_then(Value::as_array) {
            for id in array
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                push_unique(&mut ids, id.to_string());
            }
        }
    }
    ids
}

fn cursor_child_agent_ids(payload: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for path in [
        ["result", "success", "agentId"].as_slice(),
        ["input", "agentId"].as_slice(),
        ["input", "agent_id"].as_slice(),
    ] {
        if let Some(id) = value_at_path(payload, path)
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            push_unique(&mut ids, id.to_string());
        }
    }
    ids
}

fn cursor_task_prompt(payload: &Value) -> Option<String> {
    for path in [
        ["input", "prompt"].as_slice(),
        ["args", "prompt"].as_slice(),
        ["prompt"].as_slice(),
        ["raw", "tool_call", "taskToolCall", "args", "prompt"].as_slice(),
        ["raw", "tool_call", "Task", "args", "prompt"].as_slice(),
    ] {
        if let Some(prompt) = value_at_path(payload, path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
        {
            return Some(prompt.to_string());
        }
    }
    None
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.as_object()?.get(*key)?;
    }
    Some(current)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn is_duplicate_text(seen: &mut HashSet<String>, text: &str) -> bool {
    let normalized = text.trim().replace(char::is_whitespace, " ");
    !seen.insert(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{
        database::Database,
        events::{list_session_agent_events, persist_timeline_event},
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        sessions::{persist_session, update_session_provider_conversation_id, PersistSessionInput},
        workspaces::{persist_workspace, PersistWorkspaceInput},
    };
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn codex_child_trace_imports_reasoning_tool_and_message_rows_once() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "codex", "s1");
        update_session_provider_conversation_id(&connection, "s1", "parent-thread")
            .expect("provider id");
        seed_parent_agent(
            &connection,
            "spawn-1",
            json!({
                "id": "spawn-1",
                "name": "spawn_agent",
                "input": {
                    "prompt": "Inspect directory",
                    "receiver_thread_ids": ["child-thread"]
                }
            }),
            json!({
                "id": "spawn-1",
                "input": {
                    "receiver_thread_ids": ["child-thread"]
                }
            }),
        );
        let home = TempDir::new().expect("home");
        let trace_dir = home.path().join(".codex/sessions/2026/07/08");
        fs::create_dir_all(&trace_dir).expect("trace dir");
        fs::write(
            trace_dir.join("rollout-2026-07-08T16-46-49-child-thread.jsonl"),
            r#"{"timestamp":"2026-07-08T14:46:49.290Z","type":"session_meta","payload":{"id":"child-thread","parent_thread_id":"parent-thread"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:46:58.064Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"**Listing current directory contents**"}}"#
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:46:58.064Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"**Listing current directory contents**"}]}}"#
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:46:58.834Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call_1","arguments":"{\"cmd\":\"find . -maxdepth 1\"}"}}"#
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:46:58.920Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"Output:\n"}}"#
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:47:01.533Z","type":"event_msg","payload":{"type":"agent_message","message":"The current directory is empty."}}"#
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:47:01.533Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The current directory is empty."}]}}"#
                + "\n",
        )
        .expect("write trace");

        let first =
            import_subagent_trace_events_from_home(&connection, "s1", "spawn-1", home.path())
                .expect("import");
        let second =
            import_subagent_trace_events_from_home(&connection, "s1", "spawn-1", home.path())
                .expect("reimport");
        assert_eq!(first, 4);
        assert_eq!(second, 0);

        let events = list_session_agent_events(&connection, "s1", "spawn-1")
            .expect("agent events")
            .events;
        assert!(events.iter().any(
            |event| event.r#type == "message.delta" && event.payload["thinking"] == json!(true)
        ));
        assert!(events.iter().any(|event| event.r#type == "command.started"
            && event.message == "exec_command"
            && event.payload["parent_tool_use_id"] == "spawn-1"));
        assert!(events
            .iter()
            .any(|event| event.r#type == "command.completed" && event.payload["id"] == "call_1"));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.message == "The current directory is empty.")
                .count(),
            1
        );
    }

    #[test]
    fn codex_child_trace_ids_stay_stable_when_another_child_grows() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "codex", "s1");
        update_session_provider_conversation_id(&connection, "s1", "parent-thread")
            .expect("provider id");
        seed_parent_agent(
            &connection,
            "spawn-1",
            json!({
                "id": "spawn-1",
                "name": "spawn_agent",
                "input": {
                    "prompt": "Inspect directory",
                    "receiver_thread_ids": ["child-a", "child-b"]
                }
            }),
            json!({
                "id": "spawn-1",
                "input": {
                    "receiver_thread_ids": ["child-a", "child-b"]
                }
            }),
        );
        let home = TempDir::new().expect("home");
        let trace_dir = home.path().join(".codex/sessions/2026/07/08");
        fs::create_dir_all(&trace_dir).expect("trace dir");
        let child_a_path = trace_dir.join("rollout-2026-07-08T16-46-49-child-a.jsonl");
        fs::write(
            &child_a_path,
            r#"{"timestamp":"2026-07-08T14:46:49.290Z","type":"session_meta","payload":{"id":"child-a","parent_thread_id":"parent-thread"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:47:01.533Z","type":"event_msg","payload":{"type":"agent_message","message":"Child A first."}}"#
                + "\n",
        )
        .expect("write child a");
        fs::write(
            trace_dir.join("rollout-2026-07-08T16-46-50-child-b.jsonl"),
            r#"{"timestamp":"2026-07-08T14:46:50.290Z","type":"session_meta","payload":{"id":"child-b","parent_thread_id":"parent-thread"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:47:02.533Z","type":"event_msg","payload":{"type":"agent_message","message":"Child B first."}}"#
                + "\n",
        )
        .expect("write child b");

        let first =
            import_subagent_trace_events_from_home(&connection, "s1", "spawn-1", home.path())
                .expect("import");
        assert_eq!(first, 2);
        let before_child_b_ids = trace_event_ids_for_child(&connection, "spawn-1", "child-b");

        fs::write(
            &child_a_path,
            r#"{"timestamp":"2026-07-08T14:46:49.290Z","type":"session_meta","payload":{"id":"child-a","parent_thread_id":"parent-thread"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:47:01.533Z","type":"event_msg","payload":{"type":"agent_message","message":"Child A first."}}"#
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:47:03.533Z","type":"event_msg","payload":{"type":"agent_message","message":"Child A second."}}"#
                + "\n",
        )
        .expect("grow child a");

        let second =
            import_subagent_trace_events_from_home(&connection, "s1", "spawn-1", home.path())
                .expect("reimport");
        assert_eq!(second, 1);
        assert_eq!(
            trace_event_ids_for_child(&connection, "spawn-1", "child-b"),
            before_child_b_ids
        );
    }

    #[test]
    fn cursor_child_transcript_imports_text_and_tool_rows() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "cursor", "s1");
        seed_parent_agent(
            &connection,
            "call-task",
            json!({
                "call_id": "call-task",
                "name": "taskToolCall",
                "input": { "description": "Inspect directory", "agentId": "started-agent" }
            }),
            json!({
                "call_id": "call-task",
                "result": { "success": { "agentId": "child-agent" } }
            }),
        );
        let home = TempDir::new().expect("home");
        let trace_dir = home
            .path()
            .join(".cursor/projects/tmp/agent-transcripts/child-agent");
        fs::create_dir_all(&trace_dir).expect("trace dir");
        fs::write(
            trace_dir.join("child-agent.jsonl"),
            r#"{"role":"user","message":{"content":[{"type":"text","text":"Inspect"}]}}"#
                .to_string()
                + "\n"
                + r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Inspecting files.\n\n[REDACTED]"},{"type":"tool_use","name":"Glob","input":{"glob_pattern":"**/*","target_directory":"/tmp"}}]}}"#
                + "\n"
                + r#"{"role":"assistant","message":{"content":[{"type":"text","text":"[REDACTED]"},{"type":"tool_use","name":"Shell","input":{"command":"ls -la /tmp"}}]}}"#
                + "\n"
                + r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Directory is empty."}]}}"#
                + "\n",
        )
        .expect("write trace");

        let inserted =
            import_subagent_trace_events_from_home(&connection, "s1", "call-task", home.path())
                .expect("import");
        assert_eq!(inserted, 6);
        let events = list_session_agent_events(&connection, "s1", "call-task")
            .expect("agent events")
            .events;
        assert!(events
            .iter()
            .any(|event| event.message == "Inspecting files."));
        assert!(events.iter().any(|event| event.r#type == "command.started"
            && event.message == "Glob"
            && event.payload["parent_tool_use_id"] == "call-task"));
        assert!(events
            .iter()
            .any(|event| event.r#type == "command.completed"
                && event.payload["traceNoOutput"] == json!(true)));
        assert!(events
            .iter()
            .any(|event| event.message == "Directory is empty."));
    }

    #[test]
    fn cursor_real_result_on_a_later_poll_replaces_synthetic_completion_without_shifting_ids() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "cursor", "s1");
        seed_parent_agent(
            &connection,
            "call-task",
            json!({
                "call_id": "call-task",
                "name": "taskToolCall",
                "input": { "description": "Inspect directory", "agentId": "child-agent" }
            }),
            json!({
                "call_id": "call-task",
                "result": { "success": { "agentId": "child-agent" } }
            }),
        );
        let home = TempDir::new().expect("home");
        let trace_dir = home
            .path()
            .join(".cursor/projects/tmp/agent-transcripts/child-agent");
        fs::create_dir_all(&trace_dir).expect("trace dir");
        let trace_path = trace_dir.join("child-agent.jsonl");
        let running_transcript =
            r#"{"role":"user","message":{"content":[{"type":"text","text":"Inspect"}]}}"#
                .to_string()
                + "\n"
                + r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Checking files."},{"type":"tool_use","id":"tool-1","name":"Read","input":{"target_file":"README.md"}}]}}"#
                + "\n";
        fs::write(&trace_path, &running_transcript).expect("write trace");

        let first =
            import_subagent_trace_events_from_home(&connection, "s1", "call-task", home.path())
                .expect("import");
        assert_eq!(first, 3);
        let events_before = list_session_agent_events(&connection, "s1", "call-task")
            .expect("agent events")
            .events;
        let synthetic = events_before
            .iter()
            .find(|event| {
                event.r#type == "command.completed" && event.payload["id"] == json!("tool-1")
            })
            .expect("synthetic completion");
        assert_eq!(synthetic.payload["traceNoOutput"], json!(true));
        let ids_before = trace_event_ids_for_child(&connection, "call-task", "child-agent");

        fs::write(
            &trace_path,
            running_transcript
                + r#"{"role":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"README contents"}]}}"#
                + "\n"
                + r#"{"role":"assistant","message":{"content":[{"type":"text","text":"README read."}]}}"#
                + "\n",
        )
        .expect("grow trace");

        let second =
            import_subagent_trace_events_from_home(&connection, "s1", "call-task", home.path())
                .expect("reimport");
        assert_eq!(second, 2);
        let events_after = list_session_agent_events(&connection, "s1", "call-task")
            .expect("agent events")
            .events;
        let completions = events_after
            .iter()
            .filter(|event| {
                event.r#type == "command.completed" && event.payload["id"] == json!("tool-1")
            })
            .collect::<Vec<_>>();
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].id, synthetic.id);
        assert_eq!(completions[0].payload["content"], json!("README contents"));
        assert_eq!(completions[0].payload["traceNoOutput"], Value::Null);
        let ids_after = trace_event_ids_for_child(&connection, "call-task", "child-agent");
        assert!(ids_before.iter().all(|id| ids_after.contains(id)));
        assert_eq!(
            events_after
                .iter()
                .filter(|event| event.message == "README read.")
                .count(),
            1
        );

        let third =
            import_subagent_trace_events_from_home(&connection, "s1", "call-task", home.path())
                .expect("reimport again");
        assert_eq!(third, 0);
    }

    #[test]
    fn cursor_running_child_transcript_imports_by_prompt_without_agent_id() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "cursor", "s1");
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "parent-start".to_string(),
                session_id: "s1".to_string(),
                r#type: "command.started".to_string(),
                message: "taskToolCall".to_string(),
                payload: json!({
                    "call_id": "call-task",
                    "name": "taskToolCall",
                    "input": {
                        "description": "Summarize docs",
                        "prompt": "Inspect the renderer files."
                    }
                }),
                created_at: Some("2026-07-08T14:46:49.000Z".to_string()),
            },
        )
        .expect("start");
        let home = TempDir::new().expect("home");
        let trace_dir = home
            .path()
            .join(".cursor/projects/tmp-repo/agent-transcripts/running-child");
        fs::create_dir_all(&trace_dir).expect("trace dir");
        fs::write(
            trace_dir.join("running-child.jsonl"),
            r#"{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Inspect the renderer files.</user_query>"}]}}"#
                .to_string()
                + "\n"
                + r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Reading renderer files."},{"type":"tool_use","name":"Read","input":{"target_file":"src/renderer/App.tsx"}}]}}"#
                + "\n",
        )
        .expect("write trace");

        let first =
            import_subagent_trace_events_from_home(&connection, "s1", "call-task", home.path())
                .expect("import");
        let second =
            import_subagent_trace_events_from_home(&connection, "s1", "call-task", home.path())
                .expect("reimport");
        assert_eq!(first, 3);
        assert_eq!(second, 0);
        let events = list_session_agent_events(&connection, "s1", "call-task")
            .expect("agent events")
            .events;
        assert!(events
            .iter()
            .any(|event| event.message == "Reading renderer files."
                && event.payload["providerChildSessionId"] == "running-child"));
        assert!(events.iter().any(|event| event.r#type == "command.started"
            && event.message == "Read"
            && event.payload["parent_tool_use_id"] == "call-task"));
    }

    fn seed_session(connection: &Connection, provider: &str, session_id: &str) {
        persist_project(
            connection,
            &PersistProjectInput {
                id: "p1".to_string(),
                name: "Project".to_string(),
                repo_path: format!("/tmp/repo-{provider}-{session_id}"),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    default_provider: provider.to_string(),
                    default_model_label: "Model".to_string(),
                    worktree_location: "/tmp/worktrees".to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("project");
        persist_workspace(
            connection,
            &PersistWorkspaceInput {
                id: "w1".to_string(),
                project_id: "p1".to_string(),
                task_label: "Task".to_string(),
                branch: "branch".to_string(),
                base_ref: "main".to_string(),
                path: "/tmp/repo".to_string(),
                state: "running".to_string(),
                shared_workspace: false,
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("workspace");
        persist_session(
            connection,
            &PersistSessionInput {
                id: session_id.to_string(),
                workspace_id: "w1".to_string(),
                provider: provider.to_string(),
                model_label: "Model".to_string(),
                model_id: "model".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "Prompt".to_string(),
                state: "running".to_string(),
                attention: "none".to_string(),
            },
        )
        .expect("session");
    }

    fn seed_parent_agent(
        connection: &Connection,
        parent_tool_use_id: &str,
        start_payload: Value,
        completion_payload: Value,
    ) {
        persist_timeline_event(
            connection,
            &PersistTimelineEventInput {
                id: "parent-start".to_string(),
                session_id: "s1".to_string(),
                r#type: "command.started".to_string(),
                message: "agent".to_string(),
                payload: start_payload,
                created_at: Some("2026-07-08T14:46:49.000Z".to_string()),
            },
        )
        .expect("start");
        persist_timeline_event(
            connection,
            &PersistTimelineEventInput {
                id: "parent-complete".to_string(),
                session_id: "s1".to_string(),
                r#type: "command.completed".to_string(),
                message: "agent complete".to_string(),
                payload: completion_payload,
                created_at: Some("2026-07-08T14:47:01.000Z".to_string()),
            },
        )
        .expect(parent_tool_use_id);
    }

    fn trace_event_ids_for_child(
        connection: &Connection,
        parent_tool_use_id: &str,
        child_id: &str,
    ) -> Vec<String> {
        list_session_agent_events(connection, "s1", parent_tool_use_id)
            .expect("agent events")
            .events
            .into_iter()
            .filter(|event| {
                event.payload["providerChildSessionId"] == json!(child_id)
                    && event.payload["traceImported"] == json!(true)
            })
            .map(|event| event.id)
            .collect()
    }
}
