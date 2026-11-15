//! What the PR poller does when a check fails, a PR merges, or an arc's PR
//! changes state. `run()` builds these hooks once and hands them to the poller.

use std::{path::PathBuf, sync::Arc};

use serde_json::json;

use crate::{default_agent, gh, git, providers, state, workspaces};

/// The fix chat launches on the app-wide default agent, which the renderer
/// mirrors into the app data dir (see `crate::default_agent`).
pub(crate) fn check_failure_hook(
    database: &Arc<argmax_store::Database>,
    providers: &Arc<providers::session_service::ProviderSessionService>,
    notifications: &Arc<state::LiveNotificationService>,
    app_data_dir: PathBuf,
) -> gh::poller::CheckFailureHook {
    let (database, providers, notifications) = (
        Arc::clone(database),
        Arc::clone(providers),
        Arc::clone(notifications),
    );
    Arc::new(move |context: gh::poller::CheckFailureContext| {
        let database = Arc::clone(&database);
        let providers = Arc::clone(&providers);
        let notifications = Arc::clone(&notifications);
        let app_data_dir = app_data_dir.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) =
                handle_gh_check_failure(database, providers, notifications, app_data_dir, context)
                    .await
            {
                tracing::warn!(?error, "failed to handle gh check failure");
            }
        });
    })
}

/// The workspace service is built after the poller, so the hook reads it from
/// app state when it fires.
pub(crate) fn merged_pr_hook(
    app: &tauri::AppHandle,
    database: &Arc<argmax_store::Database>,
) -> gh::poller::MergedPrHook {
    let (app, database) = (app.clone(), Arc::clone(database));
    Arc::new(move |context: gh::poller::MergedPrContext| {
        let app = app.clone();
        let database = Arc::clone(&database);
        tauri::async_runtime::spawn(async move {
            let workspaces = tauri::Manager::state::<state::AppState>(&app)
                .workspaces
                .get()
                .cloned();
            let Some(workspaces) = workspaces else {
                tracing::warn!("workspace service unavailable; skipping archive on merge");
                return;
            };
            archive_merged_workspace(workspaces, database, context).await;
        });
    })
}

pub(crate) fn arc_event_hook(
    database: &Arc<argmax_store::Database>,
    providers: &Arc<providers::session_service::ProviderSessionService>,
) -> gh::poller::ArcEventHook {
    let (database, providers) = (Arc::clone(database), Arc::clone(providers));
    Arc::new(move |context: gh::poller::ArcEventContext| {
        let database = Arc::clone(&database);
        let providers = Arc::clone(&providers);
        tauri::async_runtime::spawn(async move {
            let arc_id = context.arc_id.clone();
            let kind = context.kind;
            if let Err(error) = handle_gh_arc_event(database, providers, context).await {
                // A failed send leaves no row in `session_messages` (see
                // `send_system_notice`), so the poller's next tick falls
                // through to the ordinary check-failure follow-up for a
                // `ChecksFailing` kind. Logging is all that is left to do.
                tracing::warn!(%arc_id, ?kind, ?error, "failed to handle gh arc event");
            }
        });
    })
}

/// Awaited inside the tick: the watch pass moves its cursors only once the
/// message row exists.
pub(crate) fn watch_notice_hook(
    providers: &Arc<providers::session_service::ProviderSessionService>,
) -> gh::watch::PrWatchNoticeHook {
    let providers = Arc::clone(providers);
    Arc::new(move |notice: gh::watch::PrWatchNotice| {
        let providers = Arc::clone(&providers);
        Box::pin(async move {
            providers
                .send_system_notice(
                    notice.message_id,
                    &notice.session_id,
                    notice.session_id.clone(),
                    format!("PR #{} watch", notice.pr_number),
                    notice.body,
                )
                .await
        })
    })
}

