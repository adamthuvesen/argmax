use rusqlite::{Connection, Row};
use serde::Serialize;

use super::prepared::prepared;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub id: String,
    pub session_id: String,
    pub r#type: String,
    pub message: String,
    pub payload: serde_json::Value,
    pub created_at: String,
    pub row_cursor: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawProviderOutput {
    pub id: String,
    pub session_id: String,
    pub stream: String,
    pub content: String,
    pub created_at: String,
    pub row_cursor: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventsSinceResult {
    pub events: Vec<TimelineEvent>,
    pub raw_outputs: Vec<RawProviderOutput>,
    pub event_cursor: i64,
    pub raw_output_cursor: i64,
}

pub const SESSION_EVENT_PAGE_LIMIT: usize = 500;
pub const SESSION_RAW_OUTPUT_PAGE_LIMIT: usize = 100;

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

pub fn list_dashboard_events(
    connection: &Connection,
    limit: usize,
) -> ArgmaxResult<Vec<TimelineEvent>> {
    let mut statement = prepared(
        connection,
        "SELECT rowid AS row_cursor, * FROM events ORDER BY rowid DESC LIMIT ?",
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map([limit as i64], event_row_to_timeline_event)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn list_dashboard_raw_outputs(
    connection: &Connection,
    limit: usize,
) -> ArgmaxResult<Vec<RawProviderOutput>> {
    let mut statement = prepared(
        connection,
        "SELECT rowid AS row_cursor, * FROM raw_outputs ORDER BY rowid DESC LIMIT ?",
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map([limit as i64], raw_output_row_to_provider_output)
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
            let mut statement = prepared(
                connection,
                "SELECT rowid AS row_cursor, * FROM events WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
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
            let mut statement = prepared(
                connection,
                "SELECT * FROM (SELECT rowid AS row_cursor, * FROM events WHERE session_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY row_cursor ASC",
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

fn list_raw_output_rows(
    connection: &Connection,
    session_id: &str,
    cursor: Option<i64>,
) -> ArgmaxResult<Vec<RawProviderOutput>> {
    match cursor {
        Some(cursor) => {
            let mut statement = prepared(
                connection,
                "SELECT rowid AS row_cursor, * FROM raw_outputs WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
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
            let mut statement = prepared(
                connection,
                "SELECT * FROM (SELECT rowid AS row_cursor, * FROM raw_outputs WHERE session_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY row_cursor ASC",
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
        payload: serde_json::from_str(&payload_json).unwrap_or_else(|_| serde_json::json!({})),
        created_at: row.get("created_at")?,
        row_cursor: row.get("row_cursor").ok(),
    })
}

fn raw_output_row_to_provider_output(row: &Row<'_>) -> rusqlite::Result<RawProviderOutput> {
    Ok(RawProviderOutput {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        stream: row.get("stream")?,
        content: row.get("content")?,
        created_at: row.get("created_at")?,
        row_cursor: row.get("row_cursor").ok(),
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
