mod cache;
mod codex;
mod cursor;
mod grok;
mod reconcile;
mod shared;
#[cfg(test)]
mod test_support;

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use crate::{
    error::ArgmaxResult,
    persistence::{
        database::Database,
        events::{
            completion_id_for_payload, find_event_by_id, list_session_agent_events,
            list_session_native_agent_events, persist_timeline_event_if_absent,
            tool_use_id_for_payload, update_event_payload, upgrade_trace_no_output_completion,
            PersistTimelineEventInput,
        },
        sessions::find_session_by_id,
        workspaces::find_workspace_by_id,
    },
};

use self::cache::{
    remember_imported_trace_files, with_trace_session_lock, TraceFileKey, TraceFileStamp,
};
use self::codex::{codex_trace_events, CodexNativeRun};
use self::cursor::{cursor_child_agent_ids, cursor_task_prompt, cursor_trace_events};
use self::grok::{grok_child_ids, grok_trace_events};
use self::reconcile::{
    apply_reconciliation, codex_native_runs, reconciliation_plan, reconciliation_work,
};
use self::shared::{push_unique, receiver_thread_ids};

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

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::persistence::database::Database;
    use serde_json::json;

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
}
