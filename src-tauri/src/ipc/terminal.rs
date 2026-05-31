use super::inputs::*;
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    ipc::system::SystemOk,
    state::AppState,
    terminal::service::{
        TerminalService, TerminalSpawnInput as ServiceTerminalSpawnInput, TerminalSpawnResult,
    },
};
use std::sync::Arc;
use tauri::State;

#[tauri::command(rename = "terminal:spawn")]
#[specta::specta]
pub fn terminal_spawn(
    state: State<'_, AppState>,
    input: TerminalSpawnInput,
) -> ArgmaxResult<TerminalSpawnResult> {
    live_terminals(&state)?.spawn(ServiceTerminalSpawnInput {
        workspace_id: input.workspace_id.into_string(),
        cols: input.cols.get(),
        rows: input.rows.get(),
    })
}

#[tauri::command(rename = "terminal:write")]
#[specta::specta]
pub fn terminal_write(
    state: State<'_, AppState>,
    input: TerminalWriteInput,
) -> ArgmaxResult<SystemOk> {
    live_terminals(&state)?.write(input.terminal_id.as_str(), input.data.as_str().as_bytes());
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "terminal:resize")]
#[specta::specta]
pub fn terminal_resize(
    state: State<'_, AppState>,
    input: TerminalResizeInput,
) -> ArgmaxResult<SystemOk> {
    live_terminals(&state)?.resize(
        input.terminal_id.as_str(),
        input.cols.get(),
        input.rows.get(),
    );
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "terminal:terminate")]
#[specta::specta]
pub async fn terminal_terminate(
    state: State<'_, AppState>,
    input: TerminalTerminateInput,
) -> ArgmaxResult<SystemOk> {
    live_terminals(&state)?
        .terminate(input.terminal_id.as_str())
        .await;
    Ok(SystemOk { ok: true })
}

fn live_terminals(state: &AppState) -> ArgmaxResult<Arc<TerminalService>> {
    state.terminals.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "TERMINAL_SERVICE_NOT_READY",
            "terminal service is not initialized",
        )
    })
}
