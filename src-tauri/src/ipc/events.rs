//! Push channel payloads exported with the request contracts.
use serde::Serialize;
use specta::Type;

#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentOpenEvent {
    pub terminal_id: String,
    pub workspace_id: String,
    pub command: Option<String>,
}

/// A type-level channel map. Clients index it by channel instead of choosing
/// an unrelated payload type at each subscription.
#[derive(Serialize, Type)]
pub struct PushPayloads {
    #[serde(rename = "dashboard:delta")]
    pub dashboard: crate::providers::flush_queue::DashboardDelta,
    #[serde(rename = "terminal:data")]
    pub terminal_data: crate::terminal::service::TerminalChunk,
    #[serde(rename = "terminal:exit")]
    pub terminal_exit: crate::terminal::service::TerminalExitInfo,
    #[serde(rename = "terminal:agent-open")]
    pub terminal_open: TerminalAgentOpenEvent,
    #[serde(rename = "menu:command")]
    pub menu: crate::menu::MenuCommand,
    #[serde(rename = "ui:zoom")]
    pub zoom: f64,
    #[serde(rename = "window:focus-session")]
    pub focus_session: String,
    #[serde(rename = "composer:attach-window-snapshot")]
    pub window_snapshot: crate::window_snapshot::WindowSnapshotAttach,
    #[serde(rename = "window-snapshot:failed")]
    pub window_snapshot_failed: crate::window_snapshot::SnapshotFailure,
    #[serde(rename = "browser:state")]
    pub browser_state: super::browser::BrowserStateEvent,
    #[serde(rename = "browser:new-tab")]
    pub browser_new_tab: super::browser::BrowserNewTabEvent,
    #[serde(rename = "browser:page-command")]
    pub browser_page_command: super::browser::BrowserPageCommandEvent,
    #[serde(rename = "browser:tabs")]
    pub browser_tabs: crate::browser::registry::BrowserTabsEvent,
    #[serde(rename = "browser:agent-open")]
    pub browser_open: crate::browser::registry::BrowserAgentOpenEvent,
}
