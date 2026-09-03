//! OpenCode keeps its transcript in SQLite at
//! `~/.local/share/opencode/opencode.db` rather than in JSONL. One `message`
//! row per turn carries the whole turn's usage and OpenCode's own dollar
//! figure in its `data` JSON.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::validation::ProviderId;
use crate::providers::normalizer::{number_value, object_value, string_value};
use crate::usage::records::{UsageRecord, UsageRecordTokens};

/// Reads every assistant turn created at or after `since_ms`.
///
/// The database belongs to a CLI that may be mid-turn, so it is opened
/// read-only and never written, checkpointed, or vacuumed.
pub fn read_opencode_messages(db_path: &Path, since_ms: i64) -> ArgmaxResult<Vec<UsageRecord>> {
    let connection = open_read_only(db_path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, session_id, time_created, data \
             FROM message \
             WHERE time_created >= ?1 \
             ORDER BY time_created ASC",
        )
        .map_err(|error| failed("prepare", db_path, &error))?;

    let rows = statement
        .query_map([since_ms], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| failed("query", db_path, &error))?;

    let mut records = Vec::new();
    for row in rows {
        let (id, session_id, time_created, data) =
            row.map_err(|error| failed("read row", db_path, &error))?;
        // A row whose JSON we cannot read is one turn missing from a report,
        // not a reason to fail the whole scan.
        let Ok(Value::Object(data)) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if let Some(record) = record_from_row(&id, &session_id, time_created, &data) {
            records.push(record);
        }
    }
    Ok(records)
}

/// `mode=ro` rather than the plain read-only flag: OpenCode runs the database
/// in WAL mode, and the URI form is what lets SQLite attach to an existing
/// `-wal` sidecar without claiming a write lock on it.
fn open_read_only(db_path: &Path) -> ArgmaxResult<Connection> {
    let uri = format!("file:{}?mode=ro", db_path.display());
    Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|error| failed("open", db_path, &error))
}

fn record_from_row(
    id: &str,
    session_id: &str,
    time_created: i64,
    data: &Map<String, Value>,
) -> Option<UsageRecord> {
    if string_value(data.get("role")) != Some("assistant") {
        return None;
    }
    let tokens = tokens_from_data(data);
    let reported_cost_usd = data
        .get("cost")
        .and_then(Value::as_f64)
        .filter(|cost| *cost > 0.0);
    if tokens.is_empty() && reported_cost_usd.is_none() {
        return None;
    }

    Some(UsageRecord {
        provider: ProviderId::Opencode,
        model_id: model_id(data),
        session_id: session_id.to_string(),
        // The turn bills when it finishes; a row still running has no
        // completion stamp yet and falls back to when it started.
        at_ms: object_value(data.get("time"))
            .and_then(|time| time.get("completed"))
            .and_then(Value::as_i64)
            .unwrap_or(time_created),
        tokens,
        reported_cost_usd,
        // OpenCode message ids are unique in its own store, so one row is one
        // billed turn however often it is read.
        dedupe_key: Some(format!("opencode:{id}")),
        project_path: object_value(data.get("path"))
            .and_then(|path| string_value(path.get("cwd")))
            .map(str::to_string),
    })
}

/// `<providerID>/<modelID>`, matching the ids the pricing table and the CLI's
/// own `-m` flag use.
fn model_id(data: &Map<String, Value>) -> String {
    match (
        string_value(data.get("providerID")),
        string_value(data.get("modelID")),
    ) {
        (Some(provider), Some(model)) => format!("{provider}/{model}"),
        (None, Some(model)) => model.to_string(),
        _ => "unknown".to_string(),
    }
}

fn tokens_from_data(data: &Map<String, Value>) -> UsageRecordTokens {
    let Some(tokens) = object_value(data.get("tokens")) else {
        return UsageRecordTokens::default();
    };
    let cache = object_value(tokens.get("cache"));
    UsageRecordTokens {
        // OpenCode's `input` already excludes what it read from the cache.
        input_uncached: number_value(tokens.get("input")) as i64,
        cache_read: cache
            .map(|cache| number_value(cache.get("read")) as i64)
            .unwrap_or(0),
        cache_write_5m: cache
            .map(|cache| number_value(cache.get("write")) as i64)
            .unwrap_or(0),
        cache_write_1h: 0,
        output: number_value(tokens.get("output")) as i64,
        reasoning: number_value(tokens.get("reasoning")) as i64,
    }
}

