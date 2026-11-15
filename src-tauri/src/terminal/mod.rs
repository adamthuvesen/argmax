// Owns user-spawned PTYs that back the renderer's integrated terminal
// (⌘J). See `docs/terminal.md` for the runtime expectations.

pub mod service;

#[derive(Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentOpenEvent {
    pub terminal_id: String,
    pub workspace_id: String,
    pub command: Option<String>,
}
