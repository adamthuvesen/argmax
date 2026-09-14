use super::inputs::*;
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
    approvals_resolve_impl(&state, input)
}

pub(crate) fn approvals_resolve_impl(
    state: &AppState,
    input: ApprovalsResolveInput,
) -> ArgmaxResult<ApprovalRequest> {
    live_approvals(state)?.resolve(
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
    approvals_pending_impl(&state)
}

pub(crate) fn approvals_pending_impl(state: &AppState) -> ArgmaxResult<Vec<ApprovalRequest>> {
    live_approvals(state)?.pending()
}

fn live_approvals(state: &AppState) -> ArgmaxResult<Arc<ApprovalService>> {
    state.approvals.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "APPROVAL_SERVICE_NOT_READY",
            "approval service is not initialized",
        )
    })
}
