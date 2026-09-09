use std::sync::Arc;

use tauri::State;

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    goals::{
        service::{GoalListInput, GoalService, GoalSessionInput, GoalSetInput},
        Goal,
    },
    state::AppState,
};

pub(crate) fn live_goals(state: &AppState) -> ArgmaxResult<Arc<GoalService>> {
    state.goals.get().cloned().ok_or_else(|| {
        ArgmaxError::service("GOAL_SERVICE_NOT_READY", "Goal service is not initialized")
    })
}

#[tauri::command(rename = "goal:set")]
#[specta::specta]
pub async fn goal_set(state: State<'_, AppState>, input: GoalSetInput) -> ArgmaxResult<Goal> {
    live_goals(&state)?.set(input).await
}

#[tauri::command(rename = "goal:get")]
#[specta::specta]
pub async fn goal_get(
    state: State<'_, AppState>,
    input: GoalSessionInput,
) -> ArgmaxResult<Option<Goal>> {
    let service = live_goals(&state)?;
    super::read_off_main(move || service.get_for_session(&input.session_id)).await
}

#[tauri::command(rename = "goal:list")]
#[specta::specta]
pub async fn goal_list(
    state: State<'_, AppState>,
    input: GoalListInput,
) -> ArgmaxResult<Vec<Goal>> {
    let service = live_goals(&state)?;
    super::read_off_main(move || service.list(input.workspace_id.as_deref())).await
}

#[tauri::command(rename = "goal:clear")]
#[specta::specta]
pub async fn goal_clear(
    state: State<'_, AppState>,
    input: GoalSessionInput,
) -> ArgmaxResult<Option<Goal>> {
    live_goals(&state)?.clear(&input.session_id).await
}
