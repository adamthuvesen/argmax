//! Storage for the usage dashboard's transcript scan (migration v27). The
//! scanner in `crate::usage::scanner` decides what to read; this module only
//! remembers where it got to and what it found. See `docs/usage.md`.

use rusqlite::{Connection, OptionalExtension};

use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::usage::records::UsageRecordTokens;

/// Meta key whose value is the parser version the ledger was built with.
pub const META_PARSER_VERSION: &str = "parser_version";
/// Meta key holding the RFC 3339 time the last full sweep finished.
pub const META_LAST_COMPLETED_AT: &str = "last_completed_at";

#[derive(Debug, Clone, PartialEq)]
pub struct ScanFileRecord {
    pub path: String,
    pub provider: String,
    pub session_id: Option<String>,
    pub size: i64,
    pub mtime_ms: i64,
    /// Bytes already folded into the ledger.
    pub cursor_offset: i64,
    /// Hex digest of the bytes just before `cursor_offset`, so a rewrite that
    /// keeps the file long enough is still told apart from an append.
    pub guard_hash: Option<String>,
}

pub fn find_scan_file(connection: &Connection, path: &str) -> ArgmaxResult<Option<ScanFileRecord>> {
    connection
        .prepare_cached(
            "SELECT path, provider, session_id, size, mtime_ms, cursor_offset, guard_hash
             FROM usage_scan_files WHERE path = ?",
        )
        .map_err(sqlite_error)?
        .query_row([path], |row| {
            Ok(ScanFileRecord {
                path: row.get(0)?,
                provider: row.get(1)?,
                session_id: row.get(2)?,
                size: row.get(3)?,
                mtime_ms: row.get(4)?,
                cursor_offset: row.get(5)?,
                guard_hash: row.get(6)?,
            })
        })
        .optional()
        .map_err(sqlite_error)
}

pub fn upsert_scan_file(connection: &Connection, record: &ScanFileRecord) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            INSERT INTO usage_scan_files (
              path, provider, session_id, size, mtime_ms, cursor_offset, guard_hash, scanned_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
              provider = excluded.provider,
              session_id = excluded.session_id,
              size = excluded.size,
              mtime_ms = excluded.mtime_ms,
              cursor_offset = excluded.cursor_offset,
              guard_hash = excluded.guard_hash,
              scanned_at = excluded.scanned_at
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            record.path.as_str(),
            record.provider.as_str(),
            record.session_id.as_deref(),
            record.size,
            record.mtime_ms,
            record.cursor_offset,
            record.guard_hash.as_deref(),
            now_iso().as_str(),
        ))
        .map_err(sqlite_error)?;
    Ok(())
}

