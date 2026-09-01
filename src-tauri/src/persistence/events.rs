use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};
use specta::Type;

use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

const INVALID_PAYLOAD_PREVIEW_CHARS: usize = 512;

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
}

pub const SESSION_EVENT_PAGE_LIMIT: usize = 500;
pub const SESSION_RAW_OUTPUT_PAGE_LIMIT: usize = 100;
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
    })
}

pub fn list_session_agent_events(
    connection: &Connection,
    session_id: &str,
    parent_tool_use_id: &str,
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

    let events = rows
        .into_iter()
        .filter(|row| included_ids.contains(&row.id))
        .collect::<Vec<_>>();
    let next_event_cursor = max_row_cursor(&events, 0);

    Ok(SessionEventsSinceResult {
        events,
        raw_outputs: Vec::new(),
        event_cursor: next_event_cursor,
        raw_output_cursor: 0,
    })
}

pub fn persist_timeline_event(
    connection: &Connection,
    input: &PersistTimelineEventInput,
) -> ArgmaxResult<TimelineEvent> {
    let created_at = input.created_at.clone().unwrap_or_else(now_iso);
    let payload_json = serde_json::to_string(&input.payload).map_err(json_error)?;
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
        payload: input.payload.clone(),
        created_at,
        row_cursor: Some(connection.last_insert_rowid()),
    })
}

/// Returns the persisted event when the row was new, `None` when the id
/// already existed — the sync sweep republishes fresh events from that return
/// value without a second read.
pub fn persist_timeline_event_if_absent(
    connection: &Connection,
    input: &PersistTimelineEventInput,
) -> ArgmaxResult<Option<TimelineEvent>> {
    let created_at = input.created_at.clone().unwrap_or_else(now_iso);
    let payload_json = serde_json::to_string(&input.payload).map_err(json_error)?;
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
        payload: input.payload.clone(),
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
pub fn latest_agent_message(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<String>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT message
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

fn tool_use_id_for_payload(payload: &Value) -> Option<&str> {
    string_field(payload, "id").or_else(|| string_field(payload, "call_id"))
}

fn completion_id_for_payload(payload: &Value) -> Option<&str> {
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

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn json_error(error: serde_json::Error) -> ArgmaxError {
    ArgmaxError::service("JSON", error.to_string())
}
