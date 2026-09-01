use std::sync::Arc;

use super::{inputs::*, live_database, read_off_main};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::{
        dashboard::{list_session_agent_tail, list_session_tail},
        events::{latest_agent_message, SessionEventsSinceResult},
        learnings::{search_events, EventSearchResult},
        sessions::SessionSummary,
        usage::{get_session_cost_summary, SessionCostSummary},
    },
    providers::one_shot::suggest_follow_up,
    providers::subagent_trace::{import_subagent_trace_events, reconcile_session_subagent_traces},
    state::AppState,
    workspaces::{orchestration::SessionForkResult, WorkspaceService},
};
use tauri::State;

const DEFAULT_SEARCH_LIMIT: u16 = 20;

/// A composer placeholder proposed by the cheap helper model. `suggestion` is
/// `None` whenever the agent has not spoken yet or the helper call failed —
/// both mean "keep the static placeholder".
#[derive(Debug, Clone, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpSuggestion {
    pub suggestion: Option<String>,
}

#[tauri::command(rename = "session:suggest-follow-up")]
#[specta::specta]
pub async fn session_suggest_follow_up(
    state: State<'_, AppState>,
    input: SessionSuggestFollowUpInput,
) -> ArgmaxResult<FollowUpSuggestion> {
    session_suggest_follow_up_impl(&state, input).await
}

pub(crate) async fn session_suggest_follow_up_impl(
    state: &AppState,
    input: SessionSuggestFollowUpInput,
) -> ArgmaxResult<FollowUpSuggestion> {
    let database = live_database(state)?;
    let session_id = input.session_id.into_string();
    let Some(last_message) =
        read_off_main(move || latest_agent_message(&database.read_connection(), &session_id))
            .await?
    else {
        return Ok(FollowUpSuggestion { suggestion: None });
    };

    let suggestion =
        suggest_follow_up(input.provider, input.model_id.as_str(), &last_message).await;
    Ok(FollowUpSuggestion { suggestion })
}

#[tauri::command(rename = "session:events-since")]
#[specta::specta]
pub async fn session_events_since(
    state: State<'_, AppState>,
    input: SessionEventsSinceInput,
) -> ArgmaxResult<SessionEventsSinceResult> {
    session_events_since_impl(&state, input).await
}

pub(crate) async fn session_events_since_impl(
    state: &AppState,
    input: SessionEventsSinceInput,
) -> ArgmaxResult<SessionEventsSinceResult> {
    let database = live_database(state)?;
    let session_id = input.session_id.into_string();
    let event_cursor = input.event_cursor.map(|cursor| cursor as i64);
    let raw_output_cursor = input.raw_output_cursor.map(|cursor| cursor as i64);
    read_off_main(move || {
        // Reconcile only the initial backfill. Running panes call this command
        // every 250 ms with a cursor, which must remain a cheap SQLite tail.
        if event_cursor.is_none() {
            reconcile_subagent_traces_with_warning(&database, &session_id);
        }
        list_session_tail(
            &database.read_connection(),
            &session_id,
            event_cursor,
            raw_output_cursor,
        )
    })
    .await
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
        reconcile_subagent_traces_with_warning(&database, &session_id);
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

fn reconcile_subagent_traces_with_warning(
    database: &crate::persistence::database::Database,
    session_id: &str,
) {
    if let Err(error) = reconcile_session_subagent_traces(database, session_id) {
        tracing::warn!(
            error = %error,
            session_id,
            "failed to reconcile subagent trace events"
        );
    }
}

// `spawn_blocking`, not `#[tauri::command(async)]`: that flag is a
// `tokio::spawn`, and the transcript copy is thousands of row inserts — long
// enough to park a worker shared with provider IO, the remote bridge, and the
// `dashboard:delta` emit loop.
#[tauri::command(rename = "session:fork")]
#[specta::specta]
pub async fn session_fork(
    state: State<'_, AppState>,
    input: SessionForkInput,
) -> ArgmaxResult<SessionForkResult> {
    let workspaces = live_workspaces(&state)?;
    tauri::async_runtime::spawn_blocking(move || workspaces.fork_session(input.session_id.as_str()))
        .await
        .map_err(|error| ArgmaxError::service("SESSION_FORK_JOIN", error.to_string()))?
}

pub(crate) fn session_fork_impl(
    state: &AppState,
    input: SessionForkInput,
) -> ArgmaxResult<SessionForkResult> {
    live_workspaces(state)?.fork_session(input.session_id.as_str())
}

fn live_workspaces(state: &AppState) -> ArgmaxResult<Arc<WorkspaceService>> {
    state.workspaces.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "WORKSPACE_SERVICE_NOT_READY",
            "workspace service is not initialized",
        )
    })
}

#[tauri::command(rename = "session:clear")]
#[specta::specta]
pub async fn session_clear(
    state: State<'_, AppState>,
    input: SessionClearInput,
) -> ArgmaxResult<SessionSummary> {
    session_clear_impl(&state, input).await
}

pub(crate) async fn session_clear_impl(
    state: &AppState,
    input: SessionClearInput,
) -> ArgmaxResult<SessionSummary> {
    let providers = state.providers.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "PROVIDER_SERVICE_NOT_READY",
            "provider service is not initialized",
        )
    })?;
    providers.clear(input).await
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
    let connection = database.read_connection();
    get_session_cost_summary(&connection, input.session_id.as_str())
}

#[tauri::command(rename = "session:search")]
#[specta::specta]
pub async fn session_search(
    state: State<'_, AppState>,
    input: SessionSearchInput,
) -> ArgmaxResult<Vec<EventSearchResult>> {
    session_search_impl(&state, input).await
}

pub(crate) async fn session_search_impl(
    state: &AppState,
    input: SessionSearchInput,
) -> ArgmaxResult<Vec<EventSearchResult>> {
    let database = live_database(state)?;
    let limit = input
        .limit
        .map(|limit| limit.get() as usize)
        .unwrap_or(DEFAULT_SEARCH_LIMIT as usize);
    let query = input.query.as_str().to_owned();
    read_off_main(move || search_events(&database.read_connection(), &query, limit)).await
}
