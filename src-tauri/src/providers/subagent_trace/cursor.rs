use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Component,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, Utc};
use serde_json::{Map, Value};
use walkdir::WalkDir;

use super::cache::{trace_file_step, TraceFileStep};
use super::shared::{
    is_duplicate_text, is_path_safe_agent_id, push_unique, read_trace_lines, stamp_trace_payload,
    trace_event, value_at_path, TraceFileLines,
};
use super::{AgentTraceContext, CursorTraceFile, TraceImport, TraceLine};
use crate::providers::normalizer::JSON_PARSE_LINE_CAP;

pub(super) fn cursor_trace_events(home: &Path, context: &AgentTraceContext) -> TraceImport {
    let mut events = Vec::new();
    let mut stamps = Vec::new();
    for trace_file in find_cursor_trace_files(home, context) {
        let child_id = trace_file.child_id.as_str();
        let key = context.trace_file_key(trace_file.path);
        let stamp = match trace_file_step(&key) {
            TraceFileStep::UpToDate => continue,
            TraceFileStep::Read(stamp) => stamp,
        };
        let source = key.path.to_string_lossy().into_owned();
        let lines = read_trace_lines(&key.path);
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
        if let Some(stamp) = stamp {
            stamps.push((key, stamp));
        }
    }
    TraceImport { events, stamps }
}

fn find_cursor_trace_files(home: &Path, context: &AgentTraceContext) -> Vec<CursorTraceFile> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut resolved_by_id: HashSet<&str> = HashSet::new();
    for child_id in &context.child_ids {
        for path in find_cursor_trace_files_by_id(home, context.workspace_path.as_deref(), child_id)
        {
            resolved_by_id.insert(child_id.as_str());
            push_cursor_trace_file(&mut files, &mut seen, child_id.to_string(), path);
        }
    }
    // The prompt walk crawls every `~/.cursor/projects` root and reads the head
    // of every transcript under it; the agent pane re-resolves on a 1.5 s poll,
    // so it only runs when an id is still unaccounted for.
    if !context.child_ids.is_empty()
        && context
            .child_ids
            .iter()
            .all(|child_id| resolved_by_id.contains(child_id.as_str()))
    {
        return files;
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
    if !is_path_safe_agent_id(child_agent_id) {
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

/// The opening prompt of a Cursor transcript. Streamed and stopped at the first
/// user row: the prompt match runs over every transcript in every project root,
/// and reading whole multi-MB files to look at their first few lines was the
/// bulk of that walk.
fn cursor_first_user_text(path: &Path) -> Option<String> {
    for line in TraceFileLines::open(path)? {
        let line = line.trim();
        if line.is_empty() || line.len() > JSON_PARSE_LINE_CAP {
            continue;
        }
        let Ok(Value::Object(object)) = serde_json::from_str::<Value>(line) else {
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

pub(super) fn cursor_child_agent_ids(payload: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for path in [["result", "success", "agentId"].as_slice()] {
        if let Some(id) = value_at_path(payload, path)
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            push_unique(&mut ids, id.to_string());
        }
    }
    ids
}

pub(super) fn cursor_task_prompt(payload: &Value) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::super::{import_subagent_trace_events_from_home, TraceProvider};
    use super::*;
    use crate::persistence::{
        database::Database,
        events::{list_session_agent_events, persist_timeline_event, PersistTimelineEventInput},
    };
    use serde_json::json;
    use tempfile::TempDir;

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

    #[test]
    fn cursor_trace_lookup_skips_the_prompt_walk_once_every_child_id_resolved() {
        let home = TempDir::new().expect("home");
        let transcripts = home
            .path()
            .join(".cursor/projects/tmp-repo/agent-transcripts");
        let user_row =
            r#"{"role":"user","message":{"content":[{"type":"text","text":"Inspect the renderer files."}]}}"#
                .to_string()
                + "\n";
        for child in ["child-1", "unrelated-child"] {
            fs::create_dir_all(transcripts.join(child)).expect("trace dir");
            fs::write(
                transcripts.join(child).join(format!("{child}.jsonl")),
                &user_row,
            )
            .expect("write trace");
        }

        let context = |child_ids: Vec<String>| AgentTraceContext {
            provider: TraceProvider::Cursor,
            session_id: "s1".to_string(),
            parent_tool_use_id: "call-task".to_string(),
            parent_created_at: "2026-07-08T14:46:49.000Z".to_string(),
            provider_conversation_id: None,
            workspace_path: None,
            cursor_prompt: Some("Inspect the renderer files.".to_string()),
            child_ids,
            codex_runs: Vec::new(),
        };

        // Both transcripts match the prompt, so the walk would pick one of them
        // up; with the id already resolved it must not run at all.
        let resolved = find_cursor_trace_files(home.path(), &context(vec!["child-1".to_string()]));
        assert_eq!(
            resolved
                .iter()
                .map(|file| file.child_id.as_str())
                .collect::<Vec<_>>(),
            vec!["child-1"]
        );

        // With no id to resolve, the prompt is still the only way in.
        assert!(!find_cursor_trace_files(home.path(), &context(Vec::new())).is_empty());
    }
}
