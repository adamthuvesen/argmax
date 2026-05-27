use super::inputs::*;

#[tauri::command(rename = "session:events-since")]
#[specta::specta]
pub fn session_events_since(_input: SessionEventsSinceInput) {
    super::unported("session:events-since")
}

#[tauri::command(rename = "session:cost-summary")]
#[specta::specta]
pub fn session_cost_summary(_input: SessionCostSummaryInput) {
    super::unported("session:cost-summary")
}

#[tauri::command(rename = "session:search")]
#[specta::specta]
pub fn session_search(_input: SessionSearchInput) {
    super::unported("session:search")
}
