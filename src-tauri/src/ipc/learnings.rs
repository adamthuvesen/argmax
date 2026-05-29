use tauri::State;

use super::{inputs::*, live_database};
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
pub fn learnings_list(
    state: State<'_, AppState>,
    input: LearningsListInput,
) -> ArgmaxResult<Vec<Learning>> {
    let database = live_database(&state)?;
    let connection = database.connection();
    let limit = input
        .limit
        .map(|limit| limit.get() as usize)
        .unwrap_or(DEFAULT_LEARNINGS_LIMIT as usize);
    list_learnings(&connection, input.project_id.as_str(), limit)
}

#[tauri::command(rename = "learnings:update")]
#[specta::specta]
pub fn learnings_update(
    state: State<'_, AppState>,
    input: LearningsUpdateInput,
) -> ArgmaxResult<Learning> {
    let database = live_database(&state)?;
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
    let database = live_database(&state)?;
    let connection = database.connection();
    delete_learning(&connection, input.id.as_str())
}