async fn handle_gh_check_failure(
    database: Arc<argmax_store::Database>,
    providers: Arc<providers::session_service::ProviderSessionService>,
    notifications: Arc<state::LiveNotificationService>,
    app_data_dir: std::path::PathBuf,
    context: gh::poller::CheckFailureContext,
) -> argmax_contracts::error::ArgmaxResult<()> {
    let (session, pr, input) = {
        let connection = database.connection();
        let session = argmax_store::sessions::find_session_by_id(&connection, &context.session_id)?;
        let workspace =
            argmax_store::workspaces::find_workspace_by_id(&connection, &context.workspace_id)?;
        argmax_store::projects::require_project(&connection, &workspace.project_id)?;
        let pr = argmax_store::gh::list_gh_pr_for_session(&connection, &context.session_id)?
            .into_iter()
            .find(|row| row.pr_number == context.pr_number && row.head_sha == context.head_sha)
            .unwrap_or_else(|| argmax_store::gh::GhPrRecord {
                session_id: context.session_id.clone(),
                pr_number: context.pr_number,
                head_sha: context.head_sha.clone(),
                last_seen_check_state: "failure".to_string(),
                updated_at: argmax_store::time::now_iso(),
                pr_state: Some("OPEN".to_string()),
                notified_at: None,
                pr_created_at: None,
                pr_merged_at: None,
                // Display-only fallback for a row that went missing between
                // poll and notify; never persisted, so leave the branch unset
                // rather than guessing it from the workspace's current one.
                head_ref_name: None,
            });
        let agent = default_agent::read_default_agent(&app_data_dir);
        let input = build_check_failure_follow_up_input(&workspace.id, &agent, &context)?;
        (session, pr, input)
    };

    if let Err(error) = notifications.notify_check_failure(&session, &pr) {
        tracing::warn!(?error, session_id = %session.id, "failed to fire check-failure notification");
    }
    providers.launch(input).await?;
    let connection = database.connection();
    argmax_store::gh::mark_gh_pr_notified(
        &connection,
        &context.session_id,
        context.pr_number,
        &context.head_sha,
        &argmax_store::time::now_iso(),
    )
}

/// Notifies a live Arc's coordinator that a member's PR changed state.
/// Delivered on the same path `session_message` and the completion notice
/// use — `send_system_notice` — so an idle coordinator wakes with it and a
/// busy one collects it from its inbox. `context.message_id` is the poller's
/// own deterministic id (`gh::poller::arc_event_message_id`): stable for this
/// exact transition across a restart, and identical for every session in the
/// Arc observing the same PR in the same tick, so `INSERT OR IGNORE`
/// collapses concurrent observers into one delivery.
///
/// For a `ChecksFailing` kind this does *not* suppress the ordinary
/// check-failure follow-up by itself — the poller decides that at delivery
/// time. `send_system_notice` rolls its insert back and returns `Err` when
/// the send genuinely fails, so a failure here leaves no
/// `session_messages` row, and the poller's own next-tick re-evaluation (see
/// `gh::poller::detect_transition`) falls through to the ordinary follow-up
/// because it finds nothing to suppress on. Only a successful delivery keeps
/// it suppressed.
async fn handle_gh_arc_event(
    database: Arc<argmax_store::Database>,
    providers: Arc<providers::session_service::ProviderSessionService>,
    context: gh::poller::ArcEventContext,
) -> argmax_contracts::error::ArgmaxResult<()> {
    let (member_label, project_id, project_name, pr_title, pr_url) = {
        let connection = database.connection();
        let workspace =
            argmax_store::workspaces::find_workspace_by_id(&connection, &context.workspace_id)?;
        let project = argmax_store::projects::require_project(&connection, &workspace.project_id)?;
        let pr = argmax_store::gh::list_session_prs(&connection, &context.session_id)?
            .into_iter()
            .find(|pr| pr.pr_number == context.pr_number);
        (
            workspace.task_label,
            workspace.project_id,
            project.name,
            pr.as_ref().and_then(|pr| pr.title.clone()),
            pr.as_ref().and_then(|pr| pr.url.clone()),
        )
    };
    let title = pr_title.unwrap_or_else(|| "untitled".to_string());
    let url = pr_url.clone().unwrap_or_default();
    let head7: String = context.head_sha.chars().take(7).collect();
    let status = match context.kind {
        gh::poller::ArcEventKind::ChecksFailing => format!("checks failing on {head7}"),
        gh::poller::ArcEventKind::ChecksPassing => format!("checks passing on {head7}"),
        gh::poller::ArcEventKind::Merged => "merged".to_string(),
    };
    let body = format!(
        "Arc \"{}\": PR #{} ({}) in {} — {}. Member session {} ({}). {}",
        context.arc_name,
        context.pr_number,
        title,
        project_name,
        status,
        context.session_id,
        member_label,
        url,
    );
    providers
        .send_system_notice(
            context.message_id.clone(),
            &context.coordinator_session_id,
            context.session_id.clone(),
            member_label,
            body,
        )
        .await?;
    // Recorded once the coordinator has the message, so the timeline never
    // shows an event the coordinator was not told about.
    let kind = match context.kind {
        gh::poller::ArcEventKind::ChecksFailing => {
            argmax_store::arc_events::ArcEventKind::PrChecksFailing
        }
        gh::poller::ArcEventKind::ChecksPassing => {
            argmax_store::arc_events::ArcEventKind::PrChecksPassing
        }
        gh::poller::ArcEventKind::Merged => argmax_store::arc_events::ArcEventKind::PrMerged,
    };
    let connection = database.connection();
    let mut event = argmax_store::arc_events::NewArcEvent::new(
        format!("pr:{}", context.message_id),
        &context.arc_id,
        kind,
        title,
    );
    event.session_id = Some(&context.session_id);
    event.project_id = Some(&project_id);
    event.status = (!matches!(context.kind, gh::poller::ArcEventKind::Merged)).then_some(head7);
    event.pr_number = Some(context.pr_number);
    event.pr_url = pr_url.as_deref();
    argmax_store::arc_events::record_arc_event(&connection, &event)?;
    Ok(())
}

