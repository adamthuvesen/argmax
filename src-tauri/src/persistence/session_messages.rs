//! The session inbox: messages one session's agent addressed to another, and
//! the completion notice a launched session leaves for whoever launched it.
//!
//! A row here is the durable record. Delivery is separate: the same message is
//! also handed to `ProviderSessionService::send_input`, which starts a turn in
//! an idle recipient or queues it until the running one finishes. `inbox_read`
//! and `session_wait` read the rows, so an agent that never sees the turn (it
//! was mid-turn, or it is polling on purpose) can still collect what arrived.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

/// What a row is: an agent writing to another session, or the automatic notice
/// that a launched session's turn ended.
pub const MESSAGE_KIND: &str = "message";
pub const COMPLETION_KIND: &str = "completion";

/// How much of a body the row keeps. The stored row is the fallback copy of a
/// message, not a transcript: the reply that hands it back has a hard byte
/// ceiling, so an uncapped body — a quarter-megabyte prompt, say — would make
/// `inbox_read` fail instead of delivering anything.
pub const MAX_MESSAGE_BODY_CHARS: usize = 16 * 1024;
const TRUNCATION_MARKER: &str = "\n\n(truncated)";

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_session_id: Option<String>,
    pub to_session_id: String,
    pub body: String,
    pub kind: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewSessionMessage {
    /// Deterministic for a completion (`completion:<session>:<completed_at>`),
    /// random for an agent's message. A completion that is retried therefore
    /// writes the same row instead of a duplicate notice.
    pub id: String,
    pub from_session_id: Option<String>,
    pub to_session_id: String,
    pub body: String,
    pub kind: String,
}

/// Insert the row, unless that id is already there. Returns whether this call
/// is the one that created it — the caller only delivers a message it owns.
pub fn insert_session_message(
    connection: &Connection,
    message: &NewSessionMessage,
) -> ArgmaxResult<bool> {
    let inserted = connection
        .prepare_cached(
            "INSERT OR IGNORE INTO session_messages
               (id, from_session_id, to_session_id, body, kind, created_at, delivered_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL)",
        )
        .map_err(sqlite_error)?
        .execute((
            &message.id,
            &message.from_session_id,
            &message.to_session_id,
            cap_message_body(&message.body),
            &message.kind,
            now_iso(),
        ))
        .map_err(sqlite_error)?;
    Ok(inserted > 0)
}

pub fn mark_message_delivered(connection: &Connection, id: &str) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            "UPDATE session_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL",
        )
        .map_err(sqlite_error)?
        .execute((now_iso(), id))
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn count_undelivered_messages(
    connection: &Connection,
    to_session_id: &str,
) -> ArgmaxResult<i64> {
    connection
        .prepare_cached(
            "SELECT COUNT(*) FROM session_messages WHERE to_session_id = ? AND delivered_at IS NULL",
        )
        .map_err(sqlite_error)?
        .query_row([to_session_id], |row| row.get(0))
        .map_err(sqlite_error)
}

pub fn list_undelivered_messages(
    connection: &Connection,
    to_session_id: &str,
    limit: usize,
) -> ArgmaxResult<Vec<SessionMessage>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT id, from_session_id, to_session_id, body, kind, created_at, delivered_at
             FROM session_messages
             WHERE to_session_id = ? AND delivered_at IS NULL
             ORDER BY created_at ASC, rowid ASC
             LIMIT ?",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map((to_session_id, limit as i64), |row| {
            Ok(SessionMessage {
                id: row.get(0)?,
                from_session_id: row.get(1)?,
                to_session_id: row.get(2)?,
                body: row.get(3)?,
                kind: row.get(4)?,
                created_at: row.get(5)?,
                delivered_at: row.get(6)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Undelivered messages of one kind, oldest first. The multitask preamble
/// reads its own kind rather than draining the inbox, so an agent's message
/// waiting for `inbox_read` is left where it is.
pub fn list_undelivered_messages_of_kind(
    connection: &Connection,
    to_session_id: &str,
    kind: &str,
    limit: usize,
) -> ArgmaxResult<Vec<SessionMessage>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT id, from_session_id, to_session_id, body, kind, created_at, delivered_at
             FROM session_messages
             WHERE to_session_id = ? AND kind = ? AND delivered_at IS NULL
             ORDER BY created_at ASC, rowid ASC
             LIMIT ?",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map((to_session_id, kind, limit as i64), |row| {
            Ok(SessionMessage {
                id: row.get(0)?,
                from_session_id: row.get(1)?,
                to_session_id: row.get(2)?,
                body: row.get(3)?,
                kind: row.get(4)?,
                created_at: row.get(5)?,
                delivered_at: row.get(6)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Read the caller's undelivered messages and mark them delivered in one
/// transaction, so two concurrent `inbox_read` calls cannot both take the same
/// message.
///
/// Only the prefix that fits `max_bytes` is taken. A row marked delivered
/// inside a reply the client then rejects for being too large is a message
/// nobody ever reads, so what does not fit stays undelivered and comes back on
/// the next read. The first message is always taken, so no single row can
/// wedge the inbox.
pub fn take_undelivered_messages(
    connection: &mut Connection,
    to_session_id: &str,
    limit: usize,
    max_bytes: usize,
) -> ArgmaxResult<Vec<SessionMessage>> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let candidates = list_undelivered_messages(&transaction, to_session_id, limit)?;
    let mut messages = Vec::new();
    let mut spent = 0usize;
    for message in candidates {
        let cost = message.body.len();
        if !messages.is_empty() && spent + cost > max_bytes {
            break;
        }
        spent += cost;
        messages.push(message);
    }
    let delivered_at = now_iso();
    for message in &messages {
        transaction
            .prepare_cached("UPDATE session_messages SET delivered_at = ? WHERE id = ?")
            .map_err(sqlite_error)?
            .execute((&delivered_at, &message.id))
            .map_err(sqlite_error)?;
    }
    transaction.commit().map_err(sqlite_error)?;
    Ok(messages
        .into_iter()
        .map(|message| SessionMessage {
            delivered_at: Some(delivered_at.clone()),
            ..message
        })
        .collect())
}

fn cap_message_body(body: &str) -> String {
    if body.chars().count() <= MAX_MESSAGE_BODY_CHARS {
        return body.to_string();
    }
    let mut capped: String = body.chars().take(MAX_MESSAGE_BODY_CHARS).collect();
    capped.push_str(TRUNCATION_MARKER);
    capped
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE_ERROR", error.to_string())
}
