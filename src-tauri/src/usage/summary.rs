//! Turns the hourly ledger into the `UsageSummary` the page draws: the window
//! cut into buckets, every bucket priced, and the totals rolled up by
//! provider, model, and day.
//!
//! Day buckets follow the machine's local zone (`chrono::Local`). The
//! renderer resolves the same zone, so the `time_zone` it sends is echoed
//! back for labelling rather than used for arithmetic. Hour buckets are UTC
//! hours; a zone at a half-hour offset lands an hour in the day its start
//! falls in.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Local, SecondsFormat, TimeZone, Timelike, Utc};
use rusqlite::Connection;

use crate::error::ArgmaxResult;
use crate::ipc::validation::ProviderId;
use crate::persistence::usage_scan::{self, HourlyBucket};
use crate::providers::pricing;
use crate::usage::records::UsageRecordTokens;
use crate::usage::scanner::{hour_start_secs, provider_from_key};
use crate::usage::{
    UsageCostSource, UsageDayRow, UsageModelRow, UsageProviderSummary, UsageResolution,
    UsageScanState, UsageSeriesPoint, UsageSeriesValue, UsageSummary, UsageTokenTotals,
    UsageWindow,
};

/// Providers in the order the page lists them. Cursor keeps no local usage
/// source and is reported as unavailable.
const PROVIDER_ORDER: [ProviderId; 5] = [
    ProviderId::Claude,
    ProviderId::Codex,
    ProviderId::Grok,
    ProviderId::Opencode,
    ProviderId::Cursor,
];

#[derive(Debug, Clone, Copy, Default)]
struct Rollup {
    tokens: UsageRecordTokens,
    cost_usd: f64,
    cache_savings_usd: f64,
    cost_source: Option<UsageCostSource>,
}

impl Rollup {
    fn add(&mut self, priced: &PricedBucket) {
        self.tokens = add_tokens(self.tokens, priced.tokens);
        self.cost_usd += priced.cost_usd;
        self.cache_savings_usd += priced.cache_savings_usd;
        self.cost_source = Some(merge_source(self.cost_source, priced.cost_source));
    }

    fn cost_source(&self) -> UsageCostSource {
        self.cost_source.unwrap_or(UsageCostSource::ListPrice)
    }
}

struct PricedBucket {
    provider: ProviderId,
    model_id: String,
    session_id: String,
    bucket_index: usize,
    tokens: UsageRecordTokens,
    cost_usd: f64,
    cache_savings_usd: f64,
    cost_source: UsageCostSource,
}

/// Bucket starts as UTC instants, first inclusive; the last bucket ends at
/// `now`.
pub fn bucket_starts(window: UsageWindow, now: DateTime<Utc>) -> Vec<DateTime<Utc>> {
    match window {
        UsageWindow::Past24h => {
            let current_hour = now
                .with_minute(0)
                .and_then(|value| value.with_second(0))
                .and_then(|value| value.with_nanosecond(0))
                .unwrap_or(now);
            (0..24)
                .rev()
                .map(|hours_ago| current_hour - Duration::hours(hours_ago))
                .collect()
        }
        UsageWindow::Past7d | UsageWindow::Past30d => {
            let days = match window {
                UsageWindow::Past7d => 7,
                _ => 30,
            };
            let today = now.with_timezone(&Local).date_naive();
            (0..days)
                .rev()
                .map(|days_ago| {
                    let date = today - Duration::days(days_ago);
                    let midnight = date.and_hms_opt(0, 0, 0).expect("midnight");
                    // A DST gap has no midnight; the earliest valid instant is
                    // the day's real start.
                    Local
                        .from_local_datetime(&midnight)
                        .earliest()
                        .unwrap_or_else(|| Local.from_utc_datetime(&midnight))
                        .with_timezone(&Utc)
                })
                .collect()
        }
    }
}

