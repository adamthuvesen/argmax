use super::inputs::*;

#[tauri::command(rename = "tournament:launch")]
#[specta::specta]
pub fn tournament_launch(_input: TournamentLaunchInput) {
    super::unported("tournament:launch")
}

#[tauri::command(rename = "tournament:list")]
#[specta::specta]
pub fn tournament_list(_input: TournamentListInput) {
    super::unported("tournament:list")
}

#[tauri::command(rename = "tournament:get")]
#[specta::specta]
pub fn tournament_get(_input: TournamentGetInput) {
    super::unported("tournament:get")
}

#[tauri::command(rename = "tournament:keep")]
#[specta::specta]
pub fn tournament_keep(_input: TournamentKeepInput) {
    super::unported("tournament:keep")
}
