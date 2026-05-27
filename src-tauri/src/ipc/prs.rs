use super::inputs::*;

#[tauri::command(rename = "prs:list-for-session")]
#[specta::specta]
pub fn prs_list_for_session(_input: PrsListForSessionInput) {
    super::unported("prs:list-for-session")
}

#[tauri::command(rename = "prs:refresh")]
#[specta::specta]
pub fn prs_refresh(_input: PrsRefreshInput) {
    super::unported("prs:refresh")
}
