//! Storage for the usage dashboard's transcript scan (migration v27). The
//! scanner in `crate::usage::scanner` decides what to read; this module only
//! remembers where it got to and what it found. See `docs/usage.md`.

use std::collections::{BTreeSet, HashSet};

use rusqlite::{Connection, OptionalExtension};

use super::{sqlite_error, time::now_iso};
use crate::error::ArgmaxResult;
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
    /// Provider-specific state needed to parse the next tail exactly as if the
    /// whole file had been parsed in one pass. Currently used by Codex.
    pub parser_state: Option<String>,
}

pub fn find_scan_file(connection: &Connection, path: &str) -> ArgmaxResult<Option<ScanFileRecord>> {
    connection
        .prepare_cached(
            "SELECT path, provider, session_id, size, mtime_ms, cursor_offset, guard_hash,
                    parser_state
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
                parser_state: row.get(7)?,
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
              path, provider, session_id, size, mtime_ms, cursor_offset, guard_hash, parser_state,
              scanned_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
              provider = excluded.provider,
              session_id = excluded.session_id,
              size = excluded.size,
              mtime_ms = excluded.mtime_ms,
              cursor_offset = excluded.cursor_offset,
              guard_hash = excluded.guard_hash,
              parser_state = excluded.parser_state,
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
            record.parser_state.as_deref(),
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

/// Drop everything a file contributed and elect replacement winners from
/// retained copies before removing its cursor.
pub fn forget_file(connection: &Connection, path: &str) -> ArgmaxResult<()> {
    replace_source_contributions(connection, path, 0, Vec::new(), true)?;
    connection
        .execute("DELETE FROM usage_scan_files WHERE path = ?", [path])
        .map_err(sqlite_error)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageContribution {
    pub billed_call_key: Option<String>,
    pub provider: String,
    pub model_id: String,
    pub session_id: String,
    pub at_ms: i64,
    pub hour_utc: i64,
    pub tokens: UsageRecordTokens,
    pub reported_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct BucketIdentity {
    provider: String,
    model_id: String,
    session_id: String,
    source_path: String,
    hour_utc: i64,
}

/// Merge a parsed batch into one source's normalized contributions. A full
/// reparse first removes that source. Every affected billed call then elects
/// the contribution with the largest settled token count, breaking ties by
/// source path, and only affected hourly buckets are rebuilt.
pub fn replace_source_contributions(
    connection: &Connection,
    source_path: &str,
    batch_cursor: i64,
    records: Vec<UsageContribution>,
    full_reparse: bool,
) -> ArgmaxResult<()> {
    let mut affected_keys = if full_reparse {
        contribution_keys_for_source(connection, source_path)?
    } else {
        BTreeSet::new()
    };
    let mut keyed = Vec::with_capacity(records.len());
    for (index, record) in records.into_iter().enumerate() {
        if record.tokens.is_empty() {
            continue;
        }
        let key = record
            .billed_call_key
            .clone()
            .unwrap_or_else(|| format!("unkeyed:{source_path}:{batch_cursor}:{index}"));
        affected_keys.insert(key.clone());
        keyed.push((key, record));
    }

    let mut affected_buckets = HashSet::new();
    for key in &affected_keys {
        if let Some(bucket) = winning_bucket(connection, key)? {
            affected_buckets.insert(bucket);
        }
    }

    if full_reparse {
        connection
            .execute(
                "DELETE FROM usage_contributions WHERE source_path = ?",
                [source_path],
            )
            .map_err(sqlite_error)?;
    }

    let mut insert = connection
        .prepare_cached(
            r#"
            INSERT INTO usage_contributions (
              source_path, billed_call_key, provider, model_id, session_id, at_ms, hour_utc,
              input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning,
              reported_cost_usd, processed_tokens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_path, billed_call_key) DO UPDATE SET
              provider = excluded.provider,
              model_id = excluded.model_id,
              session_id = excluded.session_id,
              at_ms = excluded.at_ms,
              hour_utc = excluded.hour_utc,
              input_uncached = excluded.input_uncached,
              cache_read = excluded.cache_read,
              cache_write_5m = excluded.cache_write_5m,
              cache_write_1h = excluded.cache_write_1h,
              output = excluded.output,
              reasoning = excluded.reasoning,
              reported_cost_usd = excluded.reported_cost_usd,
              processed_tokens = excluded.processed_tokens
            WHERE excluded.processed_tokens > usage_contributions.processed_tokens
            "#,
        )
        .map_err(sqlite_error)?;
    for (key, record) in keyed {
        insert
            .execute((
                source_path,
                key.as_str(),
                record.provider.as_str(),
                record.model_id.as_str(),
                record.session_id.as_str(),
                record.at_ms,
                record.hour_utc,
                record.tokens.input_uncached,
                record.tokens.cache_read,
                record.tokens.cache_write_5m,
                record.tokens.cache_write_1h,
                record.tokens.output,
                record.tokens.reasoning,
                record.reported_cost_usd,
                record.tokens.processed(),
            ))
            .map_err(sqlite_error)?;
    }
    drop(insert);

    for key in &affected_keys {
        match winner_for_key(connection, key)? {
            Some((winner_source, hour_utc)) => {
                connection
                    .prepare_cached(
                        "INSERT INTO usage_dedupe_keys (key, source_path, hour_utc) VALUES (?, ?, ?)
                         ON CONFLICT(key) DO UPDATE SET
                           source_path = excluded.source_path,
                           hour_utc = excluded.hour_utc",
                    )
                    .map_err(sqlite_error)?
                    .execute((key.as_str(), winner_source.as_str(), hour_utc))
                    .map_err(sqlite_error)?;
            }
            None => {
                connection
                    .execute("DELETE FROM usage_dedupe_keys WHERE key = ?", [key])
                    .map_err(sqlite_error)?;
            }
        }
        if let Some(bucket) = winning_bucket(connection, key)? {
            affected_buckets.insert(bucket);
        }
    }

    let mut ordered: Vec<_> = affected_buckets.into_iter().collect();
    ordered.sort();
    for bucket in &ordered {
        rebuild_bucket(connection, bucket)?;
    }
    Ok(())
}

fn contribution_keys_for_source(
    connection: &Connection,
    source_path: &str,
) -> ArgmaxResult<BTreeSet<String>> {
    let mut statement = connection
        .prepare_cached("SELECT billed_call_key FROM usage_contributions WHERE source_path = ?")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([source_path], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;
    rows.collect::<Result<BTreeSet<_>, _>>()
        .map_err(sqlite_error)
}

fn winner_for_key(connection: &Connection, key: &str) -> ArgmaxResult<Option<(String, i64)>> {
    connection
        .prepare_cached(
            "SELECT source_path, hour_utc
             FROM usage_contributions
             WHERE billed_call_key = ?
             ORDER BY processed_tokens DESC, source_path ASC
             LIMIT 1",
        )
        .map_err(sqlite_error)?
        .query_row([key], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(sqlite_error)
}

fn winning_bucket(connection: &Connection, key: &str) -> ArgmaxResult<Option<BucketIdentity>> {
    connection
        .prepare_cached(
            "SELECT c.provider, c.model_id, c.session_id, c.source_path, c.hour_utc
             FROM usage_dedupe_keys d
             JOIN usage_contributions c
               ON c.billed_call_key = d.key AND c.source_path = d.source_path
             WHERE d.key = ?",
        )
        .map_err(sqlite_error)?
        .query_row([key], |row| {
            Ok(BucketIdentity {
                provider: row.get(0)?,
                model_id: row.get(1)?,
                session_id: row.get(2)?,
                source_path: row.get(3)?,
                hour_utc: row.get(4)?,
            })
        })
        .optional()
        .map_err(sqlite_error)
}

fn rebuild_bucket(connection: &Connection, bucket: &BucketIdentity) -> ArgmaxResult<()> {
    let key = (
        bucket.provider.as_str(),
        bucket.model_id.as_str(),
        bucket.session_id.as_str(),
        bucket.source_path.as_str(),
        bucket.hour_utc,
    );
    connection
        .execute(
            "DELETE FROM usage_hourly
             WHERE provider = ? AND model_id = ? AND session_id = ? AND source_path = ?
               AND hour_utc = ?",
            key,
        )
        .map_err(sqlite_error)?;
    connection
        .prepare_cached(
            r#"
            INSERT INTO usage_hourly (
              provider, model_id, session_id, source_path, hour_utc,
              input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning,
              reported_cost_usd, reported_records, records
            )
            SELECT c.provider, c.model_id, c.session_id, c.source_path, c.hour_utc,
                   SUM(c.input_uncached), SUM(c.cache_read), SUM(c.cache_write_5m),
                   SUM(c.cache_write_1h), SUM(c.output), SUM(c.reasoning),
                   SUM(c.reported_cost_usd),
                   SUM(CASE WHEN c.reported_cost_usd IS NULL THEN 0 ELSE 1 END),
                   COUNT(*)
            FROM usage_contributions c
            JOIN usage_dedupe_keys d
              ON d.key = c.billed_call_key AND d.source_path = c.source_path
            WHERE c.provider = ? AND c.model_id = ? AND c.session_id = ?
              AND c.source_path = ? AND c.hour_utc = ?
            HAVING COUNT(*) > 0
            "#,
        )
        .map_err(sqlite_error)?
        .execute(key)
        .map_err(sqlite_error)?;
    Ok(())
}

#[cfg(test)]
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
#[cfg(test)]
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

/// The first hour the ledger holds, for `provider` when one is named. `None`
/// on an empty ledger. It tells a window the ledger reaches past from one it
/// only partly covers, which would make a comparison lie.
pub fn earliest_hour(connection: &Connection, provider: Option<&str>) -> ArgmaxResult<Option<i64>> {
    match provider {
        Some(provider) => connection
            .prepare_cached("SELECT MIN(hour_utc) FROM usage_hourly WHERE provider = ?")
            .map_err(sqlite_error)?
            .query_row([provider], |row| row.get::<_, Option<i64>>(0)),
        None => connection
            .prepare_cached("SELECT MIN(hour_utc) FROM usage_hourly")
            .map_err(sqlite_error)?
            .query_row([], |row| row.get::<_, Option<i64>>(0)),
    }
    .map_err(sqlite_error)
}

/// Drop ledger rows and contributions wholly older than `before_hour`.
/// Cursors stay because files outside the walk window will not be reopened.
pub fn prune_before(connection: &Connection, before_hour: i64) -> ArgmaxResult<()> {
    connection
        .execute("DELETE FROM usage_hourly WHERE hour_utc < ?", [before_hour])
        .map_err(sqlite_error)?;
    // Keep old copies when their billed call also has a retained copy. Winner
    // selection must happen before the time-window filter, otherwise deleting
    // an old winner would promote a copied call into the visible window.
    connection
        .execute(
            "DELETE FROM usage_contributions AS old
             WHERE old.hour_utc < ?
               AND NOT EXISTS (
                 SELECT 1 FROM usage_contributions AS retained
                 WHERE retained.billed_call_key = old.billed_call_key
                   AND retained.hour_utc >= ?
               )",
            [before_hour, before_hour],
        )
        .map_err(sqlite_error)?;
    connection
        .execute(
            "DELETE FROM usage_dedupe_keys
             WHERE NOT EXISTS (
               SELECT 1 FROM usage_contributions c
               WHERE c.billed_call_key = usage_dedupe_keys.key
             )",
            [],
        )
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
             DELETE FROM usage_contributions;
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

    fn contribution(key: &str, input: i64, output: i64) -> UsageContribution {
        UsageContribution {
            billed_call_key: Some(key.into()),
            provider: "claude".into(),
            model_id: "claude-opus-5".into(),
            session_id: "s1".into(),
            at_ms: 3_600_000,
            hour_utc: 3_600,
            tokens: tokens(input, output),
            reported_cost_usd: None,
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
    fn forgetting_the_winner_promotes_a_retained_copy() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        replace_source_contributions(
            &connection,
            "a.jsonl",
            0,
            vec![contribution("k1", 100, 10)],
            false,
        )
        .unwrap();
        replace_source_contributions(
            &connection,
            "b.jsonl",
            0,
            vec![contribution("k1", 100, 10)],
            false,
        )
        .unwrap();
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
                parser_state: None,
            },
        )
        .unwrap();

        forget_file(&connection, "a.jsonl").unwrap();

        let rows = list_hourly_between(&connection, 0, 7200).unwrap();
        assert_eq!(rows[0].tokens.input_uncached, 100);
        assert_eq!(rows[0].records, 1);
        assert!(find_scan_file(&connection, "a.jsonl").unwrap().is_none());
        let winner: String = connection
            .query_row(
                "SELECT source_path FROM usage_dedupe_keys WHERE key = 'k1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(winner, "b.jsonl");
    }

    #[test]
    fn a_larger_settled_contribution_replaces_its_partial_record() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        replace_source_contributions(
            &connection,
            "a.jsonl",
            0,
            vec![contribution("k1", 100, 10)],
            false,
        )
        .unwrap();
        replace_source_contributions(
            &connection,
            "a.jsonl",
            100,
            vec![contribution("k1", 100, 222)],
            false,
        )
        .unwrap();

        let rows = list_hourly_between(&connection, 0, 7200).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tokens.output, 222);
        assert_eq!(rows[0].records, 1);
    }

    #[test]
    fn rebuilt_buckets_preserve_reported_cost_counts_and_nulls() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        let mut reported = contribution("k1", 100, 10);
        reported.reported_cost_usd = Some(0.25);
        replace_source_contributions(
            &connection,
            "a.jsonl",
            0,
            vec![reported, contribution("k2", 100, 10)],
            false,
        )
        .unwrap();

        let rows = list_hourly_between(&connection, 0, 7200).unwrap();
        assert_eq!(rows[0].records, 2);
        assert_eq!(rows[0].reported_records, 1);
        assert_eq!(rows[0].reported_cost_usd, Some(0.25));

        replace_source_contributions(
            &connection,
            "b.jsonl",
            0,
            vec![contribution("k3", 100, 10)],
            false,
        )
        .unwrap();
        let b_cost: Option<f64> = connection
            .query_row(
                "SELECT reported_cost_usd FROM usage_hourly WHERE source_path = 'b.jsonl'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(b_cost, None);
    }

    #[test]
    fn pruning_keeps_an_old_winner_when_a_newer_copy_is_retained() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        let mut old = contribution("copied", 100, 10);
        old.at_ms = 0;
        old.hour_utc = 0;
        let mut copied_later = old.clone();
        copied_later.at_ms = 7_200_000;
        copied_later.hour_utc = 7_200;
        let mut expired = old.clone();
        expired.billed_call_key = Some("expired".into());
        replace_source_contributions(&connection, "a.jsonl", 0, vec![old, expired], false).unwrap();
        replace_source_contributions(&connection, "b.jsonl", 0, vec![copied_later], false).unwrap();

        prune_before(&connection, 3_600).unwrap();

        let winner: String = connection
            .query_row(
                "SELECT source_path FROM usage_dedupe_keys WHERE key = 'copied'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(winner, "a.jsonl");
        let copied_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_contributions WHERE billed_call_key = 'copied'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(copied_count, 2);
        let expired_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_contributions WHERE billed_call_key = 'expired'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(expired_count, 0);
        assert!(list_hourly_between(&connection, 3_600, 10_800)
            .unwrap()
            .is_empty());
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
            parser_state: Some("{}".into()),
        };
        upsert_scan_file(&connection, &record).unwrap();
        record.size = 20;
        record.cursor_offset = 20;
        upsert_scan_file(&connection, &record).unwrap();
        assert_eq!(
            find_scan_file(&connection, "a.jsonl").unwrap(),
            Some(record)
        );
        assert_eq!(
            list_scan_file_paths(&connection, "codex").unwrap(),
            vec!["a.jsonl"]
        );

        assert_eq!(get_meta(&connection, META_PARSER_VERSION).unwrap(), None);
        set_meta(&connection, META_PARSER_VERSION, "1").unwrap();
        set_meta(&connection, META_PARSER_VERSION, "2").unwrap();
        assert_eq!(
            get_meta(&connection, META_PARSER_VERSION)
                .unwrap()
                .as_deref(),
            Some("2")
        );

        prune_before(&connection, 7200).unwrap();
        clear_all(&connection).unwrap();
        assert!(list_scan_file_paths(&connection, "codex")
            .unwrap()
            .is_empty());
    }
}
