use super::{inputs::*, live_database};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::{
        dashboard::{list_session_agent_tail, list_session_tail},
        events::SessionEventsSinceResult,
        learnings::{search_events, EventSearchResult},
        usage::{get_session_cost_summary, SessionCostSummary},
    },
    providers::subagent_trace::import_subagent_trace_events,
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

#[tauri::command(rename = "session:agent-events")]
#[specta::specta]
pub async fn session_agent_events(
    state: State<'_, AppState>,
    input: SessionAgentEventsInput,
) -> ArgmaxResult<SessionEventsSinceResult> {
    let database = live_database(&state)?;
    let session_id = input.session_id.into_string();
    let parent_tool_use_id = input.parent_tool_use_id.into_string();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) =
            import_subagent_trace_events(&database, &session_id, &parent_tool_use_id)
        {
            tracing::warn!(
                error = %error,
                session_id = %session_id,
                parent_tool_use_id = %parent_tool_use_id,
                "failed to import subagent trace events"
            );
        }
        let connection = database.connection();
        list_session_agent_tail(&connection, &session_id, &parent_tool_use_id)
    })
    .await
    .map_err(|error| ArgmaxError::service("SESSION_AGENT_EVENTS_JOIN", error.to_string()))?
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
