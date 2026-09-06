use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader},
    path::Component,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, MutexGuard},
    time::SystemTime,
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
            completion_id_for_payload, delete_event_row, find_event_by_id,
            list_imported_trace_events, list_session_agent_events,
            list_session_native_agent_events, list_session_tool_events,
            persist_timeline_event_if_absent, rewrite_trace_event,
            supersede_synthetic_launch_events, tool_use_id_for_payload, update_event_payload,
            upgrade_trace_no_output_completion, PersistTimelineEventInput,
        },
        sessions::find_session_by_id,
        workspaces::find_workspace_by_id,
    },
    util::sync::LockOrRecover,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TraceProvider {
    Codex,
    Cursor,
    Grok,
}

impl TraceProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Grok => "grok",
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
    codex_runs: Vec<CodexNativeRun>,
}

impl AgentTraceContext {
    fn trace_file_key(&self, path: PathBuf) -> TraceFileKey {
        TraceFileKey {
            session_id: self.session_id.clone(),
            parent_tool_use_id: self.parent_tool_use_id.clone(),
            run_revision: self
                .codex_runs
                .iter()
                .map(CodexNativeRun::revision_part)
                .collect::<Vec<_>>()
                .join("|"),
            path,
        }
    }
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

/// What the child thread is running on, read from the rollout's `turn_context`
/// records. A subagent picks its own model and effort, and nothing in the
/// parent's stdout reports them, so the imported rows carry them instead.
#[derive(Debug, Clone, Default)]
struct CodexRunModel {
    model_id: Option<String>,
    reasoning_effort: Option<String>,
}

#[derive(Debug, Clone)]
struct CodexNativeRun {
    child_id: String,
    parent_conversation_id: String,
    root_tool_use_id: String,
    run_id: String,
    provider_invocation_id: String,
    codename: Option<String>,
    completed: bool,
}

impl CodexNativeRun {
    fn revision_part(&self) -> String {
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

/// Size and modified time of a child trace file when it was last imported.
type TraceFileStamp = (u64, SystemTime);

/// Identity of one imported child trace file. The resolved path is part of the
/// key so a transcript Codex rotates into `archived_sessions` re-imports under
/// its new path, and so two sessions reading the same file never skip each
/// other's import.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TraceFileKey {
    session_id: String,
    parent_tool_use_id: String,
    run_revision: String,
    path: PathBuf,
}

/// What one poll has to do with a resolved trace file.
enum TraceFileStep {
    /// The last import already covered exactly these bytes.
    UpToDate,
    /// Read and parse it, then remember `stamp` once the rows persist.
    Read(Option<TraceFileStamp>),
}

/// Trace files already imported. `session:agent-events` imports before every
/// read and the renderer polls it every 1.5 s per open agent tab, so without
/// this each poll re-read and re-parsed every multi-MB child transcript and ran
/// an insert-if-absent statement per row against the shared connection.
///
/// Dropped wholesale past the cap instead of growing for the process lifetime;
/// the cost is one extra re-import round.
static IMPORTED_TRACE_FILES: LazyLock<Mutex<HashMap<TraceFileKey, TraceFileStamp>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const MAX_REMEMBERED_TRACE_FILES: usize = 512;
static TRACE_SESSION_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn imported_trace_files() -> MutexGuard<'static, HashMap<TraceFileKey, TraceFileStamp>> {
    IMPORTED_TRACE_FILES.lock_or_recover("imported trace files")
}

fn with_trace_session_lock<T>(session_id: &str, run: impl FnOnce() -> T) -> T {
    let lock = {
        let mut locks = TRACE_SESSION_LOCKS.lock_or_recover("trace session locks");
        Arc::clone(
            locks
                .entry(session_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    };
    let guard = lock.lock_or_recover("trace session");
    let result = run();
    drop(guard);
    let mut locks = TRACE_SESSION_LOCKS.lock_or_recover("trace session locks");
    if Arc::strong_count(&lock) == 2 {
        locks.remove(session_id);
    }
    result
}

fn trace_file_step(key: &TraceFileKey) -> TraceFileStep {
    let stamp = fs::metadata(&key.path)
        .and_then(|metadata| Ok((metadata.len(), metadata.modified()?)))
        .ok();
    let mut remembered = imported_trace_files();
    let Some(stamp) = stamp else {
        // Unreadable now (rotated away, deleted): forget it so the next
        // resolved path imports from scratch instead of matching a frozen entry.
        remembered.remove(key);
        return TraceFileStep::Read(None);
    };
    if remembered.get(key) == Some(&stamp) {
        return TraceFileStep::UpToDate;
    }
    TraceFileStep::Read(Some(stamp))
}

/// Recorded only after the parsed rows persist, so a failed write re-imports on
/// the next poll instead of being skipped as up to date.
fn remember_imported_trace_files(stamps: Vec<(TraceFileKey, TraceFileStamp)>) {
    if stamps.is_empty() {
        return;
    }
    let mut remembered = imported_trace_files();
    if remembered.len() + stamps.len() > MAX_REMEMBERED_TRACE_FILES {
        remembered.clear();
    }
    remembered.extend(stamps);
}

/// Rows parsed out of the child transcripts, plus the freshness stamps their
/// import earns once the rows are written.
struct TraceImport {
    events: Vec<PersistTimelineEventInput>,
    stamps: Vec<(TraceFileKey, TraceFileStamp)>,
}

pub fn import_subagent_trace_events(
    database: &Database,
    session_id: &str,
    parent_tool_use_id: &str,
) -> ArgmaxResult<usize> {
    with_trace_session_lock(session_id, || {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return Ok(0);
        };
        import_subagent_trace_events_from_home_database(
            database,
            session_id,
            parent_tool_use_id,
            &home,
        )
    })
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

    let import = trace_events_from_home(home, &context);
    let inserted = {
        let connection = database.connection();
        persist_trace_events(&connection, import.events)?
    };
    remember_imported_trace_files(import.stamps);
    Ok(inserted)
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
    let import = trace_events_from_home(home, &context);
    let inserted = persist_trace_events(connection, import.events)?;
    remember_imported_trace_files(import.stamps);
    Ok(inserted)
}

fn trace_events_from_home(home: &Path, context: &AgentTraceContext) -> TraceImport {
    match context.provider {
        TraceProvider::Codex => codex_trace_events(home, context),
        TraceProvider::Cursor => cursor_trace_events(home, context),
        TraceProvider::Grok => grok_trace_events(home, context),
    }
}

fn persist_trace_events(
    connection: &Connection,
    events: Vec<PersistTimelineEventInput>,
) -> ArgmaxResult<usize> {
    let mut inserted = 0;
    for event in events {
        let was_inserted = persist_timeline_event_if_absent(connection, &event)?.is_some();
        let completion_upgraded = if was_inserted {
            false
        } else {
            upgrade_trace_no_output_completion(connection, &event)?
        };
        let metadata_upgraded = if was_inserted {
            false
        } else {
            upgrade_trace_native_metadata(connection, &event)?
        };
        if was_inserted || completion_upgraded || metadata_upgraded {
            inserted += 1;
        }
    }
    Ok(inserted)
}

fn upgrade_trace_native_metadata(
    connection: &Connection,
    input: &PersistTimelineEventInput,
) -> ArgmaxResult<bool> {
    let Some(incoming) = input.payload.as_object() else {
        return Ok(false);
    };
    if incoming.get("traceImported") != Some(&Value::Bool(true)) {
        return Ok(false);
    }
    let Some(existing) = find_event_by_id(connection, &input.id)? else {
        return Ok(false);
    };
    let Some(existing_payload) = existing.payload.as_object() else {
        return Ok(false);
    };
    if existing_payload.get("traceImported") != Some(&Value::Bool(true)) {
        return Ok(false);
    }
    let mut merged = existing_payload.clone();
    let mut changed = false;
    for key in [
        "providerParentConversationId",
        "providerChildSessionId",
        "agentRootToolUseId",
        "agentRunId",
        "providerInvocationId",
        "agentCodename",
    ] {
        let Some(value) = incoming.get(key) else {
            continue;
        };
        if merged.get(key) != Some(value) {
            merged.insert(key.to_string(), value.clone());
            changed = true;
        }
    }
    if !changed {
        return Ok(false);
    }
    update_event_payload(connection, &input.id, &Value::Object(merged))
}

/// Marks a launch row Argmax invented because the provider never wrote one.
const SYNTHETIC_LAUNCH_MARKER: &str = "traceSyntheticLaunch";
/// Codex closes a child rollout with one of these before the file goes quiet.
const CODEX_TERMINAL_EVENTS: [&str; 3] = ["task_complete", "turn_aborted", "shutdown_complete"];

/// What one session needs before its child rollouts can be reconciled: the
/// thread children name as their parent, and the launch rows already on the
/// timeline.
struct ReconciliationPlan {
    session_id: String,
    parent_thread_id: String,
    session_started_at: String,
    session_last_activity_at: String,
    workspace_path: Option<String>,
    /// Child thread id -> tool id of the launch row the provider itself wrote.
    real_launch_by_child: HashMap<String, String>,
    /// Child thread id -> tool id of a launch row an earlier sweep invented.
    synthetic_launch_by_child: HashMap<String, String>,
    native_runs_by_child: HashMap<String, Vec<CodexNativeRun>>,
    used_tool_ids: HashSet<String>,
}

/// A child rollout the provider announced late or not at all, and the real
/// launch row that supersedes the placeholder standing in for it.
struct SyntheticLaunchTakeover {
    synthetic_tool_use_id: String,
    real_tool_use_id: String,
}

struct ReconciliationWork {
    launches: Vec<PersistTimelineEventInput>,
    takeovers: Vec<SyntheticLaunchTakeover>,
    import: TraceImport,
}

/// One Codex child rollout that names this session's thread as its parent.
struct CodexChildTrace {
    path: PathBuf,
    meta: CodexTraceMeta,
}

/// How a child rollout ended, once it has.
struct CodexChildOutcome {
    completed_at: Option<String>,
    final_message: Option<String>,
}

/// Reconcile a whole session's subagent traces against what the provider
/// actually reported.
///
/// [`import_subagent_trace_events`] can only follow a launch row, so a spawn
/// the provider omitted leaves the child's work invisible forever. This sweep
/// asks the opposite question — which child rollouts claim this session's
/// thread as their parent — and gives the orphans a synthetic launch row to
/// hang under. The synthetic row is a placeholder: when the real launch
/// arrives, the imported rows move under it and the placeholder is deleted.
///
/// Only Codex is reconciled. Claude and OpenCode stream their subagent
/// activity inline, and Cursor's trace import stays launch-driven because its
/// transcripts carry no parent linkage to discover.
pub fn reconcile_session_subagent_traces(
    database: &Database,
    session_id: &str,
) -> ArgmaxResult<usize> {
    with_trace_session_lock(session_id, || {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return Ok(0);
        };
        reconcile_session_subagent_traces_from_home_database(database, session_id, &home)
    })
}

fn reconcile_session_subagent_traces_from_home_database(
    database: &Database,
    session_id: &str,
    home: &Path,
) -> ArgmaxResult<usize> {
    let Some(plan) = ({
        let connection = database.connection();
        reconciliation_plan(&connection, session_id)?
    }) else {
        return Ok(0);
    };
    let work = reconciliation_work(home, &plan);
    let written = {
        let connection = database.connection();
        apply_reconciliation(&connection, &plan.session_id, work)?
    };
    Ok(written)
}

#[cfg(test)]
fn reconcile_session_subagent_traces_from_home(
    connection: &Connection,
    session_id: &str,
    home: &Path,
) -> ArgmaxResult<usize> {
    let Some(plan) = reconciliation_plan(connection, session_id)? else {
        return Ok(0);
    };
    let work = reconciliation_work(home, &plan);
    apply_reconciliation(connection, &plan.session_id, work)
}

fn reconciliation_plan(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<ReconciliationPlan>> {
    let session = find_session_by_id(connection, session_id)?;
    if session.provider != TraceProvider::Codex.as_str() {
        return Ok(None);
    }
    let Some(parent_thread_id) = session.provider_conversation_id.filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let workspace_path = find_workspace_by_id(connection, &session.workspace_id)
        .ok()
        .map(|workspace| workspace.path);

    let mut real_launch_by_child = HashMap::new();
    let mut synthetic_launch_by_child = HashMap::new();
    let mut used_tool_ids = HashSet::new();
    for row in list_session_tool_events(connection, session_id)? {
        let tool_use_id = match row.r#type.as_str() {
            "command.started" => tool_use_id_for_payload(&row.payload),
            _ => completion_id_for_payload(&row.payload),
        };
        let Some(tool_use_id) = tool_use_id else {
            continue;
        };
        used_tool_ids.insert(tool_use_id.to_string());
        // Imported child rows are tool boundaries too; they launch nothing.
        if row.payload.get("parent_tool_use_id").is_some() {
            continue;
        }
        if row.payload.get("traceSyntheticSuperseded") == Some(&Value::Bool(true)) {
            continue;
        }
        if row.payload.get(SYNTHETIC_LAUNCH_MARKER) == Some(&Value::Bool(true)) {
            if let Some(child_id) = row
                .payload
                .get("providerChildSessionId")
                .and_then(Value::as_str)
            {
                synthetic_launch_by_child.insert(child_id.to_string(), tool_use_id.to_string());
            }
            continue;
        }
        if !is_spawn_agent_payload(&row.payload) {
            continue;
        }
        for child_id in receiver_thread_ids(&row.payload) {
            real_launch_by_child
                .entry(child_id)
                .or_insert_with(|| tool_use_id.to_string());
        }
    }
    let native_runs_by_child = codex_native_runs(
        list_session_native_agent_events(connection, session_id)?,
        &parent_thread_id,
    );
    for (child_id, runs) in &native_runs_by_child {
        if let Some(first_run) = runs.first() {
            real_launch_by_child
                .entry(child_id.clone())
                .or_insert_with(|| first_run.root_tool_use_id.clone());
        }
    }

    Ok(Some(ReconciliationPlan {
        session_id: session_id.to_string(),
        parent_thread_id,
        session_started_at: session.started_at,
        session_last_activity_at: session.last_activity_at,
        workspace_path,
        real_launch_by_child,
        synthetic_launch_by_child,
        native_runs_by_child,
        used_tool_ids,
    }))
}

fn codex_native_runs(
    events: Vec<crate::persistence::events::TimelineEvent>,
    parent_thread_id: &str,
) -> HashMap<String, Vec<CodexNativeRun>> {
    let mut runs_by_child: HashMap<String, Vec<CodexNativeRun>> = HashMap::new();
    let mut completed = HashSet::new();
    for event in &events {
        if event.r#type != "agent.completed" {
            continue;
        }
        let payload = &event.payload;
        let identity = (
            payload
                .get("providerChildSessionId")
                .and_then(Value::as_str),
            payload.get("agentRunId").and_then(Value::as_str),
            payload.get("providerInvocationId").and_then(Value::as_str),
        );
        if let (Some(child_id), Some(run_id), Some(invocation_id)) = identity {
            completed.insert((
                child_id.to_string(),
                run_id.to_string(),
                invocation_id.to_string(),
            ));
        }
    }
    for event in events {
        if event.r#type != "agent.started"
            || event
                .payload
                .get("providerParentConversationId")
                .and_then(Value::as_str)
                != Some(parent_thread_id)
        {
            continue;
        }
        let Some(child_id) = event
            .payload
            .get("providerChildSessionId")
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(run_id) = event.payload.get("agentRunId").and_then(Value::as_str) else {
            continue;
        };
        let Some(invocation_id) = event
            .payload
            .get("providerInvocationId")
            .and_then(Value::as_str)
        else {
            continue;
        };
        let root_tool_use_id = event
            .payload
            .get("agentRootToolUseId")
            .and_then(Value::as_str)
            .unwrap_or(run_id);
        runs_by_child
            .entry(child_id.to_string())
            .or_default()
            .push(CodexNativeRun {
                child_id: child_id.to_string(),
                parent_conversation_id: parent_thread_id.to_string(),
                root_tool_use_id: root_tool_use_id.to_string(),
                run_id: run_id.to_string(),
                provider_invocation_id: invocation_id.to_string(),
                codename: event
                    .payload
                    .get("agentCodename")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                completed: completed.contains(&(
                    child_id.to_string(),
                    run_id.to_string(),
                    invocation_id.to_string(),
                )),
            });
    }
    runs_by_child
}

