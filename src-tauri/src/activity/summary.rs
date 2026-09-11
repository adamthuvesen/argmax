//! Builds `ActivitySummary` out of the ledger. Pure over a read-only
//! connection, a time zone, and `now`, so every counting rule in
//! `docs/activity.md` has a test that names the instant it is asked about.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Datelike, Days, Months, NaiveDate, TimeZone, Timelike, Utc, Weekday};
use chrono_tz::Tz;
use rusqlite::Connection;

use crate::activity::scanner::to_utc_iso;
use crate::activity::{
    ActivityBusiestDay, ActivityCadence, ActivityGithubState, ActivityHeatmapDay, ActivityPrState,
    ActivityPullRequest, ActivityRepository, ActivityResolution, ActivityReview,
    ActivityReviewState, ActivityScanState, ActivitySeriesPoint, ActivitySeriesRepository,
    ActivityStreaks, ActivitySummary, ActivityTotals, ActivityWindow, HEATMAP_DAYS,
    MAX_PULL_REQUESTS, MAX_REVIEWS,
};
use crate::error::ArgmaxResult;
use crate::persistence::activity::{self as storage, PullRequestRow, ReviewRow};
use crate::persistence::projects;

/// A ledger row with its instant already parsed and its local day resolved.
#[derive(Debug, Clone)]
struct Commit {
    project_id: String,
    at: DateTime<Utc>,
    local_date: NaiveDate,
    local_hour: u32,
    local_weekday: Weekday,
    lines_added: i64,
    lines_removed: i64,
    files_changed: i64,
}

#[allow(clippy::too_many_arguments)]
pub fn build_summary(
    connection: &Connection,
    window: ActivityWindow,
    project_id: Option<String>,
    tz: Tz,
    scan: ActivityScanState,
    github: ActivityGithubState,
    author_emails: Vec<String>,
    now: DateTime<Utc>,
) -> ArgmaxResult<ActivitySummary> {
    let (range_start, range_end) = window_bounds(window, tz, now);
    let previous_start = previous_range_start(window, tz, now, range_start);
    let heatmap_start =
        local_day_start(tz, local_date(tz, now) - Days::new(HEATMAP_DAYS as u64 - 1));

    // One read covers the window, the comparison window, and the heatmap; the
    // three overlap and the ledger only reaches back 13 months anyway.
    let read_from = previous_start.min(heatmap_start);
    let commits = load_commits(connection, tz, read_from, range_end)?;

    let projects = projects::list_projects(connection)?;
    let remotes: HashMap<String, String> = storage::list_project_remotes(connection)?
        .into_iter()
        .collect();
    // Case-insensitive, because a remote's stored case is whatever the URL had.
    let project_by_repo: HashMap<String, String> = remotes
        .iter()
        .map(|(project_id, repo)| (repo.to_ascii_lowercase(), project_id.clone()))
        .collect();
    let latest_per_project: HashMap<String, String> =
        storage::latest_commit_per_project(connection)?
            .into_iter()
            .collect();

    let in_window = |commit: &&Commit| commit.at >= range_start && commit.at < range_end;
    let window_commits: Vec<&Commit> = commits.iter().filter(in_window).collect();
    let narrowed: Vec<&Commit> = window_commits
        .iter()
        .copied()
        .filter(|commit| matches_project(commit, project_id.as_deref()))
        .collect();

    let pull_requests = load_pull_requests(
        connection,
        &project_by_repo,
        range_start,
        range_end,
        project_id.as_deref(),
    )?;
    let reviews = load_reviews(
        connection,
        &project_by_repo,
        range_start,
        range_end,
        project_id.as_deref(),
    )?;

    let totals = totals_of(&narrowed, &pull_requests, &reviews, range_start, range_end);
    let previous = previous_totals(
        connection,
        &commits,
        &project_by_repo,
        project_id.as_deref(),
        previous_start,
        range_start,
    )?;

    let unnarrowed_commits = window_commits.len() as i64;
    let repositories = repository_rows(
        &projects,
        &window_commits,
        &pull_requests,
        &remotes,
        &latest_per_project,
        unnarrowed_commits,
        range_start,
        range_end,
    );

    // Only the pull requests actually merged inside the window have a cycle
    // time to speak of; one merged before it entered the list through its
    // creation date.
    let cycles: Vec<i64> = pull_requests
        .iter()
        .filter(|pr| {
            pr.merged_at
                .as_deref()
                .is_some_and(|merged| within(merged, range_start, range_end))
        })
        .filter_map(|pr| pr.cycle_seconds)
        .collect();

    Ok(ActivitySummary {
        window,
        time_zone: tz.name().to_string(),
        range_start: to_utc_iso(range_start),
        range_end: to_utc_iso(range_end),
        resolution: window.resolution(),
        author_emails,
        scan,
        github,
        totals,
        previous,
        repositories,
        series: series(&narrowed, bucket_starts(window, tz, now)),
        // The heatmap is a year of the user's work, not a view of the window,
        // and it never narrows — the same rule the Usage tiles follow.
        heatmap: heatmap(&commits, tz, now),
        streaks: streaks(&commits, &narrowed, tz, now, project_id.as_deref()),
        cadence: cadence(&narrowed),
        median_cycle_seconds: median_cycle_seconds(&cycles),
        pull_requests: rank_pull_requests(pull_requests),
        reviews: rank_reviews(reviews),
        project_id,
    })
}

// ---------------------------------------------------------------- time bounds

fn local_date(tz: Tz, at: DateTime<Utc>) -> NaiveDate {
    at.with_timezone(&tz).date_naive()
}

