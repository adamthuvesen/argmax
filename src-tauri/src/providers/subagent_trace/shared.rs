use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, Utc};
use serde_json::{Map, Value};

use super::{AgentTraceContext, TraceLine, TraceProvider};
use crate::persistence::events::PersistTimelineEventInput;
use crate::providers::normalizer::JSON_PARSE_LINE_CAP;

/// The lines of a trace file, with unreadable ones skipped instead of
/// truncating the file. `BufRead::lines` yields an error for a line that is not
/// valid UTF-8, and stopping at the first one silently drops every later line —
/// one mangled byte would hide the rest of a child's transcript. Only
/// `InvalidData` is skipped, because that is the invalid-UTF-8 case and the
/// reader has already moved past the line; any other IO error may not advance,
/// so it ends the read. Skipped lines are counted and reported once, on drop.
pub(super) struct TraceFileLines {
    lines: std::io::Lines<BufReader<fs::File>>,
    path: PathBuf,
    skipped: usize,
}

impl TraceFileLines {
    pub(super) fn open(path: &Path) -> Option<Self> {
        let file = fs::File::open(path).ok()?;
        Some(Self {
            lines: BufReader::new(file).lines(),
            path: path.to_path_buf(),
            skipped: 0,
        })
    }
}

impl Iterator for TraceFileLines {
    type Item = String;

    fn next(&mut self) -> Option<String> {
        loop {
            match self.lines.next()? {
                Ok(line) => return Some(line),
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                    self.skipped += 1;
                }
                Err(_) => return None,
            }
        }
    }
}

impl Drop for TraceFileLines {
    fn drop(&mut self) {
        if self.skipped > 0 {
            tracing::warn!(
                path = %self.path.display(),
                skipped = self.skipped,
                "skipped unreadable lines in a subagent trace file"
            );
        }
    }
}

pub(super) fn read_trace_lines(path: &Path) -> Vec<TraceLine> {
    let Some(lines) = TraceFileLines::open(path) else {
        return Vec::new();
    };
    lines
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

pub(super) fn stamp_trace_payload(
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

pub(super) fn trace_event(
    context: &AgentTraceContext,
    child_id: &str,
    sequence: usize,
    event_type: &str,
    message: impl Into<String>,
    payload: Map<String, Value>,
    source_timestamp: Option<String>,
) -> PersistTimelineEventInput {
    PersistTimelineEventInput {
        id: trace_event_id(
            context.provider,
            &context.session_id,
            &context.parent_tool_use_id,
            child_id,
            sequence,
            event_type,
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

/// Imported rows are addressed by where they came from, not by insertion
/// order, so re-reading a grown transcript rewrites nothing and reparenting a
/// child under its real launch row can recompute the destination id exactly.
pub(super) fn trace_event_id(
    provider: TraceProvider,
    session_id: &str,
    parent_tool_use_id: &str,
    child_id: &str,
    sequence: usize,
    event_type: &str,
) -> String {
    format!(
        "trace:{}:{session_id}:{parent_tool_use_id}:{child_id}:{sequence}:{event_type}",
        provider.as_str()
    )
}

pub(super) fn fallback_timestamp(parent_created_at: &str, sequence: usize) -> String {
    DateTime::parse_from_rfc3339(parent_created_at)
        .map(|time| {
            (time.with_timezone(&Utc) + Duration::milliseconds(sequence as i64 + 1))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .unwrap_or_else(|_| parent_created_at.to_string())
}

pub(super) fn is_spawn_agent_payload(payload: &Value) -> bool {
    payload
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| payload.get("type").and_then(Value::as_str))
        == Some("spawn_agent")
}

pub(super) fn receiver_thread_ids(payload: &Value) -> Vec<String> {
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

pub(super) fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.as_object()?.get(*key)?;
    }
    Some(current)
}

/// Agent and session ids come from provider JSON payloads — and, for Grok,
/// from free text scraped out of a launch receipt — and are joined into paths
/// under the provider's own session store. Never let one carry a path
/// separator or `..`.
pub(super) fn is_path_safe_agent_id(agent_id: &str) -> bool {
    !agent_id.is_empty()
        && agent_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

pub(super) fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

pub(super) fn is_duplicate_text(seen: &mut HashSet<String>, text: &str) -> bool {
    let normalized = text.trim().replace(char::is_whitespace, " ");
    !seen.insert(normalized)
}
