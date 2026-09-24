//! Composer placeholders minted for a finished turn, kept across restarts.
//!
//! Minting one boots a provider CLI (about 5 s and 1.7 CPU-seconds for
//! Claude), and the renderer's in-memory cache is empty after every launch, so
//! each chat a user opened re-ran it. A suggestion answers one agent message,
//! so it is stored against a digest of that message: an unchanged turn reuses
//! it, and a new turn simply misses. One row per session, in `ui_state`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::ArgmaxResult;

use super::{sqlite_error, time::now_iso};

const KEY_PREFIX: &str = "follow_up.suggestion.";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSuggestion {
    message_digest: String,
    suggestion: String,
}

fn message_digest(message: &str) -> String {
    Sha256::digest(message.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The suggestion already minted for `message`, if this session has one.
pub fn cached_follow_up_suggestion(
    connection: &Connection,
    session_id: &str,
    message: &str,
) -> ArgmaxResult<Option<String>> {
    let stored: Option<String> = connection
        .prepare_cached("SELECT value_json FROM ui_state WHERE key = ?")
        .map_err(sqlite_error)?
        .query_row(params![format!("{KEY_PREFIX}{session_id}")], |row| {
            row.get(0)
        })
        .optional()
        .map_err(sqlite_error)?;
    // A row this build cannot read is a cache miss, not an error.
    Ok(stored
        .and_then(|value| serde_json::from_str::<StoredSuggestion>(&value).ok())
        .filter(|stored| stored.message_digest == message_digest(message))
        .map(|stored| stored.suggestion))
}

pub fn store_follow_up_suggestion(
    connection: &Connection,
    session_id: &str,
    message: &str,
    suggestion: &str,
) -> ArgmaxResult<()> {
    let value = serde_json::to_string(&StoredSuggestion {
        message_digest: message_digest(message),
        suggestion: suggestion.to_owned(),
    })
    .map_err(super::json_error)?;
    connection
        .prepare_cached(
            "INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        )
        .map_err(sqlite_error)?
        .execute(params![format!("{KEY_PREFIX}{session_id}"), value, now_iso()])
        .map_err(sqlite_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::Database;

    #[test]
    fn a_suggestion_is_reused_only_for_the_message_it_answers() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        assert_eq!(
            cached_follow_up_suggestion(&connection, "s1", "Done.").unwrap(),
            None
        );

        store_follow_up_suggestion(&connection, "s1", "Done.", "Ship it").unwrap();
        assert_eq!(
            cached_follow_up_suggestion(&connection, "s1", "Done.")
                .unwrap()
                .as_deref(),
            Some("Ship it")
        );
        assert_eq!(
            cached_follow_up_suggestion(&connection, "s1", "Done again.").unwrap(),
            None
        );
        assert_eq!(
            cached_follow_up_suggestion(&connection, "s2", "Done.").unwrap(),
            None
        );
    }
}
