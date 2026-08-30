//! Bookkeeping for sessions imported from a provider CLI's own transcript
//! store (see `crate::sync`). The provider's files stay the source of truth,
//! so an un-adopted import is disposable: turning sync off, shrinking the
//! window, or losing the source file prunes it, and re-enabling re-imports.
//! `adopted` flips the first time the user continues the session inside
//! Argmax, after which it is an ordinary session and is never pruned.

use rusqlite::Connection;

use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq)]
pub struct SyncedSessionRecord {
    pub session_id: String,
    pub provider: String,
    pub external_id: String,
    pub source_path: String,
    pub byte_cursor: u64,
    pub source_mtime_ms: i64,
    pub adopted: bool,
    pub started_at: String,
}

pub fn upsert_synced_session(
    connection: &Connection,
    record: &SyncedSessionRecord,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            INSERT INTO synced_sessions (
              session_id, provider, external_id, source_path, byte_cursor,
              source_mtime_ms, adopted, started_at, last_synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              source_path = excluded.source_path,
              byte_cursor = excluded.byte_cursor,
              source_mtime_ms = excluded.source_mtime_ms,
              last_synced_at = excluded.last_synced_at
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            record.session_id.as_str(),
            record.provider.as_str(),
            record.external_id.as_str(),
            record.source_path.as_str(),
            record.byte_cursor as i64,
            record.source_mtime_ms,
            i64::from(record.adopted),
            record.started_at.as_str(),
            now_iso().as_str(),
        ))
        .map_err(sqlite_error)?;
    Ok(())
}

/// Every synced session for a provider, newest first.
pub fn list_synced_sessions(
    connection: &Connection,
    provider: &str,
) -> ArgmaxResult<Vec<SyncedSessionRecord>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT session_id, provider, external_id, source_path, byte_cursor,
                    source_mtime_ms, adopted, started_at
             FROM synced_sessions WHERE provider = ? ORDER BY started_at DESC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([provider], |row| {
            Ok(SyncedSessionRecord {
                session_id: row.get("session_id")?,
                provider: row.get("provider")?,
                external_id: row.get("external_id")?,
                source_path: row.get("source_path")?,
                byte_cursor: row.get::<_, i64>("byte_cursor")?.max(0) as u64,
                source_mtime_ms: row.get("source_mtime_ms")?,
                adopted: row.get::<_, i64>("adopted")? != 0,
                started_at: row.get("started_at")?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Provider conversation ids Argmax already knows about, whether it launched
/// them or imported them. The scanner skips these so a session Argmax started
/// is never imported as a duplicate of itself.
pub fn known_conversation_ids(
    connection: &Connection,
    provider: &str,
) -> ArgmaxResult<std::collections::HashSet<String>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT provider_conversation_id FROM sessions
             WHERE provider = ? AND provider_conversation_id IS NOT NULL",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([provider], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Called the first time the user sends into an imported session: it stops
/// being disposable. Idempotent, and a no-op for sessions Argmax launched.
pub fn mark_synced_session_adopted(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<bool> {
    let changed = connection
        .prepare_cached(
            "UPDATE synced_sessions SET adopted = 1 WHERE session_id = ? AND adopted = 0",
        )
        .map_err(sqlite_error)?
        .execute([session_id])
        .map_err(sqlite_error)?;
    Ok(changed > 0)
}

/// Session ids of un-adopted imports for a provider — everything the pruner
/// may delete. `before` (an ISO timestamp) additionally restricts to sessions
/// whose last activity predates it, which is how a window shrink is applied.
///
/// Last activity, not start time: discovery selects transcripts by file
/// mtime, so pruning on start time would delete a long-running session that
/// is still active and then re-import it on the same sweep.
pub fn prunable_session_ids(
    connection: &Connection,
    provider: &str,
    before: Option<&str>,
) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT synced_sessions.session_id FROM synced_sessions
             JOIN sessions ON sessions.id = synced_sessions.session_id
             WHERE synced_sessions.provider = ? AND synced_sessions.adopted = 0
               AND (?2 IS NULL OR sessions.last_activity_at < ?2)",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(rusqlite::params![provider, before], |row| {
            row.get::<_, String>(0)
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}
