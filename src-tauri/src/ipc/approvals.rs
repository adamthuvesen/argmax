use super::inputs::*;
use super::live_database;
use crate::error::ArgmaxResult;
use crate::persistence::approvals::{list_pending_approvals, resolve_approval, ApprovalRequest};
use crate::persistence::dashboard::DASHBOARD_ROW_LIMIT;
use crate::state::AppState;
use tauri::State;

#[tauri::command(rename = "approvals:resolve")]
#[specta::specta]
pub fn approvals_resolve(
    state: State<'_, AppState>,
    input: ApprovalsResolveInput,
) -> ArgmaxResult<ApprovalRequest> {
    let database = live_database(&state)?;
    let connection = database.connection();
    resolve_approval(
        &connection,
        input.approval_id.as_str(),
        approval_resolution_as_str(input.status),
    )
}

#[tauri::command(rename = "approvals:pending")]
#[specta::specta]
pub fn approvals_pending(
    state: State<'_, AppState>,
    _input: ApprovalsPendingInput,
) -> ArgmaxResult<Vec<ApprovalRequest>> {
    let database = live_database(&state)?;
    let connection = database.connection();
    list_pending_approvals(&connection, DASHBOARD_ROW_LIMIT)
}

fn approval_resolution_as_str(status: ApprovalResolution) -> &'static str {
    match status {
        ApprovalResolution::Approved => "approved",
        ApprovalResolution::Rejected => "rejected",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ArgmaxError;

    #[test]
    fn pending_requires_initialized_database() {
        // `.map(|_| ())` drops the Arc<Database> (which isn't Debug) so expect_err compiles.
        let error = live_database(&AppState::new())
            .map(|_| ())
            .expect_err("expected missing database error");
        assert!(
            matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "DATABASE_NOT_READY")
        );
    }

    #[test]
    fn approval_resolution_matches_legacy_statuses() {
        assert_eq!(
            approval_resolution_as_str(ApprovalResolution::Approved),
            "approved"
        );
        assert_eq!(
            approval_resolution_as_str(ApprovalResolution::Rejected),
            "rejected"
        );
    }
}