fn failed(action: &str, db_path: &Path, error: &rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service(
        "USAGE_OPENCODE_DB",
        format!("could not {action} {}: {error}", db_path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two assistant turns and the user message between them, with the shape
    /// and field names taken from a live `opencode.db`.
    fn seeded_database() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("opencode.db");
        let connection = Connection::open(&path).expect("create db");
        connection
            .execute_batch(
                "CREATE TABLE message (
                     id TEXT PRIMARY KEY,
                     session_id TEXT NOT NULL,
                     time_created INTEGER NOT NULL,
                     time_updated INTEGER NOT NULL,
                     data TEXT NOT NULL
                 );",
            )
            .expect("schema");

        let assistant = |cost: f64, input: i64, read: i64, output: i64, completed: i64| {
            serde_json::json!({
                "role": "assistant",
                "mode": "build",
                "path": { "cwd": "/private/tmp/argmax-verify-repo", "root": "/private/tmp/argmax-verify-repo" },
                "cost": cost,
                "tokens": {
                    "total": input + read + output,
                    "input": input,
                    "output": output,
                    "reasoning": 0,
                    "cache": { "write": 0, "read": read }
                },
                "modelID": "glm-5.3-flash",
                "providerID": "opencode-go",
                "time": { "created": completed - 900, "completed": completed },
                "finish": "stop"
            })
            .to_string()
        };
        let rows: [(&str, &str, i64, String); 3] = [
            (
                "msg_0667d60cd001ROLAkdoYJH0V1f",
                "ses_f99829f50ffe4GwhxjnPJYgD4C",
                1_788_425_800_000,
                serde_json::json!({ "role": "user", "time": { "created": 1_788_425_800_000i64 } })
                    .to_string(),
            ),
            (
                "msg_0667d64ef001HZm610H32yp3ry",
                "ses_f99829f50ffe4GwhxjnPJYgD4C",
                1_788_425_889_007,
                assistant(0.001_912_025, 25_437, 0, 17, 1_788_425_905_904),
            ),
            (
                "msg_0667d6a11001PLm610H32yp3rz",
                "ses_f99829f50ffe4GwhxjnPJYgD4C",
                1_788_425_990_000,
                assistant(0.004_2, 12_000, 9_000, 640, 1_788_426_001_000),
            ),
        ];
        for (id, session, created, data) in rows {
            connection
                .execute(
                    "INSERT INTO message (id, session_id, time_created, time_updated, data)
                     VALUES (?1, ?2, ?3, ?3, ?4)",
                    rusqlite::params![id, session, created, data],
                )
                .expect("insert");
        }
        drop(connection);
        (dir, path)
    }

    #[test]
    fn reads_assistant_turns_with_their_reported_cost() {
        let (_dir, path) = seeded_database();
        let records = read_opencode_messages(&path, 0).expect("read");

        assert_eq!(records.len(), 2, "the user row is not a billed turn");
        assert_eq!(records[0].model_id, "opencode-go/glm-5.3-flash");
        assert_eq!(records[0].tokens.input_uncached, 25_437);
        assert_eq!(records[0].tokens.output, 17);
        assert_eq!(records[0].reported_cost_usd, Some(0.001_912_025));
        assert_eq!(records[0].at_ms, 1_788_425_905_904, "billed when it finished");
        assert_eq!(
            records[0].dedupe_key.as_deref(),
            Some("opencode:msg_0667d64ef001HZm610H32yp3ry")
        );
        assert_eq!(
            records[0].project_path.as_deref(),
            Some("/private/tmp/argmax-verify-repo")
        );
        assert_eq!(records[0].session_id, "ses_f99829f50ffe4GwhxjnPJYgD4C");
        assert_eq!(records[1].tokens.cache_read, 9_000);
        assert_eq!(records[1].reported_cost_usd, Some(0.004_2));
    }

    #[test]
    fn since_ms_excludes_older_turns() {
        let (_dir, path) = seeded_database();
        let records = read_opencode_messages(&path, 1_788_425_900_000).expect("read");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].tokens.cache_read, 9_000);
    }

    #[test]
    fn a_missing_database_is_an_error_not_a_panic() {
        let error = read_opencode_messages(Path::new("/nope/opencode.db"), 0)
            .expect_err("no such database");
        assert!(format!("{error}").contains("could not open"));
    }
}
