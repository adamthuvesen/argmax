//! `argmax usage --days N [--json] [--scan]`: the ledger as per-day,
//! per-model token totals, for checking Argmax's numbers against ccusage and
//! CodexBar (`scripts/check-usage-oracle.mjs`). Reads the app's own database
//! in place. `--scan` runs a sweep first and prints how long it took; point
//! `ARGMAX_DATA_DIR` at a scratch directory for that, so the running app's
//! writer is left alone.

use std::{ffi::OsString, path::PathBuf};

use chrono::{Duration, Local, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::persistence::usage_scan;
use crate::usage::records::UsageRecordTokens;
use crate::usage::scanner::hour_start_secs;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DayReport {
    date: String,
    models: Vec<ModelReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelReport {
    provider: String,
    model_id: String,
    input_uncached: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
    total: i64,
    sessions: usize,
    reported_cost_usd: Option<f64>,
}

pub fn try_run_usage_cli<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) != Some("usage") {
        return None;
    }
    let mut days: i64 = 7;
    let mut json = false;
    let mut scan = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].to_str() {
            Some("--json") => json = true,
            Some("--scan") => scan = true,
            Some("--days") => {
                index += 1;
                match args.get(index).and_then(|value| value.to_str()).and_then(|value| value.parse().ok()) {
                    Some(value) if (1..=90).contains(&value) => days = value,
                    _ => {
                        eprintln!("argmax: --days takes a number from 1 to 90");
                        return Some(2);
                    }
                }
            }
            _ => {
                eprintln!("usage: argmax usage [--days N] [--json] [--scan]");
                return Some(2);
            }
        }
        index += 1;
    }
    Some(run(days, json, scan))
}

fn run(days: i64, json: bool, scan: bool) -> i32 {
    let path = database_path();
    if scan {
        if let Err(error) = sweep_in_place(&path) {
            eprintln!("argmax: {error}");
            return 1;
        }
    }
    let connection = match Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => {
            eprintln!("argmax: cannot open {}: {error}", path.display());
            return 1;
        }
    };
    let report = match daily_report(&connection, days) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("argmax: {error}");
            return 1;
        }
    };
    if json {
        match serde_json::to_string_pretty(&report) {
            Ok(text) => println!("{text}"),
            Err(error) => {
                eprintln!("argmax: {error}");
                return 1;
            }
        }
        return 0;
    }
    for day in &report {
        println!("{}", day.date);
        for model in &day.models {
            println!(
                "  {:<9} {:<32} {:>14} total  {:>12} in  {:>14} cached  {:>12} written  {:>11} out",
                model.provider,
                model.model_id,
                model.total,
                model.input_uncached,
                model.cache_read,
                model.cache_write,
                model.output
            );
        }
    }
    0
}

/// Open (and migrate) the database at `path`, run one sweep, and report its
/// wall time on stderr.
fn sweep_in_place(path: &std::path::Path) -> crate::error::ArgmaxResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            crate::error::ArgmaxError::service("USAGE_SCAN_IO", error.to_string())
        })?;
    }
    let database = std::sync::Arc::new(crate::persistence::Database::open(path)?);
    let scanner = crate::usage::scanner::UsageScanner::new(database, crate::sync::home_dir());
    let started = std::time::Instant::now();
    let ran = scanner.sweep()?;
    let progress = scanner.progress();
    eprintln!(
        "argmax: usage sweep {} in {:.2}s over {} sources",
        if ran { "finished" } else { "skipped (another sweep was running)" },
        started.elapsed().as_secs_f64(),
        progress.files_total
    );
    Ok(())
}

/// Per (provider, model): token totals, the sessions seen, and any
/// provider-reported dollars.
type ModelTotals = std::collections::BTreeMap<
    (String, String),
    (UsageRecordTokens, std::collections::BTreeSet<String>, Option<f64>),
>;

/// The last `days` local calendar days including today, oldest first, each
/// with its models sorted by total tokens.
fn daily_report(connection: &Connection, days: i64) -> crate::error::ArgmaxResult<Vec<DayReport>> {
    let now = Utc::now();
    let today = now.with_timezone(&Local).date_naive();
    let day_starts: Vec<(String, i64)> = (0..days)
        .rev()
        .map(|days_ago| {
            let date = today - Duration::days(days_ago);
            let midnight = date.and_hms_opt(0, 0, 0).expect("midnight");
            let start = Local
                .from_local_datetime(&midnight)
                .earliest()
                .unwrap_or_else(|| Local.from_utc_datetime(&midnight))
                .with_timezone(&Utc);
            (date.format("%Y-%m-%d").to_string(), start.timestamp())
        })
        .collect();
    let from_hour = hour_start_secs(day_starts[0].1 * 1000);
    let to_hour = hour_start_secs(now.timestamp_millis()) + 3600;
    let buckets = usage_scan::list_hourly_between(connection, from_hour, to_hour)?;

    let mut days_out: Vec<(String, ModelTotals)> = day_starts
            .iter()
            .map(|(date, _)| (date.clone(), Default::default()))
            .collect();
    for bucket in buckets {
        let Some(index) = day_starts
            .iter()
            .rposition(|(_, start)| *start <= bucket.hour_utc)
        else {
            continue;
        };
        let entry = days_out[index]
            .1
            .entry((bucket.provider.clone(), bucket.model_id.clone()))
            .or_default();
        entry.0.input_uncached += bucket.tokens.input_uncached;
        entry.0.cache_read += bucket.tokens.cache_read;
        entry.0.cache_write_5m += bucket.tokens.cache_write_5m;
        entry.0.cache_write_1h += bucket.tokens.cache_write_1h;
        entry.0.output += bucket.tokens.output;
        entry.0.reasoning += bucket.tokens.reasoning;
        entry.1.insert(bucket.session_id);
        if let Some(cost) = bucket.reported_cost_usd {
            entry.2 = Some(entry.2.unwrap_or(0.0) + cost);
        }
    }

    Ok(days_out
        .into_iter()
        .map(|(date, models)| {
            let mut models: Vec<ModelReport> = models
                .into_iter()
                .map(|((provider, model_id), (tokens, sessions, reported))| ModelReport {
                    provider,
                    model_id,
                    input_uncached: tokens.input_uncached,
                    cache_read: tokens.cache_read,
                    cache_write: tokens.cache_write(),
                    output: tokens.output,
                    total: tokens.input_uncached
                        + tokens.cache_read
                        + tokens.cache_write()
                        + tokens.output,
                    sessions: sessions.len(),
                    reported_cost_usd: reported,
                })
                .collect();
            models.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.model_id.cmp(&b.model_id)));
            DayReport { date, models }
        })
        .collect())
}

/// The running app's database: `ARGMAX_DATA_DIR` when set, else the Tauri
/// app-data directory for the bundle identifier in `tauri.conf.json`.
fn database_path() -> PathBuf {
    let dir = match std::env::var("ARGMAX_DATA_DIR") {
        Ok(raw) if !raw.trim().is_empty() => PathBuf::from(raw),
        _ => {
            let home = crate::sync::home_dir();
            if cfg!(target_os = "macos") {
                home.join("Library")
                    .join("Application Support")
                    .join("com.argmax.rs")
            } else {
                std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".local").join("share"))
                    .join("com.argmax.rs")
            }
        }
    };
    dir.join("argmax.sqlite")
}
