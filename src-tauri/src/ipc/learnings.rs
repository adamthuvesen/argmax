use super::inputs::*;

#[tauri::command(rename = "learnings:list")]
#[specta::specta]
pub fn learnings_list(_input: LearningsListInput) {
    super::unported("learnings:list")
}

#[tauri::command(rename = "learnings:update")]
#[specta::specta]
pub fn learnings_update(_input: LearningsUpdateInput) {
    super::unported("learnings:update")
}

#[tauri::command(rename = "learnings:delete")]
#[specta::specta]
pub fn learnings_delete(_input: LearningsDeleteInput) {
    super::unported("learnings:delete")
}