pub fn build_summary(
    connection: &Connection,
    window: UsageWindow,
    time_zone: String,
    scan: UsageScanState,
    now: DateTime<Utc>,
) -> ArgmaxResult<UsageSummary> {
    let starts = bucket_starts(window, now);
    let range_start = starts[0];
    let start_secs: Vec<i64> = starts.iter().map(|start| start.timestamp()).collect();
    let from_hour = hour_start_secs(range_start.timestamp_millis());
    let to_hour = hour_start_secs(now.timestamp_millis()) + 3600;
    let buckets = usage_scan::list_hourly_between(connection, from_hour, to_hour)?;

    let priced: Vec<PricedBucket> = buckets
        .into_iter()
        .filter(|bucket| bucket.hour_utc >= range_start.timestamp())
        .filter_map(|bucket| price_bucket(bucket, &start_secs))
        .collect();

    let mut total = Rollup::default();
    let mut total_sessions: HashSet<&str> = HashSet::new();
    let mut by_provider: HashMap<ProviderId, (Rollup, HashSet<&str>)> = HashMap::new();
    let mut by_series: Vec<HashMap<ProviderId, (f64, i64)>> = vec![HashMap::new(); starts.len()];
    let mut by_model: HashMap<(ProviderId, &str), (Rollup, HashSet<&str>)> = HashMap::new();
    let mut by_day: Vec<(Rollup, HashSet<&str>)> = vec![Default::default(); starts.len()];

    for bucket in &priced {
        total.add(bucket);
        total_sessions.insert(&bucket.session_id);
        let provider = by_provider.entry(bucket.provider).or_default();
        provider.0.add(bucket);
        provider.1.insert(&bucket.session_id);
        let point = by_series[bucket.bucket_index]
            .entry(bucket.provider)
            .or_default();
        point.0 += bucket.cost_usd;
        point.1 += processed(&bucket.tokens);
        let model = by_model
            .entry((bucket.provider, bucket.model_id.as_str()))
            .or_default();
        model.0.add(bucket);
        model.1.insert(&bucket.session_id);
        let day = &mut by_day[bucket.bucket_index];
        day.0.add(bucket);
        day.1.insert(&bucket.session_id);
    }

    let providers = PROVIDER_ORDER
        .iter()
        .map(|provider| {
            let (rollup, sessions) = by_provider.get(provider).cloned().unwrap_or_default();
            UsageProviderSummary {
                provider: *provider,
                available: *provider != ProviderId::Cursor,
                sessions: sessions.len() as i64,
                tokens: totals_of(rollup.tokens),
                cost_usd: rollup.cost_usd,
                cache_savings_usd: rollup.cache_savings_usd,
                cost_source: rollup.cost_source(),
            }
        })
        .collect();

    let series = starts
        .iter()
        .zip(by_series.iter())
        .map(|(start, values)| UsageSeriesPoint {
            bucket_start: rfc3339(*start),
            values: PROVIDER_ORDER
                .iter()
                .filter(|provider| **provider != ProviderId::Cursor)
                .map(|provider| {
                    let (cost_usd, tokens) = values.get(provider).copied().unwrap_or((0.0, 0));
                    UsageSeriesValue {
                        provider: *provider,
                        cost_usd,
                        tokens,
                    }
                })
                .collect(),
        })
        .collect();

    let mut models: Vec<UsageModelRow> = by_model
        .into_iter()
        .map(|((provider, model_id), (rollup, sessions))| UsageModelRow {
            provider,
            model_id: model_id.to_owned(),
            sessions: sessions.len() as i64,
            tokens: totals_of(rollup.tokens),
            cost_usd: rollup.cost_usd,
            cost_source: rollup.cost_source(),
        })
        .collect();
    models.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.tokens.processed().cmp(&a.tokens.processed()))
            .then_with(|| a.model_id.cmp(&b.model_id))
    });

    let days = starts
        .iter()
        .zip(by_day.iter())
        .map(|(start, (rollup, sessions))| UsageDayRow {
            bucket_start: rfc3339(*start),
            sessions: sessions.len() as i64,
            tokens: totals_of(rollup.tokens),
            cost_usd: rollup.cost_usd,
            cost_source: rollup.cost_source(),
        })
        .collect();

    Ok(UsageSummary {
        window,
        time_zone,
        range_start: rfc3339(range_start),
        range_end: rfc3339(now),
        resolution: match window {
            UsageWindow::Past24h => UsageResolution::Hour,
            UsageWindow::Past7d | UsageWindow::Past30d => UsageResolution::Day,
        },
        scan,
        sessions: total_sessions.len() as i64,
        tokens: totals_of(total.tokens),
        cost_usd: total.cost_usd,
        cache_savings_usd: total.cache_savings_usd,
        cost_source: total.cost_source(),
        providers,
        series,
        models,
        days,
    })
}

