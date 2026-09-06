use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};
use specta::Type;

use super::{json_error, sqlite_error, time::now_iso};
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};

const INVALID_PAYLOAD_PREVIEW_CHARS: usize = 512;
const AGENT_CODENAME_HEADLINE_COUNT: usize = 10;

#[derive(Debug, Clone, PartialEq)]
pub struct PersistTimelineEventInput {
    pub id: String,
    pub session_id: String,
    pub r#type: String,
    pub message: String,
    pub payload: Value,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PersistRawOutputInput {
    pub id: String,
    pub session_id: String,
    pub stream: String,
    pub content: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub id: String,
    pub session_id: String,
    pub r#type: String,
    pub message: String,
    pub payload: Value,
    pub created_at: String,
    pub row_cursor: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RawProviderOutput {
    pub id: String,
    pub session_id: String,
    pub stream: String,
    pub content: String,
    pub created_at: String,
    pub row_cursor: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventsSinceResult {
    pub events: Vec<TimelineEvent>,
    pub raw_outputs: Vec<RawProviderOutput>,
    pub event_cursor: i64,
    pub raw_output_cursor: i64,
    pub change_cursor: Option<i64>,
    pub deleted_event_ids: Vec<String>,
    pub deleted_raw_output_ids: Vec<String>,
    pub reset_required: bool,
    pub has_more: bool,
}

pub const SESSION_EVENT_PAGE_LIMIT: usize = 500;
pub const SESSION_RAW_OUTPUT_PAGE_LIMIT: usize = 100;
pub const SESSION_CHANGE_PAGE_LIMIT: usize = 500;
// `session:agent-events` scans the session tail on every pane poll, so the
// scan must stay bounded. An agent tail lives in the recent slice of its
// session; sized to the renderer's protected-event budget.
pub const SESSION_AGENT_EVENT_SCAN_LIMIT: usize = 2000;

pub fn list_session_events_since(
    connection: &Connection,
    session_id: &str,
    event_cursor: Option<i64>,
    raw_output_cursor: Option<i64>,
) -> ArgmaxResult<SessionEventsSinceResult> {
    let event_rows = list_event_rows(connection, session_id, event_cursor)?;
    let raw_output_rows = list_raw_output_rows(connection, session_id, raw_output_cursor)?;
    let next_event_cursor = max_row_cursor(&event_rows, event_cursor.unwrap_or(0));
    let next_raw_output_cursor =
        max_raw_row_cursor(&raw_output_rows, raw_output_cursor.unwrap_or(0));

    Ok(SessionEventsSinceResult {
        events: event_rows,
        raw_outputs: raw_output_rows,
        event_cursor: next_event_cursor,
        raw_output_cursor: next_raw_output_cursor,
        change_cursor: None,
        deleted_event_ids: Vec::new(),
        deleted_raw_output_ids: Vec::new(),
        reset_required: false,
        has_more: false,
    })
}

/// Reads a session through the durable mutation sequence.
///
/// A cursorless request is an authoritative bounded backfill. Its rows and
/// change cursor come from one read transaction, so a mutation cannot land
/// between the backfill and its high-water mark. Supplying either legacy rowid
/// cursor keeps the old paging behavior for older clients.
pub fn list_session_changes_since(
    connection: &Connection,
    session_id: &str,
    event_cursor: Option<i64>,
    raw_output_cursor: Option<i64>,
    change_cursor: Option<i64>,
) -> ArgmaxResult<SessionEventsSinceResult> {
    match change_cursor {
        Some(cursor) => list_change_page(connection, session_id, cursor),
        None if event_cursor.is_some() || raw_output_cursor.is_some() => {
            list_session_events_since(connection, session_id, event_cursor, raw_output_cursor)
        }
        None => list_authoritative_tail(connection, session_id),
    }
}

pub fn list_session_agent_events(
    connection: &Connection,
    session_id: &str,
    parent_tool_use_id: &str,
) -> ArgmaxResult<SessionEventsSinceResult> {
    list_session_agent_events_for_identity(connection, session_id, parent_tool_use_id, None, None)
}

pub fn list_session_agent_events_for_identity(
    connection: &Connection,
    session_id: &str,
    parent_tool_use_id: &str,
    provider_parent_conversation_id: Option<&str>,
    provider_child_session_id: Option<&str>,
) -> ArgmaxResult<SessionEventsSinceResult> {
    let rows = list_newest_event_rows(connection, session_id, SESSION_AGENT_EVENT_SCAN_LIMIT)?;
    let mut receiver_thread_ids = std::collections::HashSet::new();
    let mut child_tool_use_ids = std::collections::HashSet::new();
    let mut included_ids = std::collections::HashSet::new();

    for row in &rows {
        if is_parent_agent_event(row, parent_tool_use_id) {
            included_ids.insert(row.id.clone());
            receiver_thread_ids.extend(receiver_thread_ids_for_payload(&row.payload));
        }
        if parent_tool_use_id_for_payload(&row.payload) == Some(parent_tool_use_id) {
            included_ids.insert(row.id.clone());
            if row.r#type == "command.started" {
                if let Some(tool_use_id) = tool_use_id_for_payload(&row.payload) {
                    child_tool_use_ids.insert(tool_use_id.to_string());
                }
            }
        }
    }

    for row in &rows {
        if child_tool_use_ids.iter().any(|tool_use_id| {
            completion_id_for_payload(&row.payload) == Some(tool_use_id.as_str())
        }) {
            included_ids.insert(row.id.clone());
        }
        if is_agent_message_for_threads(&row.payload, &receiver_thread_ids) {
            included_ids.insert(row.id.clone());
        }
    }

    let mut events = rows
        .into_iter()
        .filter(|row| included_ids.contains(&row.id))
        .collect::<Vec<_>>();
    append_native_agent_events(
        connection,
        session_id,
        parent_tool_use_id,
        provider_parent_conversation_id,
        provider_child_session_id,
        &mut events,
    )?;
    let mut events_by_id = HashMap::new();
    for event in events {
        events_by_id.insert(event.id.clone(), event);
    }
    let mut events = events_by_id.into_values().collect::<Vec<_>>();
    events.sort_by_key(|event| event.row_cursor.unwrap_or_default());
    let has_more = events.len() > SESSION_AGENT_EVENT_SCAN_LIMIT;
    if has_more {
        let required_ids = events
            .iter()
            .filter(|event| {
                (matches!(
                    event.r#type.as_str(),
                    "agent.started" | "agent.completed" | "command.started" | "command.completed"
                ) && string_field(&event.payload, "providerChildSessionId").is_some())
                    || (matches!(
                        event.r#type.as_str(),
                        "command.started" | "command.completed"
                    ) && (tool_use_id_for_payload(&event.payload) == Some(parent_tool_use_id)
                        || completion_id_for_payload(&event.payload) == Some(parent_tool_use_id)))
                    || (matches!(event.r#type.as_str(), "agent.started" | "agent.completed")
                        && string_field(&event.payload, "agentRootToolUseId")
                            == Some(parent_tool_use_id)
                        && string_field(&event.payload, "agentRunId") == Some(parent_tool_use_id))
            })
            .map(|event| event.id.clone())
            .collect::<HashSet<_>>();
        let newest_slots = SESSION_AGENT_EVENT_SCAN_LIMIT.saturating_sub(required_ids.len());
        let mut bounded = events
            .iter()
            .filter(|event| required_ids.contains(&event.id))
            .cloned()
            .collect::<Vec<_>>();
        bounded.extend(
            events
                .iter()
                .rev()
                .filter(|event| !required_ids.contains(&event.id))
                .take(newest_slots)
                .cloned(),
        );
        bounded.sort_by_key(|event| event.row_cursor.unwrap_or_default());
        events = bounded;
    }
    let next_event_cursor = max_row_cursor(&events, 0);

    Ok(SessionEventsSinceResult {
        events,
        raw_outputs: Vec::new(),
        event_cursor: next_event_cursor,
        raw_output_cursor: 0,
        change_cursor: None,
        deleted_event_ids: Vec::new(),
        deleted_raw_output_ids: Vec::new(),
        reset_required: false,
        has_more,
    })
}

/// Confirms that a resumable native child belongs to the session's current
/// provider conversation. Clearing, switching provider, and forking away from
/// that conversation therefore invalidate old renderer references even though
/// their timeline rows remain readable history.
pub fn has_current_native_agent_identity(
    connection: &Connection,
    session_id: &str,
    provider_parent_conversation_id: &str,
    provider_child_session_id: &str,
) -> ArgmaxResult<bool> {
    let current_parent = current_native_agent_parent_conversation_id(connection, session_id)?;
    if current_parent.as_deref() != Some(provider_parent_conversation_id) {
        return Ok(false);
    }
    connection
        .query_row(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM events
                WHERE session_id = ?
                  AND type = 'agent.started'
                  AND json_extract(payload_json, '$.providerParentConversationId') = ?
                  AND json_extract(payload_json, '$.providerChildSessionId') = ?
                  AND rowid > COALESCE((
                      SELECT MAX(rowid) FROM events boundary
                      WHERE boundary.session_id = events.session_id
                        AND boundary.type IN ('session.cleared', 'session.provider-changed')
                  ), 0)
            )
            "#,
            (
                session_id,
                provider_parent_conversation_id,
                provider_child_session_id,
            ),
            |row| row.get::<_, bool>(0),
        )
        .map_err(sqlite_error)
}

fn append_native_agent_events(
    connection: &Connection,
    session_id: &str,
    root_tool_use_id: &str,
    requested_parent_conversation_id: Option<&str>,
    requested_child_id: Option<&str>,
    events: &mut Vec<TimelineEvent>,
) -> ArgmaxResult<()> {
    let current_parent = current_native_agent_parent_conversation_id(connection, session_id)?;
    let Some(current_parent) = current_parent else {
        return Ok(());
    };
    if requested_parent_conversation_id.is_some_and(|parent| parent != current_parent) {
        return Ok(());
    }
    let initial_lifecycle = connection
        .query_row(
            r#"
            SELECT rowid AS row_cursor, id, session_id, type, message, payload_json, created_at
            FROM events
            WHERE session_id = ?1
              AND type = 'agent.started'
              AND json_extract(payload_json, '$.providerParentConversationId') = ?2
              AND json_extract(payload_json, '$.agentRootToolUseId') = ?3
              AND (?4 IS NULL OR json_extract(payload_json, '$.providerChildSessionId') = ?4)
              AND rowid > COALESCE((
                  SELECT MAX(rowid) FROM events boundary
                  WHERE boundary.session_id = events.session_id
                    AND boundary.type IN ('session.cleared', 'session.provider-changed')
              ), 0)
            ORDER BY rowid ASC
            LIMIT 1
            "#,
            params![
                session_id,
                current_parent,
                root_tool_use_id,
                requested_child_id
            ],
            event_row_to_timeline_event,
        )
        .optional()
        .map_err(sqlite_error)?;
    let Some(initial_lifecycle) = initial_lifecycle else {
        return Ok(());
    };
    let child_id = string_field(&initial_lifecycle.payload, "providerChildSessionId")
        .unwrap_or_default()
        .to_string();
    let initial_invocation = string_field(&initial_lifecycle.payload, "providerInvocationId")
        .unwrap_or_default()
        .to_string();
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT rowid AS row_cursor, id, session_id, type, message, payload_json, created_at
            FROM events candidate
            WHERE session_id = ?1
              AND rowid > COALESCE((
                SELECT MAX(rowid) FROM events boundary
                  WHERE boundary.session_id = candidate.session_id
                    AND boundary.type IN ('session.cleared', 'session.provider-changed')
              ), 0)
              AND (
                json_extract(payload_json, '$.parent_tool_use_id') = ?4
                OR (
                  type IN ('agent.started', 'agent.completed')
                  AND json_extract(payload_json, '$.providerParentConversationId') = ?2
                  AND json_extract(payload_json, '$.providerChildSessionId') = ?3
                )
                OR (
                  type IN ('command.started', 'command.completed')
                  AND EXISTS (
                    SELECT 1 FROM events lifecycle
                    WHERE lifecycle.session_id = candidate.session_id
                      AND lifecycle.type IN ('agent.started', 'agent.completed')
                      AND json_extract(lifecycle.payload_json, '$.providerParentConversationId') = ?2
                      AND json_extract(lifecycle.payload_json, '$.providerChildSessionId') = ?3
                      AND json_extract(lifecycle.payload_json, '$.providerInvocationId') = json_extract(candidate.payload_json, '$.providerInvocationId')
                      AND json_extract(lifecycle.payload_json, '$.agentRunId') = COALESCE(
                        json_extract(candidate.payload_json, '$.tool_use_id'),
                        json_extract(candidate.payload_json, '$.id'),
                        json_extract(candidate.payload_json, '$.call_id')
                      )
                  )
                )
              )
            ORDER BY
              CASE WHEN type IN ('agent.started', 'agent.completed', 'command.started', 'command.completed')
                THEN 0 ELSE 1 END,
              rowid DESC
            LIMIT ?5
            "#,
        )
        .map_err(sqlite_error)?;
    let mut candidates = statement
        .query_map(
            params![
                session_id,
                current_parent,
                child_id,
                root_tool_use_id,
                (SESSION_AGENT_EVENT_SCAN_LIMIT + 1) as i64
            ],
            event_row_to_timeline_event,
        )
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    candidates.push(initial_lifecycle);
    if let Some(root_command) = connection
        .query_row(
            r#"
            SELECT rowid AS row_cursor, id, session_id, type, message, payload_json, created_at
            FROM events
            WHERE session_id = ?
              AND type = 'command.started'
              AND json_extract(payload_json, '$.providerInvocationId') = ?
              AND COALESCE(json_extract(payload_json, '$.id'), json_extract(payload_json, '$.call_id')) = ?
            ORDER BY rowid ASC LIMIT 1
            "#,
            (session_id, initial_invocation.as_str(), root_tool_use_id),
            event_row_to_timeline_event,
        )
        .optional()
        .map_err(sqlite_error)?
    {
        candidates.push(root_command);
    }
    if let Some(initial_completion) = connection
        .query_row(
            r#"
            SELECT rowid AS row_cursor, id, session_id, type, message, payload_json, created_at
            FROM events
            WHERE session_id = ?
              AND type = 'agent.completed'
              AND json_extract(payload_json, '$.providerParentConversationId') = ?
              AND json_extract(payload_json, '$.providerChildSessionId') = ?
              AND json_extract(payload_json, '$.providerInvocationId') = ?
              AND json_extract(payload_json, '$.agentRunId') = ?
            ORDER BY rowid ASC LIMIT 1
            "#,
            (
                session_id,
                current_parent.as_str(),
                child_id.as_str(),
                initial_invocation.as_str(),
                root_tool_use_id,
            ),
            event_row_to_timeline_event,
        )
        .optional()
        .map_err(sqlite_error)?
    {
        candidates.push(initial_completion);
    }
    if let Some(root_result) = connection
        .query_row(
            r#"
            SELECT rowid AS row_cursor, id, session_id, type, message, payload_json, created_at
            FROM events
            WHERE session_id = ?
              AND type = 'command.completed'
              AND json_extract(payload_json, '$.providerInvocationId') = ?
              AND COALESCE(json_extract(payload_json, '$.tool_use_id'), json_extract(payload_json, '$.id'), json_extract(payload_json, '$.call_id')) = ?
            ORDER BY rowid ASC LIMIT 1
            "#,
            (session_id, initial_invocation.as_str(), root_tool_use_id),
            event_row_to_timeline_event,
        )
        .optional()
        .map_err(sqlite_error)?
    {
        candidates.push(root_result);
    }
    candidates.sort_by_key(|event| event.row_cursor.unwrap_or_default());

    let child_ids = HashSet::from([child_id]);
    let run_keys = candidates
        .iter()
        .filter(|event| {
            string_field(&event.payload, "providerChildSessionId")
                .is_some_and(|id| child_ids.contains(id))
        })
        .filter_map(|event| {
            Some((
                string_field(&event.payload, "providerInvocationId")?.to_string(),
                string_field(&event.payload, "agentRunId")?.to_string(),
            ))
        })
        .collect::<HashSet<_>>();
    let identity = candidates.iter().find_map(|event| {
        let child_id = string_field(&event.payload, "providerChildSessionId")?;
        child_ids.contains(child_id).then(|| {
            (
                child_id.to_string(),
                string_field(&event.payload, "providerParentConversationId")
                    .unwrap_or_default()
                    .to_string(),
                string_field(&event.payload, "agentCodename")
                    .unwrap_or_default()
                    .to_string(),
            )
        })
    });
    let run_starts = candidates
        .iter()
        .filter(|event| event.r#type == "agent.started")
        .filter_map(|event| {
            Some((
                event.row_cursor?,
                string_field(&event.payload, "providerInvocationId")?.to_string(),
                string_field(&event.payload, "agentRunId")?.to_string(),
            ))
        })
        .collect::<Vec<_>>();

    for mut event in candidates {
        let is_child_row = parent_tool_use_id_for_payload(&event.payload) == Some(root_tool_use_id);
        let invocation_id =
            string_field(&event.payload, "providerInvocationId").unwrap_or_default();
        let child_run_id = is_child_row.then(|| {
            let row_cursor = event.row_cursor.unwrap_or_default();
            run_starts
                .iter()
                .rev()
                .find(|(started_at, invocation, _)| {
                    invocation == invocation_id && *started_at <= row_cursor
                })
                .map(|(_, _, run_id)| run_id.clone())
        });
        let is_run_control = match event.r#type.as_str() {
            "command.started" => tool_use_id_for_payload(&event.payload)
                .is_some_and(|id| run_keys.contains(&(invocation_id.to_string(), id.to_string()))),
            "command.completed" => completion_id_for_payload(&event.payload)
                .is_some_and(|id| run_keys.contains(&(invocation_id.to_string(), id.to_string()))),
            "agent.started" | "agent.completed" => {
                string_field(&event.payload, "providerChildSessionId")
                    .is_some_and(|id| child_ids.contains(id))
            }
            _ => false,
        };
        let child_invocation = is_child_row
            && run_keys
                .iter()
                .any(|(invocation, _)| invocation == invocation_id);
        if !child_invocation && !is_run_control {
            continue;
        }
        if let (Some((child_id, parent_conversation_id, codename)), Value::Object(payload)) =
            (&identity, &mut event.payload)
        {
            payload
                .entry("providerChildSessionId".to_string())
                .or_insert_with(|| Value::String(child_id.clone()));
            if !parent_conversation_id.is_empty() {
                payload
                    .entry("providerParentConversationId".to_string())
                    .or_insert_with(|| Value::String(parent_conversation_id.clone()));
            }
            payload
                .entry("agentRootToolUseId".to_string())
                .or_insert_with(|| Value::String(root_tool_use_id.to_string()));
            if !codename.is_empty() {
                payload
                    .entry("agentCodename".to_string())
                    .or_insert_with(|| Value::String(codename.clone()));
            }
            let run_id = child_run_id.flatten().or_else(|| {
                match event.r#type.as_str() {
                    "command.started" => payload.get("id").or_else(|| payload.get("call_id")),
                    "command.completed" => payload
                        .get("tool_use_id")
                        .or_else(|| payload.get("id"))
                        .or_else(|| payload.get("call_id")),
                    _ => payload.get("agentRunId"),
                }
                .and_then(Value::as_str)
                .map(str::to_string)
            });
            if let Some(run_id) = run_id {
                payload
                    .entry("agentRunId".to_string())
                    .or_insert(Value::String(run_id));
            }
        }
        events.push(event);
    }
    Ok(())
}

