//! The journal of remote mutations, keyed by client and operation id. Replays
//! return the recorded outcome. See docs/remote.md.

use rusqlite::{Connection, OptionalExtension};

use super::sqlite_error;
use argmax_contracts::error::ArgmaxResult;

/// Records a new operation. `false` means the identity was already journaled.
pub fn admit_operation(
    connection: &Connection,
    client_id: &str,
    operation_id: &str,
    request_digest: &str,
    run_id: &str,
) -> ArgmaxResult<bool> {
    let inserted = connection
        .execute(
            "INSERT OR IGNORE INTO remote_operations
         (client_id, operation_id, request_digest, run_id, created_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
            (client_id, operation_id, request_digest, run_id),
        )
        .map_err(sqlite_error)?;
    Ok(inserted == 1)
}

/// `(request digest, run id, outcome)` of a journaled operation.
pub fn find_operation(
    connection: &Connection,
    client_id: &str,
    operation_id: &str,
) -> ArgmaxResult<(String, String, Option<String>)> {
    connection
        .query_row(
            "SELECT request_digest, run_id, outcome_json FROM remote_operations
         WHERE client_id = ?1 AND operation_id = ?2",
            (client_id, operation_id),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(sqlite_error)
}

pub fn saved_outcome(
    connection: &Connection,
    client_id: &str,
    operation_id: &str,
) -> ArgmaxResult<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT outcome_json FROM remote_operations WHERE client_id = ?1 AND operation_id = ?2",
            (client_id, operation_id),
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?
        .flatten())
}

pub fn save_outcome(
    connection: &Connection,
    client_id: &str,
    operation_id: &str,
    outcome_json: &str,
) -> ArgmaxResult<()> {
    connection
        .execute(
            "UPDATE remote_operations SET outcome_json = ?3 WHERE client_id = ?1 AND operation_id = ?2",
            (client_id, operation_id, outcome_json),
        )
        .map_err(sqlite_error)?;
    Ok(())
}