/// Price one ledger bucket and place it in its chart bucket. The CLI's own
/// dollars win when every record in the bucket reported them; otherwise the
/// list-price table applies, and a model the table does not know is counted
/// but not priced.
fn price_bucket(bucket: HourlyBucket, start_secs: &[i64]) -> Option<PricedBucket> {
    let provider = provider_from_key(&bucket.provider)?;
    let bucket_index = start_secs
        .iter()
        .rposition(|start| *start <= bucket.hour_utc)?;
    let price = pricing::list_price(&bucket.model_id);
    let (cost_usd, cost_source) = if bucket.reported_records > 0 {
        let source = if bucket.reported_records == bucket.records {
            UsageCostSource::ProviderReported
        } else {
            UsageCostSource::Mixed
        };
        (bucket.reported_cost_usd.unwrap_or(0.0), source)
    } else {
        match pricing::price_record(&bucket.tokens, &bucket.model_id) {
            Some(cost) => (cost, UsageCostSource::ListPrice),
            None => (0.0, UsageCostSource::Unpriced),
        }
    };
    let cache_savings_usd = price
        .map(|price| pricing::cache_savings(&bucket.tokens, &price))
        .unwrap_or(0.0);
    Some(PricedBucket {
        provider,
        model_id: bucket.model_id,
        session_id: bucket.session_id,
        bucket_index,
        tokens: bucket.tokens,
        cost_usd,
        cache_savings_usd,
        cost_source,
    })
}

fn merge_source(current: Option<UsageCostSource>, next: UsageCostSource) -> UsageCostSource {
    match current {
        None => next,
        Some(existing) if existing == next => existing,
        Some(_) => UsageCostSource::Mixed,
    }
}

fn add_tokens(a: UsageRecordTokens, b: UsageRecordTokens) -> UsageRecordTokens {
    UsageRecordTokens {
        input_uncached: a.input_uncached + b.input_uncached,
        cache_read: a.cache_read + b.cache_read,
        cache_write_5m: a.cache_write_5m + b.cache_write_5m,
        cache_write_1h: a.cache_write_1h + b.cache_write_1h,
        output: a.output + b.output,
        reasoning: a.reasoning + b.reasoning,
    }
}

fn processed(tokens: &UsageRecordTokens) -> i64 {
    tokens.input_uncached + tokens.cache_read + tokens.cache_write() + tokens.output
}

fn totals_of(tokens: UsageRecordTokens) -> UsageTokenTotals {
    UsageTokenTotals {
        input_uncached: tokens.input_uncached,
        cache_read: tokens.cache_read,
        cache_write: tokens.cache_write(),
        output: tokens.output,
        reasoning: tokens.reasoning,
    }
}

