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
        // A ledger that has completed before is swept inline so the answer is
        // current; the first cold sweep reads every repository's history and
        // waits for the page to ask for it.
        if scanner.has_completed_once() {
            scanner.sweep()?;
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
        // Before the first sweep has completed, the ledger is partial by
        // definition, whether the sweep has reached the repository loop yet or
        // not.
        phase: if progress.scanning || progress.last_completed_at.is_none() {
            ActivityScanPhase::Scanning
        } else {
            ActivityScanPhase::Complete
        },
        repos_total: progress.repos_total,
        repos_done: progress.repos_done,
        last_completed_at: progress.last_completed_at.clone(),
    }
}
