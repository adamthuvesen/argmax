//! Usage dashboard: token and cost usage across every provider transcript on
//! disk, not only sessions Argmax launched.
//!
//! This module holds the wire contract `usage:summary` returns. The scanner,
//! storage, and aggregation live in the sibling modules.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ipc::validation::ProviderId;

pub mod claude;
pub mod cli;
pub mod codex;
pub mod grok;
pub mod opencode;
pub mod records;
pub mod scanner;
pub mod summary;

/// Date of the list prices in `providers::pricing`. Shown next to every dollar
/// figure so a stale table reads as stale.
pub const PRICING_AS_OF: &str = "2026-09-03";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum UsageWindow {
    #[serde(rename = "24h")]
    Past24h,
    #[serde(rename = "7d")]
    Past7d,
    #[serde(rename = "30d")]
    Past30d,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum UsageResolution {
    Hour,
    Day,
}

/// Token counts for one bucket. `input_uncached` excludes cache reads and
/// writes, so processed tokens are the sum of the first four fields.
/// `reasoning` is the part of `output` the model spent thinking, never added
/// on top of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokenTotals {
    pub input_uncached: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub output: i64,
    pub reasoning: i64,
}

impl UsageTokenTotals {
    pub fn processed(&self) -> i64 {
        self.input_uncached + self.cache_read + self.cache_write + self.output
    }
}

/// Where a dollar figure came from. `provider_reported` is the CLI's own
/// accounting (Grok ticks, OpenCode cost); `list_price` is our table applied
/// to the token counts; `unpriced` means a model the table does not know, so
/// tokens are counted but no dollars are claimed; `mixed` is a bucket that
/// combines more than one of those.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageCostSource {
    ProviderReported,
    ListPrice,
    Unpriced,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum UsageScanPhase {
    Idle,
    Scanning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageScanState {
    pub phase: UsageScanPhase,
    pub files_total: i64,
    pub files_done: i64,
    /// RFC 3339 UTC; `None` before the first scan finishes.
    pub last_completed_at: Option<String>,
    pub pricing_as_of: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageProviderSummary {
    pub provider: ProviderId,
    /// `false` when the provider has no local usage source (Cursor). Such a
    /// row carries zeros and the page says so instead of showing $0.
    pub available: bool,
    pub sessions: i64,
    pub tokens: UsageTokenTotals,
    pub cost_usd: f64,
    /// What the cached input would have cost at the uncached rate, minus what
    /// it did cost.
    pub cache_savings_usd: f64,
    pub cost_source: UsageCostSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageSeriesValue {
    pub provider: ProviderId,
    pub cost_usd: f64,
    /// Processed tokens in the bucket.
    pub tokens: i64,
}

/// One chart bucket: an hour for the 24h window, a local calendar day
/// otherwise. `bucket_start` is the bucket's first instant as RFC 3339 UTC;
/// the renderer formats it in `UsageSummary::time_zone`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageSeriesPoint {
    pub bucket_start: String,
    pub values: Vec<UsageSeriesValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelRow {
    pub provider: ProviderId,
    pub model_id: String,
    pub sessions: i64,
    pub tokens: UsageTokenTotals,
    pub cost_usd: f64,
    pub cost_source: UsageCostSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayRow {
    pub bucket_start: String,
    pub sessions: i64,
    pub tokens: UsageTokenTotals,
    pub cost_usd: f64,
    pub cost_source: UsageCostSource,
}

/// Totals for the same-length window immediately before `range_start`, so the
/// page can say whether this window is up or down on the last one. `None` when
/// the ledger does not cover that earlier window — a first install must not
/// read as "up 100%".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsagePreviousPeriod {
    pub cost_usd: f64,
    pub tokens: UsageTokenTotals,
    pub sessions: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub window: UsageWindow,
    /// The provider the totals, series, models, and days are narrowed to;
    /// `None` is every provider. `providers` is never narrowed.
    pub provider: Option<ProviderId>,
    /// IANA zone the renderer asked for; day buckets follow it.
    pub time_zone: String,
    /// RFC 3339 UTC instants bounding the window, start inclusive, end
    /// exclusive.
    pub range_start: String,
    pub range_end: String,
    pub resolution: UsageResolution,
    pub scan: UsageScanState,
    /// Distinct sessions with at least one record in the window, across all
    /// providers. Per-provider counts do not sum to this when a session
    /// switched provider mid-way, which is why it is carried separately.
    pub sessions: i64,
    pub tokens: UsageTokenTotals,
    pub cost_usd: f64,
    pub cache_savings_usd: f64,
    pub cost_source: UsageCostSource,
    /// The window before this one, narrowed the same way, for the "vs the
    /// previous 30 days" comparison. `None` when the ledger cannot cover it.
    pub previous: Option<UsagePreviousPeriod>,
    pub providers: Vec<UsageProviderSummary>,
    pub series: Vec<UsageSeriesPoint>,
    pub models: Vec<UsageModelRow>,
    pub days: Vec<UsageDayRow>,
}

impl UsageSummary {
    /// The shape before the first scan has produced anything: every count
    /// zero, scan marked in flight.
    pub fn before_first_scan(
        window: UsageWindow,
        provider: Option<ProviderId>,
        time_zone: String,
    ) -> Self {
        Self {
            window,
            provider,
            time_zone,
            range_start: String::new(),
            range_end: String::new(),
            resolution: match window {
                UsageWindow::Past24h => UsageResolution::Hour,
                UsageWindow::Past7d | UsageWindow::Past30d => UsageResolution::Day,
            },
            scan: UsageScanState {
                phase: UsageScanPhase::Scanning,
                files_total: 0,
                files_done: 0,
                last_completed_at: None,
                pricing_as_of: PRICING_AS_OF.to_string(),
            },
            sessions: 0,
            tokens: UsageTokenTotals::default(),
            cost_usd: 0.0,
            cache_savings_usd: 0.0,
            cost_source: UsageCostSource::ListPrice,
            previous: None,
            providers: Vec::new(),
            series: Vec::new(),
            models: Vec::new(),
            days: Vec::new(),
        }
    }
}