/// Disk phase: no database connection is held while transcripts are read.
fn reconciliation_work(home: &Path, plan: &ReconciliationPlan) -> ReconciliationWork {
    let mut work = ReconciliationWork {
        launches: Vec::new(),
        takeovers: Vec::new(),
        import: TraceImport {
            events: Vec::new(),
            stamps: Vec::new(),
        },
    };
    for child in find_codex_child_traces(home, plan) {
        let child_id = child.meta.thread_id.as_str();
        let real = plan.real_launch_by_child.get(child_id);
        let synthetic = plan.synthetic_launch_by_child.get(child_id);
        if let (Some(real), Some(synthetic)) = (real, synthetic) {
            work.takeovers.push(SyntheticLaunchTakeover {
                synthetic_tool_use_id: synthetic.clone(),
                real_tool_use_id: real.clone(),
            });
        }
        let parent_tool_use_id = match (real, synthetic) {
            (Some(real), _) => real.clone(),
            (None, Some(synthetic)) => synthetic.clone(),
            (None, None) => synthetic_launch_tool_use_id(child_id, &plan.used_tool_ids),
        };
        let launched_at = child
            .meta
            .started_at
            .clone()
            .unwrap_or_else(|| plan.session_started_at.clone());
        let context = AgentTraceContext {
            provider: TraceProvider::Codex,
            session_id: plan.session_id.clone(),
            parent_tool_use_id,
            parent_created_at: launched_at.clone(),
            provider_conversation_id: Some(plan.parent_thread_id.clone()),
            workspace_path: plan.workspace_path.clone(),
            cursor_prompt: None,
            child_ids: vec![child_id.to_string()],
            codex_runs: plan
                .native_runs_by_child
                .get(child_id)
                .cloned()
                .unwrap_or_default(),
        };
        let key = context.trace_file_key(child.path);
        let stamp = match trace_file_step(&key) {
            TraceFileStep::UpToDate => continue,
            TraceFileStep::Read(stamp) => stamp,
        };
        let lines = read_trace_lines(&key.path);
        if real.is_none() {
            work.launches.extend(synthetic_launch_events(
                &context,
                &child.meta,
                &launched_at,
                codex_child_outcome(&lines),
            ));
        }
        work.import
            .events
            .extend(codex_child_events(&context, child_id, &key.path, &lines));
        if let Some(stamp) = stamp {
            work.import.stamps.push((key, stamp));
        }
    }
    work
}

