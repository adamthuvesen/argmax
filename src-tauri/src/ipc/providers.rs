use super::inputs::*;
use crate::providers::discovery::ProviderCapabilityReport;
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    ipc::system::SystemOk,
    persistence::sessions::SessionSummary,
    providers::session_service::{ProviderSessionService, SendInputResult},
    state::AppState,
};
use std::sync::Arc;
use tauri::State;

#[tauri::command(rename = "providers:discover")]
#[specta::specta]
pub async fn providers_discover(
    state: State<'_, AppState>,
    _input: ProvidersDiscoverInput,
) -> ArgmaxResult<Vec<ProviderCapabilityReport>> {
    Ok(state.provider_discovery.discover_all().await)
}

#[tauri::command(rename = "providers:launch")]
#[specta::specta]
pub async fn providers_launch(
    state: State<'_, AppState>,
    input: ProvidersLaunchInput,
) -> ArgmaxResult<SessionSummary> {
    live_providers(&state)?.launch(input).await
}

#[tauri::command(rename = "providers:send-input")]
#[specta::specta]
pub async fn providers_send_input(
    state: State<'_, AppState>,
    input: ProvidersSendInput,
) -> ArgmaxResult<SendInputResult> {
    live_providers(&state)?.send_input(input).await
}

#[tauri::command(rename = "providers:resize")]
#[specta::specta]
pub fn providers_resize(
    state: State<'_, AppState>,
    input: ProvidersResizeInput,
) -> ArgmaxResult<SystemOk> {
    live_providers(&state)?.resize(input);
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "providers:terminate")]
#[specta::specta]
pub async fn providers_terminate(
    state: State<'_, AppState>,
    input: ProvidersTerminateInput,
) -> ArgmaxResult<SystemOk> {
    live_providers(&state)?.terminate(input).await?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "providers:cancel-queued-message")]
#[specta::specta]
pub fn providers_cancel_queued_message(
    state: State<'_, AppState>,
    input: ProvidersCancelQueuedMessageInput,
) -> ArgmaxResult<SystemOk> {
    live_providers(&state)?.cancel_queued_message(input);
    Ok(SystemOk { ok: true })
}

fn live_providers(state: &AppState) -> ArgmaxResult<Arc<ProviderSessionService>> {
    state.providers.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "PROVIDER_SERVICE_NOT_READY",
            "provider service is not initialized",
        )
    })
}
