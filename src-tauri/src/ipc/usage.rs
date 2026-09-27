//! The Usage page's requests. `usage:summary` is the local transcript ledger.
//! `usage:remaining` is live plan remaining from each provider login.
//! `usage:router-cost` is what each Auto tier spent in the window.

use std::sync::Arc;

use chrono::Utc;
use tauri::State;

use super::{
    inputs::{UsageRemainingInput, UsageRouterCostInput, UsageSummaryInput},
    live_database, read_off_main,
};
use crate::error::ArgmaxResult;
use crate::routing::cost::{router_cost, RouterCostSummary};
use crate::state::AppState;
use crate::usage::remaining::{fetch_remaining, LiveRemainingSource, UsageRemaining};
use crate::usage::scanner::{spawn_sweep, ScanProgress};
use crate::usage::{summary, UsageScanPhase, UsageScanState, UsageSummary, PRICING_AS_OF};

#[tauri::command(rename = "usage:summary")]
#[specta::specta]
pub async fn usage_summary(
    state: State<'_, AppState>,
    input: UsageSummaryInput,
) -> ArgmaxResult<UsageSummary> {
    usage_summary_impl(&state, input).await
}

pub async fn usage_summary_impl(
    state: &AppState,
    input: UsageSummaryInput,
) -> ArgmaxResult<UsageSummary> {
    let database = live_database(state)?;
    let window = input.window;
    let provider = input.provider;
    let time_zone = input.time_zone.into_string();
    let Some(scanner) = state.usage_scanner.get().cloned() else {
        return Ok(UsageSummary::before_first_scan(window, provider, time_zone));
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
            let mut summary = UsageSummary::before_first_scan(window, provider, time_zone);
            summary.scan = scan;
            return Ok(summary);
        }
        let connection = database.read_connection();
        summary::build_summary(&connection, window, provider, time_zone, scan, Utc::now())
    })
    .await
}

#[tauri::command(rename = "usage:remaining")]
#[specta::specta]
pub async fn usage_remaining(_input: UsageRemainingInput) -> ArgmaxResult<UsageRemaining> {
    usage_remaining_impl().await
}

pub async fn usage_remaining_impl() -> ArgmaxResult<UsageRemaining> {
    read_off_main(|| Ok(fetch_remaining(Arc::new(LiveRemainingSource::new())))).await
}

/// `None` when no chat was routed in the window; the card then stays hidden.
#[tauri::command(rename = "usage:router-cost")]
#[specta::specta]
pub async fn usage_router_cost(
    state: State<'_, AppState>,
    input: UsageRouterCostInput,
) -> ArgmaxResult<Option<RouterCostSummary>> {
    usage_router_cost_impl(&state, input).await
}

pub async fn usage_router_cost_impl(
    state: &AppState,
    input: UsageRouterCostInput,
) -> ArgmaxResult<Option<RouterCostSummary>> {
    let database = live_database(state)?;
    read_off_main(move || {
        let connection = database.read_connection();
        router_cost(&connection, input.window, Utc::now())
    })
    .await
}

fn scan_state(progress: &ScanProgress) -> UsageScanState {
    UsageScanState {
        // Before the first sweep has completed, the ledger is partial by
        // definition, whether the sweep has reached the file loop yet or not.
        phase: if progress.scanning || progress.last_completed_at.is_none() {
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
