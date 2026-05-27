use super::inputs::*;

#[tauri::command(rename = "review:list-changed-files")]
#[specta::specta]
pub fn review_list_changed_files(_input: ReviewListChangedFilesInput) {
    super::unported("review:list-changed-files")
}

#[tauri::command(rename = "review:load-diff")]
#[specta::specta]
pub fn review_load_diff(_input: ReviewLoadDiffInput) {
    super::unported("review:load-diff")
}

#[tauri::command(rename = "review:list-changed-files-for-project")]
#[specta::specta]
pub fn review_list_changed_files_for_project(_input: ReviewListChangedFilesForProjectInput) {
    super::unported("review:list-changed-files-for-project")
}

#[tauri::command(rename = "review:load-diff-for-project")]
#[specta::specta]
pub fn review_load_diff_for_project(_input: ReviewLoadDiffForProjectInput) {
    super::unported("review:load-diff-for-project")
}
