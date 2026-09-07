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
use tauri::{AppHandle, State};

#[tauri::command(rename = "providers:discover")]
#[specta::specta]
pub async fn providers_discover(
    state: State<'_, AppState>,
    input: ProvidersDiscoverInput,
) -> ArgmaxResult<Vec<ProviderCapabilityReport>> {
    providers_discover_impl(&state, input).await
}

pub(crate) async fn providers_discover_impl(
    state: &AppState,
    input: ProvidersDiscoverInput,
) -> ArgmaxResult<Vec<ProviderCapabilityReport>> {
    if input.refresh {
        state.provider_discovery.invalidate().await;
    }
    Ok(state.provider_discovery.discover_all().await)
}

#[tauri::command(rename = "providers:launch")]
#[specta::specta]
pub async fn providers_launch(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ProvidersLaunchInput,
) -> ArgmaxResult<SessionSummary> {
    let app_data = crate::util::data_dir::app_data_dir(&app)
        .map_err(|error| ArgmaxError::service("APP_DATA_DIR", error.to_string()))?;
    let default_permission_mode =
        crate::default_agent::read_default_agent(&app_data).permission_mode;
    providers_launch_impl(&state, input, default_permission_mode).await
}

pub(crate) async fn providers_launch_impl(
    state: &AppState,
    mut input: ProvidersLaunchInput,
    default_permission_mode: crate::providers::PermissionMode,
) -> ArgmaxResult<SessionSummary> {
    apply_launch_permission_default(&mut input, default_permission_mode);
    live_providers(state)?.launch(input).await
}

fn apply_launch_permission_default(
    input: &mut ProvidersLaunchInput,
    default_permission_mode: crate::providers::PermissionMode,
) {
    input.permission_mode.get_or_insert(default_permission_mode);
}

#[tauri::command(rename = "providers:send-input")]
#[specta::specta]
pub async fn providers_send_input(
    state: State<'_, AppState>,
    input: ProvidersSendInput,
) -> ArgmaxResult<SendInputResult> {
    providers_send_input_impl(&state, input).await
}

pub(crate) async fn providers_send_input_impl(
    state: &AppState,
    input: ProvidersSendInput,
) -> ArgmaxResult<SendInputResult> {
    live_providers(state)?.send_input(input).await
}

#[tauri::command(rename = "providers:resize")]
#[specta::specta]
pub fn providers_resize(
    state: State<'_, AppState>,
    input: ProvidersResizeInput,
) -> ArgmaxResult<SystemOk> {
    providers_resize_impl(&state, input)
}

pub(crate) fn providers_resize_impl(
    state: &AppState,
    input: ProvidersResizeInput,
) -> ArgmaxResult<SystemOk> {
    live_providers(state)?.resize(input);
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "providers:terminate")]
#[specta::specta]
pub async fn providers_terminate(
    state: State<'_, AppState>,
    input: ProvidersTerminateInput,
) -> ArgmaxResult<SystemOk> {
    providers_terminate_impl(&state, input).await
}

pub(crate) async fn providers_terminate_impl(
    state: &AppState,
    input: ProvidersTerminateInput,
) -> ArgmaxResult<SystemOk> {
    live_providers(state)?.terminate(input).await?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "providers:cancel-queued-message")]
#[specta::specta]
pub fn providers_cancel_queued_message(
    state: State<'_, AppState>,
    input: ProvidersCancelQueuedMessageInput,
) -> ArgmaxResult<SystemOk> {
    providers_cancel_queued_message_impl(&state, input)
}

pub(crate) fn providers_cancel_queued_message_impl(
    state: &AppState,
    input: ProvidersCancelQueuedMessageInput,
) -> ArgmaxResult<SystemOk> {
    live_providers(state)?.cancel_queued_message(input)?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "providers:send-queued-message-now")]
#[specta::specta]
pub async fn providers_send_queued_message_now(
    state: State<'_, AppState>,
    input: ProvidersSendQueuedMessageNowInput,
) -> ArgmaxResult<SendInputResult> {
    providers_send_queued_message_now_impl(&state, input).await
}

pub(crate) async fn providers_send_queued_message_now_impl(
    state: &AppState,
    input: ProvidersSendQueuedMessageNowInput,
) -> ArgmaxResult<SendInputResult> {
    live_providers(state)?.send_queued_message_now(input).await
}

fn live_providers(state: &AppState) -> ArgmaxResult<Arc<ProviderSessionService>> {
    state.providers.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "PROVIDER_SERVICE_NOT_READY",
            "provider service is not initialized",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::PermissionMode;

    fn launch_input(permission_mode: Option<PermissionMode>) -> ProvidersLaunchInput {
        let mut value = serde_json::json!({
            "workspaceId": "w1",
            "provider": "claude",
            "prompt": "hello",
            "modelLabel": "Opus 5",
            "modelId": "claude-opus-5",
            "cols": 80,
            "rows": 24
        });
        if let Some(permission_mode) = permission_mode {
            value["permissionMode"] = serde_json::to_value(permission_mode).expect("mode");
        }
        serde_json::from_value(value).expect("launch input")
    }

    #[test]
    fn launch_uses_the_host_default_only_when_the_client_omits_permissions() {
        let mut omitted = launch_input(None);
        apply_launch_permission_default(&mut omitted, PermissionMode::AskEachTime);
        assert_eq!(omitted.permission_mode, Some(PermissionMode::AskEachTime));

        let mut explicit = launch_input(Some(PermissionMode::AutoApprove));
        apply_launch_permission_default(&mut explicit, PermissionMode::AskEachTime);
        assert_eq!(explicit.permission_mode, Some(PermissionMode::AutoApprove));
    }
}
