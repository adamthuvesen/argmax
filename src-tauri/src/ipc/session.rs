use super::{inputs::*, live_database};
use crate::{
    error::ArgmaxResult,
    persistence::{
        dashboard::list_session_tail,
        events::SessionEventsSinceResult,
        learnings::{search_events, EventSearchResult},
        usage::{get_session_cost_summary, SessionCostSummary},
    },
    state::AppState,
};
use tauri::State;

const DEFAULT_SEARCH_LIMIT: u16 = 20;

#[tauri::command(rename = "session:events-since")]
#[specta::specta]
pub fn session_events_since(
    state: State<'_, AppState>,
    input: SessionEventsSinceInput,
) -> ArgmaxResult<SessionEventsSinceResult> {
    let database = live_database(&state)?;
    let connection = database.connection();
    list_session_tail(
        &connection,
        input.session_id.as_str(),
        input.event_cursor.map(|cursor| cursor as i64),
        input.raw_output_cursor.map(|cursor| cursor as i64),
    )
}

#[tauri::command(rename = "session:cost-summary")]
#[specta::specta]
pub fn session_cost_summary(
    state: State<'_, AppState>,
    input: SessionCostSummaryInput,
) -> ArgmaxResult<SessionCostSummary> {
    let database = live_database(&state)?;
    let connection = database.connection();
    get_session_cost_summary(&connection, input.session_id.as_str())
}

#[tauri::command(rename = "session:search")]
#[specta::specta]
pub fn session_search(
    state: State<'_, AppState>,
    input: SessionSearchInput,
) -> ArgmaxResult<Vec<EventSearchResult>> {
    let database = live_database(&state)?;
    let connection = database.connection();
    let limit = input
        .limit
        .map(|limit| limit.get() as usize)
        .unwrap_or(DEFAULT_SEARCH_LIMIT as usize);
    search_events(&connection, input.query.as_str(), limit)
}
