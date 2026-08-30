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

// `spawn_blocking`, not a plain `async` body: `#[tauri::command(async)]` on a
// sync body is `tokio::spawn`, and a spawn does a SQLite lookup, an `openpty`
// and a fork/exec of a large-RSS process — none of which belong on the macOS
// main thread or on a tokio worker.
#[tauri::command(rename = "terminal:spawn")]
#[specta::specta]
pub async fn terminal_spawn(
    state: State<'_, AppState>,
    input: TerminalSpawnInput,
) -> ArgmaxResult<TerminalSpawnResult> {
    let terminals = live_terminals(&state)?;
    tauri::async_runtime::spawn_blocking(move || terminal_spawn_with(&terminals, input))
        .await
        .map_err(|error| ArgmaxError::service("TERMINAL_SPAWN_JOIN", error.to_string()))?
}

pub(crate) fn terminal_spawn_impl(
    state: &AppState,
    input: TerminalSpawnInput,
) -> ArgmaxResult<TerminalSpawnResult> {
    terminal_spawn_with(&live_terminals(state)?, input)
}

fn terminal_spawn_with(
    terminals: &Arc<TerminalService>,
    input: TerminalSpawnInput,
) -> ArgmaxResult<TerminalSpawnResult> {
    terminals.spawn(ServiceTerminalSpawnInput {
        workspace_id: input.workspace_id.into_string(),
        cols: input.cols.get(),
        rows: input.rows.get(),
    })
}

// `spawn_blocking`, not `#[tauri::command(async)]`: that flag is a
// `tokio::spawn`, and the PTY write blocks once the child stops draining its
// tty input queue. One suspended child plus continued typing would park a
// tokio worker per keystroke until nothing else — provider IO, git, the remote
// bridge, `dashboard:delta` — could run.
#[tauri::command(rename = "terminal:write")]
#[specta::specta]
pub async fn terminal_write(
    state: State<'_, AppState>,
    input: TerminalWriteInput,
) -> ArgmaxResult<SystemOk> {
    let terminals = live_terminals(&state)?;
    tauri::async_runtime::spawn_blocking(move || terminal_write_with(&terminals, input))
        .await
        .map_err(|error| ArgmaxError::service("TERMINAL_WRITE_JOIN", error.to_string()))?
}

pub(crate) fn terminal_write_impl(
    state: &AppState,
    input: TerminalWriteInput,
) -> ArgmaxResult<SystemOk> {
    let terminals = live_terminals(state)?;
    terminal_write_with(&terminals, input)
}

fn terminal_write_with(
    terminals: &TerminalService,
    input: TerminalWriteInput,
) -> ArgmaxResult<SystemOk> {
    terminals.write(input.terminal_id.as_str(), input.data.as_str().as_bytes())?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "terminal:resize")]
#[specta::specta]
pub fn terminal_resize(
    state: State<'_, AppState>,
    input: TerminalResizeInput,
) -> ArgmaxResult<SystemOk> {
    terminal_resize_impl(&state, input)
}

pub(crate) fn terminal_resize_impl(
    state: &AppState,
    input: TerminalResizeInput,
) -> ArgmaxResult<SystemOk> {
    live_terminals(state)?.resize(
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
    terminal_terminate_impl(&state, input).await
}

pub(crate) async fn terminal_terminate_impl(
    state: &AppState,
    input: TerminalTerminateInput,
) -> ArgmaxResult<SystemOk> {
    live_terminals(state)?
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
