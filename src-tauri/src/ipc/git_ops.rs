use std::sync::Arc;
use tauri::State;

use super::{inputs::*, live_database};
use crate::{
    error::ArgmaxResult,
    gh::service::GhService,
    git::ops::{
        GitCommitInput as GitCommitOpsInput, GitCommitResult,
        GitCreateBranchInput as GitCreateBranchOpsInput, GitCreateBranchResult, GitOpsService,
        GitPushInput as GitPushOpsInput, GitPushResult,
        GitViewOrCreatePrInput as GitViewOrCreatePrOpsInput, GitViewOrCreatePrResult, RefreshPrFn,
    },
    state::AppState,
    util::gh_runner::default_gh_runner,
};

#[tauri::command(rename = "git:commit")]
#[specta::specta]
pub async fn git_commit(
    state: State<'_, AppState>,
    input: GitCommitInput,
) -> ArgmaxResult<GitCommitResult> {
    let service = GitOpsService::new(live_database(&state)?);
    service
        .commit_all(GitCommitOpsInput {
            workspace_id: input.workspace_id.into_string(),
            message: input.message.into_string(),
            selected_files: input
                .selected_files
                .unwrap_or_default()
                .into_iter()
                .map(|path| path.into_string())
                .collect(),
        })
        .await
}

#[tauri::command(rename = "git:push")]
#[specta::specta]
pub async fn git_push(
    state: State<'_, AppState>,
    input: GitPushInput,
) -> ArgmaxResult<GitPushResult> {
    let service = GitOpsService::new(live_database(&state)?);
    service
        .push(GitPushOpsInput {
            workspace_id: input.workspace_id.into_string(),
        })
        .await
}

#[tauri::command(rename = "git:create-branch")]
#[specta::specta]
pub async fn git_create_branch(
    state: State<'_, AppState>,
    input: GitCreateBranchInput,
) -> ArgmaxResult<GitCreateBranchResult> {
    let service = GitOpsService::new(live_database(&state)?);
    service
        .create_branch(GitCreateBranchOpsInput {
            workspace_id: input.workspace_id.into_string(),
            branch: input.branch.into_string(),
        })
        .await
}

#[tauri::command(rename = "git:view-or-create-pr")]
#[specta::specta]
pub async fn git_view_or_create_pr(
    state: State<'_, AppState>,
    input: GitViewOrCreatePrInput,
) -> ArgmaxResult<GitViewOrCreatePrResult> {
    let database = live_database(&state)?;
    let refresh_database = Arc::clone(&database);
    let refresh_pr: RefreshPrFn = Arc::new(move |session_id| {
        let database = Arc::clone(&refresh_database);
        Box::pin(async move { GhService::new(database).refresh(&session_id).await })
    });
    let service = GitOpsService::with_runners(database, default_gh_runner(), Some(refresh_pr));
    service
        .view_or_create_pr(GitViewOrCreatePrOpsInput {
            session_id: input.session_id.into_string(),
        })
        .await
}
