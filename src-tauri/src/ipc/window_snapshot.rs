//! Settings surface for the window snapshot chord. The capture itself runs from
//! the global shortcut and never through an IPC call, so it can be taken before
//! Argmax comes to the front.

use tauri::{AppHandle, State};

use super::{live_database, read_off_main};
use crate::error::ArgmaxResult;
use crate::state::AppState;
use crate::window_snapshot::shortcut::{
    configure, status, Settings, WindowSnapshotConfigureInput, WindowSnapshotState,
    WindowSnapshotStatus,
};

const SCREEN_RECORDING_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

async fn current_status(
    state: &AppState,
    snapshot: &WindowSnapshotState,
) -> ArgmaxResult<WindowSnapshotStatus> {
    let database = live_database(state)?;
    let registration = snapshot.registration();
    read_off_main(move || Ok(status(&database.read_connection(), &registration))).await
}

#[tauri::command(rename = "window-snapshot:status")]
#[specta::specta]
pub async fn window_snapshot_status(
    state: State<'_, AppState>,
    snapshot: State<'_, WindowSnapshotState>,
) -> ArgmaxResult<WindowSnapshotStatus> {
    current_status(&state, &snapshot).await
}

/// Turn the chord on or off, or move it. A chord the system refuses is an
/// error and leaves the previous one in place.
#[tauri::command(rename = "window-snapshot:configure")]
#[specta::specta]
pub async fn window_snapshot_configure(
    app: AppHandle,
    state: State<'_, AppState>,
    snapshot: State<'_, WindowSnapshotState>,
    input: WindowSnapshotConfigureInput,
) -> ArgmaxResult<WindowSnapshotStatus> {
    let database = live_database(&state)?;
    let handle = app.clone();
    read_off_main(move || {
        configure(
            &handle,
            &database.connection(),
            Settings {
                enabled: input.enabled,
                chord: input.chord,
            },
        )
        .map(|_| ())
    })
    .await?;
    current_status(&state, &snapshot).await
}

/// Ask macOS for Screen Recording access. The system prompt appears once per
/// install; after a refusal it never appears again, so the answer is to open
/// System Settings on the right pane instead.
#[tauri::command(rename = "window-snapshot:request-permission")]
#[specta::specta]
pub async fn window_snapshot_request_permission(
    state: State<'_, AppState>,
    snapshot: State<'_, WindowSnapshotState>,
) -> ArgmaxResult<WindowSnapshotStatus> {
    let granted = tauri::async_runtime::spawn_blocking(crate::window_snapshot::request_permission)
        .await
        .unwrap_or(false);
    if !granted && crate::window_snapshot::is_supported() {
        // `open` takes the URL as one argument, so nothing is shell-parsed.
        if let Err(error) = std::process::Command::new("/usr/bin/open")
            .arg(SCREEN_RECORDING_SETTINGS_URL)
            .spawn()
        {
            tracing::warn!(%error, "could not open the Screen Recording settings pane");
        }
    }
    current_status(&state, &snapshot).await
}
