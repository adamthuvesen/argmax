use super::inputs::*;
#[cfg(test)]
use super::live_database;
use crate::approvals::service::{ApprovalService, ResolveStatus};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::approvals::ApprovalRequest;
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command(rename = "approvals:resolve")]
#[specta::specta]
pub fn approvals_resolve(
    state: State<'_, AppState>,
    input: ApprovalsResolveInput,
) -> ArgmaxResult<ApprovalRequest> {
    live_approvals(&state)?.resolve(
        input.approval_id.as_str(),
        match input.status {
            ApprovalResolution::Approved => ResolveStatus::Approved,
            ApprovalResolution::Rejected => ResolveStatus::Rejected,
        },
    )
}

#[tauri::command(rename = "approvals:pending")]
#[specta::specta]
pub fn approvals_pending(
    state: State<'_, AppState>,
    _input: ApprovalsPendingInput,
) -> ArgmaxResult<Vec<ApprovalRequest>> {
    live_approvals(&state)?.pending()
}

fn live_approvals(state: &AppState) -> ArgmaxResult<Arc<ApprovalService>> {
    state.approvals.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "APPROVAL_SERVICE_NOT_READY",
            "approval service is not initialized",
        )
    })
}

#[cfg(test)]
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
    fn approval_resolution_uses_persisted_status_strings() {
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