/// Every path the ledger knows for a provider, so a sweep can notice files
/// that disappeared.
pub fn list_scan_file_paths(connection: &Connection, provider: &str) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached("SELECT path FROM usage_scan_files WHERE provider = ? ORDER BY path")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([provider], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Drop everything a file contributed: its ledger rows, its dedupe claims,
/// and its cursor. Used before a full reparse and when the file is gone.
pub fn forget_file(connection: &Connection, path: &str) -> ArgmaxResult<()> {
    connection
        .execute("DELETE FROM usage_hourly WHERE source_path = ?", [path])
        .map_err(sqlite_error)?;
    connection
        .execute("DELETE FROM usage_dedupe_keys WHERE source_path = ?", [path])
        .map_err(sqlite_error)?;
    connection
        .execute("DELETE FROM usage_scan_files WHERE path = ?", [path])
        .map_err(sqlite_error)?;
    Ok(())
}

/// Claim a billed-call key for a file. Returns `false` when another file (or
/// an earlier pass over this one) already counted it.
pub fn claim_dedupe_key(
    connection: &Connection,
    key: &str,
    source_path: &str,
    hour_utc: i64,
) -> ArgmaxResult<bool> {
    let inserted = connection
        .prepare_cached(
            "INSERT OR IGNORE INTO usage_dedupe_keys (key, source_path, hour_utc) VALUES (?, ?, ?)",
        )
        .map_err(sqlite_error)?
        .execute((key, source_path, hour_utc))
        .map_err(sqlite_error)?;
    Ok(inserted == 1)
}

#[derive(Debug, Clone, PartialEq)]
pub struct HourlyBucketDelta {
    pub provider: String,
    pub model_id: String,
    pub session_id: String,
    pub source_path: String,
    /// Unix seconds at the start of the UTC hour.
    pub hour_utc: i64,
    pub tokens: UsageRecordTokens,
    /// Sum of the CLI-reported dollars in this delta, `None` when no record
    /// reported any.
    pub reported_cost_usd: Option<f64>,
    /// How many of `records` carried a reported cost.
    pub reported_records: i64,
    pub records: i64,
}

/// Fold a delta into its bucket, creating the bucket on first sight.
pub fn add_hourly_bucket(connection: &Connection, delta: &HourlyBucketDelta) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            INSERT INTO usage_hourly (
              provider, model_id, session_id, source_path, hour_utc,
              input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning,
              reported_cost_usd, reported_records, records
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, model_id, session_id, source_path, hour_utc) DO UPDATE SET
              input_uncached = input_uncached + excluded.input_uncached,
              cache_read = cache_read + excluded.cache_read,
              cache_write_5m = cache_write_5m + excluded.cache_write_5m,
              cache_write_1h = cache_write_1h + excluded.cache_write_1h,
              output = output + excluded.output,
              reasoning = reasoning + excluded.reasoning,
              reported_cost_usd = CASE
                WHEN excluded.reported_cost_usd IS NULL THEN reported_cost_usd
                WHEN reported_cost_usd IS NULL THEN excluded.reported_cost_usd
                ELSE reported_cost_usd + excluded.reported_cost_usd
              END,
              reported_records = reported_records + excluded.reported_records,
              records = records + excluded.records
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            delta.provider.as_str(),
            delta.model_id.as_str(),
            delta.session_id.as_str(),
            delta.source_path.as_str(),
            delta.hour_utc,
            delta.tokens.input_uncached,
            delta.tokens.cache_read,
            delta.tokens.cache_write_5m,
            delta.tokens.cache_write_1h,
            delta.tokens.output,
            delta.tokens.reasoning,
            delta.reported_cost_usd,
            delta.reported_records,
            delta.records,
        ))
        .map_err(sqlite_error)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct HourlyBucket {
    pub provider: String,
    pub model_id: String,
    pub session_id: String,
    pub hour_utc: i64,
    pub tokens: UsageRecordTokens,
    pub reported_cost_usd: Option<f64>,
    pub reported_records: i64,
    pub records: i64,
}