fn apply_reconciliation(
    connection: &Connection,
    session_id: &str,
    work: ReconciliationWork,
) -> ArgmaxResult<usize> {
    // Takeovers run first so the rows they free up cannot collide with the
    // import about to be written under the real launch row.
    for takeover in work.takeovers {
        take_over_synthetic_launch(connection, session_id, &takeover)?;
    }
    let mut written = 0;
    for launch in work.launches {
        if persist_timeline_event_if_absent(connection, &launch)?.is_some() {
            written += 1;
        }
    }
    written += persist_trace_events(connection, work.import.events)?;
    remember_imported_trace_files(work.import.stamps);
    Ok(written)
}

/// Move a child's imported rows from the placeholder launch to the real one,
/// then drop the placeholder. Rows are rewritten in place, so their rowids —
/// and with them timeline ordering and every renderer cursor — survive.
fn take_over_synthetic_launch(
    connection: &Connection,
    session_id: &str,
    takeover: &SyntheticLaunchTakeover,
) -> ArgmaxResult<()> {
    for row in list_imported_trace_events(connection, session_id, &takeover.synthetic_tool_use_id)?
    {
        let (Some(row_cursor), Some(payload)) = (row.row_cursor, row.payload.as_object()) else {
            continue;
        };
        let (Some(child_id), Some(sequence)) = (
            payload
                .get("providerChildSessionId")
                .and_then(Value::as_str),
            payload.get("traceSequence").and_then(Value::as_u64),
        ) else {
            continue;
        };
        let id = trace_event_id(
            TraceProvider::Codex,
            session_id,
            &takeover.real_tool_use_id,
            child_id,
            sequence as usize,
            &row.r#type,
        );
        let mut payload = payload.clone();
        payload.insert(
            "parent_tool_use_id".to_string(),
            Value::String(takeover.real_tool_use_id.clone()),
        );
        if !rewrite_trace_event(connection, row_cursor, &id, &Value::Object(payload))? {
            // The real launch already imported this row under that id.
            delete_event_row(connection, row_cursor)?;
        }
    }
    supersede_synthetic_launch_events(
        connection,
        session_id,
        &takeover.synthetic_tool_use_id,
        &takeover.real_tool_use_id,
    )?;
    Ok(())
}

