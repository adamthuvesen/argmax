use super::inputs::*;

#[tauri::command(rename = "git:commit")]
#[specta::specta]
pub fn git_commit(_input: GitCommitInput) {
    super::unported("git:commit")
}

#[tauri::command(rename = "git:push")]
#[specta::specta]
pub fn git_push(_input: GitPushInput) {
    super::unported("git:push")
}

#[tauri::command(rename = "git:create-branch")]
#[specta::specta]
pub fn git_create_branch(_input: GitCreateBranchInput) {
    super::unported("git:create-branch")
}

#[tauri::command(rename = "git:view-or-create-pr")]
#[specta::specta]
pub fn git_view_or_create_pr(_input: GitViewOrCreatePrInput) {
    super::unported("git:view-or-create-pr")
}