/// A local day's first instant. A DST spring-forward day has no midnight, so
/// the earliest valid instant is that day's real start.
fn local_day_start(tz: Tz, date: NaiveDate) -> DateTime<Utc> {
    let midnight = date.and_hms_opt(0, 0, 0).expect("midnight");
    tz.from_local_datetime(&midnight)
        .earliest()
        .map(|local| local.with_timezone(&Utc))
        // A zone that has no valid instant at all for this local midnight is
        // impossible in the IANA data; falling back to the UTC reading keeps
        // the function total rather than panicking on it.
        .unwrap_or_else(|| DateTime::from_naive_utc_and_offset(midnight, Utc))
}

/// The local hour `at` falls in, as an instant. Zones with a half-hour offset
/// make this differ from truncating the UTC hour, which is why it goes through
/// the zone.
fn local_hour_start(tz: Tz, at: DateTime<Utc>) -> DateTime<Utc> {
    let local = at.with_timezone(&tz);
    let truncated = local
        .with_minute(0)
        .and_then(|value| value.with_second(0))
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(local);
    truncated.with_timezone(&Utc)
}

/// Start inclusive, end exclusive. The end is always `now`: a window that ran
/// to the end of today would claim hours that have not happened.
pub fn window_bounds(
    window: ActivityWindow,
    tz: Tz,
    now: DateTime<Utc>,
) -> (DateTime<Utc>, DateTime<Utc>) {
    let today = local_date(tz, now);
    let start = match window {
        ActivityWindow::Past24h => local_hour_start(tz, now) - chrono::Duration::hours(23),
        ActivityWindow::Past7d => local_day_start(tz, today - Days::new(6)),
        ActivityWindow::Past30d => local_day_start(tz, today - Days::new(29)),
        ActivityWindow::Past12m => local_day_start(
            tz,
            today.checked_sub_months(Months::new(12)).unwrap_or(today),
        ),
        ActivityWindow::CalendarYear => local_day_start(
            tz,
            NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today),
        ),
    };
    (start, now)
}

/// Bucket boundaries inside the window. Hour and day windows start on a
/// boundary already; a week window's first bucket is short, starting at
/// `range_start` and running to the following Monday, so no bucket ever begins
/// outside the range it is summing.
pub fn bucket_starts(window: ActivityWindow, tz: Tz, now: DateTime<Utc>) -> Vec<DateTime<Utc>> {
    let (range_start, range_end) = window_bounds(window, tz, now);
    match window.resolution() {
        ActivityResolution::Hour => (0..24)
            .rev()
            .map(|hours_ago| local_hour_start(tz, now) - chrono::Duration::hours(hours_ago))
            .collect(),
        ActivityResolution::Day => {
            let today = local_date(tz, now);
            let first = local_date(tz, range_start);
            let days = (today - first).num_days().max(0) as u64;
            (0..=days)
                .map(|offset| local_day_start(tz, first + Days::new(offset)))
                .collect()
        }
        ActivityResolution::Week => {
            let mut starts = vec![range_start];
            let mut cursor = next_monday(local_date(tz, range_start));
            while local_day_start(tz, cursor) < range_end {
                starts.push(local_day_start(tz, cursor));
                cursor = cursor + Days::new(7);
            }
            starts
        }
    }
}

fn next_monday(date: NaiveDate) -> NaiveDate {
    let ahead = 7 - date.weekday().num_days_from_monday() as u64;
    date + Days::new(ahead)
}

/// Start of the same-length window immediately before this one. Day and month
/// windows step on local dates so a DST change does not slide the edge; the
/// calendar year steps back by however many days of it have elapsed.
pub fn previous_range_start(
    window: ActivityWindow,
    tz: Tz,
    now: DateTime<Utc>,
    range_start: DateTime<Utc>,
) -> DateTime<Utc> {
    let start_date = local_date(tz, range_start);
    match window {
        ActivityWindow::Past24h => range_start - chrono::Duration::hours(24),
        ActivityWindow::Past7d => local_day_start(tz, start_date - Days::new(7)),
        ActivityWindow::Past30d => local_day_start(tz, start_date - Days::new(30)),
        ActivityWindow::Past12m => local_day_start(
            tz,
            start_date
                .checked_sub_months(Months::new(12))
                .unwrap_or(start_date),
        ),
        ActivityWindow::CalendarYear => {
            let elapsed = (local_date(tz, now) - start_date).num_days().max(0) as u64 + 1;
            local_day_start(tz, start_date - Days::new(elapsed))
        }
    }
}

// -------------------------------------------------------------------- loading

fn load_commits(
    connection: &Connection,
    tz: Tz,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> ArgmaxResult<Vec<Commit>> {
    let rows = storage::list_commits_between(connection, &to_utc_iso(from), &to_utc_iso(to))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let at = DateTime::parse_from_rfc3339(&row.committed_at)
                .ok()?
                .with_timezone(&Utc);
            let local = at.with_timezone(&tz);
            Some(Commit {
                project_id: row.project_id,
                at,
                local_date: local.date_naive(),
                local_hour: local.hour(),
                local_weekday: local.weekday(),
                lines_added: row.lines_added,
                lines_removed: row.lines_removed,
                files_changed: row.files_changed,
            })
        })
        .collect())
}

fn matches_project(commit: &Commit, project_id: Option<&str>) -> bool {
    project_id.is_none_or(|wanted| commit.project_id == wanted)
}

