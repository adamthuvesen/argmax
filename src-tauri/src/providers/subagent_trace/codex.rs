use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

use chrono::{DateTime, Datelike, Duration, Utc};
use serde_json::{Map, Value};
use walkdir::WalkDir;

use super::cache::{trace_file_step, TraceFileStamp, TraceFileStep};
use super::reconcile::{CodexChildTrace, ReconciliationPlan};
use super::shared::{
    fallback_timestamp, is_duplicate_text, push_unique, read_trace_lines, stamp_trace_payload,
    trace_event, TraceFileLines,
};
use super::{AgentTraceContext, TraceImport, TraceLine};
use crate::{
    persistence::events::PersistTimelineEventInput, providers::normalizer::JSON_PARSE_LINE_CAP,
    util::sync::LockOrRecover,
};

/// What the child thread is running on, read from the rollout's `turn_context`
/// records. A subagent picks its own model and effort, and nothing in the
/// parent's stdout reports them, so the imported rows carry them instead.
#[derive(Debug, Clone, Default)]
struct CodexRunModel {
    model_id: Option<String>,
    reasoning_effort: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct CodexNativeRun {
    pub(super) child_id: String,
    pub(super) parent_conversation_id: String,
    pub(super) root_tool_use_id: String,
    pub(super) run_id: String,
    pub(super) provider_invocation_id: String,
    pub(super) codename: Option<String>,
    pub(super) completed: bool,
}

impl CodexNativeRun {
    pub(super) fn revision_part(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.child_id, self.provider_invocation_id, self.run_id, self.completed
        )
    }
}

