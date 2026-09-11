//! Activity page: the user's own engineering output — commits, lines, streaks,
//! pull requests, reviews — read out of the git history of every registered
//! project plus a cached `gh` half.
//!
//! This module holds the wire contract `activity:summary` returns. The git
//! parser, the scanner, the GitHub fetch, and the aggregation live in the
//! sibling modules. See `docs/activity.md`.

use serde::{Deserialize, Serialize};
use specta::Type;

pub mod git_log;
pub mod github;
pub mod scanner;
pub mod summary;

/// How far back the commit ledger reaches. Everything the page can ask for
/// fits inside it, with a month of slack so the 12-month window's `previous`
/// comparison has something to stand on at its far edge.
pub const LEDGER_MONTHS: u32 = 13;

/// Cells in the contribution heatmap: the 365 local days ending today.
pub const HEATMAP_DAYS: i64 = 365;

/// Caps on the two list fields, so one busy year cannot hand the renderer an
/// unbounded payload.
pub const MAX_PULL_REQUESTS: usize = 100;
pub const MAX_REVIEWS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ActivityWindow {
    #[serde(rename = "24h")]
    Past24h,
    #[serde(rename = "7d")]
    Past7d,
    #[serde(rename = "30d")]
    Past30d,
    /// The 12 months ending today.
    #[serde(rename = "12m")]
    Past12m,
    /// The current calendar year, January 1 local through now.
    #[serde(rename = "year")]
    CalendarYear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ActivityResolution {
    Hour,
    Day,
    Week,
}

impl ActivityWindow {
    pub fn resolution(self) -> ActivityResolution {
        match self {
            Self::Past24h => ActivityResolution::Hour,
            Self::Past7d | Self::Past30d => ActivityResolution::Day,
            Self::Past12m | Self::CalendarYear => ActivityResolution::Week,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTotals {
    pub commits: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub files_changed: i64,
    /// Distinct local days with at least one commit.
    pub active_days: i64,
    pub prs_opened: i64,
    pub prs_merged: i64,
    /// Closed without merging.
    pub prs_closed: i64,
    /// Review submissions on pull requests the user did not author.
    pub reviews_given: i64,
    pub review_approvals: i64,
    pub review_changes_requested: i64,
    /// Review submissions that neither approved nor requested changes.
    pub review_comments: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRepository {
    pub project_id: String,
    pub name: String,
    pub path: String,
    /// `owner/name` parsed from the origin remote; `None` when the project has
    /// no GitHub remote.
    pub github_repo: Option<String>,
    pub commits: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub prs_merged: i64,
    /// Newest commit in the whole ledger, not just the window, so a repository
    /// with a quiet month still says when it was last touched.
    pub last_commit_at: Option<String>,
    /// This repository's share of the window's commits across every
    /// repository, 0..1. It stays a share of the whole even while one project
    /// is in focus — the same rule the Usage tiles follow.
    pub share: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySeriesRepository {
    pub project_id: String,
    pub commits: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
}

/// One chart bucket. `bucket_start` is the bucket's first instant as RFC 3339
/// UTC; the renderer formats it in `ActivitySummary::time_zone`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySeriesPoint {
    pub bucket_start: String,
    /// Only repositories with commits in the bucket.
    pub by_repository: Vec<ActivitySeriesRepository>,
}

/// One cell per local day. Always the 365 days ending today, whatever the
/// window is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityHeatmapDay {
    pub date: String,
    pub commits: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBusiestDay {
    pub date: String,
    pub commits: i64,
}

/// Streak arithmetic runs over the whole ledger, not the window: a 40-day
/// streak is a 40-day streak whether or not the 7-day view can see all of it.
/// `busiest_day` is the exception and is scoped to the window.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStreaks {
    pub current_days: i64,
    pub current_start: Option<String>,
    pub longest_days: i64,
    pub longest_start: Option<String>,
    pub longest_end: Option<String>,
    pub busiest_day: Option<ActivityBusiestDay>,
}

/// Commits in the window by local weekday (Monday first) and local hour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCadence {
    pub by_weekday: Vec<i64>,
    pub by_hour: Vec<i64>,
}

impl Default for ActivityCadence {
    fn default() -> Self {
        Self {
            by_weekday: vec![0; 7],
            by_hour: vec![0; 24],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ActivityPrState {
    Open,
    Merged,
    Closed,
}

impl ActivityPrState {
    /// Read the value `activity_github_prs.state` holds. The column is
    /// normalized on the way in, so an unknown string can only mean a row
    /// written by an older build: `open` is the safe reading.
    pub fn from_stored(value: &str) -> Self {
        match value {
            "merged" => Self::Merged,
            "closed" => Self::Closed,
            _ => Self::Open,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPullRequest {
    pub number: i64,
    pub title: String,
    /// `owner/name`.
    pub repository: String,
    /// The local project whose remote matches, else `None`.
    pub project_id: Option<String>,
    pub url: String,
    pub state: ActivityPrState,
    pub is_draft: bool,
    pub created_at: String,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    /// `merged_at - created_at` in seconds; `None` unless merged.
    pub cycle_seconds: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ActivityReviewState {
    Approved,
    ChangesRequested,
    Commented,
}

impl ActivityReviewState {
    /// Read the value `activity_github_reviews.state` holds. Anything GitHub
    /// reports that is neither an approval nor a change request is a comment.
    pub fn from_stored(value: &str) -> Self {
        match value {
            "approved" => Self::Approved,
            "changes_requested" => Self::ChangesRequested,
            _ => Self::Commented,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityReview {
    pub number: i64,
    pub title: String,
    pub repository: String,
    pub url: String,
    pub state: ActivityReviewState,
    pub submitted_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ActivityScanPhase {
    Idle,
    Scanning,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityScanState {
    pub phase: ActivityScanPhase,
    pub repos_total: i64,
    pub repos_done: i64,
    /// RFC 3339 UTC; `None` before the first sweep finishes.
    pub last_completed_at: Option<String>,
}

impl ActivityScanState {
    /// Nothing has run and nothing is running: boot has not installed a
    /// scanner yet, so the page shows its skeleton and the next read starts
    /// the sweep.
    pub fn idle() -> Self {
        Self {
            phase: ActivityScanPhase::Idle,
            repos_total: 0,
            repos_done: 0,
            last_completed_at: None,
        }
    }
}

/// State of the `gh` half. `available` is false when `gh` is missing, signed
/// out, or the last refresh failed with nothing cached; the local half of the
/// page renders either way.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityGithubState {
    pub available: bool,
    pub login: Option<String>,
    pub error: Option<String>,
    pub last_fetched_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySummary {
    pub window: ActivityWindow,
    /// The project the totals, series, streaks, cadence, pull requests and
    /// reviews are narrowed to; `None` is every repository. `repositories` and
    /// `heatmap` are never narrowed.
    pub project_id: Option<String>,
    /// IANA zone the renderer asked for; day buckets follow it.
    pub time_zone: String,
    /// RFC 3339 UTC instants bounding the window, start inclusive, end
    /// exclusive.
    pub range_start: String,
    pub range_end: String,
    pub resolution: ActivityResolution,
    /// Author emails the commits were matched on: `git config user.email` in
    /// each repository plus the global one.
    pub author_emails: Vec<String>,
    pub scan: ActivityScanState,
    pub github: ActivityGithubState,
    pub totals: ActivityTotals,
    /// The same-length window immediately before, narrowed the same way.
    /// `None` when the ledger cannot honestly cover it.
    pub previous: Option<ActivityTotals>,
    /// Every project, ranked by commits in the window, descending. Projects
    /// with no commits are included.
    pub repositories: Vec<ActivityRepository>,
    /// One point per bucket, empty buckets included.
    pub series: Vec<ActivitySeriesPoint>,
    pub heatmap: Vec<ActivityHeatmapDay>,
    pub streaks: ActivityStreaks,
    pub cadence: ActivityCadence,
    /// Authored by the user and created or merged inside the window, newest
    /// activity first, capped at [`MAX_PULL_REQUESTS`].
    pub pull_requests: Vec<ActivityPullRequest>,
    /// Submitted inside the window, newest first, capped at [`MAX_REVIEWS`].
    pub reviews: Vec<ActivityReview>,
    /// Median `cycle_seconds` over the pull requests merged in the window.
    pub median_cycle_seconds: Option<i64>,
}

impl ActivitySummary {
    /// The shape before the first sweep has produced anything: every count
    /// zero, scan marked in flight. `range_start` / `range_end` are still real
    /// so the renderer's axis has something to draw.
    pub fn before_first_scan(
        window: ActivityWindow,
        project_id: Option<String>,
        time_zone: String,
        scan: ActivityScanState,
    ) -> Self {
        Self {
            window,
            project_id,
            time_zone,
            range_start: String::new(),
            range_end: String::new(),
            resolution: window.resolution(),
            author_emails: Vec::new(),
            scan,
            github: ActivityGithubState::default(),
            totals: ActivityTotals::default(),
            previous: None,
            repositories: Vec::new(),
            series: Vec::new(),
            heatmap: Vec::new(),
            streaks: ActivityStreaks::default(),
            cadence: ActivityCadence::default(),
            pull_requests: Vec::new(),
            reviews: Vec::new(),
            median_cycle_seconds: None,
        }
    }
}
