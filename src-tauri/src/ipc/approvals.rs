use super::inputs::*;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::approvals::{list_pending_approvals, resolve_approval, ApprovalRequest};
use crate::persistence::dashboard::DASHBOARD_ROW_LIMIT;
use crate::persistence::Database;
use crate::state::AppState;
use std::sync::Arc;
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

fn live_database(state: &AppState) -> ArgmaxResult<Arc<Database>> {
    state
        .db
        .get()
        .cloned()
        .ok_or_else(|| ArgmaxError::service("DATABASE_NOT_READY", "database is not initialized"))
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

    #[test]
    fn pending_requires_initialized_database() {
        let error = match live_database(&AppState::new()) {
            Ok(_) => panic!("expected missing database error"),
            Err(error) => error,
        };

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
