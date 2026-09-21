//! Chat windows: the main window plus any session the user tore off into a
//! window of its own. Every one of them loads the same renderer; a torn-off
//! window boots with `?session=<id>` so it opens on that chat.
//!
//! The app's own windows are the ones a menu command, a theme flip, or a page
//! zoom should reach. Browser popups (`browser-popup-*`) and the browser
//! pane's child webviews (`browser-*`) are not: they show someone else's page.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::util::sync::LockOrRecover;

pub const MAIN_WINDOW_LABEL: &str = "main";
const CHAT_WINDOW_LABEL_PREFIX: &str = "chat-";
/// A step smaller than the main window's 1400×900 (tauri.conf.json), so the
/// cascade reads as a second window rather than a copy laid over the first.
/// The minimum matches the main window's.
const CHAT_WINDOW_SIZE: (f64, f64) = (1100.0, 800.0);
const CHAT_WINDOW_MIN_SIZE: (f64, f64) = (600.0, 640.0);
const CASCADE_OFFSET: f64 = 40.0;

/// The chat window that last had focus: where menu commands go.
static FOCUSED_WINDOW: Mutex<Option<String>> = Mutex::new(None);
/// Any window of ours that last had focus, browser popups included. A ⌘W
/// with a popup in front closes the popup, not a pane behind it.
static KEY_WINDOW: Mutex<Option<String>> = Mutex::new(None);

/// Which torn-off window shows which session, so a second "open in new
/// window" focuses the existing one instead of stacking a twin on top.
#[derive(Default)]
pub struct ChatWindows {
    session_by_label: Mutex<HashMap<String, String>>,
}

impl ChatWindows {
    pub fn label_for_session(&self, session_id: &str) -> Option<String> {
        self.session_by_label
            .lock_or_recover("chat windows")
            .iter()
            .find(|(_, session)| session.as_str() == session_id)
            .map(|(label, _)| label.clone())
    }

    pub(crate) fn register(&self, label: String, session_id: String) {
        self.session_by_label
            .lock_or_recover("chat windows")
            .insert(label, session_id);
    }

    pub(crate) fn forget(&self, label: &str) {
        self.session_by_label
            .lock_or_recover("chat windows")
            .remove(label);
    }

    fn next_label(&self) -> String {
        let taken = self.session_by_label.lock_or_recover("chat windows");
        (1..)
            .map(|n| format!("{CHAT_WINDOW_LABEL_PREFIX}{n}"))
            .find(|label| !taken.contains_key(label))
            .expect("an unused chat window label always exists")
    }
}

/// True for the app's own shell windows: main and every torn-off chat.
pub fn is_chat_window(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL || label.starts_with(CHAT_WINDOW_LABEL_PREFIX)
}

/// The app window that last had focus. Menu commands go here: the menu is
/// app-global and its handler is not told which window the user was in.
pub fn focused_window_label() -> String {
    FOCUSED_WINDOW
        .lock_or_recover("focused window")
        .clone()
        .unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string())
}

/// The window that last had focus, whatever kind it is.
pub fn key_window_label() -> Option<String> {
    KEY_WINDOW.lock_or_recover("key window").clone()
}

/// The window to bring forward for `session_id`: the one it was torn off
/// into, else the last-focused chat window.
pub fn focus_session_window<R: Runtime>(app: &AppHandle<R>, session_id: Option<&str>) {
    let state = app.state::<crate::state::AppState>();
    let label = session_id
        .and_then(|id| state.chat_windows.label_for_session(id))
        .unwrap_or_else(focused_window_label);
    let Some(window) = app
        .get_window(&label)
        .or_else(|| app.get_window(MAIN_WINDOW_LABEL))
    else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Where a UI push about `session_id` belongs: its torn-off window, else main.
pub fn window_label_for_session<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> String {
    app.state::<crate::state::AppState>()
        .chat_windows
        .label_for_session(session_id)
        .unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string())
}

/// True when any app window is frontmost — the notification suppression
/// probe, which used to ask the main window alone.
pub fn any_chat_window_focused<R: Runtime>(app: &AppHandle<R>) -> bool {
    chat_windows(app)
        .iter()
        .any(|window| window.is_focused().unwrap_or(false))
}

pub fn chat_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<Window<R>> {
    app.windows()
        .into_iter()
        .filter(|(label, _)| is_chat_window(label))
        .map(|(_, window)| window)
        .collect()
}