fn load_pull_requests(
    connection: &Connection,
    project_by_repo: &HashMap<String, String>,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
    project_id: Option<&str>,
) -> ArgmaxResult<Vec<ActivityPullRequest>> {
    let rows = storage::list_pull_requests_touching(
        connection,
        &to_utc_iso(range_start),
        &to_utc_iso(range_end),
    )?;
    Ok(rows
        .into_iter()
        .map(|row| to_pull_request(row, project_by_repo))
        .filter(|pr| project_id.is_none_or(|wanted| pr.project_id.as_deref() == Some(wanted)))
        .collect())
}

fn to_pull_request(
    row: PullRequestRow,
    project_by_repo: &HashMap<String, String>,
) -> ActivityPullRequest {
    let cycle_seconds = row.merged_at.as_deref().and_then(|merged| {
        let merged = DateTime::parse_from_rfc3339(merged).ok()?;
        let created = DateTime::parse_from_rfc3339(&row.created_at).ok()?;
        Some(merged.signed_duration_since(created).num_seconds().max(0))
    });
    ActivityPullRequest {
        number: row.number,
        title: row.title,
        project_id: project_by_repo
            .get(&row.repository.to_ascii_lowercase())
            .cloned(),
        repository: row.repository,
        url: row.url,
        state: ActivityPrState::from_stored(&row.state),
        is_draft: row.is_draft,
        created_at: row.created_at,
        merged_at: row.merged_at,
        closed_at: row.closed_at,
        additions: row.additions,
        deletions: row.deletions,
        cycle_seconds,
    }
}

fn load_reviews(
    connection: &Connection,
    project_by_repo: &HashMap<String, String>,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
    project_id: Option<&str>,
) -> ArgmaxResult<Vec<ActivityReview>> {
    let rows = storage::list_reviews_between(
        connection,
        &to_utc_iso(range_start),
        &to_utc_iso(range_end),
    )?;
    Ok(rows
        .into_iter()
        .filter(|row| {
            project_id.is_none_or(|wanted| {
                project_by_repo.get(&row.repository.to_ascii_lowercase())
                    == Some(&wanted.to_string())
            })
        })
        .map(to_review)
        .collect())
}

fn to_review(row: ReviewRow) -> ActivityReview {
    ActivityReview {
        number: row.number,
        title: row.title,
        repository: row.repository,
        url: row.url,
        state: ActivityReviewState::from_stored(&row.state),
        submitted_at: row.submitted_at,
    }
}

// ------------------------------------------------------------------- counting

fn totals_of(
    commits: &[&Commit],
    pull_requests: &[ActivityPullRequest],
    reviews: &[ActivityReview],
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
) -> ActivityTotals {
    let mut totals = ActivityTotals {
        commits: commits.len() as i64,
        ..ActivityTotals::default()
    };
    let mut days: HashSet<NaiveDate> = HashSet::new();
    for commit in commits {
        totals.lines_added += commit.lines_added;
        totals.lines_removed += commit.lines_removed;
        totals.files_changed += commit.files_changed;
        days.insert(commit.local_date);
    }
    totals.active_days = days.len() as i64;

    for pr in pull_requests {
        if within(&pr.created_at, range_start, range_end) {
            totals.prs_opened += 1;
        }
        match (pr.merged_at.as_deref(), pr.closed_at.as_deref()) {
            (Some(merged), _) if within(merged, range_start, range_end) => totals.prs_merged += 1,
            // GitHub stamps `closed_at` on a merge too, so only an unmerged
            // pull request counts as closed.
            (None, Some(closed)) if within(closed, range_start, range_end) => {
                totals.prs_closed += 1
            }
            _ => {}
        }
    }

    totals.reviews_given = reviews.len() as i64;
    for review in reviews {
        match review.state {
            ActivityReviewState::Approved => totals.review_approvals += 1,
            ActivityReviewState::ChangesRequested => totals.review_changes_requested += 1,
            ActivityReviewState::Commented => totals.review_comments += 1,
        }
    }
    totals
}

fn within(value: &str, from: DateTime<Utc>, to: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| {
            let at = parsed.with_timezone(&Utc);
            at >= from && at < to
        })
        .unwrap_or(false)
}

/// `None` when the ledger cannot honestly cover the earlier window: when it
/// holds nothing inside it, or when its oldest commit starts after that window
/// began. A first install must not read as up 100%.
fn previous_totals(
    connection: &Connection,
    commits: &[Commit],
    project_by_repo: &HashMap<String, String>,
    project_id: Option<&str>,
    previous_start: DateTime<Utc>,
    previous_end: DateTime<Utc>,
) -> ArgmaxResult<Option<ActivityTotals>> {
    let earliest = storage::earliest_commit_at(connection)?
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.with_timezone(&Utc));
    if earliest.is_none_or(|oldest| oldest > previous_start) {
        return Ok(None);
    }
    let selected: Vec<&Commit> = commits
        .iter()
        .filter(|commit| commit.at >= previous_start && commit.at < previous_end)
        .filter(|commit| matches_project(commit, project_id))
        .collect();
    let pull_requests = load_pull_requests(
        connection,
        project_by_repo,
        previous_start,
        previous_end,
        project_id,
    )?;
    let reviews = load_reviews(
        connection,
        project_by_repo,
        previous_start,
        previous_end,
        project_id,
    )?;
    if selected.is_empty() && pull_requests.is_empty() && reviews.is_empty() {
        return Ok(None);
    }
    Ok(Some(totals_of(
        &selected,
        &pull_requests,
        &reviews,
        previous_start,
        previous_end,
    )))
}

