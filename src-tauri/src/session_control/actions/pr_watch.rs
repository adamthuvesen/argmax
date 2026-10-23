//! `pr_watch` and `pr_unwatch`: ask Argmax to wake this chat about one of its
//! pull requests, so the agent ends its turn instead of polling GitHub. The
//! gh poller does the watching (docs/gh.md#pr-watch). `pr_cleanup` runs the
//! git cleanup after a merge and removes the chat's checkout when the turn
//! ends (docs/workspaces.md#pr-cleanup).

use std::path::Path;
use std::sync::Arc;

use tokio::sync::oneshot;
use uuid::Uuid;

use super::super::{
    argmax_protocol_error,
    protocol::{
        PrCleanupAction, PrUnwatchAction, PrUnwatchOutcome, PrWatchAction, PrWatchOutcome,
        SessionControlError, SessionControlResponse, SessionControlResult,
    },
    protocol_error,
    registry::{AfterTurn, ParentLaunchSettings, SessionLaunchRegistry},
};
use super::move_archive::run_after_turn;
use super::workspace_tools::resolve_session_workspace;
use crate::git::exec::{run_git_text, run_git_text_with_allowed_exit_codes, GIT_DEFAULT_TIMEOUT};
use crate::git::pr_cleanup::PrCleanupReport;
use crate::persistence::{
    after_turn::{AfterTurnAction, ArchiveRequest, MergedPrRequest},
    database::Database,
    gh::list_session_prs,
    pr_watches::{delete_pr_watch, upsert_pr_watch, watched_pr_state},
    workspaces::WorkspaceSummary,
};
use crate::providers::session_service::ProviderSessionService;
use crate::workspaces::WorkspaceService;

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
    crate::persistence::project_folders::assert_workspace_pr_repository(
        &database.read_connection(),
        &target.workspace.id,
    )
    .map_err(argmax_protocol_error)?;
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
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) -> Result<SessionControlResponse, SessionControlError> {
    let target = resolve_session_workspace(&database, &parent.session_id, None)?;
    if target.project.id == crate::workspaces::SCRATCH_PROJECT_ID {
        return Err(protocol_error(
            "PROJECT_NOT_ALLOWED",
            "A side chat has no repository, so it has no pull request to clean up.",
        ));
    }
    crate::persistence::project_folders::assert_workspace_pr_repository(
        &database.read_connection(),
        &target.workspace.id,
    )
    .map_err(argmax_protocol_error)?;
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
    let mut report = crate::git::pr_cleanup::cleanup_merged_pr(
        &database,
        &service,
        &parent.session_id,
        pr_number,
    )
    .await
    .map_err(argmax_protocol_error)?;
    if let Some(checkout) = report.checkout_path.clone() {
        let line = schedule_checkout_removal(
            &report,
            &checkout,
            &target.workspace,
            &parent.session_id,
            database,
            workspaces,
            providers,
            registry,
        )
        .await;
        report.set_chat_checkout(&line);
    }
    Ok(SessionControlResponse::new(
        SessionControlResult::PrCleanup(report),
    ))
}

/// The chat's own checkout goes too once its PR merged
/// (docs/workspaces.md#pr-cleanup). Scheduled for when this turn ends, like
/// `workspace_archive`: removal stops every process in the checkout, and the
/// agent calling this tool is one of them. The checks here make the report
/// true now; the removal repeats them, so work added later in the turn stays.
#[allow(clippy::too_many_arguments)]
async fn schedule_checkout_removal(
    report: &PrCleanupReport,
    checkout: &str,
    workspace: &WorkspaceSummary,
    session_id: &str,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) -> String {
    let kept = |reason: &str| format!("checkout {checkout} kept ({reason})");
    let removing = format!("checkout {checkout} removed when this turn ends");
    if workspace.kind != "git" {
        return kept("it is a folder, not a git worktree");
    }
    if workspace.shared_workspace {
        return kept("a shared checkout is not Argmax's to remove");
    }
    if registry.pending_after_turn(session_id) == Some(AfterTurn::RemoveCheckout) {
        return format!("{removing} (already scheduled)");
    }
    let path = Path::new(checkout);
    match run_git_text(path, ["status", "--porcelain"], GIT_DEFAULT_TIMEOUT).await {
        Ok(status) if status.trim().is_empty() => {}
        Ok(_) => return kept("it has uncommitted changes"),
        Err(error) => return kept(&format!("its status could not be read: {error}")),
    }
    // Exit 128: the merged head is not here yet. The removal fetches it and
    // keeps the checkout when HEAD is still not in it.
    let has_later_commits = run_git_text_with_allowed_exit_codes(
        path,
        [
            "merge-base",
            "--is-ancestor",
            "HEAD",
            report.merged_head.as_str(),
        ],
        &[1, 128],
        GIT_DEFAULT_TIMEOUT,
    )
    .await
    .is_ok_and(|exit| exit.exit_code == 1);
    if has_later_commits {
        return kept("it has commits the merged PR does not contain");
    }

    let scheduled = AfterTurnAction::Archive(ArchiveRequest {
        workspace_id: workspace.id.clone(),
        merged_pr: Some(MergedPrRequest {
            pr_number: report.pr_number,
            merged_head: report.merged_head.clone(),
        }),
    });
    let (settled_tx, settled_rx) = oneshot::channel();
    if let Err(error) = registry.schedule_after_turn(session_id, &scheduled, settled_tx) {
        return kept(&format!(
            "its removal could not be scheduled: {}",
            error.message
        ));
    }
    if let Err(error) =
        providers.ensure_after_turn_schedulable(session_id, AfterTurn::RemoveCheckout)
    {
        registry.cancel_after_turn(session_id);
        return kept(&format!("its removal could not be scheduled: {error}"));
    }
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        // The sender goes away only with a cancel or with the app; boot
        // recovery keeps the promise in the second case.
        if settled_rx.await.is_err() {
            return;
        }
        run_after_turn(
            scheduled, session_id, database, workspaces, providers, registry,
        )
        .await;
    });
    removing
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