/// Registered alongside the dock badge's window-event hook: records which app
/// window has focus and drops a closed chat window from the registry.
pub fn track_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let label = window.label();
    match event {
        WindowEvent::Focused(true) => {
            *KEY_WINDOW.lock_or_recover("key window") = Some(label.to_string());
            if is_chat_window(label) {
                *FOCUSED_WINDOW.lock_or_recover("focused window") = Some(label.to_string());
            }
        }
        WindowEvent::Destroyed => {
            let mut key = KEY_WINDOW.lock_or_recover("key window");
            if key.as_deref() == Some(label) {
                *key = None;
            }
            drop(key);
            if !is_chat_window(label) {
                return;
            }
            if let Some(state) = window.app_handle().try_state::<crate::state::AppState>() {
                state.chat_windows.forget(label);
            }
            let mut focused = FOCUSED_WINDOW.lock_or_recover("focused window");
            if focused.as_deref() == Some(label) {
                *focused = None;
            }
            drop(focused);
            // The main window owns the app's lifetime: the dock badge, the
            // browser's native tabs and notification clicks all live on it.
            // Closing it closes the chats torn off from it, so the app exits
            // instead of lingering headless behind them.
            if label == MAIN_WINDOW_LABEL {
                for chat in chat_windows(window.app_handle()) {
                    if chat.label() != MAIN_WINDOW_LABEL {
                        let _ = chat.close();
                    }
                }
            }
        }
        _ => {}
    }
}

/// Opens `session_id` in its own window, or focuses the window that already
/// shows it. Returns the window label.
pub fn open_session_window<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> ArgmaxResult<String> {
    if session_id.is_empty()
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(ArgmaxError::service(
            "WINDOW_BAD_SESSION_ID",
            "a session id is letters, digits, '-' and '_'",
        ));
    }
    let state = app.state::<crate::state::AppState>();
    if let Some(label) = state.chat_windows.label_for_session(session_id) {
        if let Some(window) = app.get_window(&label) {
            let _ = window.unminimize();
            let _ = window.set_focus();
            return Ok(label);
        }
        state.chat_windows.forget(&label);
    }

    let label = state.chat_windows.next_label();
    let url = WebviewUrl::App(format!("index.html?session={session_id}").into());
    let mut builder = WebviewWindowBuilder::new(app, &label, url)
        .title("Argmax")
        .inner_size(CHAT_WINDOW_SIZE.0, CHAT_WINDOW_SIZE.1)
        .min_inner_size(CHAT_WINDOW_MIN_SIZE.0, CHAT_WINDOW_MIN_SIZE.1)
        .transparent(true)
        .effects(tauri::utils::config::WindowEffectsConfig {
            effects: vec![tauri::window::Effect::Sidebar],
            state: Some(tauri::window::EffectState::FollowsWindowActiveState),
            radius: None,
            color: None,
        })
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .disable_drag_drop_handler()
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 24.0))
        .hidden_title(true);
    if let Some((x, y)) = cascade_origin(app) {
        builder = builder.position(x, y);
    }
    let window = builder.build().map_err(|error| {
        ArgmaxError::service(
            "WINDOW_CREATE_FAILED",
            format!("could not open a window: {error}"),
        )
    })?;
    state
        .chat_windows
        .register(label.clone(), session_id.to_string());
    // A fresh document starts at zoom 1.0; match the windows already open.
    if let Err(error) = window.set_zoom(crate::menu::main_window_zoom()) {
        tracing::warn!(?error, label, "failed to apply zoom to a new chat window");
    }
    tracing::info!(label, session_id, "opened a chat window");
    Ok(label)
}

/// A step down and right from the window the user is in, in logical points.
fn cascade_origin<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64)> {
    let window = app.get_window(&focused_window_label())?;
    let scale = window.scale_factor().ok()?;
    let origin = window.outer_position().ok()?.to_logical::<f64>(scale);
    Some((origin.x + CASCADE_OFFSET, origin.y + CASCADE_OFFSET))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_reused_only_after_a_window_closes() {
        let windows = ChatWindows::default();
        let first = windows.next_label();
        windows.register(first.clone(), "session-a".into());
        let second = windows.next_label();
        assert_ne!(first, second);
        assert_eq!(
            windows.label_for_session("session-a").as_deref(),
            Some(first.as_str())
        );
        windows.forget(&first);
        assert_eq!(windows.next_label(), first);
        assert_eq!(windows.label_for_session("session-a"), None);
    }

    #[test]
    fn only_app_shell_windows_count_as_chat_windows() {
        assert!(is_chat_window("main"));
        assert!(is_chat_window("chat-3"));
        assert!(!is_chat_window("browser-abc"));
        assert!(!is_chat_window("browser-popup-user-1"));
    }
}