pub fn persist_timeline_event(
    connection: &Connection,
    input: &PersistTimelineEventInput,
) -> ArgmaxResult<TimelineEvent> {
    let created_at = input.created_at.clone().unwrap_or_else(now_iso);
    let payload = enrich_native_agent_event(connection, input)?;
    let payload_json = serde_json::to_string(&payload).map_err(json_error)?;
    let mut statement = connection
        .prepare_cached(
            r#"
        INSERT INTO events (id, session_id, type, message, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
        )
        .map_err(sqlite_error)?;
    statement
        .execute((
            input.id.as_str(),
            input.session_id.as_str(),
            input.r#type.as_str(),
            input.message.as_str(),
            payload_json.as_str(),
            created_at.as_str(),
        ))
        .map_err(sqlite_error)?;
    Ok(TimelineEvent {
        id: input.id.clone(),
        session_id: input.session_id.clone(),
        r#type: input.r#type.clone(),
        message: input.message.clone(),
        payload,
        created_at,
        row_cursor: Some(connection.last_insert_rowid()),
    })
}

fn enrich_native_agent_event(
    connection: &Connection,
    input: &PersistTimelineEventInput,
) -> ArgmaxResult<Value> {
    if !matches!(input.r#type.as_str(), "agent.started" | "agent.completed") {
        return enrich_native_agent_child_row(connection, input);
    }
    let Some(payload) = input.payload.as_object() else {
        return Ok(input.payload.clone());
    };
    let Some(parent_conversation_id) = payload
        .get("providerParentConversationId")
        .and_then(Value::as_str)
    else {
        return Ok(input.payload.clone());
    };
    let Some(child_id) = payload
        .get("providerChildSessionId")
        .and_then(Value::as_str)
    else {
        return Ok(input.payload.clone());
    };
    if current_native_agent_parent_conversation_id(connection, input.session_id.as_str())?
        .as_deref()
        != Some(parent_conversation_id)
    {
        return Ok(input.payload.clone());
    }
    let current_run_id = payload
        .get("agentRunId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let existing_identity = connection
        .query_row(
            r#"
            SELECT json_extract(payload_json, '$.agentRunId'),
                   json_extract(payload_json, '$.agentCodename')
            FROM events
            WHERE session_id = ?
              AND type = 'agent.started'
              AND json_extract(payload_json, '$.providerParentConversationId') = ?
              AND json_extract(payload_json, '$.providerChildSessionId') = ?
              AND rowid > COALESCE((
                  SELECT MAX(rowid) FROM events boundary
                  WHERE boundary.session_id = events.session_id
                    AND boundary.type IN ('session.cleared', 'session.provider-changed')
              ), 0)
            ORDER BY rowid ASC
            LIMIT 1
            "#,
            (input.session_id.as_str(), parent_conversation_id, child_id),
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(sqlite_error)?;
    let root_tool_use_id = existing_identity
        .as_ref()
        .map(|(root, _)| root.clone())
        .unwrap_or_else(|| current_run_id.to_string());
    let mut enriched = payload.clone();
    if !root_tool_use_id.is_empty() {
        enriched.insert(
            "agentRootToolUseId".to_string(),
            Value::String(root_tool_use_id.clone()),
        );
    }
    let codename = match existing_identity.and_then(|(_, codename)| codename) {
        Some(codename) => Some(codename),
        None => assign_native_agent_codename(
            connection,
            input.session_id.as_str(),
            parent_conversation_id,
            root_tool_use_id.as_str(),
        )?,
    };
    if let Some(codename) = codename {
        enriched.insert("agentCodename".to_string(), Value::String(codename));
    }
    Ok(Value::Object(enriched))
}

fn enrich_native_agent_child_row(
    connection: &Connection,
    input: &PersistTimelineEventInput,
) -> ArgmaxResult<Value> {
    let Some(payload) = input.payload.as_object() else {
        return Ok(input.payload.clone());
    };
    let Some(root_tool_use_id) = payload.get("parent_tool_use_id").and_then(Value::as_str) else {
        return Ok(input.payload.clone());
    };
    let Some(provider_invocation_id) = payload.get("providerInvocationId").and_then(Value::as_str)
    else {
        return Ok(input.payload.clone());
    };
    let Some(current_parent_conversation_id) =
        current_native_agent_parent_conversation_id(connection, input.session_id.as_str())?
    else {
        return Ok(input.payload.clone());
    };
    let has_explicit_native_identity = payload
        .get("providerParentConversationId")
        .and_then(Value::as_str)
        == Some(current_parent_conversation_id.as_str())
        && ["providerChildSessionId", "agentRunId", "agentRootToolUseId"]
            .into_iter()
            .all(|key| {
                payload
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
            });
    if has_explicit_native_identity {
        return Ok(input.payload.clone());
    }
    let identity = connection
        .query_row(
            r#"
            SELECT json_extract(payload_json, '$.providerChildSessionId'),
                   json_extract(payload_json, '$.providerParentConversationId'),
                   json_extract(payload_json, '$.agentRunId'),
                   json_extract(payload_json, '$.agentCodename'),
                   json_extract(payload_json, '$.agentRootToolUseId')
            FROM events
            WHERE session_id = ?
              AND type = 'agent.started'
              AND json_extract(payload_json, '$.providerInvocationId') = ?
              AND json_extract(payload_json, '$.agentRootToolUseId') = ?
              AND json_extract(payload_json, '$.providerParentConversationId') = ?
              AND rowid > COALESCE((
                  SELECT MAX(rowid) FROM events boundary
                  WHERE boundary.session_id = events.session_id
                    AND boundary.type IN ('session.cleared', 'session.provider-changed')
              ), 0)
            ORDER BY rowid DESC
            LIMIT 1
            "#,
            (
                input.session_id.as_str(),
                provider_invocation_id,
                root_tool_use_id,
                current_parent_conversation_id.as_str(),
            ),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(sqlite_error)?;
    let Some((child_id, parent_conversation_id, run_id, codename, root_tool_use_id)) = identity
    else {
        return Ok(input.payload.clone());
    };
    let mut enriched = payload.clone();
    enriched.insert(
        "providerChildSessionId".to_string(),
        Value::String(child_id),
    );
    enriched.insert(
        "providerParentConversationId".to_string(),
        Value::String(parent_conversation_id),
    );
    enriched.insert("agentRunId".to_string(), Value::String(run_id));
    enriched.insert(
        "agentRootToolUseId".to_string(),
        Value::String(root_tool_use_id),
    );
    if let Some(codename) = codename {
        enriched.insert("agentCodename".to_string(), Value::String(codename));
    }
    Ok(Value::Object(enriched))
}

fn current_native_agent_parent_conversation_id(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<String>> {
    let current: Option<(String, Option<String>, bool)> = connection
        .query_row(
            "SELECT provider, provider_conversation_id, resume_fork FROM sessions WHERE id = ?",
            (session_id,),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(sqlite_error)?;
    let Some((provider, parent_conversation_id, resume_fork)) = current else {
        return Ok(None);
    };
    if resume_fork
        || !matches!(
            provider.as_str(),
            "claude" | "codex" | "cursor" | "opencode"
        )
    {
        return Ok(None);
    }
    Ok(parent_conversation_id.filter(|id| !id.is_empty()))
}

fn assign_native_agent_codename(
    connection: &Connection,
    session_id: &str,
    parent_conversation_id: &str,
    root_tool_use_id: &str,
) -> ArgmaxResult<Option<String>> {
    static CODENAMES: OnceLock<Vec<String>> = OnceLock::new();
    let codenames = CODENAMES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/shared/agentCodenames.json"))
            .expect("shared agent codename catalog must be valid JSON")
    });
    if codenames.is_empty() {
        return Ok(None);
    }
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT DISTINCT json_extract(payload_json, '$.agentCodename')
            FROM events
            WHERE session_id = ?
              AND type = 'agent.started'
              AND json_extract(payload_json, '$.providerParentConversationId') = ?
              AND json_extract(payload_json, '$.agentCodename') IS NOT NULL
              AND rowid > COALESCE((
                  SELECT MAX(rowid) FROM events boundary
                  WHERE boundary.session_id = events.session_id
                    AND boundary.type IN ('session.cleared', 'session.provider-changed')
              ), 0)
            "#,
        )
        .map_err(sqlite_error)?;
    let taken = statement
        .query_map((session_id, parent_conversation_id), |row| {
            row.get::<_, String>(0)
        })
        .map_err(sqlite_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(sqlite_error)?;
    let hash = root_tool_use_id
        .encode_utf16()
        .fold(0x811c9dc5_u32, |hash, unit| {
            (hash ^ u32::from(unit)).wrapping_mul(0x01000193)
        });
    if taken.len() >= codenames.len() {
        return Ok(Some(codenames[hash as usize % codenames.len()].clone()));
    }
    let modulus = if taken.is_empty() {
        AGENT_CODENAME_HEADLINE_COUNT.min(codenames.len())
    } else {
        codenames.len()
    };
    let start = hash as usize % modulus;
    Ok((0..codenames.len())
        .map(|step| &codenames[(start + step) % codenames.len()])
        .find(|name| !taken.contains(name.as_str()))
        .cloned())
}

/// Returns the persisted event when the row was new, `None` when the id
/// already existed — the sync sweep republishes fresh events from that return
/// value without a second read.
pub fn persist_timeline_event_if_absent(
    connection: &Connection,
    input: &PersistTimelineEventInput,
) -> ArgmaxResult<Option<TimelineEvent>> {
    let created_at = input.created_at.clone().unwrap_or_else(now_iso);
    let payload = enrich_native_agent_event(connection, input)?;
    let payload_json = serde_json::to_string(&payload).map_err(json_error)?;
    let mut statement = connection
        .prepare_cached(
            r#"
        INSERT OR IGNORE INTO events (id, session_id, type, message, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .execute((
            input.id.as_str(),
            input.session_id.as_str(),
            input.r#type.as_str(),
            input.message.as_str(),
            payload_json.as_str(),
            created_at.as_str(),
        ))
        .map_err(sqlite_error)?;
    if rows == 0 {
        return Ok(None);
    }
    Ok(Some(TimelineEvent {
        id: input.id.clone(),
        session_id: input.session_id.clone(),
        r#type: input.r#type.clone(),
        message: input.message.clone(),
        payload,
        created_at,
        row_cursor: Some(connection.last_insert_rowid()),
    }))
}

/// Returns whether a provider permission event with this request identity has
/// already been recorded for the session. Unsupported approval modes do not
/// create an approval row, so their blocked timeline event is the durable
/// replay-deduplication record.
pub fn has_provider_permission_event(
    connection: &Connection,
    session_id: &str,
    provider: &str,
    provider_invocation_id: &str,
    provider_request_id: &str,
) -> ArgmaxResult<bool> {
    let exists = connection
        .query_row(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM events
                WHERE session_id = ?
                  AND type IN ('approval.requested', 'permission.blocked')
                  AND json_extract(payload_json, '$.provider') = ?
                  AND json_extract(payload_json, '$.providerInvocationId') = ?
                  AND json_extract(payload_json, '$.providerRequestId') = ?
            )
            "#,
            (
                session_id,
                provider,
                provider_invocation_id,
                provider_request_id,
            ),
            |row| row.get::<_, i64>(0),
        )
        .map_err(sqlite_error)?;
    Ok(exists != 0)
}

/// A Cursor trace import persists a synthetic `traceNoOutput` completion in
/// the sequence slot the tool's real result will occupy once the child
/// transcript catches up. The real completion then arrives under the same
/// deterministic id, so `INSERT OR IGNORE` would keep the placeholder forever.
/// Upgrade it in place (same rowid, so cursors and ordering are untouched).
pub fn upgrade_trace_no_output_completion(
    connection: &Connection,
    input: &PersistTimelineEventInput,
) -> ArgmaxResult<bool> {
    if input.r#type != "command.completed" || input.payload.get("traceNoOutput").is_some() {
        return Ok(false);
    }
    let created_at = input.created_at.clone().unwrap_or_else(now_iso);
    let payload_json = serde_json::to_string(&input.payload).map_err(json_error)?;
    let mut statement = connection
        .prepare_cached(
            r#"
        UPDATE events
        SET message = ?, payload_json = ?, created_at = ?
        WHERE id = ? AND json_extract(payload_json, '$.traceNoOutput') = true
        "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .execute((
            input.message.as_str(),
            payload_json.as_str(),
            created_at.as_str(),
            input.id.as_str(),
        ))
        .map_err(sqlite_error)?;
    Ok(rows > 0)
}

pub fn find_event_by_id(
    connection: &Connection,
    event_id: &str,
) -> ArgmaxResult<Option<TimelineEvent>> {
    let mut statement = connection
        .prepare_cached("SELECT rowid AS row_cursor, * FROM events WHERE id = ?")
        .map_err(sqlite_error)?;
    statement
        .query_row((event_id,), event_row_to_timeline_event)
        .optional()
        .map_err(sqlite_error)
}

/// Replace one event's payload, keeping its rowid so cursors and timeline
/// ordering are untouched. Used when Argmax learns something about an event
/// after the fact — the measured diff for a file write the provider reported
/// without one.
pub fn update_event_payload(
    connection: &Connection,
    event_id: &str,
    payload: &Value,
) -> ArgmaxResult<bool> {
    let payload_json = serde_json::to_string(payload).map_err(json_error)?;
    let rows = connection
        .prepare_cached("UPDATE events SET payload_json = ? WHERE id = ?")
        .map_err(sqlite_error)?
        .execute((payload_json.as_str(), event_id))
        .map_err(sqlite_error)?;
    Ok(rows > 0)
}

/// Every tool boundary row of a session, oldest first. The subagent trace
/// reconciler reads them to learn which child threads already carry a launch
/// row and which tool ids are taken.
pub fn list_session_tool_events(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<TimelineEvent>> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT rowid AS row_cursor, *
        FROM events
        WHERE session_id = ? AND type IN ('command.started', 'command.completed')
        ORDER BY rowid ASC
        "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map((session_id,), event_row_to_timeline_event)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Native child lifecycle rows, oldest first. Trace reconciliation uses these
/// persisted run boundaries to attach each appended Codex child turn to the
/// parent invocation that dispatched it.
pub fn list_session_native_agent_events(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<TimelineEvent>> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT rowid AS row_cursor, *
        FROM events
        WHERE session_id = ?
          AND type IN ('agent.started', 'agent.completed')
          AND rowid > COALESCE((
              SELECT MAX(rowid) FROM events boundary
              WHERE boundary.session_id = events.session_id
                AND boundary.type IN ('session.cleared', 'session.provider-changed')
          ), 0)
        ORDER BY rowid ASC
        "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map((session_id,), event_row_to_timeline_event)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Imported child trace rows filed under one parent tool call, oldest first.
pub fn list_imported_trace_events(
    connection: &Connection,
    session_id: &str,
    parent_tool_use_id: &str,
) -> ArgmaxResult<Vec<TimelineEvent>> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT rowid AS row_cursor, *
        FROM events
        WHERE session_id = ?
          AND json_extract(payload_json, '$.traceImported') = 1
          AND json_extract(payload_json, '$.parent_tool_use_id') = ?
        ORDER BY rowid ASC
        "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(
            (session_id, parent_tool_use_id),
            event_row_to_timeline_event,
        )
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Re-files one imported trace row under a different parent tool call. The
/// rewrite keeps the rowid, so cursors and timeline ordering are untouched.
/// Returns false when the destination id already exists — the caller decides
/// whether the row it was moving is now a duplicate.
pub fn rewrite_trace_event(
    connection: &Connection,
    row_cursor: i64,
    id: &str,
    payload: &Value,
) -> ArgmaxResult<bool> {
    let payload_json = serde_json::to_string(payload).map_err(json_error)?;
    let mut statement = connection
        .prepare_cached("UPDATE OR IGNORE events SET id = ?, payload_json = ? WHERE rowid = ?")
        .map_err(sqlite_error)?;
    let rows = statement
        .execute((id, payload_json.as_str(), row_cursor))
        .map_err(sqlite_error)?;
    Ok(rows > 0)
}

pub fn delete_event_row(connection: &Connection, row_cursor: i64) -> ArgmaxResult<()> {
    connection
        .prepare_cached("DELETE FROM events WHERE rowid = ?")
        .map_err(sqlite_error)?
        .execute((row_cursor,))
        .map_err(sqlite_error)?;
    Ok(())
}

/// Rewrites placeholder launch rows as cursor-visible tombstones after a real
/// launch takes over. Re-inserting the same event ids gives them fresh rowids,
/// so an incremental renderer replaces and hides its stale launch cards.
pub fn supersede_synthetic_launch_events(
    connection: &Connection,
    session_id: &str,
    tool_use_id: &str,
    real_tool_use_id: &str,
) -> ArgmaxResult<usize> {
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let rows = {
        let mut statement = transaction
            .prepare_cached(
                r#"
            SELECT rowid AS row_cursor, *
            FROM events
            WHERE session_id = ?
              AND json_extract(payload_json, '$.traceSyntheticLaunch') = 1
              AND json_extract(payload_json, '$.id') = ?
            ORDER BY rowid ASC
            "#,
            )
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map((session_id, tool_use_id), event_row_to_timeline_event)
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        rows
    };
    let deleted = transaction
        .prepare_cached(
            r#"
        DELETE FROM events
        WHERE session_id = ?
          AND json_extract(payload_json, '$.traceSyntheticLaunch') = 1
          AND json_extract(payload_json, '$.id') = ?
        "#,
        )
        .map_err(sqlite_error)?
        .execute((session_id, tool_use_id))
        .map_err(sqlite_error)?;
    for row in rows {
        let mut payload = row.payload;
        if let Some(payload) = payload.as_object_mut() {
            payload.remove("traceSyntheticLaunch");
            payload.insert("traceSyntheticSuperseded".to_string(), Value::Bool(true));
            payload.insert(
                "traceSupersededBy".to_string(),
                Value::String(real_tool_use_id.to_string()),
            );
        }
        persist_timeline_event(
            &transaction,
            &PersistTimelineEventInput {
                id: row.id,
                session_id: row.session_id,
                r#type: row.r#type,
                message: row.message,
                payload,
                created_at: Some(row.created_at),
            },
        )?;
    }
    transaction.commit().map_err(sqlite_error)?;
    Ok(deleted)
}

pub fn persist_raw_output(
    connection: &Connection,
    input: &PersistRawOutputInput,
) -> ArgmaxResult<RawProviderOutput> {
    let created_at = input.created_at.clone().unwrap_or_else(now_iso);
    let mut statement = connection
        .prepare_cached(
            r#"
        INSERT INTO raw_outputs (id, session_id, stream, content, created_at)
        VALUES (?, ?, ?, ?, ?)
        "#,
        )
        .map_err(sqlite_error)?;
    statement
        .execute((
            input.id.as_str(),
            input.session_id.as_str(),
            input.stream.as_str(),
            input.content.as_str(),
            created_at.as_str(),
        ))
        .map_err(sqlite_error)?;
    Ok(RawProviderOutput {
        id: input.id.clone(),
        session_id: input.session_id.clone(),
        stream: input.stream.clone(),
        content: input.content.clone(),
        created_at,
        row_cursor: Some(connection.last_insert_rowid()),
    })
}

/// Every timeline row for a session, oldest first and unpaged.
///
/// `list_session_events_since` is the renderer's pager: called with no cursor
/// it returns only the newest `SESSION_EVENT_PAGE_LIMIT` rows. Copying a
/// transcript (session fork) needs all of it — a long run passes 500 rows
/// easily, since every tool call and assistant chunk is a row, and paging
/// would otherwise drop the beginning of the conversation with no warning.
pub fn list_all_session_events(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<TimelineEvent>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT rowid AS row_cursor, * FROM events WHERE session_id = ? ORDER BY rowid ASC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map((session_id,), event_row_to_timeline_event)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// The agent's most recent visible message in a session — what a suggested
/// follow-up is a reply to. Applies the same child-agent exclusions as
/// `compose_follow_up_prompt`: subagent prose never reaches the transcript, so
/// it must not reach the suggestion either.
///
/// Clamped like `compose_follow_up_prompt` clamps its own lines. The caller
/// spends a model call on this text, and four of the five providers carry it
/// in argv, where a pasted log would cost real tokens and eventually exceed
/// `ARG_MAX`. The opening characters are all a follow-up needs to reply to.
pub fn latest_agent_message(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<String>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT substr(message, 1, 4000)
            FROM events
            WHERE session_id = ?
              AND type = 'message.completed'
              AND trim(message) <> ''
              AND rowid > COALESCE((
                SELECT MAX(rowid) FROM events cleared
                WHERE cleared.session_id = events.session_id
                  AND cleared.type = 'session.cleared'
              ), 0)
              AND json_extract(payload_json, '$.parent_tool_use_id') IS NULL
              AND json_extract(payload_json, '$.traceImported') IS NULL
              AND NOT (
                (json_extract(payload_json, '$.item_type') = 'agent_message'
                  OR json_extract(payload_json, '$.item.type') = 'agent_message')
                AND (json_extract(payload_json, '$.thread_id') IS NOT NULL
                  OR json_extract(payload_json, '$.sender_thread_id') IS NOT NULL
                  OR json_extract(payload_json, '$.item.thread_id') IS NOT NULL
                  OR json_extract(payload_json, '$.item.sender_thread_id') IS NOT NULL)
              )
            ORDER BY rowid DESC
            LIMIT 1
            "#,
        )
        .map_err(sqlite_error)?;
    let message = statement
        .query_row((session_id,), |row| row.get::<_, String>(0))
        .optional()
        .map_err(sqlite_error)?;
    Ok(message)
}

/// When the current turn's prompt landed — what `session_status` ages to
/// report how long a session has been working. Ignores subagent rows and
/// anything before the last `/clear`, like the transcript itself does.
pub fn latest_user_message_at(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<String>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT created_at
            FROM events
            WHERE session_id = ?
              AND type = 'user.message'
              AND rowid > COALESCE((
                SELECT MAX(rowid) FROM events cleared
                WHERE cleared.session_id = events.session_id
                  AND cleared.type = 'session.cleared'
              ), 0)
              AND json_extract(payload_json, '$.parent_tool_use_id') IS NULL
            ORDER BY rowid DESC
            LIMIT 1
            "#,
        )
        .map_err(sqlite_error)?;
    statement
        .query_row((session_id,), |row| row.get::<_, String>(0))
        .optional()
        .map_err(sqlite_error)
}

/// How many times this chat has arrived somewhere by being moved. A move
/// copies the transcript, so the seams of earlier moves ride along and the
/// count is the whole chain rather than the last hop.
pub fn count_move_arrivals(connection: &Connection, session_id: &str) -> ArgmaxResult<i64> {
    connection
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM events
            WHERE session_id = ?
              AND type = 'session.moved'
              AND json_extract(payload_json, '$.direction') = 'destination'
            "#,
            (session_id,),
            |row| row.get::<_, i64>(0),
        )
        .map_err(sqlite_error)
}

fn list_authoritative_tail(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<SessionEventsSinceResult> {
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let events = list_event_rows(&transaction, session_id, None)?;
    let raw_outputs = list_raw_output_rows(&transaction, session_id, None)?;
    let change_cursor = change_feed_head(&transaction)?;
    let event_cursor = max_row_cursor(&events, 0);
    let raw_output_cursor = max_raw_row_cursor(&raw_outputs, 0);
    transaction.commit().map_err(sqlite_error)?;

    Ok(SessionEventsSinceResult {
        events,
        raw_outputs,
        event_cursor,
        raw_output_cursor,
        change_cursor: Some(change_cursor),
        deleted_event_ids: Vec::new(),
        deleted_raw_output_ids: Vec::new(),
        reset_required: true,
        has_more: false,
    })
}

fn list_change_page(
    connection: &Connection,
    session_id: &str,
    cursor: i64,
) -> ArgmaxResult<SessionEventsSinceResult> {
    if cursor < 0 {
        return Err(ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["changeCursor".to_owned()],
            "CHANGE_CURSOR_NEGATIVE",
            "change cursor must be zero or greater",
        )));
    }

    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let head = change_feed_head(&transaction)?;
    let pruned_through = transaction
        .prepare_cached("SELECT pruned_through FROM session_change_watermarks WHERE session_id = ?")
        .map_err(sqlite_error)?
        .query_row((session_id,), |row| row.get::<_, i64>(0))
        .optional()
        .map_err(sqlite_error)?
        .unwrap_or(0);

    if cursor > head || cursor < pruned_through {
        let events = list_event_rows(&transaction, session_id, None)?;
        let raw_outputs = list_raw_output_rows(&transaction, session_id, None)?;
        let event_cursor = max_row_cursor(&events, 0);
        let raw_output_cursor = max_raw_row_cursor(&raw_outputs, 0);
        transaction.commit().map_err(sqlite_error)?;
        return Ok(SessionEventsSinceResult {
            events,
            raw_outputs,
            event_cursor,
            raw_output_cursor,
            change_cursor: Some(head),
            deleted_event_ids: Vec::new(),
            deleted_raw_output_ids: Vec::new(),
            reset_required: true,
            has_more: false,
        });
    }

    let changes = {
        let mut statement = transaction
            .prepare_cached(
                r#"
                SELECT sequence, entity_kind, entity_id
                FROM session_changes
                WHERE session_id = ? AND sequence > ? AND sequence <= ?
                ORDER BY sequence ASC
                LIMIT ?
                "#,
            )
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map(
                (
                    session_id,
                    cursor,
                    head,
                    (SESSION_CHANGE_PAGE_LIMIT + 1) as i64,
                ),
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        rows
    };
    let has_more = changes.len() > SESSION_CHANGE_PAGE_LIMIT;
    let consumed = &changes[..changes.len().min(SESSION_CHANGE_PAGE_LIMIT)];
    let next_cursor = if has_more {
        consumed.last().map(|change| change.0).unwrap_or(cursor)
    } else {
        head
    };

    let mut event_ids = Vec::new();
    let mut raw_output_ids = Vec::new();
    let mut seen_event_ids = HashSet::new();
    let mut seen_raw_output_ids = HashSet::new();
    for (_, entity_kind, entity_id) in consumed {
        match entity_kind.as_str() {
            "event" if seen_event_ids.insert(entity_id.as_str()) => {
                event_ids.push(entity_id.clone());
            }
            "raw_output" if seen_raw_output_ids.insert(entity_id.as_str()) => {
                raw_output_ids.push(entity_id.clone());
            }
            _ => {}
        }
    }

    let events = list_events_by_ids(&transaction, session_id, &event_ids)?;
    let raw_outputs = list_raw_outputs_by_ids(&transaction, session_id, &raw_output_ids)?;
    let current_event_ids = events
        .iter()
        .map(|event| event.id.as_str())
        .collect::<HashSet<_>>();
    let current_raw_output_ids = raw_outputs
        .iter()
        .map(|output| output.id.as_str())
        .collect::<HashSet<_>>();
    let deleted_event_ids = event_ids
        .into_iter()
        .filter(|id| !current_event_ids.contains(id.as_str()))
        .collect();
    let deleted_raw_output_ids = raw_output_ids
        .into_iter()
        .filter(|id| !current_raw_output_ids.contains(id.as_str()))
        .collect();
    let event_cursor = max_row_cursor(&events, 0);
    let raw_output_cursor = max_raw_row_cursor(&raw_outputs, 0);
    transaction.commit().map_err(sqlite_error)?;

    Ok(SessionEventsSinceResult {
        events,
        raw_outputs,
        event_cursor,
        raw_output_cursor,
        change_cursor: Some(next_cursor),
        deleted_event_ids,
        deleted_raw_output_ids,
        reset_required: false,
        has_more,
    })
}

fn change_feed_head(connection: &Connection) -> ArgmaxResult<i64> {
    connection
        .query_row(
            "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'session_changes'), 0)",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sqlite_error)
}

fn list_events_by_ids(
    connection: &Connection,
    session_id: &str,
    ids: &[String],
) -> ArgmaxResult<Vec<TimelineEvent>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT rowid AS row_cursor, id, session_id, type, message, payload_json, created_at \
         FROM events WHERE session_id = ? AND id IN ({placeholders}) ORDER BY rowid ASC"
    );
    let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
    let rows = statement
        .query_map(
            params_from_iter(std::iter::once(session_id).chain(ids.iter().map(String::as_str))),
            event_row_to_timeline_event,
        )
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

fn list_raw_outputs_by_ids(
    connection: &Connection,
    session_id: &str,
    ids: &[String],
) -> ArgmaxResult<Vec<RawProviderOutput>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT rowid AS row_cursor, id, session_id, stream, content, created_at \
         FROM raw_outputs WHERE session_id = ? AND id IN ({placeholders}) ORDER BY rowid ASC"
    );
    let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
    let rows = statement
        .query_map(
            params_from_iter(std::iter::once(session_id).chain(ids.iter().map(String::as_str))),
            raw_output_row_to_provider_output,
        )
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

