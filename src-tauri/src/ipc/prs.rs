use super::{inputs::*, live_database};
use crate::{
    error::ArgmaxResult, gh::service::GhService, persistence::gh::GhPrRecord, state::AppState,
};
use tauri::State;

#[tauri::command(rename = "prs:list-for-session")]
#[specta::specta]
pub fn prs_list_for_session(
    state: State<'_, AppState>,
    input: PrsListForSessionInput,
) -> ArgmaxResult<Vec<GhPrRecord>> {
    prs_list_for_session_impl(&state, input)
}

pub(crate) fn prs_list_for_session_impl(
    state: &AppState,
    input: PrsListForSessionInput,
) -> ArgmaxResult<Vec<GhPrRecord>> {
    let service = GhService::new(live_database(state)?);
    service.list_for_session(input.session_id.as_str())
}

#[tauri::command(rename = "prs:refresh")]
#[specta::specta]
pub async fn prs_refresh(
    state: State<'_, AppState>,
    input: PrsRefreshInput,
) -> ArgmaxResult<Vec<GhPrRecord>> {
    prs_refresh_impl(&state, input).await
}

pub(crate) async fn prs_refresh_impl(
    state: &AppState,
    input: PrsRefreshInput,
) -> ArgmaxResult<Vec<GhPrRecord>> {
    let session_id = input.session_id.as_str();
    let service = GhService::new(live_database(state)?);
    let rows = service.refresh(session_id).await?;
    if let Err(error) = super::publish_workspace_for_session(state, session_id) {
        tracing::warn!(
            %session_id,
            ?error,
            "prs.refresh: could not publish workspace after PR refresh"
        );
    }
    Ok(rows)
}
