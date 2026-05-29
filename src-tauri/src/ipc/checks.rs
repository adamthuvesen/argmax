use super::inputs::*;
use crate::{
    checks::service::{CheckService, RunWorkspaceCheckInput},
    error::{ArgmaxError, ArgmaxResult},
    persistence::checks::CheckRun,
    state::AppState,
};
use std::sync::Arc;
use tauri::State;

#[tauri::command(rename = "checks:run")]
#[specta::specta]
pub async fn checks_run(
    state: State<'_, AppState>,
    input: ChecksRunInput,
) -> ArgmaxResult<CheckRun> {
    live_checks(&state)?
        .run_workspace_check(
            RunWorkspaceCheckInput {
                workspace_id: input.workspace_id.into_string(),
                command: input.command.into_string(),
                timeout_ms: None,
            },
            None,
        )
        .await
}

fn live_checks(state: &AppState) -> ArgmaxResult<Arc<CheckService>> {
    state.checks.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "CHECK_SERVICE_NOT_READY",
            "check service is not initialized",
        )
    })
}
