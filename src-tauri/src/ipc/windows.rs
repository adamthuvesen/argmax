use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};

use crate::error::ArgmaxResult;
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowOpenSessionInput {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowOpenSessionResult {
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowSetSessionInput {
    pub session_id: Option<String>,
}

/// A torn-off window reports the chat it is showing, so "Open in new window"
/// keeps focusing the right window after the user switches chats in it.
#[tauri::command(rename = "window:set-session")]
#[specta::specta]
pub fn window_set_session(
    window: tauri::Window,
    input: WindowSetSessionInput,
) -> ArgmaxResult<WindowOpenSessionResult> {
    let label = window.label().to_string();
    let chat_windows = &window.app_handle().state::<AppState>().chat_windows;
    if label != crate::windows::MAIN_WINDOW_LABEL {
        match input.session_id {
            Some(session_id) => chat_windows.register(label.clone(), session_id),
            None => chat_windows.forget(&label),
        }
    }
    Ok(WindowOpenSessionResult { label })
}

/// Opens the session in a window of its own, or focuses the one that already
/// shows it. Synchronous: creating a native window belongs on the main thread.
#[tauri::command(rename = "window:open-session")]
#[specta::specta]
pub fn window_open_session(
    app: AppHandle,
    input: WindowOpenSessionInput,
) -> ArgmaxResult<WindowOpenSessionResult> {
    let label = crate::windows::open_session_window(&app, &input.session_id)?;
    Ok(WindowOpenSessionResult { label })
}