#[allow(clippy::too_many_arguments)]
fn repository_rows(
    projects: &[projects::ProjectSummary],
    window_commits: &[&Commit],
    pull_requests: &[ActivityPullRequest],
    remotes: &HashMap<String, String>,
    latest_per_project: &HashMap<String, String>,
    unnarrowed_commits: i64,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
) -> Vec<ActivityRepository> {
    let mut tally: HashMap<&str, (i64, i64, i64)> = HashMap::new();
    for commit in window_commits {
        let entry = tally.entry(commit.project_id.as_str()).or_default();
        entry.0 += 1;
        entry.1 += commit.lines_added;
        entry.2 += commit.lines_removed;
    }
    let mut merged: HashMap<&str, i64> = HashMap::new();
    for pr in pull_requests {
        let Some(project_id) = pr.project_id.as_deref() else {
            continue;
        };
        if pr
            .merged_at
            .as_deref()
            .is_some_and(|merged| within(merged, range_start, range_end))
        {
            *merged.entry(project_id).or_default() += 1;
        }
    }

    let mut rows: Vec<ActivityRepository> = projects
        .iter()
        .map(|project| {
            let (commits, lines_added, lines_removed) =
                tally.get(project.id.as_str()).copied().unwrap_or_default();
            ActivityRepository {
                project_id: project.id.clone(),
                name: project.name.clone(),
                path: project.repo_path.clone(),
                github_repo: remotes.get(&project.id).cloned(),
                commits,
                lines_added,
                lines_removed,
                prs_merged: merged.get(project.id.as_str()).copied().unwrap_or(0),
                last_commit_at: latest_per_project.get(&project.id).cloned(),
                share: if unnarrowed_commits > 0 {
                    commits as f64 / unnarrowed_commits as f64
                } else {
                    0.0
                },
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.commits
            .cmp(&a.commits)
            .then_with(|| b.lines_added.cmp(&a.lines_added))
            .then_with(|| a.name.cmp(&b.name))
    });
    rows
}

fn series(commits: &[&Commit], starts: Vec<DateTime<Utc>>) -> Vec<ActivitySeriesPoint> {
    let mut buckets: Vec<BTreeMap<&str, (i64, i64, i64)>> = vec![BTreeMap::new(); starts.len()];
    for commit in commits {
        // The latest boundary at or before the commit is its bucket.
        let Some(index) = starts.iter().rposition(|start| *start <= commit.at) else {
            continue;
        };
        let entry = buckets[index]
            .entry(commit.project_id.as_str())
            .or_default();
        entry.0 += 1;
        entry.1 += commit.lines_added;
        entry.2 += commit.lines_removed;
    }
    starts
        .into_iter()
        .zip(buckets)
        .map(|(start, bucket)| ActivitySeriesPoint {
            bucket_start: to_utc_iso(start),
            by_repository: bucket
                .into_iter()
                .map(|(project_id, (commits, lines_added, lines_removed))| {
                    ActivitySeriesRepository {
                        project_id: project_id.to_string(),
                        commits,
                        lines_added,
                        lines_removed,
                    }
                })
                .collect(),
        })
        .collect()
}

/// Always the 365 local days ending today, one cell each, zeros included.
fn heatmap(commits: &[Commit], tz: Tz, now: DateTime<Utc>) -> Vec<ActivityHeatmapDay> {
    let today = local_date(tz, now);
    let first = today - Days::new(HEATMAP_DAYS as u64 - 1);
    let mut per_day: HashMap<NaiveDate, i64> = HashMap::new();
    for commit in commits {
        if commit.local_date >= first && commit.local_date <= today {
            *per_day.entry(commit.local_date).or_default() += 1;
        }
    }
    (0..HEATMAP_DAYS as u64)
        .map(|offset| {
            let date = first + Days::new(offset);
            ActivityHeatmapDay {
                date: date.to_string(),
                commits: per_day.get(&date).copied().unwrap_or(0),
            }
        })
        .collect()
}

/// Current and longest streaks run over every local day the ledger holds — a
/// 40-day streak is a 40-day streak whether or not the 7-day view can see all
/// of it. The busiest day is the one figure scoped to the window.
fn streaks(
    all: &[Commit],
    window: &[&Commit],
    tz: Tz,
    now: DateTime<Utc>,
    project_id: Option<&str>,
) -> ActivityStreaks {
    let days: BTreeSet<NaiveDate> = all
        .iter()
        .filter(|commit| matches_project(commit, project_id))
        .map(|commit| commit.local_date)
        .collect();

    let mut longest = 0i64;
    let mut longest_start = None;
    let mut longest_end = None;
    let mut run_start: Option<NaiveDate> = None;
    let mut previous: Option<NaiveDate> = None;
    for day in &days {
        let continues = previous.is_some_and(|last| last + Days::new(1) == *day);
        if !continues {
            run_start = Some(*day);
        }
        let start = run_start.unwrap_or(*day);
        let length = (*day - start).num_days() + 1;
        if length > longest {
            longest = length;
            longest_start = Some(start);
            longest_end = Some(*day);
        }
        previous = Some(*day);
    }

    // A streak counts as current while today is still open: yesterday's commit
    // keeps it alive until midnight, which is how every contribution graph
    // reads.
    let today = local_date(tz, now);
    let anchor = if days.contains(&today) {
        Some(today)
    } else {
        let yesterday = today - Days::new(1);
        days.contains(&yesterday).then_some(yesterday)
    };
    let (current_days, current_start) = match anchor {
        Some(anchor) => {
            let mut start = anchor;
            while days.contains(&(start - Days::new(1))) {
                start = start - Days::new(1);
            }
            ((anchor - start).num_days() + 1, Some(start))
        }
        None => (0, None),
    };

    let mut per_day: HashMap<NaiveDate, i64> = HashMap::new();
    for commit in window {
        *per_day.entry(commit.local_date).or_default() += 1;
    }
    let busiest_day = per_day
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)))
        .map(|(date, commits)| ActivityBusiestDay {
            date: date.to_string(),
            commits,
        });

    ActivityStreaks {
        current_days,
        current_start: current_start.map(|date| date.to_string()),
        longest_days: longest,
        longest_start: longest_start.map(|date| date.to_string()),
        longest_end: longest_end.map(|date| date.to_string()),
        busiest_day,
    }
}