/// A launch row of our own making must never answer to an id the provider
/// could also use, so it is prefixed and checked against the ids already on
/// the session's timeline.
fn synthetic_launch_tool_use_id(child_id: &str, used_tool_ids: &HashSet<String>) -> String {
    let base = format!("trace-spawn-{child_id}");
    if !used_tool_ids.contains(&base) {
        return base;
    }
    let mut attempt = 1;
    loop {
        let candidate = format!("{base}-{attempt}");
        if !used_tool_ids.contains(&candidate) {
            return candidate;
        }
        attempt += 1;
    }
}

fn synthetic_launch_events(
    context: &AgentTraceContext,
    meta: &CodexTraceMeta,
    launched_at: &str,
    outcome: Option<CodexChildOutcome>,
) -> Vec<PersistTimelineEventInput> {
    let child_id = meta.thread_id.as_str();
    let tool_use_id = context.parent_tool_use_id.as_str();
    let mut input = Map::new();
    input.insert(
        "receiver_thread_ids".to_string(),
        Value::Array(vec![Value::String(child_id.to_string())]),
    );
    // A `wait` that timed out reports no receivers, so the sender is the only
    // way the renderer can settle this launch from that wait.
    if let Some(parent_thread_id) = meta.parent_thread_id.as_deref() {
        input.insert(
            "sender_thread_id".to_string(),
            Value::String(parent_thread_id.to_string()),
        );
    }
    if let Some(description) = meta
        .task_name
        .as_deref()
        .or(meta.role.as_deref())
        .or(meta.nickname.as_deref())
    {
        input.insert(
            "description".to_string(),
            Value::String(description.to_string()),
        );
    }

    let mut started = Map::new();
    started.insert("id".to_string(), Value::String(tool_use_id.to_string()));
    started.insert(
        "call_id".to_string(),
        Value::String(tool_use_id.to_string()),
    );
    started.insert("name".to_string(), Value::String("spawn_agent".to_string()));
    started.insert("type".to_string(), Value::String("spawn_agent".to_string()));
    started.insert(SYNTHETIC_LAUNCH_MARKER.to_string(), Value::Bool(true));
    started.insert(
        "providerChildSessionId".to_string(),
        Value::String(child_id.to_string()),
    );
    started.insert(
        "receiver_thread_ids".to_string(),
        Value::Array(vec![Value::String(child_id.to_string())]),
    );
    started.insert("input".to_string(), Value::Object(input));
    for (key, value) in [
        ("agentNickname", meta.nickname.as_deref()),
        ("agentRole", meta.role.as_deref()),
        ("agentTaskName", meta.task_name.as_deref()),
    ] {
        if let Some(value) = value {
            started.insert(key.to_string(), Value::String(value.to_string()));
        }
    }

    let mut events = vec![PersistTimelineEventInput {
        id: format!("trace-launch:{}:{child_id}:started", context.session_id),
        session_id: context.session_id.clone(),
        r#type: "command.started".to_string(),
        message: "spawn_agent".to_string(),
        payload: Value::Object(started.clone()),
        created_at: Some(launched_at.to_string()),
    }];

    let Some(outcome) = outcome else {
        return events;
    };
    let mut completed = Map::new();
    completed.insert("id".to_string(), Value::String(tool_use_id.to_string()));
    completed.insert(
        "call_id".to_string(),
        Value::String(tool_use_id.to_string()),
    );
    completed.insert("name".to_string(), Value::String("spawn_agent".to_string()));
    completed.insert(SYNTHETIC_LAUNCH_MARKER.to_string(), Value::Bool(true));
    completed.insert(
        "providerChildSessionId".to_string(),
        Value::String(child_id.to_string()),
    );
    if let Some(message) = outcome.final_message {
        completed.insert("output".to_string(), Value::String(message));
    }
    events.push(PersistTimelineEventInput {
        id: format!("trace-launch:{}:{child_id}:completed", context.session_id),
        session_id: context.session_id.clone(),
        r#type: "command.completed".to_string(),
        message: "spawn_agent".to_string(),
        payload: Value::Object(completed),
        created_at: Some(
            outcome
                .completed_at
                .unwrap_or_else(|| launched_at.to_string()),
        ),
    });
    events
}

