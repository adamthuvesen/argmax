// Turn waterfalls: one row per provider turn that says where the time went
// between the user's send and the first painted answer
// (docs/performance.md#turn-waterfall). The rows are field data from daily
// use, so the table keeps only the newest `RETAINED_TURN_WATERFALLS`.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{json_error, sqlite_error, time::now_iso};
use argmax_contracts::error::ArgmaxResult;

/// Registered by migration v76.
pub const MIGRATION_SQL: &str = r#"
CREATE TABLE turn_waterfalls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_key TEXT,
  provider TEXT,
  stamps_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_turn_waterfalls_session ON turn_waterfalls(session_id);
"#;

/// Enough turns for a few days of use; each row is well under 1 KB.
pub const RETAINED_TURN_WATERFALLS: i64 = 500;

/// One step of a turn, in milliseconds from the moment the send reached the
/// backend (`ipc_received`). `submit` is negative: the click came first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnStamp {
    pub name: String,
    pub offset_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnWaterfall {
    pub id: i64,
    pub session_id: String,
    /// The `user.message` event id the turn answers, when one was persisted.
    pub turn_key: Option<String>,
    pub provider: Option<String>,
    /// In the order the steps happen in a turn, not sorted by time.
    pub stamps: Vec<TurnStamp>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewTurnWaterfall {
    pub session_id: String,
    pub turn_key: Option<String>,
    pub provider: Option<String>,
    pub stamps: Vec<TurnStamp>,
}

/// Stores one turn and drops the rows older than the newest
/// `RETAINED_TURN_WATERFALLS`, in one transaction.
pub fn record_turn_waterfall(
    connection: &mut Connection,
    waterfall: &NewTurnWaterfall,
) -> ArgmaxResult<i64> {
    let stamps_json = serde_json::to_string(&waterfall.stamps).map_err(json_error)?;
    let transaction = connection.transaction().map_err(sqlite_error)?;
    transaction
        .prepare_cached(
            "INSERT INTO turn_waterfalls (session_id, turn_key, provider, stamps_json, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .map_err(sqlite_error)?
        .execute(params![
            waterfall.session_id,
            waterfall.turn_key,
            waterfall.provider,
            stamps_json,
            now_iso(),
        ])
        .map_err(sqlite_error)?;
    let id = transaction.last_insert_rowid();
    transaction
        .prepare_cached("DELETE FROM turn_waterfalls WHERE id <= ? - ?")
        .map_err(sqlite_error)?
        .execute(params![id, RETAINED_TURN_WATERFALLS])
        .map_err(sqlite_error)?;
    transaction.commit().map_err(sqlite_error)?;
    Ok(id)
}

/// The newest turns first.
pub fn recent_turn_waterfalls(
    connection: &Connection,
    limit: u32,
) -> ArgmaxResult<Vec<TurnWaterfall>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT id, session_id, turn_key, provider, stamps_json, created_at
             FROM turn_waterfalls ORDER BY id DESC LIMIT ?",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(sqlite_error)?;
    rows.map(|row| {
        let (id, session_id, turn_key, provider, stamps_json, created_at) =
            row.map_err(sqlite_error)?;
        Ok(TurnWaterfall {
            id,
            session_id,
            turn_key,
            provider,
            stamps: serde_json::from_str(&stamps_json).map_err(json_error)?,
            created_at,
        })
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn seed_session(connection: &Connection, id: &str) {
        connection
            .execute_batch(&format!(
                "INSERT OR IGNORE INTO projects (id, name, repo_path, current_branch, worktree_location,
                   created_at, updated_at)
                 VALUES ('p', 'p', '/tmp/p', 'main', 'sibling', '2026-01-01', '2026-01-01');
                 INSERT OR IGNORE INTO workspaces (id, project_id, task_label, branch, base_ref, path,
                   state, last_activity_at, created_at, updated_at)
                 VALUES ('w', 'p', 'task', 'main', 'main', '/tmp/p', 'complete', '2026-01-01',
                   '2026-01-01', '2026-01-01');
                 INSERT INTO sessions (id, workspace_id, provider, model_label, prompt, state,
                   attention, started_at, last_activity_at)
                 VALUES ('{id}', 'w', 'claude', 'Sonnet', 'hi', 'running', 'normal',
                   '2026-01-01', '2026-01-01');"
            ))
            .expect("seed session");
    }

    fn waterfall(session_id: &str, turn_key: &str) -> NewTurnWaterfall {
        NewTurnWaterfall {
            session_id: session_id.into(),
            turn_key: Some(turn_key.into()),
            provider: Some("claude".into()),
            stamps: vec![
                TurnStamp {
                    name: "submit".into(),
                    offset_ms: -4.5,
                },
                TurnStamp {
                    name: "ipc_received".into(),
                    offset_ms: 0.0,
                },
                TurnStamp {
                    name: "spawn".into(),
                    offset_ms: 120.25,
                },
            ],
        }
    }

    #[test]
    fn a_recorded_turn_reads_back_newest_first_with_its_stamps_in_order() {
        let database = Database::open_in_memory().expect("database");
        let mut connection = database.connection();
        seed_session(&connection, "s1");
        record_turn_waterfall(&mut connection, &waterfall("s1", "u1")).expect("first");
        record_turn_waterfall(&mut connection, &waterfall("s1", "u2")).expect("second");

        let rows = recent_turn_waterfalls(&connection, 10).expect("read");
        assert_eq!(
            rows.iter()
                .map(|row| row.turn_key.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("u2"), Some("u1")]
        );
        assert_eq!(rows[0].stamps, waterfall("s1", "u2").stamps);
        assert_eq!(rows[0].provider.as_deref(), Some("claude"));
    }

    #[test]
    fn the_table_keeps_only_the_newest_retained_rows() {
        let database = Database::open_in_memory().expect("database");
        let mut connection = database.connection();
        seed_session(&connection, "s1");
        for turn in 0..RETAINED_TURN_WATERFALLS + 3 {
            record_turn_waterfall(&mut connection, &waterfall("s1", &format!("u{turn}")))
                .expect("record");
        }
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM turn_waterfalls", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, RETAINED_TURN_WATERFALLS);
        let oldest = recent_turn_waterfalls(&connection, RETAINED_TURN_WATERFALLS as u32)
            .expect("read")
            .pop()
            .and_then(|row| row.turn_key);
        assert_eq!(oldest.as_deref(), Some("u3"));
    }

    #[test]
    fn deleting_the_chat_deletes_its_turns() {
        let database = Database::open_in_memory().expect("database");
        let mut connection = database.connection();
        seed_session(&connection, "s1");
        seed_session(&connection, "s2");
        record_turn_waterfall(&mut connection, &waterfall("s1", "u1")).expect("s1");
        record_turn_waterfall(&mut connection, &waterfall("s2", "u2")).expect("s2");
        connection
            .execute("DELETE FROM sessions WHERE id = 's1'", [])
            .expect("delete");
        let rows = recent_turn_waterfalls(&connection, 10).expect("read");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "s2");
    }
}
