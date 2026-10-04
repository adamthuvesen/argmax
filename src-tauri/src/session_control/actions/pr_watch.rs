//! `pr_watch` and `pr_unwatch`: ask Argmax to wake this chat about one of its
//! pull requests, so the agent ends its turn instead of polling GitHub. The
//! gh poller does the watching (docs/gh.md#pr-watch). `pr_cleanup` runs the
//! git cleanup after a merge (docs/workspaces.md#pr-cleanup).

use std::sync::Arc;

use uuid::Uuid;

use super::super::{
    argmax_protocol_error,
    protocol::{
        PrCleanupAction, PrUnwatchAction, PrUnwatchOutcome, PrWatchAction, PrWatchOutcome,
        SessionControlError, SessionControlResponse, SessionControlResult,
    },
    protocol_error,
    registry::ParentLaunchSettings,
};
use super::workspace_tools::resolve_session_workspace;
use crate::persistence::{
    database::Database,
    gh::list_session_prs,
    pr_watches::{delete_pr_watch, upsert_pr_watch, watched_pr_state},
};

pub(super) fn watch_pr(
    action: PrWatchAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let target = resolve_session_workspace(&database, &parent.session_id, None)?;
    if target.project.id == crate::workspaces::SCRATCH_PROJECT_ID {
        return Err(protocol_error(
            "PROJECT_NOT_ALLOWED",
            "A side chat has no repository, so it has no pull request to watch.",
        ));
    }
    let pr_number = resolve_pr_number(&database, &parent.session_id, action.pr)?;
    // A PR Argmax has not read yet is accepted: the poller views a watched PR
    // by number on its next tick.
    let state = watched_pr_state(&database.read_connection(), &target.project.id, pr_number)
        .map_err(argmax_protocol_error)?;
    if let Some(pr_state) = state
        .as_ref()
        .and_then(|state| state.pr_state.as_deref())
        .filter(|pr_state| matches!(*pr_state, "MERGED" | "CLOSED"))
    {
        return Err(protocol_error(
            "PR_NOT_OPEN",
            format!(
                "PR #{pr_number} is {}, so there is nothing to watch.",
                pr_state.to_lowercase()
            ),
        ));
    }
    let head_sha = state
        .as_ref()
        .map(|state| state.head_sha.clone())
        .filter(|sha| !sha.is_empty());
    upsert_pr_watch(
        &database.connection(),
        &Uuid::new_v4().to_string(),
        &parent.session_id,
        &target.project.id,
        pr_number,
        action.cleanup_on_merge,
        head_sha.as_deref().unwrap_or_default(),
    )
    .map_err(argmax_protocol_error)?;
    Ok(SessionControlResponse::new(SessionControlResult::PrWatch(
        PrWatchOutcome {
            project_id: target.project.id,
            pr_number,
            url: state.and_then(|state| state.url),
            head_sha,
            watching: true,
        },
    )))
}

pub(super) fn unwatch_pr(
    action: PrUnwatchAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let target = resolve_session_workspace(&database, &parent.session_id, None)?;
    let pr_number = resolve_pr_number(&database, &parent.session_id, action.pr)?;
    let removed = delete_pr_watch(
        &database.connection(),
        &parent.session_id,
        &target.project.id,
        pr_number,
    )
    .map_err(argmax_protocol_error)?;
    Ok(SessionControlResponse::new(
        SessionControlResult::PrUnwatch(PrUnwatchOutcome { removed }),
    ))
}

pub(super) async fn cleanup_pr(
    action: PrCleanupAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let target = resolve_session_workspace(&database, &parent.session_id, None)?;
    if target.project.id == crate::workspaces::SCRATCH_PROJECT_ID {
        return Err(protocol_error(
            "PROJECT_NOT_ALLOWED",
            "A side chat has no repository, so it has no pull request to clean up.",
        ));
    }
    let pr_number = resolve_pr_number(&database, &parent.session_id, action.pr)?;
    // A PR Argmax already knows is open or closed is refused without a GitHub
    // call. Cleanup itself re-reads the PR before it touches anything.
    let known_state = watched_pr_state(&database.read_connection(), &target.project.id, pr_number)
        .map_err(argmax_protocol_error)?
        .and_then(|state| state.pr_state);
    if let Some(pr_state) = known_state.filter(|state| matches!(state.as_str(), "OPEN" | "CLOSED"))
    {
        return Err(protocol_error(
            "PR_NOT_MERGED",
            format!(
                "PR #{pr_number} is {}. Cleanup runs only after it merges.",
                pr_state.to_lowercase()
            ),
        ));
    }
    let service = crate::gh::service::GhService::new(Arc::clone(&database));
    let report = crate::git::pr_cleanup::cleanup_merged_pr(
        &database,
        &service,
        &parent.session_id,
        pr_number,
    )
    .await
    .map_err(argmax_protocol_error)?;
    Ok(SessionControlResponse::new(
        SessionControlResult::PrCleanup(report),
    ))
}

/// The PR the agent named, or this session's primary PR.
fn resolve_pr_number(
    database: &Database,
    session_id: &str,
    requested: Option<i64>,
) -> Result<i64, SessionControlError> {
    if let Some(pr_number) = requested {
        if pr_number <= 0 {
            return Err(protocol_error(
                "PR_NOT_FOUND",
                format!("{pr_number} is not a pull request number."),
            ));
        }
        return Ok(pr_number);
    }
    list_session_prs(&database.read_connection(), session_id)
        .map_err(argmax_protocol_error)?
        .into_iter()
        .find(|pr| pr.is_primary)
        .map(|pr| pr.pr_number)
        .ok_or_else(|| {
            protocol_error(
                "PR_NOT_FOUND",
                "Argmax has no pull request for this chat yet. Pass `pr` with its number.",
            )
        })
}