fn cadence(commits: &[&Commit]) -> ActivityCadence {
    let mut cadence = ActivityCadence::default();
    for commit in commits {
        cadence.by_weekday[commit.local_weekday.num_days_from_monday() as usize] += 1;
        cadence.by_hour[commit.local_hour as usize] += 1;
    }
    cadence
}

/// Newest activity first: a pull request opened last year and merged yesterday
/// belongs at the top of a window that only includes it because of the merge.
fn rank_pull_requests(mut rows: Vec<ActivityPullRequest>) -> Vec<ActivityPullRequest> {
    rows.sort_by(|a, b| newest_stamp(b).cmp(newest_stamp(a)));
    rows.truncate(MAX_PULL_REQUESTS);
    rows
}

fn newest_stamp(pr: &ActivityPullRequest) -> &str {
    [
        pr.merged_at.as_deref(),
        pr.closed_at.as_deref(),
        Some(pr.created_at.as_str()),
    ]
    .into_iter()
    .flatten()
    .max()
    .unwrap_or("")
}

fn rank_reviews(mut rows: Vec<ActivityReview>) -> Vec<ActivityReview> {
    rows.sort_by(|a, b| b.submitted_at.cmp(&a.submitted_at));
    rows.truncate(MAX_REVIEWS);
    rows
}

