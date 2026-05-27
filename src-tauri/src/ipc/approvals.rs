use super::inputs::*;

#[tauri::command(rename = "approvals:resolve")]
#[specta::specta]
pub fn approvals_resolve(_input: ApprovalsResolveInput) {
    super::unported("approvals:resolve")
}

#[tauri::command(rename = "approvals:pending")]
#[specta::specta]
pub fn approvals_pending(_input: ApprovalsPendingInput) {
    super::unported("approvals:pending")
}
