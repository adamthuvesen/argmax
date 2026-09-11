use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value};

use super::cache::{trace_file_step, TraceFileStep};
use super::shared::{
    is_path_safe_agent_id, push_unique, read_trace_lines, stamp_trace_payload, trace_event,
};
use super::{AgentTraceContext, TraceImport, TraceLine};
use crate::persistence::events::PersistTimelineEventInput;
use crate::providers::grok_trust::grok_home;

pub(super) fn grok_trace_events(home: &Path, context: &AgentTraceContext) -> TraceImport {
    let mut import = TraceImport {
        events: Vec::new(),
        stamps: Vec::new(),
    };
    let mut child_ids = context.child_ids.clone();
    if child_ids.is_empty() {
        child_ids = list_grok_subagent_ids(home, context);
    }
    for child_id in child_ids {
        let Some(path) = grok_child_history_path(home, context, &child_id) else {
            continue;
        };
        let key = context.trace_file_key(path);
        let stamp = match trace_file_step(&key) {
            TraceFileStep::UpToDate => continue,
            TraceFileStep::Read(stamp) => stamp,
        };
        let lines = read_trace_lines(&key.path);
        import
            .events
            .extend(grok_child_events(context, &child_id, &key.path, &lines));
        if let Some(stamp) = stamp {
            import.stamps.push((key, stamp));
        }
    }
    import
}

fn grok_child_events(
    context: &AgentTraceContext,
    child_id: &str,
    path: &Path,
    lines: &[TraceLine],
) -> Vec<PersistTimelineEventInput> {
    let source = path.to_string_lossy().into_owned();
    let mut events = Vec::new();
    let mut sequence = 0;
    let mut run_model = grok_run_model(path);
    for line in lines {
        let Some(object) = line.value.as_object() else {
            continue;
        };
        run_model.absorb(object);
        for (kind, message, mut payload) in grok_history_events(object) {
            let event_sequence = sequence;
            sequence += 1;
            // Same fallback rule as the Codex loop: a history row with no tool
            // id still needs one, and it has to carry the child and sequence to
            // stay unique across the session's tool-call map.
            if matches!(kind, "command.started" | "command.completed")
                && !payload.contains_key("id")
            {
                let id = Value::String(format!("trace-grok-tool-{child_id}-{event_sequence}"));
                if kind == "command.completed" {
                    payload.insert("tool_use_id".to_string(), id.clone());
                }
                payload.insert("id".to_string(), id);
            }
            stamp_trace_payload(&mut payload, context, child_id, &source, event_sequence);
            run_model.stamp(&mut payload);
            events.push(trace_event(
                context,
                child_id,
                event_sequence,
                kind,
                message,
                payload,
                line.timestamp.clone(),
            ));
        }
    }
    events
}

#[derive(Debug, Clone, Default)]
struct GrokRunModel {
    model_id: Option<String>,
    reasoning_effort: Option<String>,
}

impl GrokRunModel {
    fn absorb(&mut self, object: &Map<String, Value>) {
        if object.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        if let Some(model_id) = object.get("model_id").and_then(Value::as_str) {
            if !model_id.is_empty() {
                self.model_id = Some(model_id.to_string());
            }
        }
        if let Some(effort) = object.get("reasoning_effort").and_then(Value::as_str) {
            if !effort.is_empty() {
                self.reasoning_effort = Some(effort.to_string());
            }
        }
    }

    fn stamp(&self, payload: &mut Map<String, Value>) {
        if let Some(model_id) = &self.model_id {
            payload.insert("agentModelId".to_string(), Value::String(model_id.clone()));
        }
        if let Some(effort) = &self.reasoning_effort {
            payload.insert(
                "agentReasoningEffort".to_string(),
                Value::String(effort.clone()),
            );
        }
    }
}