fn codex_child_outcome(lines: &[TraceLine]) -> Option<CodexChildOutcome> {
    let mut completed_at = None;
    let mut completed = false;
    let mut final_message = None;
    for line in lines {
        let Some(object) = line.value.as_object() else {
            continue;
        };
        if let Some(("message.completed", message, _)) = codex_trace_event_payload(object) {
            final_message = Some(message);
        }
        let is_terminal = object.get("type").and_then(Value::as_str) == Some("event_msg")
            && object
                .get("payload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
                .is_some_and(|kind| CODEX_TERMINAL_EVENTS.contains(&kind));
        if is_terminal {
            completed = true;
            completed_at = line.timestamp.clone().or(completed_at);
        }
    }
    completed.then_some(CodexChildOutcome {
        completed_at,
        final_message,
    })
}

fn find_codex_child_traces(home: &Path, plan: &ReconciliationPlan) -> Vec<CodexChildTrace> {
    let mut children = Vec::new();
    let mut seen = HashSet::new();
    let mut roots = codex_trace_roots(home, &plan.session_started_at);
    roots.extend(codex_trace_roots(home, &plan.session_last_activity_at));
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
        "grok" => TraceProvider::Grok,
        _ => return Ok(None),
    };
    let tail = list_session_agent_events(connection, session_id, parent_tool_use_id)?;
    let mut parent_created_at = None;
    let mut cursor_prompt = None;
    let mut child_ids = Vec::new();
    for row in &tail.events {
        let is_parent_start = row.r#type == "command.started"
            && tool_use_id_for_payload(&row.payload) == Some(parent_tool_use_id);
        let is_parent_completion = row.r#type == "command.completed"
            && completion_id_for_payload(&row.payload) == Some(parent_tool_use_id);
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
            TraceProvider::Grok => {
                for child_id in grok_child_ids(&row.payload) {
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
        && !(provider == TraceProvider::Grok
            && workspace_path.as_deref().is_some()
            && session.provider_conversation_id.as_deref().is_some())
    {
        return Ok(None);
    }
    let codex_runs = if provider == TraceProvider::Codex {
        if let Some(parent_thread_id) = session.provider_conversation_id.as_deref() {
            codex_native_runs(
                list_session_native_agent_events(connection, session_id)?,
                parent_thread_id,
            )
            .into_values()
            .flatten()
            .filter(|run| run.root_tool_use_id == parent_tool_use_id)
            .collect()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    Ok(Some(AgentTraceContext {
        provider,
        session_id: session_id.to_string(),
        parent_tool_use_id: parent_tool_use_id.to_string(),
        parent_created_at,
        provider_conversation_id: session.provider_conversation_id,
        workspace_path,
        cursor_prompt,
        child_ids,
        codex_runs,
    }))
}

fn codex_trace_events(home: &Path, context: &AgentTraceContext) -> TraceImport {
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
fn codex_child_events(
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

fn cursor_trace_events(home: &Path, context: &AgentTraceContext) -> TraceImport {
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

fn grok_trace_events(home: &Path, context: &AgentTraceContext) -> TraceImport {
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
                        .filter(|id| !id.is_empty())
                        .unwrap_or("trace-grok-tool")
                        .to_string();
                    let tool_name = call
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty())
                        .unwrap_or("tool")
                        .to_string();
                    let mut payload = Map::new();
                    payload.insert("id".to_string(), Value::String(tool_id));
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
                .filter(|id| !id.is_empty())
                .unwrap_or("trace-grok-tool")
                .to_string();
            let content = grok_tool_result_content(object);
            let mut payload = Map::new();
            payload.insert("id".to_string(), Value::String(tool_id.clone()));
            payload.insert("tool_use_id".to_string(), Value::String(tool_id));
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
    let cwd = context.workspace_path.as_deref()?;
    let path = grok_session_dir(home, cwd, child_id).join("chat_history.jsonl");
    path.is_file().then_some(path)
}

fn grok_session_dir(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    home.join(".grok/sessions")
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

fn grok_child_ids(payload: &Value) -> Vec<String> {
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
struct CodexTraceMeta {
    thread_id: String,
    parent_thread_id: Option<String>,
    nickname: Option<String>,
    role: Option<String>,
    task_name: Option<String>,
    started_at: Option<String>,
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
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .take(CODEX_TRACE_HEADER_LINES)
    {
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
        });
    }
    None
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

/// The opening prompt of a Cursor transcript. Streamed and stopped at the first
/// user row: the prompt match runs over every transcript in every project root,
/// and reading whole multi-MB files to look at their first few lines was the
/// bulk of that walk.
fn cursor_first_user_text(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
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
fn trace_event_id(
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

fn fallback_timestamp(parent_created_at: &str, sequence: usize) -> String {
    DateTime::parse_from_rfc3339(parent_created_at)
        .map(|time| {
            (time.with_timezone(&Utc) + Duration::milliseconds(sequence as i64 + 1))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .unwrap_or_else(|_| parent_created_at.to_string())
}

fn is_spawn_agent_payload(payload: &Value) -> bool {
    payload
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| payload.get("type").and_then(Value::as_str))
        == Some("spawn_agent")
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
        events::{list_session_agent_events, list_session_events_since, persist_timeline_event},
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        sessions::{persist_session, update_session_provider_conversation_id, PersistSessionInput},
        workspaces::{persist_workspace, PersistWorkspaceInput},
    };
    use crate::sessions::state::SessionState;
    use serde_json::json;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Barrier,
        },
        thread,
        time::Duration as StdDuration,
    };
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
    fn reconciliation_recovers_a_child_thread_the_provider_never_announced() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "codex", "s1");
        update_session_provider_conversation_id(&connection, "s1", "parent-thread")
            .expect("provider id");
        let home = TempDir::new().expect("home");
        write_codex_child_trace(home.path(), "child-thread", &child_trace(false));

        let first = reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("reconcile");
        assert!(first > 0);

        let launch = session_events(&connection)
            .into_iter()
            .find(|event| event.payload[SYNTHETIC_LAUNCH_MARKER] == json!(true))
            .expect("synthetic launch");
        assert_eq!(launch.r#type, "command.started");
        assert_eq!(launch.payload["id"], json!("trace-spawn-child-thread"));
        assert_eq!(
            launch.payload["providerChildSessionId"],
            json!("child-thread")
        );
        assert_eq!(launch.payload["agentNickname"], json!("Scout"));
        assert_eq!(launch.payload["agentRole"], json!("researcher"));
        assert_eq!(launch.payload["agentTaskName"], json!("Inspect directory"));
        assert_eq!(
            launch.payload["input"]["receiver_thread_ids"],
            json!(["child-thread"])
        );
        assert_eq!(
            launch.payload["input"]["sender_thread_id"],
            json!("parent-thread"),
            "a timed-out wait reports no receivers and can only match on the sender"
        );
        assert!(launch.payload.get("parent_tool_use_id").is_none());

        // The child's work now hangs under the placeholder launch, and the
        // pane's own launch-driven import finds it there.
        let events = list_session_agent_events(&connection, "s1", "trace-spawn-child-thread")
            .expect("agent events")
            .events;
        assert!(events
            .iter()
            .any(|event| event.message == "Looking around."));
        assert!(events.iter().any(|event| event.r#type == "command.started"
            && event.message == "exec_command"
            && event.payload["parent_tool_use_id"] == "trace-spawn-child-thread"));

        let before = session_events(&connection).len();
        let second = reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("reconcile again");
        assert_eq!(second, 0);
        assert_eq!(session_events(&connection).len(), before);
    }

    #[test]
    fn reconciliation_completes_a_synthetic_launch_once_the_child_finishes() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "codex", "s1");
        update_session_provider_conversation_id(&connection, "s1", "parent-thread")
            .expect("provider id");
        let home = TempDir::new().expect("home");
        write_codex_child_trace(home.path(), "child-thread", &child_trace(false));

        reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("reconcile running child");
        assert!(!synthetic_launch_completed(&connection));

        write_codex_child_trace(home.path(), "child-thread", &child_trace(true));
        reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("reconcile finished child");

        assert!(synthetic_launch_completed(&connection));
        let completion = session_events(&connection)
            .into_iter()
            .find(|event| {
                event.r#type == "command.completed"
                    && event.payload[SYNTHETIC_LAUNCH_MARKER] == json!(true)
            })
            .expect("synthetic completion");
        assert_eq!(completion.payload["id"], json!("trace-spawn-child-thread"));
        assert_eq!(completion.payload["output"], json!("All done."));
    }

    #[test]
    fn a_real_launch_row_takes_over_the_synthetic_one_without_duplicating_rows() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "codex", "s1");
        update_session_provider_conversation_id(&connection, "s1", "parent-thread")
            .expect("provider id");
        let home = TempDir::new().expect("home");
        write_codex_child_trace(home.path(), "child-thread", &child_trace(true));

        reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("reconcile");
        let imported_before = imported_trace_row_count(&connection, "trace-spawn-child-thread");
        assert!(imported_before > 0);
        let cursors_before = imported_trace_cursors(&connection, "trace-spawn-child-thread");

        // The provider catches up and writes the launch row it owed us.
        seed_real_launch(&connection, "spawn-1", "child-thread");
        let cursor_before_takeover = session_events(&connection)
            .last()
            .and_then(|event| event.row_cursor)
            .expect("cursor before takeover");

        reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("reconcile after real launch");

        assert_eq!(
            imported_trace_row_count(&connection, "trace-spawn-child-thread"),
            0
        );
        assert_eq!(
            imported_trace_row_count(&connection, "spawn-1"),
            imported_before
        );
        assert_eq!(
            imported_trace_cursors(&connection, "spawn-1"),
            cursors_before,
            "reparenting must keep rowids so ordering and cursors hold"
        );
        assert!(!session_events(&connection)
            .iter()
            .any(|event| event.payload[SYNTHETIC_LAUNCH_MARKER] == json!(true)));
        let tombstones =
            list_session_events_since(&connection, "s1", Some(cursor_before_takeover), None)
                .expect("incremental tombstones")
                .events;
        assert_eq!(tombstones.len(), 2);
        assert!(tombstones
            .iter()
            .all(|event| event.payload["traceSyntheticSuperseded"] == json!(true)));

        let before_repeat = session_events(&connection).len();
        let repeat = reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("repeat takeover");
        assert_eq!(repeat, 0);
        assert_eq!(session_events(&connection).len(), before_repeat);

        // A pane opening on the real launch imports nothing new.
        let after_pane_load =
            import_subagent_trace_events_from_home(&connection, "s1", "spawn-1", home.path())
                .expect("pane import");
        assert_eq!(after_pane_load, 0);
        assert_eq!(
            imported_trace_row_count(&connection, "spawn-1"),
            imported_before
        );
    }

    #[test]
    fn agent_control_rows_do_not_take_over_a_synthetic_launch() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "codex", "s1");
        update_session_provider_conversation_id(&connection, "s1", "parent-thread")
            .expect("provider id");
        let home = TempDir::new().expect("home");
        write_codex_child_trace(home.path(), "child-thread", &child_trace(false));

        reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("initial reconcile");
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: "wait-start".to_string(),
                session_id: "s1".to_string(),
                r#type: "command.started".to_string(),
                message: "wait".to_string(),
                payload: json!({
                    "id": "wait-1",
                    "name": "wait",
                    "input": { "receiver_thread_ids": ["child-thread"] }
                }),
                created_at: Some(Utc::now().to_rfc3339()),
            },
        )
        .expect("wait row");

        reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("reconcile control row");

        assert!(session_events(&connection)
            .iter()
            .any(|event| event.payload[SYNTHETIC_LAUNCH_MARKER] == json!(true)));
        assert_eq!(
            imported_trace_row_count(&connection, "trace-spawn-child-thread"),
            2
        );
        assert_eq!(imported_trace_row_count(&connection, "wait-1"), 0);
    }

    #[test]
    fn reconciliation_searches_around_recent_session_activity() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "codex", "s1");
        update_session_provider_conversation_id(&connection, "s1", "parent-thread")
            .expect("provider id");
        connection
            .execute(
                "UPDATE sessions SET started_at = '2026-01-01T00:00:00Z', last_activity_at = ? WHERE id = 's1'",
                [Utc::now().to_rfc3339()],
            )
            .expect("age session");
        let home = TempDir::new().expect("home");
        write_codex_child_trace(home.path(), "child-thread", &child_trace(false));

        let reconciled =
            reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
                .expect("reconcile recent child");

        assert!(reconciled > 0);
        assert!(session_events(&connection)
            .iter()
            .any(|event| event.payload[SYNTHETIC_LAUNCH_MARKER] == json!(true)));
    }

    #[test]
    fn takeover_drops_synthetic_rows_the_real_launch_already_imported() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "codex", "s1");
        update_session_provider_conversation_id(&connection, "s1", "parent-thread")
            .expect("provider id");
        let home = TempDir::new().expect("home");
        write_codex_child_trace(home.path(), "child-thread", &child_trace(true));

        reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("reconcile");
        let imported_before = imported_trace_row_count(&connection, "trace-spawn-child-thread");

        seed_real_launch(&connection, "spawn-1", "child-thread");
        // The pane opens on the real launch first, so both copies exist when
        // reconciliation gets there.
        import_subagent_trace_events_from_home(&connection, "s1", "spawn-1", home.path())
            .expect("pane import");
        assert_eq!(
            imported_trace_row_count(&connection, "spawn-1"),
            imported_before
        );

        reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
            .expect("reconcile after real launch");

        assert_eq!(
            imported_trace_row_count(&connection, "trace-spawn-child-thread"),
            0
        );
        assert_eq!(
            imported_trace_row_count(&connection, "spawn-1"),
            imported_before
        );
        assert_eq!(
            session_events(&connection)
                .iter()
                .filter(|event| event.message == "All done.")
                .count(),
            1
        );
    }

    #[test]
    fn reconciliation_skips_providers_that_stream_their_subagents() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "cursor", "s1");
        update_session_provider_conversation_id(&connection, "s1", "parent-thread")
            .expect("provider id");
        let home = TempDir::new().expect("home");
        write_codex_child_trace(home.path(), "child-thread", &child_trace(true));

        let reconciled =
            reconcile_session_subagent_traces_from_home(&connection, "s1", home.path())
                .expect("reconcile");
        assert_eq!(reconciled, 0);
        assert!(session_events(&connection).is_empty());
    }

    #[test]
    fn unchanged_trace_file_is_skipped_until_it_changes() {
        let dir = TempDir::new().expect("dir");
        let path = dir.path().join("child-thread.jsonl");
        fs::write(&path, "one\n").expect("write trace");
        let key = TraceFileKey {
            session_id: "s1".to_string(),
            parent_tool_use_id: "spawn-1".to_string(),
            run_revision: String::new(),
            path: path.clone(),
        };

        let TraceFileStep::Read(Some(stamp)) = trace_file_step(&key) else {
            panic!("first poll must read the trace");
        };
        remember_imported_trace_files(vec![(key.clone(), stamp)]);
        assert!(matches!(trace_file_step(&key), TraceFileStep::UpToDate));

        fs::write(&path, "one\ntwo\n").expect("grow trace");
        assert!(matches!(
            trace_file_step(&key),
            TraceFileStep::Read(Some(_))
        ));

        // A rotated or deleted transcript forgets its stamp instead of freezing.
        fs::remove_file(&path).expect("remove trace");
        assert!(matches!(trace_file_step(&key), TraceFileStep::Read(None)));
        assert!(!imported_trace_files().contains_key(&key));
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
            workspace_path: None,
            cursor_prompt: None,
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
            workspace_path: None,
            cursor_prompt: None,
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
    fn imported_trace_rows_gain_native_identity_in_place() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_session(&connection, "codex", "s1");
        let base = PersistTimelineEventInput {
            id: "stable-trace-row".to_string(),
            session_id: "s1".to_string(),
            r#type: "message.completed".to_string(),
            message: "Answer".to_string(),
            payload: json!({
                "parent_tool_use_id": "item_5",
                "providerChildSessionId": "child-thread",
                "traceImported": true,
            }),
            created_at: Some("2026-09-06T06:51:00.000Z".to_string()),
        };
        assert_eq!(
            persist_trace_events(&connection, vec![base.clone()]).expect("base"),
            1
        );
        let before = find_event_by_id(&connection, &base.id)
            .expect("find before")
            .expect("row before");
        let mut upgraded = base;
        upgraded.payload = json!({
            "parent_tool_use_id": "item_5",
            "providerChildSessionId": "child-thread",
            "providerParentConversationId": "parent-thread",
            "agentRootToolUseId": "item_5",
            "agentRunId": "item_3",
            "providerInvocationId": "invoke-2",
            "agentCodename": "Scout",
            "traceImported": true,
        });
        assert_eq!(
            persist_trace_events(&connection, vec![upgraded.clone()]).expect("upgrade"),
            1
        );
        let after = find_event_by_id(&connection, &upgraded.id)
            .expect("find after")
            .expect("row after");
        assert_eq!(after.row_cursor, before.row_cursor);
        assert_eq!(after.payload["agentRunId"], "item_3");
        assert_eq!(after.payload["providerInvocationId"], "invoke-2");
        assert_eq!(
            persist_trace_events(&connection, vec![upgraded]).expect("repeat"),
            0
        );
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

    #[test]
    fn trace_work_for_one_session_is_serialized() {
        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let barrier = Arc::clone(&barrier);
            let active = Arc::clone(&active);
            threads.push(thread::spawn(move || {
                barrier.wait();
                with_trace_session_lock("serialized-session", || {
                    assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                    thread::sleep(StdDuration::from_millis(10));
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }));
        }
        barrier.wait();
        for thread in threads {
            thread.join().expect("trace worker");
        }
    }

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
                    archive_on_merge: false,
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
                kind: "git".to_string(),
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
                state: SessionState::Running,
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

    /// A child rollout that names `parent-thread` as its parent, optionally
    /// closed by the `task_complete` Codex writes when the child is done.
    fn child_trace(finished: bool) -> String {
        let mut lines = String::new();
        lines.push_str(
            r#"{"timestamp":"2026-07-08T14:46:49.290Z","type":"session_meta","payload":{"id":"child-thread","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent-thread","nickname":"Scout","role":"researcher","task_name":"Inspect directory"}}}}}"#,
        );
        lines.push('\n');
        lines.push_str(
            r#"{"timestamp":"2026-07-08T14:46:58.064Z","type":"event_msg","payload":{"type":"agent_message","message":"Looking around."}}"#,
        );
        lines.push('\n');
        lines.push_str(
            r#"{"timestamp":"2026-07-08T14:46:58.834Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call_1","arguments":"{\"cmd\":\"ls\"}"}}"#,
        );
        lines.push('\n');
        if finished {
            lines.push_str(
                r#"{"timestamp":"2026-07-08T14:47:01.533Z","type":"event_msg","payload":{"type":"agent_message","message":"All done."}}"#,
            );
            lines.push('\n');
            lines.push_str(
                r#"{"timestamp":"2026-07-08T14:47:01.900Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"All done."}}"#,
            );
            lines.push('\n');
        }
        lines
    }

    /// Reconciliation looks in the day window around the session's start, so
    /// the fixture lands where a rollout written now would.
    fn write_codex_child_trace(home: &Path, child_id: &str, contents: &str) {
        let today = Utc::now();
        let directory = home.join(format!(
            ".codex/sessions/{:04}/{:02}/{:02}",
            today.year(),
            today.month(),
            today.day()
        ));
        fs::create_dir_all(&directory).expect("trace dir");
        fs::write(
            directory.join(format!("rollout-{child_id}.jsonl")),
            contents,
        )
        .expect("write trace");
    }

    /// The launch row the provider owed us, dated now so the launch-driven
    /// import searches the same day window the fixture was written into.
    fn seed_real_launch(connection: &Connection, tool_use_id: &str, child_id: &str) {
        let created_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let payload = json!({
            "id": tool_use_id,
            "name": "spawn_agent",
            "input": { "receiver_thread_ids": [child_id] }
        });
        for (suffix, event_type) in [("start", "command.started"), ("end", "command.completed")] {
            persist_timeline_event(
                connection,
                &PersistTimelineEventInput {
                    id: format!("{tool_use_id}-{suffix}"),
                    session_id: "s1".to_string(),
                    r#type: event_type.to_string(),
                    message: "spawn_agent".to_string(),
                    payload: payload.clone(),
                    created_at: Some(created_at.clone()),
                },
            )
            .expect("real launch row");
        }
    }

    fn session_events(connection: &Connection) -> Vec<crate::persistence::events::TimelineEvent> {
        crate::persistence::events::list_all_session_events(connection, "s1").expect("events")
    }

    fn synthetic_launch_completed(connection: &Connection) -> bool {
        session_events(connection).iter().any(|event| {
            event.r#type == "command.completed"
                && event.payload[SYNTHETIC_LAUNCH_MARKER] == json!(true)
        })
    }

    fn imported_trace_row_count(connection: &Connection, parent_tool_use_id: &str) -> usize {
        list_imported_trace_events(connection, "s1", parent_tool_use_id)
            .expect("imported rows")
            .len()
    }

    fn imported_trace_cursors(connection: &Connection, parent_tool_use_id: &str) -> Vec<i64> {
        list_imported_trace_events(connection, "s1", parent_tool_use_id)
            .expect("imported rows")
            .into_iter()
            .filter_map(|event| event.row_cursor)
            .collect()
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
