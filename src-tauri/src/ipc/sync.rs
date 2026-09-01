//! Settings → Agents → Session sync. Reads and writes `sync.json`, and runs
//! a sweep immediately on every change so the sidebar reflects the new
//! settings without waiting for the next tick.

use tauri::{AppHandle, Manager, State};

use super::inputs::SyncSetConfigInput;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::state::AppState;
use crate::sync::{self, SyncConfig, SyncStatus};

#[tauri::command(rename = "sync:get-status", async)]
#[specta::specta]
pub fn sync_get_status(app: AppHandle, state: State<'_, AppState>) -> ArgmaxResult<SyncStatus> {
    let config = sync::load_or_create_config(&app_data_dir(&app)?);
    Ok(status(&state, config))
}

#[tauri::command(rename = "sync:set-config", async)]
#[specta::specta]
pub fn sync_set_config(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SyncSetConfigInput,
) -> ArgmaxResult<SyncStatus> {
    let dir = app_data_dir(&app)?;
    let config = SyncConfig {
        claude: input.claude,
        codex: input.codex,
        cursor: input.cursor,
        opencode: input.opencode,
        grok: input.grok,
        window_hours: input.window_hours,
    }
    .normalized();
    sync::save_config(&dir, &config)?;
    // Turning a provider off prunes its un-adopted imports, and shrinking the
    // window prunes what fell outside it — both happen inside the sweep, so
    // the user sees the effect of the setting immediately.
    run_now(&state, &config);
    Ok(status(&state, config))
}

#[tauri::command(rename = "sync:run-now", async)]
#[specta::specta]
pub fn sync_run_now(app: AppHandle, state: State<'_, AppState>) -> ArgmaxResult<SyncStatus> {
    let config = sync::load_or_create_config(&app_data_dir(&app)?);
    run_now(&state, &config);
    Ok(status(&state, config))
}

fn run_now(state: &State<'_, AppState>, config: &SyncConfig) {
    let (Some(database), Some(workspaces)) = (state.db.get(), state.workspaces.get()) else {
        return;
    };
    // One sweep at a time. Two concurrent sweeps read the same not-yet-imported
    // transcript and both import it; the loser's `synced_sessions` insert then
    // trips the provider/external unique index and aborts its whole sweep.
    let _serialized = state.sync_sweep.lock_or_recover("sync sweep");
    let outcome = sync::run_sync(
        database,
        workspaces,
        config,
        &sync::home_dir(),
        sync::now_ms(),
    );
    let mut report = state.sync_report.lock_or_recover("sync report");
    *report = Some(match outcome {
        Ok(outcome) => sync::SyncReport::ok(outcome),
        Err(error) => sync::SyncReport::failed(error.to_string()),
    });
}

fn status(state: &State<'_, AppState>, config: SyncConfig) -> SyncStatus {
    let report = state.sync_report.lock_or_recover("sync report").clone();
    SyncStatus {
        config,
        supported_providers: sync::SUPPORTED_PROVIDERS
            .iter()
            .map(|provider| provider.to_string())
            .collect(),
        last_run_at: report.as_ref().map(|report| report.ran_at.clone()),
        imported_count: report.as_ref().map_or(0, |report| report.imported),
        last_error: report.and_then(|report| report.error),
    }
}

fn app_data_dir(app: &AppHandle) -> ArgmaxResult<std::path::PathBuf> {
    app.path().app_data_dir().map_err(|error| {
        ArgmaxError::service("SYNC_NO_APP_DATA_DIR", format!("app data dir: {error}"))
    })
}

use crate::util::sync::LockOrRecover;