/// Every bucket with `from_hour <= hour_utc < to_hour`, merged across source
/// files. The aggregation into days, providers, and models happens in Rust.
pub fn list_hourly_between(
    connection: &Connection,
    from_hour: i64,
    to_hour: i64,
) -> ArgmaxResult<Vec<HourlyBucket>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT provider, model_id, session_id, hour_utc,
                   SUM(input_uncached), SUM(cache_read), SUM(cache_write_5m), SUM(cache_write_1h),
                   SUM(output), SUM(reasoning),
                   SUM(reported_cost_usd), SUM(reported_records), SUM(records)
            FROM usage_hourly
            WHERE hour_utc >= ? AND hour_utc < ?
            GROUP BY provider, model_id, session_id, hour_utc
            ORDER BY hour_utc, provider, model_id, session_id
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([from_hour, to_hour], |row| {
            Ok(HourlyBucket {
                provider: row.get(0)?,
                model_id: row.get(1)?,
                session_id: row.get(2)?,
                hour_utc: row.get(3)?,
                tokens: UsageRecordTokens {
                    input_uncached: row.get(4)?,
                    cache_read: row.get(5)?,
                    cache_write_5m: row.get(6)?,
                    cache_write_1h: row.get(7)?,
                    output: row.get(8)?,
                    reasoning: row.get(9)?,
                },
                reported_cost_usd: row.get(10)?,
                reported_records: row.get(11)?,
                records: row.get(12)?,
            })
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Drop ledger rows and dedupe claims older than `before_hour`. Cursors stay:
/// a file that old is outside the walk window and will not be reopened.
pub fn prune_before(connection: &Connection, before_hour: i64) -> ArgmaxResult<()> {
    connection
        .execute("DELETE FROM usage_hourly WHERE hour_utc < ?", [before_hour])
        .map_err(sqlite_error)?;
    connection
        .execute("DELETE FROM usage_dedupe_keys WHERE hour_utc < ?", [before_hour])
        .map_err(sqlite_error)?;
    Ok(())
}

/// Start over: every table the scan owns, emptied. Used on a parser version
/// bump.
pub fn clear_all(connection: &Connection) -> ArgmaxResult<()> {
    connection
        .execute_batch(
            "DELETE FROM usage_hourly;
             DELETE FROM usage_dedupe_keys;
             DELETE FROM usage_scan_files;
             DELETE FROM usage_scan_meta;",
        )
        .map_err(sqlite_error)
}

pub fn get_meta(connection: &Connection, key: &str) -> ArgmaxResult<Option<String>> {
    connection
        .prepare_cached("SELECT value FROM usage_scan_meta WHERE key = ?")
        .map_err(sqlite_error)?
        .query_row([key], |row| row.get::<_, String>(0))
        .optional()
        .map_err(sqlite_error)
}

pub fn set_meta(connection: &Connection, key: &str, value: &str) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            "INSERT INTO usage_scan_meta (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .map_err(sqlite_error)?
        .execute((key, value))
        .map_err(sqlite_error)?;
    Ok(())
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::Database;

    fn tokens(input_uncached: i64, output: i64) -> UsageRecordTokens {
        UsageRecordTokens {
            input_uncached,
            output,
            ..UsageRecordTokens::default()
        }
    }

    fn delta(source_path: &str, hour_utc: i64, reported: Option<f64>) -> HourlyBucketDelta {
        HourlyBucketDelta {
            provider: "claude".into(),
            model_id: "claude-opus-5".into(),
            session_id: "s1".into(),
            source_path: source_path.into(),
            hour_utc,
            tokens: tokens(100, 10),
            reported_cost_usd: reported,
            reported_records: i64::from(reported.is_some()),
            records: 1,
        }
    }

    #[test]
    fn buckets_accumulate_and_merge_across_files() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        add_hourly_bucket(&connection, &delta("a.jsonl", 3600, None)).unwrap();
        add_hourly_bucket(&connection, &delta("a.jsonl", 3600, Some(0.5))).unwrap();
        add_hourly_bucket(&connection, &delta("b.jsonl", 3600, Some(0.25))).unwrap();
        add_hourly_bucket(&connection, &delta("b.jsonl", 7200, None)).unwrap();

        let rows = list_hourly_between(&connection, 0, 7200).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tokens.input_uncached, 300);
        assert_eq!(rows[0].tokens.output, 30);
        assert_eq!(rows[0].records, 3);
        assert_eq!(rows[0].reported_records, 2);
        assert_eq!(rows[0].reported_cost_usd, Some(0.75));

        let rows = list_hourly_between(&connection, 0, 10_800).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].reported_cost_usd, None);
    }

    #[test]
    fn forgetting_a_file_removes_only_its_rows_and_claims() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        add_hourly_bucket(&connection, &delta("a.jsonl", 3600, None)).unwrap();
        add_hourly_bucket(&connection, &delta("b.jsonl", 3600, None)).unwrap();
        assert!(claim_dedupe_key(&connection, "k1", "a.jsonl", 3600).unwrap());
        assert!(!claim_dedupe_key(&connection, "k1", "b.jsonl", 3600).unwrap());
        upsert_scan_file(
            &connection,
            &ScanFileRecord {
                path: "a.jsonl".into(),
                provider: "claude".into(),
                session_id: Some("s1".into()),
                size: 10,
                mtime_ms: 1,
                cursor_offset: 10,
                guard_hash: None,
            },
        )
        .unwrap();

        forget_file(&connection, "a.jsonl").unwrap();

        let rows = list_hourly_between(&connection, 0, 7200).unwrap();
        assert_eq!(rows[0].tokens.input_uncached, 100);
        assert!(find_scan_file(&connection, "a.jsonl").unwrap().is_none());
        assert!(claim_dedupe_key(&connection, "k1", "b.jsonl", 3600).unwrap());
    }

    #[test]
    fn scan_file_upsert_replaces_cursor_and_meta_round_trips() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        let mut record = ScanFileRecord {
            path: "a.jsonl".into(),
            provider: "codex".into(),
            session_id: None,
            size: 10,
            mtime_ms: 1,
            cursor_offset: 10,
            guard_hash: Some("abc".into()),
        };
        upsert_scan_file(&connection, &record).unwrap();
        record.size = 20;
        record.cursor_offset = 20;
        upsert_scan_file(&connection, &record).unwrap();
        assert_eq!(find_scan_file(&connection, "a.jsonl").unwrap(), Some(record));
        assert_eq!(list_scan_file_paths(&connection, "codex").unwrap(), vec!["a.jsonl"]);

        assert_eq!(get_meta(&connection, META_PARSER_VERSION).unwrap(), None);
        set_meta(&connection, META_PARSER_VERSION, "1").unwrap();
        set_meta(&connection, META_PARSER_VERSION, "2").unwrap();
        assert_eq!(get_meta(&connection, META_PARSER_VERSION).unwrap().as_deref(), Some("2"));

        prune_before(&connection, 7200).unwrap();
        clear_all(&connection).unwrap();
        assert!(list_scan_file_paths(&connection, "codex").unwrap().is_empty());
    }
}