/// Disposes of a workspace whose PR has merged, for projects that asked for
/// it. Never forced: a dirty worktree returns to `kept` instead of being
/// deleted, and uncommitted work outliving a merged PR is exactly the case
/// worth keeping.
async fn archive_merged_workspace(
    workspaces: Arc<workspaces::orchestration::WorkspaceService>,
    database: Arc<argmax_store::database::Database>,
    context: gh::poller::MergedPrContext,
) {
    use argmax_store::projects::MergeCleanup;
    let result = match context.cleanup {
        MergeCleanup::Off => return,
        MergeCleanup::Archive => {
            let workspace_id = match argmax_contracts::validation::WorkspaceId::try_from(
                context.workspace_id.clone(),
            ) {
                Ok(workspace_id) => workspace_id,
                Err(error) => {
                    tracing::warn!(workspace_id = %context.workspace_id, ?error, "archive on merge: invalid workspace id");
                    return;
                }
            };
            workspaces
                .archive(workspaces::inputs::WorkspacesArchiveInput {
                    workspace_id,
                    force: Some(false),
                })
                .await
        }
        MergeCleanup::RemoveCheckout => {
            workspaces
                .remove_merged_checkout(&context.workspace_id, &context.merged_head)
                .await
        }
    };
    match result {
        Ok(result) if result.workspace.state == "kept" => tracing::info!(
            workspace_id = %result.workspace.id,
            pr_number = context.pr_number,
            changed_files = result.workspace.changed_files,
            "merge cleanup: kept the workspace and its worktree",
        ),
        Ok(result) => {
            tracing::info!(
                workspace_id = %result.workspace.id,
                pr_number = context.pr_number,
                cleanup = context.cleanup.as_wire(),
                "merge cleanup: the PR merged, so the workspace was archived",
            );
            // With the checkout gone, nothing has the branch checked out, so
            // PR cleanup can delete it when its tip is the merged head.
            if result.workspace.checkout_removed_at.is_some() {
                let service = gh::service::GhService::new(Arc::clone(&database));
                match git::pr_cleanup::cleanup_merged_pr(
                    &database,
                    &service,
                    &context.session_id,
                    context.pr_number,
                )
                .await
                {
                    Ok(report) => tracing::info!(
                        pr_number = context.pr_number,
                        report = %report.text,
                        "merge cleanup: PR cleanup after removing the checkout",
                    ),
                    Err(error) => tracing::warn!(
                        pr_number = context.pr_number,
                        ?error,
                        "merge cleanup: PR cleanup after removing the checkout failed",
                    ),
                }
            }
        }
        Err(error) => tracing::warn!(
            workspace_id = %context.workspace_id,
            pr_number = context.pr_number,
            ?error,
            "merge cleanup failed",
        ),
    }
}