/// Median over the pull requests merged inside the window. An even count takes
/// the mean of the two middles, floored — seconds, so a half second is noise.
fn median_cycle_seconds(cycles: &[i64]) -> Option<i64> {
    if cycles.is_empty() {
        return None;
    }
    let mut sorted = cycles.to_vec();
    sorted.sort_unstable();
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        Some(sorted[middle])
    } else {
        Some((sorted[middle - 1] + sorted[middle]) / 2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::{ActivityScanPhase, ActivityWindow};
    use crate::persistence::projects::{PersistProjectInput, ProjectSettings};
    use crate::persistence::Database;

    const STOCKHOLM: Tz = chrono_tz::Europe::Stockholm;

    fn scan_state() -> ActivityScanState {
        ActivityScanState {
            phase: ActivityScanPhase::Complete,
            repos_total: 1,
            repos_done: 1,
            last_completed_at: Some("2026-09-10T12:00:00.000Z".into()),
        }
    }

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .expect("instant")
            .with_timezone(&Utc)
    }

    fn seed_project(connection: &Connection, id: &str, name: &str) {
        projects::persist_project(
            connection,
            &PersistProjectInput {
                id: id.to_owned(),
                name: name.to_owned(),
                repo_path: format!("/tmp/{id}"),
                current_branch: "main".to_owned(),
                default_branch: Some("main".to_owned()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: "~/.argmax".to_owned(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("persist project");
    }

    /// One commit at `committed_at`, with a SHA derived from the timestamp so
    /// a fixture cannot silently collide with itself.
    fn seed_commit(connection: &Connection, project_id: &str, committed_at: &str) {
        seed_commits(connection, project_id, &[committed_at]);
    }

    fn seed_commits(connection: &Connection, project_id: &str, stamps: &[&str]) {
        let rows: Vec<storage::CommitRow> = stamps
            .iter()
            .enumerate()
            .map(|(index, stamp)| storage::CommitRow {
                sha: format!("{project_id}-{index}-{stamp}"),
                project_id: project_id.to_owned(),
                author_email: "me@example.com".to_owned(),
                committed_at: to_utc_iso(at(stamp)),
                author_at: to_utc_iso(at(stamp)),
                lines_added: 10,
                lines_removed: 4,
                files_changed: 2,
            })
            .collect();
        storage::upsert_commits(connection, &rows).expect("seed commits");
    }

    fn build(
        connection: &Connection,
        window: ActivityWindow,
        project_id: Option<&str>,
        now: &str,
    ) -> ActivitySummary {
        build_summary(
            connection,
            window,
            project_id.map(str::to_owned),
            STOCKHOLM,
            scan_state(),
            ActivityGithubState::default(),
            vec!["me@example.com".to_owned()],
            at(now),
        )
        .expect("summary")
    }

    /// Stockholm leaves DST at 03:00 local on 2026-10-25, so the seven days
    /// ending 2026-10-27 span both offsets. Each bucket has to be that local
    /// day, which means one of them is 25 hours long — a fixed 24-hour step
    /// would slide every earlier boundary by an hour.
    #[test]
    fn day_buckets_hold_their_local_midnight_across_a_dst_change() {
        let starts = bucket_starts(
            ActivityWindow::Past7d,
            STOCKHOLM,
            at("2026-10-27T09:00:00Z"),
        );

        assert_eq!(starts.len(), 7);
        assert_eq!(
            starts
                .iter()
                .map(|start| to_utc_iso(*start))
                .collect::<Vec<_>>(),
            vec![
                // CEST, UTC+2
                "2026-10-20T22:00:00.000Z",
                "2026-10-21T22:00:00.000Z",
                "2026-10-22T22:00:00.000Z",
                "2026-10-23T22:00:00.000Z",
                "2026-10-24T22:00:00.000Z",
                // The change happens inside this day; the next midnight is CET.
                "2026-10-25T23:00:00.000Z",
                "2026-10-26T23:00:00.000Z",
            ]
        );
        let (range_start, range_end) = window_bounds(
            ActivityWindow::Past7d,
            STOCKHOLM,
            at("2026-10-27T09:00:00Z"),
        );
        assert_eq!(to_utc_iso(range_start), "2026-10-20T22:00:00.000Z");
        assert_eq!(to_utc_iso(range_end), "2026-10-27T09:00:00.000Z");
    }

    /// The comparison window steps on local dates too, so the seven days
    /// before a DST change are seven local days, not 168 hours.
    #[test]
    fn the_previous_window_steps_on_local_days_not_fixed_hours() {
        let now = at("2026-10-27T09:00:00Z");
        let (range_start, _) = window_bounds(ActivityWindow::Past7d, STOCKHOLM, now);
        let previous = previous_range_start(ActivityWindow::Past7d, STOCKHOLM, now, range_start);

        assert_eq!(to_utc_iso(previous), "2026-10-13T22:00:00.000Z");
        assert_eq!(
            range_start.signed_duration_since(previous).num_hours(),
            7 * 24
        );
    }

    #[test]
    fn a_commit_at_the_window_edge_lands_in_the_window() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        // Local midnight on the first day of the window, and the instant
        // before it.
        seed_commit(&connection, "p1", "2026-10-20T22:00:00Z");
        seed_commit(&connection, "p1", "2026-10-20T21:59:59Z");

        let summary = build(
            &connection,
            ActivityWindow::Past7d,
            None,
            "2026-10-27T09:00:00Z",
        );

        assert_eq!(summary.totals.commits, 1);
        assert_eq!(summary.totals.lines_added, 10);
        assert_eq!(summary.totals.files_changed, 2);
    }

    #[test]
    fn the_heatmap_is_always_a_year_of_local_days() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        seed_commit(&connection, "p1", "2026-09-09T10:00:00Z");

        for window in [
            ActivityWindow::Past24h,
            ActivityWindow::Past7d,
            ActivityWindow::Past30d,
            ActivityWindow::Past12m,
            ActivityWindow::CalendarYear,
        ] {
            let summary = build(&connection, window, None, "2026-09-10T12:00:00Z");
            assert_eq!(summary.heatmap.len(), HEATMAP_DAYS as usize, "{window:?}");
            assert_eq!(summary.heatmap[364].date, "2026-09-10", "{window:?}");
            assert_eq!(summary.heatmap[0].date, "2025-09-11", "{window:?}");
            assert_eq!(summary.heatmap[363].commits, 1, "{window:?}");
        }
    }

    #[test]
    fn resolution_and_bucket_counts_follow_the_window() {
        let now = "2026-09-10T12:00:00Z";
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        seed_commit(&connection, "p1", "2026-09-10T10:00:00Z");

        let day = build(&connection, ActivityWindow::Past24h, None, now);
        assert_eq!(day.resolution, ActivityResolution::Hour);
        assert_eq!(day.series.len(), 24);

        let month = build(&connection, ActivityWindow::Past30d, None, now);
        assert_eq!(month.resolution, ActivityResolution::Day);
        assert_eq!(month.series.len(), 30);

        let year = build(&connection, ActivityWindow::CalendarYear, None, now);
        assert_eq!(year.resolution, ActivityResolution::Week);
        // 2026-01-01 is a Thursday, so the first bucket is a four-day stub and
        // every later one starts on a Monday.
        assert_eq!(year.range_start, "2025-12-31T23:00:00.000Z");
        assert_eq!(year.series[0].bucket_start, "2025-12-31T23:00:00.000Z");
        assert_eq!(year.series[1].bucket_start, "2026-01-04T23:00:00.000Z");
        assert!(year
            .series
            .iter()
            .all(|point| point.bucket_start.as_str() <= year.range_end.as_str()));
    }

    /// Five days in a row ending yesterday is a live streak; a longer run
    /// earlier in the ledger is still the longest.
    #[test]
    fn streaks_count_consecutive_local_days_over_the_whole_ledger() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        seed_commits(
            &connection,
            "p1",
            &[
                // A seven-day run in June.
                "2026-06-01T10:00:00Z",
                "2026-06-02T10:00:00Z",
                "2026-06-03T10:00:00Z",
                "2026-06-04T10:00:00Z",
                "2026-06-05T10:00:00Z",
                "2026-06-06T10:00:00Z",
                "2026-06-07T10:00:00Z",
                // Three days ending yesterday, 2026-09-09.
                "2026-09-07T10:00:00Z",
                "2026-09-08T10:00:00Z",
                "2026-09-09T10:00:00Z",
                "2026-09-09T14:00:00Z",
            ],
        );

        let summary = build(
            &connection,
            ActivityWindow::Past7d,
            None,
            "2026-09-10T12:00:00Z",
        );

        assert_eq!(summary.streaks.longest_days, 7);
        assert_eq!(summary.streaks.longest_start.as_deref(), Some("2026-06-01"));
        assert_eq!(summary.streaks.longest_end.as_deref(), Some("2026-06-07"));
        // Yesterday keeps the streak alive until today's midnight.
        assert_eq!(summary.streaks.current_days, 3);
        assert_eq!(summary.streaks.current_start.as_deref(), Some("2026-09-07"));
        // Two commits on the 9th make it the busiest day in the window.
        let busiest = summary.streaks.busiest_day.expect("busiest day");
        assert_eq!((busiest.date.as_str(), busiest.commits), ("2026-09-09", 2));
        assert_eq!(summary.totals.active_days, 3);
    }

    #[test]
    fn a_streak_that_ended_before_yesterday_is_not_current() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        seed_commits(
            &connection,
            "p1",
            &["2026-09-06T10:00:00Z", "2026-09-07T10:00:00Z"],
        );

        let summary = build(
            &connection,
            ActivityWindow::Past30d,
            None,
            "2026-09-10T12:00:00Z",
        );

        assert_eq!(summary.streaks.current_days, 0);
        assert_eq!(summary.streaks.current_start, None);
        assert_eq!(summary.streaks.longest_days, 2);
    }

    #[test]
    fn previous_is_null_until_the_ledger_reaches_back_that_far() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        // The oldest commit sits inside the current window, so the ledger
        // cannot say anything honest about the seven days before it.
        seed_commit(&connection, "p1", "2026-09-08T10:00:00Z");

        let fresh = build(
            &connection,
            ActivityWindow::Past7d,
            None,
            "2026-09-10T12:00:00Z",
        );
        assert!(fresh.previous.is_none());

        // Reaching back past the comparison window, with work inside it.
        seed_commit(&connection, "p1", "2026-08-20T10:00:00Z");
        seed_commit(&connection, "p1", "2026-08-30T10:00:00Z");
        let covered = build(
            &connection,
            ActivityWindow::Past7d,
            None,
            "2026-09-10T12:00:00Z",
        );
        let previous = covered.previous.expect("previous");
        assert_eq!(previous.commits, 1);
        assert_eq!(previous.active_days, 1);
    }

    #[test]
    fn previous_is_null_when_the_earlier_window_is_covered_but_empty() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        seed_commit(&connection, "p1", "2026-06-01T10:00:00Z");
        seed_commit(&connection, "p1", "2026-09-09T10:00:00Z");

        let summary = build(
            &connection,
            ActivityWindow::Past7d,
            None,
            "2026-09-10T12:00:00Z",
        );

        assert_eq!(summary.totals.commits, 1);
        assert!(summary.previous.is_none());
    }

    #[test]
    fn narrowing_to_a_project_leaves_the_repository_rows_and_heatmap_whole() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        seed_project(&connection, "p2", "Other");
        seed_commits(
            &connection,
            "p1",
            &["2026-09-09T10:00:00Z", "2026-09-09T11:00:00Z"],
        );
        seed_commits(&connection, "p2", &["2026-09-09T12:00:00Z"]);

        let all = build(
            &connection,
            ActivityWindow::Past7d,
            None,
            "2026-09-10T12:00:00Z",
        );
        let narrowed = build(
            &connection,
            ActivityWindow::Past7d,
            Some("p2"),
            "2026-09-10T12:00:00Z",
        );

        assert_eq!(all.totals.commits, 3);
        assert_eq!(narrowed.totals.commits, 1);
        // Both rows survive, ranked by commits, with shares of the whole.
        assert_eq!(narrowed.repositories.len(), 2);
        assert_eq!(narrowed.repositories[0].project_id, "p1");
        assert_eq!(narrowed.repositories[0].commits, 2);
        assert!((narrowed.repositories[0].share - 2.0 / 3.0).abs() < 1e-9);
        assert_eq!(narrowed.repositories[1].commits, 1);
        // The heatmap is the whole year across every repository either way.
        assert_eq!(narrowed.heatmap, all.heatmap);
        assert_eq!(narrowed.heatmap[363].commits, 3);
        // The series does narrow.
        let series_commits: i64 = narrowed
            .series
            .iter()
            .flat_map(|point| point.by_repository.iter())
            .map(|row| row.commits)
            .sum();
        assert_eq!(series_commits, 1);
        assert!(narrowed
            .series
            .iter()
            .flat_map(|point| point.by_repository.iter())
            .all(|row| row.project_id == "p2"));
    }

    #[test]
    fn cadence_buckets_on_local_weekday_and_hour() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        // 2026-09-09 is a Wednesday. 22:00 UTC is midnight on Thursday in
        // Stockholm, which is the point of bucketing locally.
        seed_commits(
            &connection,
            "p1",
            &["2026-09-09T08:00:00Z", "2026-09-09T22:00:00Z"],
        );

        let summary = build(
            &connection,
            ActivityWindow::Past7d,
            None,
            "2026-09-10T12:00:00Z",
        );

        assert_eq!(summary.cadence.by_weekday.len(), 7);
        assert_eq!(summary.cadence.by_hour.len(), 24);
        // Wednesday is index 2, Thursday index 3.
        assert_eq!(summary.cadence.by_weekday[2], 1);
        assert_eq!(summary.cadence.by_weekday[3], 1);
        assert_eq!(summary.cadence.by_hour[10], 1);
        assert_eq!(summary.cadence.by_hour[0], 1);
    }

    #[test]
    fn pull_requests_count_by_the_event_that_happened_in_the_window() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        projects::update_project_remote(
            &connection,
            "p1",
            Some(&projects::ProjectRemote {
                owner: "Menti".to_owned(),
                name: "Argmax".to_owned(),
            }),
        )
        .expect("remote");
        seed_commit(&connection, "p1", "2026-08-01T10:00:00Z");
        storage::upsert_pull_requests(
            &connection,
            &[
                // Opened and merged inside the window: 24 hours of cycle time.
                storage::PullRequestRow {
                    repository: "menti/argmax".into(),
                    number: 1,
                    title: "One".into(),
                    url: "u1".into(),
                    state: "merged".into(),
                    is_draft: false,
                    created_at: "2026-09-08T10:00:00Z".into(),
                    merged_at: Some("2026-09-09T10:00:00Z".into()),
                    closed_at: Some("2026-09-09T10:00:00Z".into()),
                    additions: 5,
                    deletions: 1,
                    author_login: "adam".into(),
                },
                // Opened long ago, merged inside the window: counted as merged
                // but not as opened.
                storage::PullRequestRow {
                    repository: "menti/argmax".into(),
                    number: 2,
                    title: "Two".into(),
                    url: "u2".into(),
                    state: "merged".into(),
                    is_draft: false,
                    created_at: "2026-05-01T10:00:00Z".into(),
                    merged_at: Some("2026-09-10T08:00:00Z".into()),
                    closed_at: Some("2026-09-10T08:00:00Z".into()),
                    additions: 1,
                    deletions: 1,
                    author_login: "adam".into(),
                },
                // Closed without merging inside the window.
                storage::PullRequestRow {
                    repository: "menti/argmax".into(),
                    number: 3,
                    title: "Three".into(),
                    url: "u3".into(),
                    state: "closed".into(),
                    is_draft: false,
                    created_at: "2026-09-07T10:00:00Z".into(),
                    merged_at: None,
                    closed_at: Some("2026-09-08T10:00:00Z".into()),
                    additions: 1,
                    deletions: 1,
                    author_login: "adam".into(),
                },
            ],
        )
        .expect("prs");
        storage::upsert_reviews(
            &connection,
            &[
                storage::ReviewRow {
                    repository: "menti/other".into(),
                    number: 9,
                    submitted_at: "2026-09-09T09:00:00Z".into(),
                    state: "approved".into(),
                    title: "Theirs".into(),
                    url: "u9".into(),
                },
                storage::ReviewRow {
                    repository: "menti/other".into(),
                    number: 9,
                    submitted_at: "2026-09-09T08:00:00Z".into(),
                    state: "changes_requested".into(),
                    title: "Theirs".into(),
                    url: "u9".into(),
                },
            ],
        )
        .expect("reviews");

        let summary = build(
            &connection,
            ActivityWindow::Past7d,
            None,
            "2026-09-10T12:00:00Z",
        );

        assert_eq!(summary.totals.prs_opened, 2);
        assert_eq!(summary.totals.prs_merged, 2);
        assert_eq!(summary.totals.prs_closed, 1);
        assert_eq!(summary.totals.reviews_given, 2);
        assert_eq!(summary.totals.review_approvals, 1);
        assert_eq!(summary.totals.review_changes_requested, 1);
        assert_eq!(summary.totals.review_comments, 0);
        // One day and 131 days 22 hours. An even count takes the mean of the
        // two middles; the PR closed without merging contributes no cycle.
        let one_day = 86_400;
        let long_haul = 131 * 86_400 + 22 * 3_600;
        assert_eq!(
            summary.median_cycle_seconds,
            Some((one_day + long_haul) / 2)
        );
        assert_eq!(summary.pull_requests[2].cycle_seconds, None);
        // Newest activity first, so the PR merged this morning leads.
        assert_eq!(
            summary
                .pull_requests
                .iter()
                .map(|pr| pr.number)
                .collect::<Vec<_>>(),
            vec![2, 1, 3]
        );
        // Matched to the local project case-insensitively.
        assert_eq!(summary.pull_requests[0].project_id.as_deref(), Some("p1"));
        assert_eq!(summary.repositories[0].prs_merged, 2);
        assert_eq!(
            summary.repositories[0].github_repo.as_deref(),
            Some("Menti/Argmax")
        );
        // Reviews are newest first.
        assert_eq!(
            summary.reviews[0].submitted_at,
            "2026-09-09T09:00:00Z".to_string()
        );
    }

    #[test]
    fn narrowing_by_project_drops_pull_requests_from_other_repositories() {
        let database = Database::open_in_memory().expect("db");
        let connection = database.connection();
        seed_project(&connection, "p1", "Argmax");
        seed_commit(&connection, "p1", "2026-08-01T10:00:00Z");
        storage::upsert_pull_requests(
            &connection,
            &[storage::PullRequestRow {
                repository: "menti/unmapped".into(),
                number: 1,
                title: "One".into(),
                url: "u1".into(),
                state: "open".into(),
                is_draft: false,
                created_at: "2026-09-09T10:00:00Z".into(),
                merged_at: None,
                closed_at: None,
                additions: 1,
                deletions: 0,
                author_login: "adam".into(),
            }],
        )
        .expect("prs");

        let all = build(
            &connection,
            ActivityWindow::Past7d,
            None,
            "2026-09-10T12:00:00Z",
        );
        let narrowed = build(
            &connection,
            ActivityWindow::Past7d,
            Some("p1"),
            "2026-09-10T12:00:00Z",
        );

        // Unmapped repositories still count in the unnarrowed view, with no
        // local project to point at.
        assert_eq!(all.pull_requests.len(), 1);
        assert_eq!(all.pull_requests[0].project_id, None);
        assert_eq!(all.totals.prs_opened, 1);
        assert!(narrowed.pull_requests.is_empty());
        assert_eq!(narrowed.totals.prs_opened, 0);
    }

    #[test]
    fn medians_over_an_odd_count_take_the_middle() {
        assert_eq!(median_cycle_seconds(&[]), None);
        assert_eq!(median_cycle_seconds(&[7]), Some(7));
        assert_eq!(median_cycle_seconds(&[9, 1, 5]), Some(5));
        assert_eq!(median_cycle_seconds(&[1, 2, 3, 4]), Some(2));
    }
}
