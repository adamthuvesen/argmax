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
    let service = GhService::new(live_database(&state)?);
    service.list_for_session(input.session_id.as_str())
}

#[tauri::command(rename = "prs:refresh")]
#[specta::specta]
pub async fn prs_refresh(
    state: State<'_, AppState>,
    input: PrsRefreshInput,
) -> ArgmaxResult<Vec<GhPrRecord>> {
    let service = GhService::new(live_database(&state)?);
    service.refresh(input.session_id.as_str()).await
}