fn list_event_rows(
    connection: &Connection,
    session_id: &str,
    cursor: Option<i64>,
) -> ArgmaxResult<Vec<TimelineEvent>> {
    match cursor {
        Some(cursor) => {
            let mut statement = connection.prepare_cached("SELECT rowid AS row_cursor, * FROM events WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map(
                    (session_id, cursor, SESSION_EVENT_PAGE_LIMIT as i64),
                    event_row_to_timeline_event,
                )
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
        None => {
            let mut statement = connection.prepare_cached("SELECT * FROM (SELECT rowid AS row_cursor, * FROM events WHERE session_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY row_cursor ASC",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map(
                    (session_id, SESSION_EVENT_PAGE_LIMIT as i64),
                    event_row_to_timeline_event,
                )
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
    }
}

fn list_newest_event_rows(
    connection: &Connection,
    session_id: &str,
    limit: usize,
) -> ArgmaxResult<Vec<TimelineEvent>> {
    let mut statement = connection.prepare_cached("SELECT * FROM (SELECT rowid AS row_cursor, * FROM events WHERE session_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY row_cursor ASC",
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map((session_id, limit as i64), event_row_to_timeline_event)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

fn list_raw_output_rows(
    connection: &Connection,
    session_id: &str,
    cursor: Option<i64>,
) -> ArgmaxResult<Vec<RawProviderOutput>> {
    match cursor {
        Some(cursor) => {
            let mut statement = connection.prepare_cached("SELECT rowid AS row_cursor, * FROM raw_outputs WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map(
                    (session_id, cursor, SESSION_RAW_OUTPUT_PAGE_LIMIT as i64),
                    raw_output_row_to_provider_output,
                )
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
        None => {
            let mut statement = connection.prepare_cached("SELECT * FROM (SELECT rowid AS row_cursor, * FROM raw_outputs WHERE session_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY row_cursor ASC",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map(
                    (session_id, SESSION_RAW_OUTPUT_PAGE_LIMIT as i64),
                    raw_output_row_to_provider_output,
                )
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        }
    }
}

fn event_row_to_timeline_event(row: &Row<'_>) -> rusqlite::Result<TimelineEvent> {
    let payload_json: String = row.get("payload_json")?;
    Ok(TimelineEvent {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        r#type: row.get("type")?,
        message: row.get("message")?,
        payload: parse_event_payload(&payload_json),
        created_at: row.get("created_at")?,
        row_cursor: Some(row.get("row_cursor")?),
    })
}

fn parse_event_payload(payload_json: &str) -> Value {
    match serde_json::from_str(payload_json) {
        Ok(payload) => payload,
        Err(error) => {
            let raw_payload: String = payload_json
                .chars()
                .take(INVALID_PAYLOAD_PREVIEW_CHARS)
                .collect();
            let raw_payload_truncated =
                payload_json.chars().count() > INVALID_PAYLOAD_PREVIEW_CHARS;
            tracing::warn!(?error, "invalid timeline event payload json");
            json!({
                "parseError": true,
                "error": error.to_string(),
                "rawPayload": raw_payload,
                "rawPayloadTruncated": raw_payload_truncated,
            })
        }
    }
}

fn object_field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    object_field(value, key).and_then(Value::as_str)
}

fn object_path_string<'a>(value: &'a Value, first: &str, second: &str) -> Option<&'a str> {
    object_field(value, first)
        .and_then(Value::as_object)
        .and_then(|object| object.get(second))
        .and_then(Value::as_str)
}

pub(crate) fn tool_use_id_for_payload(payload: &Value) -> Option<&str> {
    string_field(payload, "id").or_else(|| string_field(payload, "call_id"))
}

pub(crate) fn completion_id_for_payload(payload: &Value) -> Option<&str> {
    string_field(payload, "tool_use_id")
        .or_else(|| string_field(payload, "id"))
        .or_else(|| string_field(payload, "call_id"))
}

fn parent_tool_use_id_for_payload(payload: &Value) -> Option<&str> {
    string_field(payload, "parent_tool_use_id")
}

fn receiver_thread_ids_for_payload(payload: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for value in [
        object_field(payload, "receiver_thread_ids"),
        object_field(payload, "input")
            .and_then(Value::as_object)
            .and_then(|input| input.get("receiver_thread_ids")),
    ] {
        let Some(array) = value.and_then(Value::as_array) else {
            continue;
        };
        ids.extend(
            array
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
        );
    }
    ids
}

fn is_parent_agent_event(row: &TimelineEvent, parent_tool_use_id: &str) -> bool {
    match row.r#type.as_str() {
        "command.started" => tool_use_id_for_payload(&row.payload) == Some(parent_tool_use_id),
        "command.completed" => completion_id_for_payload(&row.payload) == Some(parent_tool_use_id),
        _ => false,
    }
}

fn is_agent_message_for_threads(
    payload: &Value,
    receiver_thread_ids: &std::collections::HashSet<String>,
) -> bool {
    if receiver_thread_ids.is_empty() {
        return false;
    }
    let item_type = object_field(payload, "item")
        .and_then(Value::as_object)
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .or_else(|| string_field(payload, "item_type"));
    if item_type != Some("agent_message") {
        return false;
    }
    [
        string_field(payload, "thread_id"),
        string_field(payload, "sender_thread_id"),
        object_path_string(payload, "item", "thread_id"),
        object_path_string(payload, "item", "sender_thread_id"),
    ]
    .into_iter()
    .flatten()
    .any(|id| receiver_thread_ids.contains(id))
}

fn raw_output_row_to_provider_output(row: &Row<'_>) -> rusqlite::Result<RawProviderOutput> {
    Ok(RawProviderOutput {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        stream: row.get("stream")?,
        content: row.get("content")?,
        created_at: row.get("created_at")?,
        row_cursor: Some(row.get("row_cursor")?),
    })
}

fn max_row_cursor(rows: &[TimelineEvent], fallback: i64) -> i64 {
    rows.iter()
        .filter_map(|row| row.row_cursor)
        .max()
        .unwrap_or(fallback)
}

fn max_raw_row_cursor(rows: &[RawProviderOutput], fallback: i64) -> i64 {
    rows.iter()
        .filter_map(|row| row.row_cursor)
        .max()
        .unwrap_or(fallback)
}

#[cfg(test)]
mod change_feed_tests {
    use super::*;
    use crate::persistence::Database;

    const TIME: &str = "2026-09-05T10:00:00.000Z";

    #[test]
    fn initial_tail_establishes_an_exact_revision_boundary() {
        let database = seeded_database();
        let connection = database.connection();
        insert_event(&connection, "e1", "s1", "one");

        let initial =
            list_session_changes_since(&connection, "s1", None, None, None).expect("initial");
        assert!(initial.reset_required);
        assert!(!initial.has_more);
        assert_eq!(ids(&initial.events), vec!["e1"]);
        assert_eq!(
            initial.change_cursor,
            Some(change_feed_head(&connection).expect("feed head"))
        );

        insert_event(&connection, "e2", "s1", "two");
        let next = list_session_changes_since(&connection, "s1", None, None, initial.change_cursor)
            .expect("incremental");
        assert!(!next.reset_required);
        assert_eq!(ids(&next.events), vec!["e2"]);
        assert!(next.deleted_event_ids.is_empty());
    }

    #[test]
    fn upgrading_existing_rows_starts_with_an_authoritative_tail_without_backfill() {
        use crate::persistence::migrations::{run_migrations_with, MIGRATIONS};

        let mut connection = Connection::open_in_memory().expect("open database");
        run_migrations_with(&mut connection, &MIGRATIONS[..27]).expect("migrate through v27");
        seed_connection(&connection);
        insert_event(&connection, "legacy", "s1", "before upgrade");

        run_migrations_with(&mut connection, MIGRATIONS).expect("apply v28");
        let backfilled = connection
            .query_row("SELECT COUNT(*) FROM session_changes", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count revisions");
        assert_eq!(backfilled, 0);

        let initial =
            list_session_changes_since(&connection, "s1", None, None, None).expect("initial");
        assert!(initial.reset_required);
        assert_eq!(initial.change_cursor, Some(0));
        assert_eq!(ids(&initial.events), vec!["legacy"]);

        connection
            .execute(
                "UPDATE events SET message = 'after upgrade' WHERE id = 'legacy'",
                [],
            )
            .expect("update legacy row");
        let next = list_session_changes_since(&connection, "s1", None, None, initial.change_cursor)
            .expect("incremental");
        assert_eq!(next.events[0].message, "after upgrade");
        assert_eq!(next.change_cursor, Some(1));
    }

    #[test]
    fn revisions_cover_updates_deletes_raw_output_and_reparenting() {
        let database = seeded_database();
        let connection = database.connection();
        insert_event(&connection, "e1", "s1", "one");
        insert_raw(&connection, "r1", "s1", "raw one");
        let s1_cursor = initial_cursor(&connection, "s1");
        let s2_cursor = initial_cursor(&connection, "s2");

        connection
            .execute("UPDATE events SET message = 'updated' WHERE id = 'e1'", [])
            .expect("update event");
        connection
            .execute(
                "UPDATE raw_outputs SET content = 'raw updated' WHERE id = 'r1'",
                [],
            )
            .expect("update raw");
        let updated = list_session_changes_since(&connection, "s1", None, None, Some(s1_cursor))
            .expect("updated page");
        assert_eq!(updated.events[0].message, "updated");
        assert_eq!(updated.raw_outputs[0].content, "raw updated");

        let updated_cursor = updated.change_cursor.expect("updated cursor");
        connection
            .execute("UPDATE events SET session_id = 's2' WHERE id = 'e1'", [])
            .expect("reparent event");
        connection
            .execute(
                "UPDATE raw_outputs SET session_id = 's2' WHERE id = 'r1'",
                [],
            )
            .expect("reparent raw output");

        let old_session =
            list_session_changes_since(&connection, "s1", None, None, Some(updated_cursor))
                .expect("old session page");
        assert_eq!(old_session.deleted_event_ids, vec!["e1"]);
        assert_eq!(old_session.deleted_raw_output_ids, vec!["r1"]);
        assert!(old_session.events.is_empty());
        assert!(old_session.raw_outputs.is_empty());

        let new_session =
            list_session_changes_since(&connection, "s2", None, None, Some(s2_cursor))
                .expect("new session page");
        assert_eq!(ids(&new_session.events), vec!["e1"]);
        assert_eq!(new_session.events[0].session_id, "s2");
        assert_eq!(new_session.raw_outputs[0].id, "r1");
        assert_eq!(new_session.raw_outputs[0].session_id, "s2");

        connection
            .execute("DELETE FROM raw_outputs WHERE id = 'r1'", [])
            .expect("delete raw output");
        let after_delete =
            list_session_changes_since(&connection, "s2", None, None, new_session.change_cursor)
                .expect("raw deletion page");
        assert_eq!(after_delete.deleted_raw_output_ids, vec!["r1"]);

        let operations: Vec<(String, String, String, String)> = connection
            .prepare(
                "SELECT session_id, entity_kind, entity_id, operation FROM session_changes ORDER BY sequence",
            )
            .expect("prepare operations")
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("read operations")
            .collect::<Result<_, _>>()
            .expect("collect operations");
        assert!(operations.contains(&(
            "s1".to_owned(),
            "event".to_owned(),
            "e1".to_owned(),
            "delete".to_owned(),
        )));
        assert!(operations.contains(&(
            "s2".to_owned(),
            "raw_output".to_owned(),
            "r1".to_owned(),
            "upsert".to_owned(),
        )));
        assert_eq!(
            operations.last(),
            Some(&(
                "s2".to_owned(),
                "raw_output".to_owned(),
                "r1".to_owned(),
                "delete".to_owned(),
            ))
        );
    }

    #[test]
    fn ignored_id_collision_then_delete_is_visible() {
        let database = seeded_database();
        let connection = database.connection();
        insert_event(&connection, "kept", "s1", "kept");
        insert_event(&connection, "duplicate", "s1", "duplicate");
        let cursor = initial_cursor(&connection, "s1");
        let duplicate_rowid = connection
            .query_row(
                "SELECT rowid FROM events WHERE id = 'duplicate'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("duplicate rowid");

        let changed = rewrite_trace_event(
            &connection,
            duplicate_rowid,
            "kept",
            &serde_json::json!({ "traceImported": true }),
        )
        .expect("ignored collision");
        assert!(!changed);
        delete_event_row(&connection, duplicate_rowid).expect("delete duplicate");

        let page = list_session_changes_since(&connection, "s1", None, None, Some(cursor))
            .expect("collision page");
        assert_eq!(page.deleted_event_ids, vec!["duplicate"]);
        assert!(page.events.is_empty());
    }

    #[test]
    fn rolled_back_writes_leave_no_revision() {
        let database = seeded_database();
        let connection = database.connection();
        let cursor = initial_cursor(&connection, "s1");

        let transaction = connection
            .unchecked_transaction()
            .expect("begin transaction");
        insert_event(&transaction, "rolled-back", "s1", "temporary");
        transaction.rollback().expect("rollback");

        let page = list_session_changes_since(&connection, "s1", None, None, Some(cursor))
            .expect("read after rollback");
        assert!(page.events.is_empty());
        assert!(page.deleted_event_ids.is_empty());
        assert_eq!(page.change_cursor, Some(cursor));
    }

    #[test]
    fn revision_pages_do_not_skip_a_busy_session() {
        let database = seeded_database();
        let connection = database.connection();
        insert_event(&connection, "e1", "s1", "zero");
        let cursor = initial_cursor(&connection, "s1");
        for index in 0..=SESSION_CHANGE_PAGE_LIMIT {
            connection
                .execute(
                    "UPDATE events SET message = ? WHERE id = 'e1'",
                    (format!("message {index}"),),
                )
                .expect("update event");
        }

        let first = list_session_changes_since(&connection, "s1", None, None, Some(cursor))
            .expect("first page");
        assert!(first.has_more);
        assert_eq!(
            first.events.first().map(|event| event.message.as_str()),
            Some("message 500")
        );
        let first_cursor = first.change_cursor.expect("first cursor");

        let second = list_session_changes_since(&connection, "s1", None, None, Some(first_cursor))
            .expect("second page");
        assert!(!second.has_more);
        assert_eq!(
            second.events.first().map(|event| event.message.as_str()),
            Some("message 500")
        );
        assert!(second.change_cursor.expect("second cursor") > first_cursor);
    }

    #[test]
    fn a_pruned_session_cursor_and_future_cursor_request_replacement() {
        let database = seeded_database();
        let connection = database.connection();
        insert_event(&connection, "e1", "s1", "current");
        let head = change_feed_head(&connection).expect("head");
        connection
            .execute(
                "INSERT INTO session_change_watermarks (session_id, pruned_through) VALUES ('s1', ?)",
                (head,),
            )
            .expect("watermark");

        let stale = list_session_changes_since(&connection, "s1", None, None, Some(head - 1))
            .expect("stale reset");
        assert!(stale.reset_required);
        assert_eq!(ids(&stale.events), vec!["e1"]);
        assert_eq!(stale.change_cursor, Some(head));

        let future = list_session_changes_since(&connection, "s1", None, None, Some(head + 100))
            .expect("future reset");
        assert!(future.reset_required);
        assert_eq!(future.change_cursor, Some(head));
    }

    #[test]
    fn trigger_pruning_records_the_session_watermark_and_keeps_the_head() {
        let database = seeded_database();
        let connection = database.connection();
        insert_event(&connection, "e1", "s1", "one");
        connection
            .execute(
                "UPDATE sqlite_sequence SET seq = 50175 WHERE name = 'session_changes'",
                [],
            )
            .expect("advance sequence near retention boundary");
        connection
            .execute("UPDATE events SET message = 'two' WHERE id = 'e1'", [])
            .expect("trigger pruning");

        let retained: Vec<i64> = connection
            .prepare("SELECT sequence FROM session_changes ORDER BY sequence")
            .expect("prepare retained revisions")
            .query_map([], |row| row.get(0))
            .expect("read retained revisions")
            .collect::<Result<_, _>>()
            .expect("collect retained revisions");
        let watermark = connection
            .query_row(
                "SELECT pruned_through FROM session_change_watermarks WHERE session_id = 's1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("read watermark");
        assert_eq!(retained, vec![50176]);
        assert_eq!(watermark, 1);

        connection
            .execute("DELETE FROM sessions WHERE id = 's1'", [])
            .expect("delete session");
        let orphan_counts = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM session_changes WHERE session_id = 's1'),
                   (SELECT COUNT(*) FROM session_change_watermarks WHERE session_id = 's1')",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("count orphan feed rows");
        assert_eq!(orphan_counts, (0, 0));
        assert_eq!(
            change_feed_head(&connection).expect("head survives empty feed"),
            50177
        );
    }

    #[test]
    fn negative_change_cursor_is_rejected() {
        let database = seeded_database();
        let connection = database.connection();
        let error = list_session_changes_since(&connection, "s1", None, None, Some(-1))
            .expect_err("negative cursor");
        assert!(matches!(error, ArgmaxError::InvalidInput { .. }));
    }

    fn seeded_database() -> Database {
        let database = Database::open_in_memory().expect("open database");
        let connection = database.connection();
        seed_connection(&connection);
        drop(connection);
        database
    }

    fn seed_connection(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO projects (id, name, repo_path, current_branch, worktree_location, created_at, updated_at) VALUES ('p1', 'Project', '/tmp/change-feed-project', 'main', '/tmp/worktrees', ?, ?)",
                (TIME, TIME),
            )
            .expect("insert project");
        connection
            .execute(
                "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES ('w1', 'p1', 'Task', 'main', 'main', '/tmp/change-feed-workspace', 'running', ?, ?, ?)",
                (TIME, TIME, TIME),
            )
            .expect("insert workspace");
        for session_id in ["s1", "s2"] {
            connection
                .execute(
                    "INSERT INTO sessions (id, workspace_id, provider, model_label, prompt, state, attention, started_at, last_activity_at) VALUES (?, 'w1', 'codex', 'Default', 'Prompt', 'running', 'normal', ?, ?)",
                    (session_id, TIME, TIME),
                )
                .expect("insert session");
        }
    }

    fn insert_event(connection: &Connection, id: &str, session_id: &str, message: &str) {
        persist_timeline_event(
            connection,
            &PersistTimelineEventInput {
                id: id.to_owned(),
                session_id: session_id.to_owned(),
                r#type: "message.completed".to_owned(),
                message: message.to_owned(),
                payload: serde_json::json!({}),
                created_at: Some(TIME.to_owned()),
            },
        )
        .expect("insert event");
    }

    fn insert_raw(connection: &Connection, id: &str, session_id: &str, content: &str) {
        persist_raw_output(
            connection,
            &PersistRawOutputInput {
                id: id.to_owned(),
                session_id: session_id.to_owned(),
                stream: "stdout".to_owned(),
                content: content.to_owned(),
                created_at: Some(TIME.to_owned()),
            },
        )
        .expect("insert raw output");
    }

    fn initial_cursor(connection: &Connection, session_id: &str) -> i64 {
        list_session_changes_since(connection, session_id, None, None, None)
            .expect("initial tail")
            .change_cursor
            .expect("initial cursor")
    }

    fn ids(events: &[TimelineEvent]) -> Vec<&str> {
        events.iter().map(|event| event.id.as_str()).collect()
    }
}