fn grok_run_model(history_path: &Path) -> GrokRunModel {
    let mut model = GrokRunModel::default();
    let summary_path = history_path
        .parent()
        .map(|parent| parent.join("summary.json"));
    let Some(summary_path) = summary_path else {
        return model;
    };
    let Ok(text) = fs::read_to_string(&summary_path) else {
        return model;
    };
    let Ok(Value::Object(summary)) = serde_json::from_str::<Value>(&text) else {
        return model;
    };
    if let Some(model_id) = summary.get("current_model_id").and_then(Value::as_str) {
        if !model_id.is_empty() {
            model.model_id = Some(model_id.to_string());
        }
    }
    if let Some(effort) = summary.get("reasoning_effort").and_then(Value::as_str) {
        if !effort.is_empty() {
            model.reasoning_effort = Some(effort.to_string());
        }
    }
    model
}

fn grok_history_events(
    object: &Map<String, Value>,
) -> Vec<(&'static str, String, Map<String, Value>)> {
    match object.get("type").and_then(Value::as_str) {
        Some("reasoning") => grok_reasoning_text(object)
            .map(|text| {
                let mut payload = Map::new();
                payload.insert("thinking".to_string(), Value::Bool(true));
                vec![("message.delta", text, payload)]
            })
            .unwrap_or_default(),
        Some("assistant") => {
            let mut events = Vec::new();
            if let Some(text) = grok_assistant_text(object) {
                events.push(("message.completed", text, Map::new()));
            }
            if let Some(Value::Array(calls)) = object.get("tool_calls") {
                for call in calls {
                    let Some(call) = call.as_object() else {
                        continue;
                    };
                    let tool_id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty());
                    let tool_name = call
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty())
                        .unwrap_or("tool")
                        .to_string();
                    let mut payload = Map::new();
                    if let Some(tool_id) = tool_id {
                        payload.insert("id".to_string(), Value::String(tool_id.to_string()));
                    }
                    payload.insert("name".to_string(), Value::String(tool_name.clone()));
                    payload.insert("type".to_string(), Value::String(tool_name.clone()));
                    payload.insert(
                        "input".to_string(),
                        Value::Object(grok_tool_arguments(call)),
                    );
                    events.push(("command.started", tool_name, payload));
                }
            }
            events
        }
        Some("tool_result") => {
            let tool_id = object
                .get("tool_call_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty());
            let content = grok_tool_result_content(object);
            let mut payload = Map::new();
            if let Some(tool_id) = tool_id {
                payload.insert("id".to_string(), Value::String(tool_id.to_string()));
                payload.insert(
                    "tool_use_id".to_string(),
                    Value::String(tool_id.to_string()),
                );
            }
            if let Some(content) = content {
                payload.insert("content".to_string(), Value::String(content));
            }
            vec![("command.completed", "tool_result".to_string(), payload)]
        }
        _ => Vec::new(),
    }
}

fn grok_reasoning_text(object: &Map<String, Value>) -> Option<String> {
    let text = object
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

fn grok_assistant_text(object: &Map<String, Value>) -> Option<String> {
    let text = object.get("content").and_then(Value::as_str)?.trim();
    (!text.is_empty()).then_some(text.to_string())
}

fn grok_tool_arguments(call: &Map<String, Value>) -> Map<String, Value> {
    match call.get("arguments") {
        Some(Value::Object(object)) => object.clone(),
        Some(Value::String(text)) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(object)) => object,
            _ => {
                let mut out = Map::new();
                out.insert("arguments".to_string(), Value::String(text.clone()));
                out
            }
        },
        _ => Map::new(),
    }
}

