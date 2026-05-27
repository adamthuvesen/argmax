use super::inputs::*;

#[tauri::command(rename = "providers:discover")]
#[specta::specta]
pub fn providers_discover(_input: ProvidersDiscoverInput) {
    super::unported("providers:discover")
}

#[tauri::command(rename = "providers:launch")]
#[specta::specta]
pub fn providers_launch(_input: ProvidersLaunchInput) {
    super::unported("providers:launch")
}

#[tauri::command(rename = "providers:send-input")]
#[specta::specta]
pub fn providers_send_input(_input: ProvidersSendInput) {
    super::unported("providers:send-input")
}

#[tauri::command(rename = "providers:resize")]
#[specta::specta]
pub fn providers_resize(_input: ProvidersResizeInput) {
    super::unported("providers:resize")
}

#[tauri::command(rename = "providers:terminate")]
#[specta::specta]
pub fn providers_terminate(_input: ProvidersTerminateInput) {
    super::unported("providers:terminate")
}

#[tauri::command(rename = "providers:cancel-queued-message")]
#[specta::specta]
pub fn providers_cancel_queued_message(_input: ProvidersCancelQueuedMessageInput) {
    super::unported("providers:cancel-queued-message")
}
