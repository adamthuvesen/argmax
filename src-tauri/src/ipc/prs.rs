use super::{inputs::*, live_database};
use crate::{
    error::ArgmaxResult, gh::service::GhService, persistence::gh::GhPrRecord, state::AppState,
};
use tauri::State;

use crate::persistence::gh::{
    dismiss_session_pr, list_session_prs, set_session_pr_selection, SessionPrSummary,
};

#[tauri::command(rename = "prs:set-primary")]
#[specta::specta]
pub async fn prs_set_primary(
    state: State<'_, AppState>,
    input: PrsSetPrimaryInput,
) -> ArgmaxResult<Vec<SessionPrSummary>> {
    prs_set_primary_impl(&state, input).await
}

pub(crate) async fn prs_set_primary_impl(
    state: &AppState,
    input: PrsSetPrimaryInput,
) -> ArgmaxResult<Vec<SessionPrSummary>> {
    let database = live_database(state)?;
    let session_id = input.session_id.into_string();
    let mutation_session = session_id.clone();
    let rows = super::read_off_main(move || {
        let conn = database.connection();
        set_session_pr_selection(&conn, &mutation_session, input.pr_number)?;
        list_session_prs(&conn, &mutation_session)
    })
    .await?;
    super::publish_pr_workspaces_for_session(state, &session_id)?;
    Ok(rows)
}

#[tauri::command(rename = "prs:dismiss")]
#[specta::specta]
pub async fn prs_dismiss(
    state: State<'_, AppState>,
    input: PrsDismissInput,
) -> ArgmaxResult<Vec<SessionPrSummary>> {
    prs_dismiss_impl(&state, input).await
}

pub(crate) async fn prs_dismiss_impl(
    state: &AppState,
    input: PrsDismissInput,
) -> ArgmaxResult<Vec<SessionPrSummary>> {
    let database = live_database(state)?;
    let session_id = input.session_id.into_string();
    let mutation_session = session_id.clone();
    let rows = super::read_off_main(move || {
        let conn = database.connection();
        dismiss_session_pr(&conn, &mutation_session, input.pr_number)?;
        list_session_prs(&conn, &mutation_session)
    })
    .await?;
    super::publish_pr_workspaces_for_session(state, &session_id)?;
    Ok(rows)
}

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
    if let Err(error) = super::publish_pr_workspaces_for_session(state, session_id) {
        tracing::warn!(
            %session_id,
            ?error,
            "prs.refresh: could not publish workspace after PR refresh"
        );
    }
    Ok(rows)
}
