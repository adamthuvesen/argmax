//! Scheduled-task scheduler: a slow tokio loop that fires stored routines
//! as normal top-level sessions when their `next_run_at` passes.
//!
//! Missed-while-closed semantics: tokio timers do not run while the app is
//! dead, and macOS sleeps pause them, so an overdue routine fires once on
//! the first tick after wake — the next occurrence is computed strictly
//! after the fire time, collapsing any backlog into a single late run.
//! A one-shot that fired is disabled; a recurring launch failure backs off
//! by [`crate::routines::schedule::retry_after`] so a broken routine can
//! never retry on every future tick.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tauri::Manager;

use crate::error::ArgmaxResult;
use crate::persistence::database::Database;
use crate::persistence::routines::{self, RoutineLaunchFields};
use crate::persistence::time::now_iso;
use crate::providers::session_service::ProviderSessionService;
use crate::providers::{AgentMode, PermissionMode, ProviderId, ReasoningEffort};
use crate::session_control::{self, LaunchSpec};
use crate::state::AppState;
use crate::workspaces::WorkspaceService;

use super::schedule;

const SCHEDULER_TICK: Duration = Duration::from_secs(30);

/// Spawns the tick loop. Services are pulled from `AppState` on every tick
/// and skipped while boot has not installed them yet, mirroring the session
/// sync sweep loop, so this can start before the database opens.
pub fn spawn(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(SCHEDULER_TICK);
        // A tick that overruns must not be followed by a burst of catch-up
        // ticks: each one would re-evaluate the same due rows.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = tick(&app).await {
                tracing::warn!(?error, "routines.scheduler: tick failed");
            }
        }
    });
}

async fn tick(app: &tauri::AppHandle) -> ArgmaxResult<()> {
    let (database, workspaces, providers) = {
        let state = app.state::<AppState>();
        let (Some(database), Some(workspaces), Some(providers)) = (
            state.db.get(),
            state.workspaces.get(),
            state.providers.get(),
        ) else {
            return Ok(());
        };
        (
            Arc::clone(database),
            Arc::clone(workspaces),
            Arc::clone(providers),
        )
    };
    let due = {
        let connection = database.connection();
        routines::due_routines(&connection, &now_iso())?
    };
    for fields in due {
        fire_routine(&database, &workspaces, &providers, fields).await;
    }
    Ok(())
}

/// Launches one routine as a top-level session and records the outcome.
/// Sequential by design — the scheduler tick is the concurrency guard, so
/// several routines due in the same tick launch one after another instead
/// of stampeding worktree creation.
pub(crate) async fn fire_routine(
    database: &Arc<Database>,
    workspaces: &Arc<WorkspaceService>,
    providers: &Arc<ProviderSessionService>,
    fields: RoutineLaunchFields,
) {
    let now = Utc::now();
    let last_run = now_iso();
    let is_once = fields.run_once_at.is_some();
    // `routines:run-now` fires paused rows on demand. Recording that run must
    // leave them paused, so a recurring routine only keeps its enabled state
    // and earns a fresh `next_run_at` when it was already scheduled.
    let stays_scheduled = fields.enabled && !is_once;

    // Compute the next occurrence before launching: a corrupt schedule
    // disables the row instead of launching on a broken definition.
    let next = match schedule::next_occurrence(
        fields.cron_expr.as_deref(),
        fields.run_once_at.as_deref(),
        now,
    ) {
        Ok(next) => next,
        Err(error) => {
            tracing::warn!(routine_id = %fields.id, ?error, "routine schedule invalid; disabling");
            let _ = mark(
                database,
                &fields.id,
                &last_run,
                None,
                Some(error.to_string()).as_deref(),
                false,
            );
            return;
        }
    };

    let Some(provider) = parse_provider(&fields.provider) else {
        let _ = mark(
            database,
            &fields.id,
            &last_run,
            None,
            Some("stored provider is not recognized"),
            false,
        );
        return;
    };

    let spec = LaunchSpec {
        project: Some(fields.project_id.clone()),
        prompt: fields.prompt.clone(),
        worktree: fields.worktree,
        provider,
        model_label: fields.model_label.clone(),
        model_id: fields.model_id.clone(),
        reasoning_effort: None::<ReasoningEffort>,
        fast_mode: false,
        // Nobody is watching a scheduled run, so an approval prompt would just
        // hang the session until someone noticed. Scheduled tasks are always
        // auto-approve; the panel offers no other mode.
        permission_mode: PermissionMode::AutoApprove,
        agent_mode: AgentMode::Auto,
        task_label: None,
    };
    let outcome = session_control::launch_with_spec(
        spec,
        Arc::clone(database),
        Arc::clone(workspaces),
        Arc::clone(providers),
        &fields.project_id,
    )
    .await;

    match outcome {
        Ok(launched) => {
            tracing::info!(
                routine_id = %fields.id,
                session_id = %launched.session_id,
                workspace_id = %launched.workspace_id,
                "scheduled task fired"
            );
            // A one-shot is spent once it launches: disable the row so the
            // task list keeps showing what ran rather than silently deleting.
            let (next_run, enabled) = if stays_scheduled {
                (
                    next.as_ref().map(|time| schedule::format_rfc3339(*time)),
                    true,
                )
            } else {
                (None, false)
            };
            let _ = mark(
                database,
                &fields.id,
                &last_run,
                next_run.as_deref(),
                None,
                enabled,
            );
        }
        Err(error) => {
            tracing::warn!(routine_id = %fields.id, code = %error.code, message = %error.message, "scheduled task launch failed");
            // No unbounded retries of a one-shot; the panel surfaces the error
            // and run-now can retry deliberately.
            let (next_run, enabled) = if stays_scheduled {
                (
                    Some(schedule::format_rfc3339(schedule::retry_after(now))),
                    true,
                )
            } else {
                (None, false)
            };
            let _ = mark(
                database,
                &fields.id,
                &last_run,
                next_run.as_deref(),
                Some(&error.message),
                enabled,
            );
        }
    }
}

fn mark(
    database: &Arc<Database>,
    id: &str,
    last_run_at: &str,
    next_run_at: Option<&str>,
    last_error: Option<&str>,
    enabled: bool,
) -> ArgmaxResult<()> {
    let connection = database.connection();
    routines::mark_routine_run(
        &connection,
        id,
        last_run_at,
        next_run_at,
        last_error,
        enabled,
    )
}

fn parse_provider(value: &str) -> Option<ProviderId> {
    match value {
        "claude" => Some(ProviderId::Claude),
        "codex" => Some(ProviderId::Codex),
        "cursor" => Some(ProviderId::Cursor),
        "opencode" => Some(ProviderId::Opencode),
        "grok" => Some(ProviderId::Grok),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_wire_strings_round_trip() {
        assert_eq!(parse_provider("claude"), Some(ProviderId::Claude));
        assert_eq!(parse_provider("opencode"), Some(ProviderId::Opencode));
        assert_eq!(parse_provider("gemini"), None);
    }
}
