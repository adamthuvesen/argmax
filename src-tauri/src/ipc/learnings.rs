use tauri::State;

use super::{inputs::*, live_database, read_off_main};
use crate::{
    error::ArgmaxResult,
    persistence::learnings::{
        delete_learning, list_learnings, update_learning, Learning, UpdateLearningInput,
    },
    state::AppState,
};

const DEFAULT_LEARNINGS_LIMIT: u16 = 50;

#[tauri::command(rename = "learnings:list")]
#[specta::specta]
pub async fn learnings_list(
    state: State<'_, AppState>,
    input: LearningsListInput,
) -> ArgmaxResult<Vec<Learning>> {
    learnings_list_impl(&state, input).await
}

pub(crate) async fn learnings_list_impl(
    state: &AppState,
    input: LearningsListInput,
) -> ArgmaxResult<Vec<Learning>> {
    let database = live_database(state)?;
    let limit = input
        .limit
        .map(|limit| limit.get() as usize)
        .unwrap_or(DEFAULT_LEARNINGS_LIMIT as usize);
    let project_id = input.project_id.into_string();
    read_off_main(move || list_learnings(&database.read_connection(), &project_id, limit)).await
}

#[tauri::command(rename = "learnings:update")]
#[specta::specta]
pub fn learnings_update(
    state: State<'_, AppState>,
    input: LearningsUpdateInput,
) -> ArgmaxResult<Learning> {
    learnings_update_impl(&state, input)
}

pub(crate) fn learnings_update_impl(
    state: &AppState,
    input: LearningsUpdateInput,
) -> ArgmaxResult<Learning> {
    let database = live_database(state)?;
    let connection = database.connection();
    update_learning(
        &connection,
        &UpdateLearningInput {
            id: input.id.as_str().to_owned(),
            summary: input.summary.map(|summary| summary.as_str().to_owned()),
            verified: input.verified,
        },
    )
}

#[tauri::command(rename = "learnings:delete")]
#[specta::specta]
pub fn learnings_delete(
    state: State<'_, AppState>,
    input: LearningsDeleteInput,
) -> ArgmaxResult<()> {
    learnings_delete_impl(&state, input)
}

pub(crate) fn learnings_delete_impl(
    state: &AppState,
    input: LearningsDeleteInput,
) -> ArgmaxResult<()> {
    let database = live_database(state)?;
    let connection = database.connection();
    delete_learning(&connection, input.id.as_str())
}