fn build_check_failure_follow_up_input(
    workspace_id: &str,
    agent: &default_agent::DefaultAgent,
    context: &gh::poller::CheckFailureContext,
) -> argmax_contracts::error::ArgmaxResult<providers::inputs::ProvidersLaunchInput> {
    let provider = argmax_contracts::validation::parse_provider(&agent.provider)?;
    serde_json::from_value(json!({
        "workspaceId": workspace_id,
        "provider": agent.provider,
        "prompt": format!(
            "Checks on PR #{} (commit {}) are failing. Run `gh pr checks {}` to see which checks failed, then investigate and fix.",
            context.pr_number,
            context.head_sha.chars().take(12).collect::<String>(),
            context.pr_number
        ),
        "modelLabel": agent.model_label,
        "modelId": agent.model_id,
        "reasoningEffort": agent.reasoning_effort,
        "permissionMode": agent.permission_mode_for(provider),
        "cols": 120,
        "rows": 36
    }))
    .map_err(|error| argmax_contracts::error::ArgmaxError::service("GH_FOLLOW_UP_INPUT_INVALID", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn follow_up_context() -> gh::poller::CheckFailureContext {
        gh::poller::CheckFailureContext {
            session_id: "s1".to_string(),
            workspace_id: "w1".to_string(),
            pr_number: 7,
            head_sha: "abcdef1234567890".to_string(),
        }
    }

    #[test]
    fn check_failure_follow_up_launches_on_the_app_default_agent() {
        let agent = default_agent::DefaultAgent {
            provider: "codex".to_string(),
            model_label: "GPT-5.6 Luna".to_string(),
            model_id: "gpt-5.6-luna".to_string(),
            reasoning_effort: Some("high".to_string()),
            permission_mode: argmax_contracts::validation::PermissionMode::AskEachTime,
            permission_modes: std::collections::HashMap::from([(
                argmax_contracts::validation::ProviderId::Codex,
                argmax_contracts::validation::PermissionMode::ProviderDefaults,
            )]),
        };
        let input = build_check_failure_follow_up_input("w1", &agent, &follow_up_context())
            .expect("follow-up input");
        assert_eq!(
            input.permission_mode,
            Some(argmax_contracts::validation::PermissionMode::ProviderDefaults)
        );
        assert_eq!(input.model_label.as_str(), "GPT-5.6 Luna");
        assert_eq!(input.model_id.as_str(), "gpt-5.6-luna");
        assert_eq!(
            input.reasoning_effort.map(|effort| effort.as_str()),
            Some("high")
        );
    }

    #[test]
    fn check_failure_follow_up_falls_back_to_the_factory_agent() {
        // Nothing mirrored yet — a fresh install launches the fix chat on the
        // same agent the launcher shows: Opus 5.5 at Medium.
        let input = build_check_failure_follow_up_input(
            "w1",
            &default_agent::DefaultAgent::factory(),
            &follow_up_context(),
        )
        .expect("follow-up input");
        assert_eq!(input.model_label.as_str(), "Opus 5.5");
        assert_eq!(input.model_id.as_str(), "claude-opus-5-5");
        assert_eq!(
            input.reasoning_effort.map(|effort| effort.as_str()),
            Some("medium")
        );
    }
}
