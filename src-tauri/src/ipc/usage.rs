//! The Usage page's one request. A ledger that has completed before is swept
//! inline (a warm sweep stats a few thousand files and reads only what grew)
//! so the numbers are current; the first cold sweep runs in the background and
//! the page polls its progress.

use chrono::Utc;
use tauri::State;

use super::{inputs::UsageSummaryInput, live_database, read_off_main};
use crate::error::ArgmaxResult;
use crate::state::AppState;
use crate::usage::scanner::{spawn_sweep, ScanProgress};
use crate::usage::{summary, UsageScanPhase, UsageScanState, UsageSummary, PRICING_AS_OF};

#[tauri::command(rename = "usage:summary")]
#[specta::specta]
pub async fn usage_summary(
    state: State<'_, AppState>,
    input: UsageSummaryInput,
) -> ArgmaxResult<UsageSummary> {
    let database = live_database(&state)?;
    let window = input.window;
    let time_zone = input.time_zone.into_string();
    let Some(scanner) = state.usage_scanner.get().cloned() else {
        return Ok(UsageSummary::before_first_scan(window, time_zone));
    };
    read_off_main(move || {
        if scanner.has_completed_once() {
            scanner.sweep()?;
        } else {
            spawn_sweep(&scanner);
        }
        let progress = scanner.progress();
        let scan = scan_state(&progress);
        if progress.last_completed_at.is_none() {
            let mut summary = UsageSummary::before_first_scan(window, time_zone);
            summary.scan = scan;
            return Ok(summary);
        }
        let connection = database.read_connection();
        summary::build_summary(&connection, window, time_zone, scan, Utc::now())
    })
    .await
}

fn scan_state(progress: &ScanProgress) -> UsageScanState {
    UsageScanState {
        phase: if progress.scanning {
            UsageScanPhase::Scanning
        } else {
            UsageScanPhase::Idle
        },
        files_total: progress.files_total,
        files_done: progress.files_done,
        last_completed_at: progress.last_completed_at.clone(),
        pricing_as_of: PRICING_AS_OF.to_string(),
    }
}
