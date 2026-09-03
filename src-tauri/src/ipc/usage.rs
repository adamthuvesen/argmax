use tauri::State;

use super::{inputs::UsageSummaryInput, live_database, read_off_main};
use crate::error::ArgmaxResult;
use crate::state::AppState;
use crate::usage::UsageSummary;

#[tauri::command(rename = "usage:summary")]
#[specta::specta]
pub async fn usage_summary(
    state: State<'_, AppState>,
    input: UsageSummaryInput,
) -> ArgmaxResult<UsageSummary> {
    let _database = live_database(&state)?;
    let window = input.window;
    let time_zone = input.time_zone.into_string();
    read_off_main(move || Ok(UsageSummary::before_first_scan(window, time_zone))).await
}
