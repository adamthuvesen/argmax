//! The Activity page's request. `activity:summary` is the local commit ledger
//! plus whatever the cached `gh` half currently holds.

use chrono::Utc;
use chrono_tz::Tz;
use tauri::State;

use super::{inputs::ActivitySummaryInput, live_database, read_off_main};
use crate::activity::scanner::{spawn_sweep, ActivityScanProgress};
use crate::activity::{github, summary, ActivityScanPhase, ActivityScanState, ActivitySummary};
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};
use crate::state::AppState;
use crate::util::gh_runner::default_gh_runner;

#[tauri::command(rename = "activity:summary")]
#[specta::specta]
pub async fn activity_summary(
    state: State<'_, AppState>,
    input: ActivitySummaryInput,
) -> ArgmaxResult<ActivitySummary> {
    activity_summary_impl(&state, input).await
}

pub async fn activity_summary_impl(
    state: &AppState,
    input: ActivitySummaryInput,
) -> ArgmaxResult<ActivitySummary> {
    let database = live_database(state)?;
    let window = input.window;
    let project_id = input.project_id.map(|id| id.into_string());
    let time_zone = input.time_zone.into_string();
    // Every bucket boundary is cut on this zone, so an unknown name has to be
    // rejected rather than quietly falling back to UTC and mislabelling days.
    let tz: Tz = time_zone.parse().map_err(|_| {
        ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["timeZone".into()],
            "UNKNOWN_TIME_ZONE",
            format!("{time_zone} is not an IANA time zone name"),
        ))
    })?;

    let Some(scanner) = state.activity_scanner.get().cloned() else {
        return Ok(ActivitySummary::before_first_scan(
            window,
            project_id,
            time_zone,
            ActivityScanState::idle(),
        ));
    };

    // The GitHub half never holds the page up: the refresh runs behind the
    // answer and lands in the next read.
    let now = Utc::now();
    let github = {
        let connection = database.read_connection();
        github::cached_state(&connection)?
    };
    github::spawn_refresh_if_stale(
        std::sync::Arc::clone(&database),
        default_gh_runner(),
        crate::sync::home_dir().to_string_lossy().to_string(),
        &github,
        now,
    );

    read_off_main(move || {
        // A ledger that has never completed has nothing to answer from, so
        // the first cold sweep runs in the background and the page reads
        // `before_first_scan` until it lands. A ledger that has completed
        // answers immediately from what is already stored, and only kicks a
        // background sweep if that answer is older than `FRESHNESS_INTERVAL`
        // — the same stale-while-revalidate shape as the GitHub half.
        // `sweep()`'s own `try_lock` guarantees a burst of window or
        // project-picker changes inside that window starts at most one sweep.
        if scanner.has_completed_once() {
            if scanner.is_stale(now) {
                spawn_sweep(&scanner);
            }
        } else {
            spawn_sweep(&scanner);
        }
        let progress = scanner.progress();
        let scan = scan_state(&progress);
        if progress.last_completed_at.is_none() {
            return Ok(ActivitySummary::before_first_scan(
                window, project_id, time_zone, scan,
            ));
        }
        let connection = database.read_connection();
        summary::build_summary(
            &connection,
            window,
            project_id,
            tz,
            scan,
            github,
            progress.author_emails,
            now,
        )
    })
    .await
}

fn scan_state(progress: &ActivityScanProgress) -> ActivityScanState {
    ActivityScanState {
        // A ledger that has completed at least once answers as `Complete`
        // even while a background refresh sweep is in flight: the stored
        // rows are a whole, current-enough answer, not a partial one, so the
        // renderer's "still walking your clones" notice and faster poll must
        // stay reserved for the one-time cold sweep.
        phase: if progress.last_completed_at.is_none() {
            ActivityScanPhase::Scanning
        } else {
            ActivityScanPhase::Complete
        },
        repos_total: progress.repos_total,
        repos_done: progress.repos_done,
        last_completed_at: progress.last_completed_at.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ledger_that_has_never_completed_reports_scanning() {
        let progress = ActivityScanProgress::default();
        assert_eq!(scan_state(&progress).phase, ActivityScanPhase::Scanning);
    }

    #[test]
    fn a_background_sweep_over_a_completed_ledger_still_reports_complete() {
        // The bug this pins: `scanning` used to leak into `phase`, so a
        // background refresh over an already-complete ledger showed the
        // renderer's "still walking your clones" partial-data notice for
        // numbers that were never partial.
        let progress = ActivityScanProgress {
            scanning: true,
            repos_total: 10,
            repos_done: 3,
            last_completed_at: Some("2026-09-16T12:00:00.000Z".into()),
            author_emails: vec!["me@example.com".into()],
        };
        assert_eq!(scan_state(&progress).phase, ActivityScanPhase::Complete);
    }
}