fn grok_tool_result_content(object: &Map<String, Value>) -> Option<String> {
    match object.get("content") {
        Some(Value::String(text)) => Some(unwrap_grok_text_envelope(text)),
        Some(Value::Array(blocks)) => {
            let text = blocks
                .iter()
                .filter_map(|block| {
                    block
                        .as_object()
                        .and_then(|block| block.get("text"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn unwrap_grok_text_envelope(output: &str) -> String {
    let trimmed = output.trim();
    let Ok(Value::Object(envelope)) = serde_json::from_str::<Value>(trimmed) else {
        return output.to_string();
    };
    let type_ok = matches!(
        envelope.get("type").and_then(Value::as_str),
        Some("Text" | "text")
    );
    let Some(text) = envelope.get("text").and_then(Value::as_str) else {
        return output.to_string();
    };
    let extra = envelope.keys().any(|key| key != "type" && key != "text");
    if type_ok && !extra {
        text.to_string()
    } else {
        output.to_string()
    }
}

fn grok_child_history_path(
    home: &Path,
    context: &AgentTraceContext,
    child_id: &str,
) -> Option<PathBuf> {
    if !is_path_safe_agent_id(child_id) {
        tracing::warn!(
            child_id,
            "rejected grok child id with unsafe path characters"
        );
        return None;
    }
    let cwd = context.workspace_path.as_deref()?;
    let path = grok_session_dir(home, cwd, child_id).join("chat_history.jsonl");
    path.is_file().then_some(path)
}

/// Callers must have run `session_id` past [`is_path_safe_agent_id`]: it is
/// joined straight into the session store's path.
fn grok_session_dir(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    grok_home(home)
        .join("sessions")
        .join(grok_percent_encode(cwd))
        .join(session_id)
}

fn list_grok_subagent_ids(home: &Path, context: &AgentTraceContext) -> Vec<String> {
    let Some(cwd) = context.workspace_path.as_deref() else {
        return Vec::new();
    };
    let Some(parent_id) = context.provider_conversation_id.as_deref() else {
        return Vec::new();
    };
    if !is_path_safe_agent_id(parent_id) {
        tracing::warn!(
            parent_id,
            "rejected grok parent session id with unsafe path characters"
        );
        return Vec::new();
    }
    let dir = grok_session_dir(home, cwd, parent_id).join("subagents");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let meta_path = entry.path().join("meta.json");
        if let Ok(text) = fs::read_to_string(&meta_path) {
            if let Ok(Value::Object(meta)) = serde_json::from_str::<Value>(&text) {
                if let Some(id) = meta
                    .get("child_session_id")
                    .or_else(|| meta.get("subagent_id"))
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    push_unique(&mut ids, id.to_string());
                    continue;
                }
            }
        }
        if let Some(name) = entry.file_name().to_str().filter(|name| !name.is_empty()) {
            push_unique(&mut ids, name.to_string());
        }
    }
    ids
}

fn grok_percent_encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len() * 3);
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub(super) fn grok_child_ids(payload: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for value in [
        payload.get("content"),
        payload.get("output"),
        payload.get("text"),
    ] {
        match value {
            Some(Value::String(text)) => grok_collect_subagent_ids(text, &mut ids),
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    if let Some(text) = block
                        .as_object()
                        .and_then(|block| block.get("text"))
                        .and_then(Value::as_str)
                    {
                        grok_collect_subagent_ids(text, &mut ids);
                    }
                }
            }
            _ => {}
        }
    }
    ids
}

fn grok_collect_subagent_ids(text: &str, ids: &mut Vec<String>) {
    let unwrapped = unwrap_grok_text_envelope(text);
    let mut rest = unwrapped.as_str();
    while let Some(index) = rest.find("subagent_id:") {
        rest = rest[index + "subagent_id:".len()..].trim_start();
        let id = rest
            .split(|ch: char| ch.is_whitespace() || ch == '"' || ch == ',')
            .next()
            .unwrap_or("")
            .trim();
        if !id.is_empty() {
            push_unique(ids, id.to_string());
        }
        rest = rest.get(id.len()..).unwrap_or("");
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::super::{import_subagent_trace_events_from_home, TraceProvider};
    use super::*;
    use crate::persistence::{
        database::Database, events::list_session_agent_events,
        sessions::update_session_provider_conversation_id,
    };
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn grok_percent_encode_matches_cli_session_dirs() {
        assert_eq!(
            grok_percent_encode(
                "/Users/adamthuvesen/dev/menti/argmax/.argmax/worktrees/argmax-if-i-have-argmax-open-i-take-a-screenshot--9b2cb5f69c6e45d5"
            ),
            "%2FUsers%2Fadamthuvesen%2Fdev%2Fmenti%2Fargmax%2F.argmax%2Fworktrees%2Fargmax-if-i-have-argmax-open-i-take-a-screenshot--9b2cb5f69c6e45d5"
        );
        assert_eq!(
            grok_percent_encode("/Users/a/Library/Application Support/com.argmax.rs"),
            "%2FUsers%2Fa%2FLibrary%2FApplication%20Support%2Fcom.argmax.rs"
        );
    }

    #[test]
    fn grok_child_ids_unwrap_the_text_envelope() {
        let ids = grok_child_ids(&json!({
            "content": {
                "ignored": true
            }
        }));
        assert!(ids.is_empty());
        let ids = grok_child_ids(&json!({
            "content": "{\"type\":\"Text\",\"text\":\"Subagent started in background.\\nsubagent_id: 01a07579-bad6-7b31-b248-8aa103ee10a8\\ntype: reviewer\"}"
        }));
        assert_eq!(ids, vec!["01a07579-bad6-7b31-b248-8aa103ee10a8"]);
    }

    #[test]
    fn grok_child_transcript_imports_text_and_tool_rows() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "grok", "s1");
        seed_parent_agent(
            &connection,
            "call-spawn",
            json!({
                "id": "call-spawn",
                "name": "spawn_subagent",
                "input": {
                    "description": "Review screenshot drop fix",
                    "subagent_type": "reviewer",
                    "prompt": "Review the diff."
                }
            }),
            json!({
                "tool_use_id": "call-spawn",
                "content": "{\"type\":\"Text\",\"text\":\"Subagent started in background.\\nsubagent_id: child-agent\\ntype: reviewer\\ndescription: Review screenshot drop fix\"}"
            }),
        );
        let home = TempDir::new().expect("home");
        let trace_dir = home
            .path()
            .join(".grok/sessions")
            .join(grok_percent_encode("/tmp/repo"))
            .join("child-agent");
        fs::create_dir_all(&trace_dir).expect("trace dir");
        fs::write(
            trace_dir.join("summary.json"),
            r#"{"current_model_id":"grok-4.6","reasoning_effort":"high"}"#,
        )
        .expect("summary");
        fs::write(
            trace_dir.join("chat_history.jsonl"),
            r#"{"type":"user","content":[{"type":"text","text":"Review the diff."}]}"#.to_string()
                + "\n"
                + r#"{"type":"reasoning","summary":[{"type":"summary_text","text":"I will read the files."}]}"#
                + "\n"
                + r#"{"type":"assistant","content":"Inspecting the change.","tool_calls":[{"id":"call-1","name":"read_file","arguments":"{\"target_file\":\"src/foo.ts\"}"}],"model_id":"grok-4.6","reasoning_effort":"high"}"#
                + "\n"
                + r#"{"type":"tool_result","tool_call_id":"call-1","content":"export const foo = 1;"}"#
                + "\n"
                + r#"{"type":"assistant","content":"The change looks correct.","model_id":"grok-4.6","reasoning_effort":"high"}"#
                + "\n",
        )
        .expect("write trace");

        let inserted =
            import_subagent_trace_events_from_home(&connection, "s1", "call-spawn", home.path())
                .expect("import");
        assert_eq!(inserted, 5);
        let events = list_session_agent_events(&connection, "s1", "call-spawn")
            .expect("agent events")
            .events;
        assert!(events.iter().any(|event| {
            event.r#type == "message.delta"
                && event.message == "I will read the files."
                && event.payload["thinking"] == json!(true)
        }));
        assert!(events
            .iter()
            .any(|event| event.r#type == "message.completed"
                && event.message == "Inspecting the change."));
        assert!(events.iter().any(|event| event.r#type == "command.started"
            && event.message == "read_file"
            && event.payload["parent_tool_use_id"] == "call-spawn"
            && event.payload["input"]["target_file"] == "src/foo.ts"));
        assert!(events.iter().any(|event| {
            event.r#type == "command.completed"
                && event.payload["content"] == "export const foo = 1;"
        }));
        assert!(events.iter().any(|event| {
            event.message == "The change looks correct."
                && event.payload["agentModelId"] == "grok-4.6"
                && event.payload["agentReasoningEffort"] == "high"
        }));
    }

    #[test]
    fn grok_child_ids_recover_from_the_parent_subagents_dir() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "grok", "s1");
        update_session_provider_conversation_id(&connection, "s1", "parent-session")
            .expect("provider id");
        seed_parent_agent(
            &connection,
            "call-spawn",
            json!({
                "id": "call-spawn",
                "name": "spawn_subagent",
                "input": { "description": "Review screenshot drop fix" }
            }),
            json!({
                "tool_use_id": "call-spawn",
                "content": "spawned"
            }),
        );
        let home = TempDir::new().expect("home");
        let encoded = grok_percent_encode("/tmp/repo");
        let parent_dir = home
            .path()
            .join(".grok/sessions")
            .join(&encoded)
            .join("parent-session");
        fs::create_dir_all(parent_dir.join("subagents/child-from-meta")).expect("parent subagents");
        fs::write(
            parent_dir.join("subagents/child-from-meta/meta.json"),
            r#"{"child_session_id":"child-from-meta","parent_session_id":"parent-session"}"#,
        )
        .expect("meta");
        let child_dir = home
            .path()
            .join(".grok/sessions")
            .join(&encoded)
            .join("child-from-meta");
        fs::create_dir_all(&child_dir).expect("child dir");
        fs::write(
            child_dir.join("chat_history.jsonl"),
            r#"{"type":"assistant","content":"Recovered from disk."}"#,
        )
        .expect("history");

        let inserted =
            import_subagent_trace_events_from_home(&connection, "s1", "call-spawn", home.path())
                .expect("import");
        assert_eq!(inserted, 1);
        let events = list_session_agent_events(&connection, "s1", "call-spawn")
            .expect("agent events")
            .events;
        assert!(events
            .iter()
            .any(|event| event.message == "Recovered from disk."));
    }

    #[test]
    fn grok_child_ids_that_walk_out_of_the_session_store_are_rejected() {
        let home = TempDir::new().expect("home");
        // A transcript above the session store, and the store itself, so the
        // traversal below is a real escape rather than a missing directory.
        let escaped = home.path().join("escaped");
        fs::create_dir_all(&escaped).expect("escaped dir");
        fs::write(
            escaped.join("chat_history.jsonl"),
            r#"{"type":"assistant","content":"Should never be read."}"#,
        )
        .expect("history");
        fs::create_dir_all(
            home.path()
                .join(".grok/sessions")
                .join(grok_percent_encode("/tmp/repo")),
        )
        .expect("session store");

        let context = AgentTraceContext {
            provider: TraceProvider::Grok,
            session_id: "s1".to_string(),
            parent_tool_use_id: "call-spawn".to_string(),
            parent_created_at: "2026-09-06T06:50:53.000Z".to_string(),
            provider_conversation_id: Some("parent-session".to_string()),
            provider_invocation_id: None,
            workspace_path: Some("/tmp/repo".to_string()),
            cursor_prompt: None,
            cursor_background_launch: false,
            child_ids: Vec::new(),
            codex_runs: Vec::new(),
        };

        let escape_id = "../../../escaped";
        assert!(
            grok_session_dir(home.path(), "/tmp/repo", escape_id)
                .join("chat_history.jsonl")
                .is_file(),
            "the traversal target must exist for this test to prove anything"
        );
        for id in [escape_id, "..", "child/nested"] {
            assert!(
                grok_child_history_path(home.path(), &context, id).is_none(),
                "{id} was joined into a session path"
            );
        }
        assert!(is_path_safe_agent_id("child-agent_1"));
    }
}
