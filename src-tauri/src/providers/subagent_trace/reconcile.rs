use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use rusqlite::Connection;
use serde_json::{Map, Value};

use super::cache::{remember_imported_trace_files, trace_file_step, TraceFileStep};
use super::codex::{
    codex_child_events, codex_trace_event_payload, find_codex_child_traces, CodexNativeRun,
    CodexTraceMeta,
};
use super::shared::{
    is_spawn_agent_payload, read_trace_lines, receiver_thread_ids, trace_event_id,
};
use super::{persist_trace_events, AgentTraceContext, TraceImport, TraceLine, TraceProvider};
use crate::{
    error::ArgmaxResult,
    persistence::{
        events::{
            completion_id_for_payload, delete_event_row, list_imported_trace_events,
            list_session_native_agent_events, list_session_tool_events,
            persist_timeline_event_if_absent, rewrite_trace_event,
            supersede_synthetic_launch_events, tool_use_id_for_payload, PersistTimelineEventInput,
        },
        sessions::find_session_by_id,
        workspaces::find_workspace_by_id,
    },
};

/// Marks a launch row Argmax invented because the provider never wrote one.
pub(super) const SYNTHETIC_LAUNCH_MARKER: &str = "traceSyntheticLaunch";
/// Codex closes a child rollout with one of these before the file goes quiet.
const CODEX_TERMINAL_EVENTS: [&str; 3] = ["task_complete", "turn_aborted", "shutdown_complete"];

/// What one session needs before its child rollouts can be reconciled: the
/// thread children name as their parent, and the launch rows already on the
/// timeline.
pub(super) struct ReconciliationPlan {
    pub(super) session_id: String,
    pub(super) parent_thread_id: String,
    pub(super) session_started_at: String,
    pub(super) session_last_activity_at: String,
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

pub(super) struct ReconciliationWork {
    launches: Vec<PersistTimelineEventInput>,
    takeovers: Vec<SyntheticLaunchTakeover>,
    import: TraceImport,
}

/// One Codex child rollout that names this session's thread as its parent.
pub(super) struct CodexChildTrace {
    pub(super) path: PathBuf,
    pub(super) meta: CodexTraceMeta,
}

/// How a child rollout ended, once it has.
struct CodexChildOutcome {
    completed_at: Option<String>,
    final_message: Option<String>,
}

pub(super) fn reconciliation_plan(
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

pub(super) fn codex_native_runs(
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
pub(super) fn reconciliation_work(home: &Path, plan: &ReconciliationPlan) -> ReconciliationWork {
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

pub(super) fn apply_reconciliation(
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

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::super::{
        import_subagent_trace_events_from_home, reconcile_session_subagent_traces_from_home,
    };
    use super::*;
    use crate::persistence::{
        database::Database,
        events::{list_session_agent_events, list_session_events_since, persist_timeline_event},
        sessions::update_session_provider_conversation_id,
    };
    use chrono::Utc;
    use serde_json::json;
    use tempfile::TempDir;

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
}