impl CodexRunModel {
    fn absorb(&mut self, object: &Map<String, Value>) {
        if object.get("type").and_then(Value::as_str) != Some("turn_context") {
            return;
        }
        let Some(payload) = object.get("payload").and_then(Value::as_object) else {
            return;
        };
        if let Some(model_id) = payload.get("model").and_then(Value::as_str) {
            self.model_id = Some(model_id.to_string());
        }
        if let Some(effort) = payload.get("effort").and_then(Value::as_str) {
            self.reasoning_effort = Some(effort.to_string());
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

pub(super) fn find_codex_child_traces(
    home: &Path,
    plan: &ReconciliationPlan,
) -> Vec<CodexChildTrace> {
    let mut children = Vec::new();
    let mut seen = HashSet::new();
    let roots = codex_trace_roots(
        home,
        &plan.session_started_at,
        &plan.session_last_activity_at,
    );
    let mut seen_roots = HashSet::new();
    for (root, max_depth) in roots {
        if !seen_roots.insert(root.clone()) {
            continue;
        }
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
            if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(meta) = codex_trace_file_meta(path) else {
                continue;
            };
            if meta.parent_thread_id.as_deref() != Some(plan.parent_thread_id.as_str()) {
                continue;
            }
            if !seen.insert(meta.thread_id.clone()) {
                continue;
            }
            children.push(CodexChildTrace {
                path: path.to_path_buf(),
                meta,
            });
        }
    }
    children
}

pub(super) fn codex_trace_events(home: &Path, context: &AgentTraceContext) -> TraceImport {
    let mut import = TraceImport {
        events: Vec::new(),
        stamps: Vec::new(),
    };
    for child_id in &context.child_ids {
        let Some(path) = find_codex_trace_file(
            home,
            child_id,
            context.provider_conversation_id.as_deref(),
            &context.parent_created_at,
        ) else {
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
            .extend(codex_child_events(context, child_id, &key.path, &lines));
        if let Some(stamp) = stamp {
            import.stamps.push((key, stamp));
        }
    }
    import
}

/// Timeline rows for one child rollout, parsed from lines already read.
///
/// Event IDs include the child id, so the sequence must be per child.
/// Otherwise a growing child trace shifts later siblings' IDs and re-imports
/// duplicate rows.
pub(super) fn codex_child_events(
    context: &AgentTraceContext,
    child_id: &str,
    path: &Path,
    lines: &[TraceLine],
) -> Vec<PersistTimelineEventInput> {
    let source = path.to_string_lossy().into_owned();
    let mut events = Vec::new();
    let mut seen_messages = HashSet::new();
    let mut seen_thinking = HashSet::new();
    let mut sequence = 0;
    let mut run_model = CodexRunModel::default();
    let mut turn_ids = Vec::new();
    for line in lines {
        let Some(object) = line.value.as_object() else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) == Some("event_msg")
            && object
                .get("payload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
                == Some("task_started")
        {
            if let Some(turn_id) = codex_trace_turn_id(object) {
                push_unique(&mut turn_ids, turn_id.to_string());
            }
        }
    }
    let child_runs = context
        .codex_runs
        .iter()
        .filter(|run| run.child_id == child_id)
        .collect::<Vec<_>>();
    let runs_by_turn = if turn_ids.len() == child_runs.len() {
        turn_ids
            .iter()
            .zip(child_runs.iter().copied())
            .map(|(turn_id, run)| (turn_id.as_str(), run))
            .collect::<HashMap<_, _>>()
    } else {
        HashMap::new()
    };
    let fallback_run = if turn_ids.len() <= 1 && child_runs.len() == 1 {
        child_runs.first().copied()
    } else {
        None
    };
    let mut current_turn_id = None;
    for line in lines {
        let Some(object) = line.value.as_object() else {
            continue;
        };
        if let Some(turn_id) = codex_trace_turn_id(object) {
            if current_turn_id != Some(turn_id) {
                seen_messages.clear();
                seen_thinking.clear();
                current_turn_id = Some(turn_id);
            }
        }
        let native_run = current_turn_id
            .and_then(|turn_id| runs_by_turn.get(turn_id).copied())
            .or(fallback_run);
        if is_codex_task_complete(object) {
            if let Some(run) = native_run.filter(|run| !run.completed) {
                events.push(codex_trace_completion_event(
                    context,
                    child_id,
                    &source,
                    run,
                    object,
                    line.timestamp.clone(),
                ));
            }
            continue;
        }
        // A rollout opens with `turn_context` and repeats it per turn, so the
        // model and effort are known before the first row they get stamped on.
        run_model.absorb(object);
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
        // A rollout row that carried no call id still needs one, and the
        // renderer keys its tool-call map session-wide, so the fallback carries
        // the child id and this event's sequence — the rule `cursor_tool_id`
        // documents. One constant collided across every fallback in a session.
        if matches!(kind, "command.started" | "command.completed") && !payload.contains_key("id") {
            let id = Value::String(format!("trace-codex-tool-{child_id}-{event_sequence}"));
            payload.insert("call_id".to_string(), id.clone());
            payload.insert("id".to_string(), id);
        }
        stamp_trace_payload(&mut payload, context, child_id, &source, event_sequence);
        if let Some(run) = native_run {
            stamp_codex_native_run(&mut payload, run);
        }
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
    events
}

fn codex_trace_turn_id(object: &Map<String, Value>) -> Option<&str> {
    let payload = object.get("payload")?.as_object()?;
    payload.get("turn_id").and_then(Value::as_str).or_else(|| {
        payload
            .get("internal_chat_message_metadata_passthrough")
            .and_then(Value::as_object)
            .and_then(|metadata| metadata.get("turn_id"))
            .and_then(Value::as_str)
    })
}

fn is_codex_task_complete(object: &Map<String, Value>) -> bool {
    object.get("type").and_then(Value::as_str) == Some("event_msg")
        && object
            .get("payload")
            .and_then(Value::as_object)
            .and_then(|payload| payload.get("type"))
            .and_then(Value::as_str)
            == Some("task_complete")
}

fn stamp_codex_native_run(payload: &mut Map<String, Value>, run: &CodexNativeRun) {
    payload.insert(
        "providerParentConversationId".to_string(),
        Value::String(run.parent_conversation_id.clone()),
    );
    payload.insert(
        "providerChildSessionId".to_string(),
        Value::String(run.child_id.clone()),
    );
    payload.insert(
        "agentRootToolUseId".to_string(),
        Value::String(run.root_tool_use_id.clone()),
    );
    payload.insert("agentRunId".to_string(), Value::String(run.run_id.clone()));
    payload.insert(
        "providerInvocationId".to_string(),
        Value::String(run.provider_invocation_id.clone()),
    );
    if let Some(codename) = &run.codename {
        payload.insert("agentCodename".to_string(), Value::String(codename.clone()));
    }
}

fn codex_trace_completion_event(
    context: &AgentTraceContext,
    child_id: &str,
    source: &str,
    run: &CodexNativeRun,
    object: &Map<String, Value>,
    created_at: Option<String>,
) -> PersistTimelineEventInput {
    let payload = object.get("payload").and_then(Value::as_object);
    let message = payload
        .and_then(|payload| payload.get("last_agent_message"))
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("Agent completed")
        .to_string();
    let mut stamped = Map::new();
    stamp_trace_payload(&mut stamped, context, child_id, source, usize::MAX);
    stamp_codex_native_run(&mut stamped, run);
    stamped.insert("status".to_string(), Value::String("completed".to_string()));
    PersistTimelineEventInput {
        id: format!(
            "trace-codex-agent-completed-{}-{}-{}-{}",
            context.session_id, child_id, run.provider_invocation_id, run.run_id
        ),
        session_id: context.session_id.clone(),
        r#type: "agent.completed".to_string(),
        message,
        payload: Value::Object(stamped),
        created_at: Some(
            created_at.unwrap_or_else(|| fallback_timestamp(&context.parent_created_at, 0)),
        ),
    }
}

/// Copy the rollout row's call id onto the timeline payload, leaving both keys
/// unset when the row carried none — [`codex_child_events`] owns the fallback,
/// because only it knows the child and sequence the fallback has to be unique
/// against.
fn insert_codex_call_id(out: &mut Map<String, Value>, payload: &Map<String, Value>) {
    let Some(call_id) = payload
        .get("call_id")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)
        .filter(|call_id| !call_id.is_empty())
    else {
        return;
    };
    out.insert("id".to_string(), Value::String(call_id.to_string()));
    out.insert("call_id".to_string(), Value::String(call_id.to_string()));
}

pub(super) fn codex_trace_event_payload(
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
                let mut out = Map::new();
                insert_codex_call_id(&mut out, payload);
                out.insert("name".to_string(), Value::String(tool_name.clone()));
                out.insert("type".to_string(), Value::String(tool_name.clone()));
                out.insert(
                    "input".to_string(),
                    Value::Object(codex_function_call_input(payload)),
                );
                Some(("command.started", tool_name, out))
            }
            Some("function_call_output") => {
                let mut out = Map::new();
                insert_codex_call_id(&mut out, payload);
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
    for (root, max_depth) in codex_trace_roots(home, parent_created_at, parent_created_at) {
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

/// A session open for months would otherwise walk hundreds of day directories
/// on every poll. Past this span, fall back to the two ends — the days a
/// long-lived session most likely started and last ran a child on.
const MAX_CODEX_TRACE_SPAN_DAYS: i64 = 60;

/// The day directories a child rollout of this session could sit in: every day
/// from `from` to `to` inclusive, padded a day either side for clock skew
/// between the session row and the rollout's own directory name. Pass the same
/// timestamp twice when only one is known.
fn codex_trace_roots(home: &Path, from: &str, to: &str) -> Vec<(PathBuf, usize)> {
    let sessions = home.join(".codex/sessions");
    let archived = home.join(".codex/archived_sessions");
    let (Some(from), Some(to)) = (parse_trace_time(from), parse_trace_time(to)) else {
        return vec![(sessions, usize::MAX), (archived, 1)];
    };
    let (first, last) = if from <= to { (from, to) } else { (to, from) };
    let span = (last.date_naive() - first.date_naive()).num_days();

    let offsets = if span <= MAX_CODEX_TRACE_SPAN_DAYS {
        (-1..=span + 1).collect::<Vec<_>>()
    } else {
        vec![-1, 0, 1, span - 1, span, span + 1]
    };
    let mut roots = Vec::new();
    for offset in offsets {
        let day = first + Duration::days(offset);
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

fn parse_trace_time(timestamp: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn codex_trace_file_matches(
    path: &Path,
    child_thread_id: &str,
    parent_thread_id: Option<&str>,
) -> bool {
    let Some(meta) = codex_trace_file_meta(path) else {
        return false;
    };
    if meta.thread_id != child_thread_id {
        return false;
    }
    match (parent_thread_id, meta.parent_thread_id.as_deref()) {
        (Some(expected), Some(parent)) => parent == expected,
        _ => true,
    }
}

/// The `session_meta` header of a Codex rollout: who the thread is, who
/// spawned it, and whatever the spawn named it.
#[derive(Debug, Clone)]
pub(super) struct CodexTraceMeta {
    pub(super) thread_id: String,
    pub(super) parent_thread_id: Option<String>,
    pub(super) nickname: Option<String>,
    pub(super) role: Option<String>,
    pub(super) task_name: Option<String>,
    pub(super) started_at: Option<String>,
    /// One of Codex's own review threads rather than a subagent the agent
    /// spawned. See [`is_codex_review_thread`].
    pub(super) review_thread: bool,
}

/// Codex runs review threads of its own: the guardian that judges a pending
/// action before it runs, and the reviewer behind `/review`. Each is written as
/// a child rollout naming the parent thread, exactly like a subagent, but
/// nobody spawned it and it carries no task of its own — so it does not belong
/// on the agents list.
///
/// The marker moved between CLI versions: older rollouts only tag the thread
/// through `source.subagent`, newer ones also set `thread_source`.
fn is_codex_review_thread(payload: &Map<String, Value>) -> bool {
    if payload.get("thread_source").and_then(Value::as_str) == Some("guardian_review") {
        return true;
    }
    let kind = payload
        .get("source")
        .and_then(Value::as_object)
        .and_then(|source| source.get("subagent"))
        .and_then(|subagent| match subagent {
            Value::String(kind) => Some(kind.as_str()),
            Value::Object(fields) => fields.get("other").and_then(Value::as_str),
            _ => None,
        });
    matches!(kind, Some("guardian" | "review"))
}

/// Codex writes `session_meta` as the first record of a rollout. Reconciliation
/// reads the header of every rollout in the session's day window, so give up
/// after a few lines rather than scanning a multi-MB transcript that has none.
const CODEX_TRACE_HEADER_LINES: usize = 8;

/// Headers already read, keyed by path with the `(len, modified)` stamp they
/// were read at. `session_meta` is the immutable first record of a rollout, so
/// an unchanged file cannot have a different header. Reconciliation walks up to
/// three day directories plus `archived_sessions` on every sweep, and without
/// this it opened and parsed the head of every rollout in them each time.
///
/// Dropped wholesale past the cap rather than growing for the process lifetime,
/// the same as `IMPORTED_TRACE_FILES`.
static CODEX_TRACE_META: LazyLock<Mutex<HashMap<PathBuf, RememberedCodexMeta>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// A rollout header as it was read, with the file stamp it was read at.
type RememberedCodexMeta = (TraceFileStamp, Option<CodexTraceMeta>);
const MAX_REMEMBERED_CODEX_TRACE_META: usize = 1024;

fn codex_trace_file_meta(path: &Path) -> Option<CodexTraceMeta> {
    let stamp = fs::metadata(path)
        .and_then(|metadata| Ok((metadata.len(), metadata.modified()?)))
        .ok()?;
    if let Some((remembered, meta)) = CODEX_TRACE_META
        .lock_or_recover("codex trace meta")
        .get(path)
    {
        if *remembered == stamp {
            return meta.clone();
        }
    }
    let meta = read_codex_trace_file_meta(path);
    let mut remembered = CODEX_TRACE_META.lock_or_recover("codex trace meta");
    if remembered.len() >= MAX_REMEMBERED_CODEX_TRACE_META {
        remembered.clear();
    }
    remembered.insert(path.to_path_buf(), (stamp, meta.clone()));
    meta
}

fn read_codex_trace_file_meta(path: &Path) -> Option<CodexTraceMeta> {
    for line in TraceFileLines::open(path)?.take(CODEX_TRACE_HEADER_LINES) {
        let line = line.trim();
        if line.is_empty() || line.len() > JSON_PARSE_LINE_CAP {
            continue;
        }
        let Ok(Value::Object(object)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let payload = object.get("payload").and_then(Value::as_object)?;
        let thread_id = payload.get("id").and_then(Value::as_str)?.to_string();
        let thread_spawn = payload
            .get("source")
            .and_then(Value::as_object)
            .and_then(|source| source.get("subagent"))
            .and_then(Value::as_object)
            .and_then(|subagent| subagent.get("thread_spawn"))
            .and_then(Value::as_object);
        let spawn_field = |keys: &[&str]| {
            keys.iter()
                .filter_map(|key| {
                    thread_spawn
                        .and_then(|spawn| spawn.get(*key))
                        .or_else(|| payload.get(*key))
                        .and_then(Value::as_str)
                })
                .map(str::trim)
                .find(|value| !value.is_empty())
                .map(str::to_string)
        };
        return Some(CodexTraceMeta {
            thread_id,
            parent_thread_id: spawn_field(&["parent_thread_id"]),
            nickname: spawn_field(&["nickname", "agent_nickname"]),
            role: spawn_field(&["role", "agent_role"]),
            task_name: spawn_field(&["task_name", "name", "description"]),
            started_at: object
                .get("timestamp")
                .and_then(Value::as_str)
                .filter(|timestamp| !timestamp.is_empty())
                .map(str::to_string),
            review_thread: is_codex_review_thread(payload),
        });
    }
    None
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
    fn codex_child_trace_stamps_the_model_and_effort_the_child_ran_with() {
        // A subagent picks its own model and effort, and nothing in the
        // parent's stdout reports them — only the child rollout's turn_context.
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
                "input": { "prompt": "Inspect directory", "receiver_thread_ids": ["child-thread"] }
            }),
            json!({ "id": "spawn-1", "input": { "receiver_thread_ids": ["child-thread"] } }),
        );
        let home = TempDir::new().expect("home");
        let trace_dir = home.path().join(".codex/sessions/2026/07/08");
        fs::create_dir_all(&trace_dir).expect("trace dir");
        fs::write(
            trace_dir.join("rollout-2026-07-08T16-46-49-child-thread.jsonl"),
            r#"{"timestamp":"2026-07-08T14:46:49.290Z","type":"session_meta","payload":{"id":"child-thread","parent_thread_id":"parent-thread"}}"#
                .to_string()
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:46:49.300Z","type":"turn_context","payload":{"model":"gpt-5.5","effort":"xhigh"}}"#
                + "\n"
                + r#"{"timestamp":"2026-07-08T14:46:58.064Z","type":"event_msg","payload":{"type":"agent_message","message":"Looking around."}}"#
                + "\n",
        )
        .expect("write trace");

        import_subagent_trace_events_from_home(&connection, "s1", "spawn-1", home.path())
            .expect("import");

        let events = list_session_agent_events(&connection, "s1", "spawn-1")
            .expect("agent events")
            .events;
        let message = events
            .iter()
            .find(|event| event.r#type == "message.completed")
            .expect("child message");
        assert_eq!(message.payload["agentModelId"], "gpt-5.5");
        assert_eq!(message.payload["agentReasoningEffort"], "xhigh");
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
    fn codex_trace_turns_keep_their_native_run_boundaries() {
        let run = |run_id: &str, invocation_id: &str| CodexNativeRun {
            child_id: "child-thread".to_string(),
            parent_conversation_id: "parent-thread".to_string(),
            root_tool_use_id: "item_5".to_string(),
            run_id: run_id.to_string(),
            provider_invocation_id: invocation_id.to_string(),
            codename: Some("Scout".to_string()),
            completed: false,
        };
        let context = AgentTraceContext {
            provider: TraceProvider::Codex,
            session_id: "s1".to_string(),
            parent_tool_use_id: "item_5".to_string(),
            parent_created_at: "2026-09-06T06:50:53.000Z".to_string(),
            provider_conversation_id: Some("parent-thread".to_string()),
            provider_invocation_id: None,
            workspace_path: None,
            cursor_prompt: None,
            cursor_background_launch: false,
            child_ids: vec!["child-thread".to_string()],
            codex_runs: vec![run("item_5", "invoke-1"), run("item_3", "invoke-2")],
        };
        let line = |value: Value| TraceLine {
            value,
            timestamp: Some("2026-09-06T06:51:00.000Z".to_string()),
        };
        let lines = vec![
            line(json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}})),
            line(
                json!({"type":"event_msg","payload":{"type":"agent_message","turn_id":"turn-1","message":"First answer"}}),
            ),
            line(
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","last_agent_message":"First answer"}}),
            ),
            line(json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2"}})),
            line(
                json!({"type":"event_msg","payload":{"type":"agent_message","turn_id":"turn-2","message":"Second answer"}}),
            ),
            line(
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-2","last_agent_message":"Second answer"}}),
            ),
        ];

        let events = codex_child_events(
            &context,
            "child-thread",
            Path::new("/tmp/child.jsonl"),
            &lines,
        );
        let first = events
            .iter()
            .find(|event| event.message == "First answer" && event.r#type == "message.completed")
            .expect("first message");
        let second = events
            .iter()
            .find(|event| event.message == "Second answer" && event.r#type == "message.completed")
            .expect("second message");
        assert_eq!(first.payload["agentRunId"], "item_5");
        assert_eq!(first.payload["providerInvocationId"], "invoke-1");
        assert_eq!(second.payload["agentRunId"], "item_3");
        assert_eq!(second.payload["providerInvocationId"], "invoke-2");
        assert_eq!(
            events
                .iter()
                .filter(|event| event.r#type == "agent.completed")
                .count(),
            2
        );
    }

    #[test]
    fn codex_trace_omits_native_identity_when_turn_and_run_counts_disagree() {
        let context = AgentTraceContext {
            provider: TraceProvider::Codex,
            session_id: "s1".to_string(),
            parent_tool_use_id: "item_5".to_string(),
            parent_created_at: "2026-09-06T06:50:53.000Z".to_string(),
            provider_conversation_id: Some("parent-thread".to_string()),
            provider_invocation_id: None,
            workspace_path: None,
            cursor_prompt: None,
            cursor_background_launch: false,
            child_ids: vec!["child-thread".to_string()],
            codex_runs: vec![CodexNativeRun {
                child_id: "child-thread".to_string(),
                parent_conversation_id: "parent-thread".to_string(),
                root_tool_use_id: "item_5".to_string(),
                run_id: "item_3".to_string(),
                provider_invocation_id: "invoke-2".to_string(),
                codename: None,
                completed: false,
            }],
        };
        let lines = ["old", "current"]
            .into_iter()
            .flat_map(|turn| {
                [
                    TraceLine {
                        value: json!({"type":"event_msg","payload":{"type":"task_started","turn_id":turn}}),
                        timestamp: None,
                    },
                    TraceLine {
                        value: json!({"type":"event_msg","payload":{"type":"agent_message","turn_id":turn,"message":format!("{turn} answer")}}),
                        timestamp: None,
                    },
                    TraceLine {
                        value: json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":turn}}),
                        timestamp: None,
                    },
                ]
            })
            .collect::<Vec<_>>();

        let events = codex_child_events(
            &context,
            "child-thread",
            Path::new("/tmp/child.jsonl"),
            &lines,
        );
        assert!(events
            .iter()
            .all(|event| event.payload.get("agentRunId").is_none()));
        assert!(!events.iter().any(|event| event.r#type == "agent.completed"));
    }

    #[test]
    fn an_unchanged_codex_rollout_header_is_not_re_read() {
        let dir = TempDir::new().expect("dir");
        let path = dir.path().join("rollout-child.jsonl");
        let header = |id: &str| {
            format!(
                r#"{{"timestamp":"2026-07-08T14:46:49.290Z","type":"session_meta","payload":{{"id":"{id}","parent_thread_id":"parent-thread"}}}}"#
            ) + "\n"
        };
        fs::write(&path, header("child-aaa")).expect("write rollout");
        let modified = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .expect("modified");
        assert_eq!(
            codex_trace_file_meta(&path).expect("meta").thread_id,
            "child-aaa"
        );

        // Same byte length, same mtime: re-reading the file is the only way to
        // see the new id, so the old one coming back proves it was not re-read.
        fs::write(&path, header("child-bbb")).expect("rewrite rollout");
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open rollout")
            .set_modified(modified)
            .expect("restore mtime");
        assert_eq!(
            codex_trace_file_meta(&path).expect("meta").thread_id,
            "child-aaa"
        );

        // A file that actually moved is read again.
        fs::write(&path, header("child-bbb") + "{}\n").expect("grow rollout");
        assert_eq!(
            codex_trace_file_meta(&path).expect("meta").thread_id,
            "child-bbb"
        );
    }

    #[test]
    fn codex_trace_roots_span_every_day_between_the_two_timestamps() {
        let home = TempDir::new().expect("home");
        let sessions = home.path().join(".codex/sessions");
        let days = |roots: &[(PathBuf, usize)]| {
            roots
                .iter()
                .filter_map(|(root, _)| root.strip_prefix(&sessions).ok())
                .map(|day| day.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };

        let roots = codex_trace_roots(
            home.path(),
            "2026-09-01T09:00:00.000Z",
            "2026-09-05T09:00:00.000Z",
        );
        assert_eq!(
            days(&roots),
            vec![
                "2026/08/31",
                "2026/09/01",
                "2026/09/02",
                "2026/09/03",
                "2026/09/04",
                "2026/09/05",
                "2026/09/06",
            ]
        );
        assert!(roots
            .iter()
            .any(|(root, _)| root.ends_with(".codex/archived_sessions")));

        // Past the cap a months-long session takes the two ends instead of a
        // hundred day directories.
        let wide = codex_trace_roots(
            home.path(),
            "2026-01-01T09:00:00.000Z",
            "2026-09-05T09:00:00.000Z",
        );
        assert_eq!(
            days(&wide),
            vec![
                "2025/12/31",
                "2026/01/01",
                "2026/01/02",
                "2026/09/04",
                "2026/09/05",
                "2026/09/06",
            ]
        );
    }
}
