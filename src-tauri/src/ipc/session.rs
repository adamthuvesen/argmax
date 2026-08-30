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
    workspaces::orchestration::SessionForkResult,
};
use tauri::State;

const DEFAULT_SEARCH_LIMIT: u16 = 20;

#[tauri::command(rename = "session:events-since")]
#[specta::specta]
pub fn session_events_since(
    state: State<'_, AppState>,
    input: SessionEventsSinceInput,
) -> ArgmaxResult<SessionEventsSinceResult> {
    session_events_since_impl(&state, input)
}

pub(crate) fn session_events_since_impl(
    state: &AppState,
    input: SessionEventsSinceInput,
) -> ArgmaxResult<SessionEventsSinceResult> {
    let database = live_database(state)?;
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
    session_agent_events_impl(&state, input).await
}

pub(crate) async fn session_agent_events_impl(
    state: &AppState,
    input: SessionAgentEventsInput,
) -> ArgmaxResult<SessionEventsSinceResult> {
    let database = live_database(state)?;
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

// `async` so the transcript copy (potentially thousands of row inserts) runs
// off the macOS main thread.
#[tauri::command(rename = "session:fork", async)]
#[specta::specta]
pub fn session_fork(
    state: State<'_, AppState>,
    input: SessionForkInput,
) -> ArgmaxResult<SessionForkResult> {
    session_fork_impl(&state, input)
}

pub(crate) fn session_fork_impl(
    state: &AppState,
    input: SessionForkInput,
) -> ArgmaxResult<SessionForkResult> {
    let workspaces = state.workspaces.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "WORKSPACE_SERVICE_NOT_READY",
            "workspace service is not initialized",
        )
    })?;
    workspaces.fork_session(input.session_id.as_str())
}

#[tauri::command(rename = "session:cost-summary")]
#[specta::specta]
pub fn session_cost_summary(
    state: State<'_, AppState>,
    input: SessionCostSummaryInput,
) -> ArgmaxResult<SessionCostSummary> {
    session_cost_summary_impl(&state, input)
}

pub(crate) fn session_cost_summary_impl(
    state: &AppState,
    input: SessionCostSummaryInput,
) -> ArgmaxResult<SessionCostSummary> {
    let database = live_database(state)?;
    let connection = database.connection();
    get_session_cost_summary(&connection, input.session_id.as_str())
}

#[tauri::command(rename = "session:search")]
#[specta::specta]
pub fn session_search(
    state: State<'_, AppState>,
    input: SessionSearchInput,
) -> ArgmaxResult<Vec<EventSearchResult>> {
    session_search_impl(&state, input)
}

pub(crate) fn session_search_impl(
    state: &AppState,
    input: SessionSearchInput,
) -> ArgmaxResult<Vec<EventSearchResult>> {
    let database = live_database(state)?;
    let connection = database.connection();
    let limit = input
        .limit
        .map(|limit| limit.get() as usize)
        .unwrap_or(DEFAULT_SEARCH_LIMIT as usize);
    search_events(&connection, input.query.as_str(), limit)
}