fn rfc3339(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::usage_scan::HourlyBucketDelta;
    use crate::persistence::Database;
    use crate::usage::{UsageScanPhase, PRICING_AS_OF};

    fn scan_state() -> UsageScanState {
        UsageScanState {
            phase: UsageScanPhase::Idle,
            files_total: 0,
            files_done: 0,
            last_completed_at: None,
            pricing_as_of: PRICING_AS_OF.to_string(),
        }
    }

    fn delta(
        provider: &str,
        model_id: &str,
        session_id: &str,
        hour_utc: i64,
        tokens: UsageRecordTokens,
        reported: Option<f64>,
    ) -> HourlyBucketDelta {
        HourlyBucketDelta {
            provider: provider.into(),
            model_id: model_id.into(),
            session_id: session_id.into(),
            source_path: "x".into(),
            hour_utc,
            tokens,
            reported_cost_usd: reported,
            reported_records: i64::from(reported.is_some()),
            records: 1,
        }
    }

    #[test]
    fn hour_window_has_24_buckets_ending_in_the_current_hour() {
        let now = Utc.with_ymd_and_hms(2026, 9, 3, 14, 25, 0).unwrap();
        let starts = bucket_starts(UsageWindow::Past24h, now);
        assert_eq!(starts.len(), 24);
        assert_eq!(
            starts[23],
            Utc.with_ymd_and_hms(2026, 9, 3, 14, 0, 0).unwrap()
        );
        assert_eq!(
            starts[0],
            Utc.with_ymd_and_hms(2026, 9, 2, 15, 0, 0).unwrap()
        );
    }

    #[test]
    fn day_windows_start_at_local_midnight_and_end_today() {
        let now = Utc::now();
        let starts = bucket_starts(UsageWindow::Past7d, now);
        assert_eq!(starts.len(), 7);
        let last_local = starts[6].with_timezone(&Local);
        assert_eq!(
            last_local.date_naive(),
            now.with_timezone(&Local).date_naive()
        );
        assert_eq!((last_local.hour(), last_local.minute()), (0, 0));
        assert!(starts[6] <= now);
        assert_eq!(bucket_starts(UsageWindow::Past30d, now).len(), 30);
    }

    #[test]
    fn summary_prices_list_models_and_keeps_reported_and_unpriced_apart() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        let now = Utc.with_ymd_and_hms(2026, 9, 3, 14, 25, 0).unwrap();
        let this_hour = Utc
            .with_ymd_and_hms(2026, 9, 3, 14, 0, 0)
            .unwrap()
            .timestamp();
        let million = UsageRecordTokens {
            input_uncached: 1_000_000,
            ..UsageRecordTokens::default()
        };
        // claude-opus-5 input is $5 per million.
        usage_scan::add_hourly_bucket(
            &connection,
            &delta("claude", "claude-opus-5", "s1", this_hour, million, None),
        )
        .unwrap();
        usage_scan::add_hourly_bucket(
            &connection,
            &delta(
                "claude",
                "claude-opus-5",
                "s2",
                this_hour - 3600,
                million,
                None,
            ),
        )
        .unwrap();
        usage_scan::add_hourly_bucket(
            &connection,
            &delta("grok", "grok-4.6", "s3", this_hour, million, Some(0.34)),
        )
        .unwrap();
        usage_scan::add_hourly_bucket(
            &connection,
            &delta("codex", "codex-auto-review", "s4", this_hour, million, None),
        )
        .unwrap();
        // Outside the window.
        usage_scan::add_hourly_bucket(
            &connection,
            &delta(
                "claude",
                "claude-opus-5",
                "s5",
                this_hour - 48 * 3600,
                million,
                None,
            ),
        )
        .unwrap();

        let summary = build_summary(
            &connection,
            UsageWindow::Past24h,
            "Europe/Stockholm".into(),
            scan_state(),
            now,
        )
        .unwrap();

        assert_eq!(summary.sessions, 4);
        assert_eq!(summary.tokens.input_uncached, 4_000_000);
        assert!((summary.cost_usd - 10.34).abs() < 1e-9);
        assert_eq!(summary.cost_source, UsageCostSource::Mixed);
        assert_eq!(summary.series.len(), 24);
        assert_eq!(summary.range_end, "2026-09-03T14:25:00.000Z");

        let claude = &summary.providers[0];
        assert_eq!(claude.provider, ProviderId::Claude);
        assert_eq!(claude.sessions, 2);
        assert!((claude.cost_usd - 10.0).abs() < 1e-9);
        assert_eq!(claude.cost_source, UsageCostSource::ListPrice);
        let grok = &summary.providers[2];
        assert_eq!(grok.cost_source, UsageCostSource::ProviderReported);
        let cursor = &summary.providers[4];
        assert!(!cursor.available);

        let unpriced = summary
            .models
            .iter()
            .find(|row| row.model_id == "codex-auto-review")
            .expect("unpriced row");
        assert_eq!(unpriced.cost_source, UsageCostSource::Unpriced);
        assert_eq!(unpriced.cost_usd, 0.0);
        assert_eq!(unpriced.tokens.input_uncached, 1_000_000);
        assert_eq!(summary.models[0].model_id, "claude-opus-5");

        let last = summary.series.last().unwrap();
        let claude_now = last
            .values
            .iter()
            .find(|value| value.provider == ProviderId::Claude)
            .unwrap();
        assert!((claude_now.cost_usd - 5.0).abs() < 1e-9);
        assert_eq!(claude_now.tokens, 1_000_000);
        assert_eq!(summary.days.len(), 24);
        assert_eq!(summary.days[22].sessions, 1);
    }
}
