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

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use tauri::Manager;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::inputs::ProvidersSendInput;
use crate::ipc::validation::{NonEmptyString, Prompt, SessionId};
use crate::persistence::database::Database;
use crate::persistence::routines::{self, RoutineLaunchFields, RoutineRunTarget};
use crate::persistence::time::now_iso;
use crate::providers::session_service::ProviderSessionService;
use crate::providers::{AgentMode, PermissionMode, ProviderId, ReasoningEffort};
use crate::session_control::{self, LaunchSpec};
use crate::state::AppState;
use crate::util::sync::LockOrRecover;
use crate::workspaces::WorkspaceService;

use super::schedule;

const SCHEDULER_TICK: Duration = Duration::from_secs(30);

/// Both scheduler ticks and Run now claim the routine before reading its
/// current definition. The guard releases on cancellation as well as return.
#[derive(Default)]
pub struct RoutineRuns(Mutex<HashSet<String>>);

impl RoutineRuns {
    pub fn try_start(&self, id: &str) -> Option<RoutineRun<'_>> {
        self.0
            .lock_or_recover("routine runs")
            .insert(id.to_string())
            .then(|| RoutineRun {
                runs: self,
                id: id.to_string(),
            })
    }
}

pub struct RoutineRun<'a> {
    runs: &'a RoutineRuns,
    id: String,
}

impl Drop for RoutineRun<'_> {
    fn drop(&mut self) {
        self.runs.0.lock_or_recover("routine runs").remove(&self.id);
    }
}

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
    let app_data = crate::util::data_dir::app_data_dir(app)
        .map_err(|error| ArgmaxError::service("APP_DATA_DIR", error.to_string()))?;
    let permission_mode = crate::default_agent::read_default_agent(&app_data).permission_mode;
    let state = app.state::<AppState>();
    for fields in due {
        let Some(_run) = state.routine_runs.try_start(&fields.id) else {
            continue;
        };
        // A manual run or schedule edit can finish after the due list was read.
        // Re-read under the claim so that stale entries cannot fire again.
        let fields = {
            let connection = database.connection();
            let current = match routines::find_routine_by_id(&connection, &fields.id) {
                Ok(current) => current,
                Err(ArgmaxError::RecordNotFound { .. }) => continue,
                Err(error) => return Err(error),
            };
            if !current.enabled
                || current
                    .next_run_at
                    .as_deref()
                    .is_none_or(|at| at > now_iso().as_str())
            {
                continue;
            }
            routines::routine_launch_fields(&current)
        };
        fire_routine(&database, &workspaces, &providers, fields, permission_mode).await;
    }
    Ok(())
}

/// Launches one routine as a top-level session and records the outcome.
/// Callers hold a RoutineRun claim until this returns. Ticks also launch their
/// due routines sequentially to bound concurrent worktree creation.
pub(crate) async fn fire_routine(
    database: &Arc<Database>,
    workspaces: &Arc<WorkspaceService>,
    providers: &Arc<ProviderSessionService>,
    mut fields: RoutineLaunchFields,
    permission_mode: PermissionMode,
) {
    let now = Utc::now();
    let last_run = now_iso();
    let is_once = fields.run_once_at.is_some();
    // `routines:run-now` fires paused rows on demand. Recording that run must
    // leave them paused, so a recurring routine only keeps its enabled state
    // and earns a fresh `next_run_at` when it was already scheduled.
    let stays_scheduled = StaysScheduled(fields.enabled && !is_once);

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
                &fields,
                &last_run,
                None,
                Some(error.to_string()).as_deref(),
                false,
                None,
            );
            return;
        }
    };

    let Some(provider) = parse_provider(&fields.provider) else {
        let _ = mark(
            database,
            &fields,
            &last_run,
            None,
            Some("stored provider is not recognized"),
            false,
            None,
        );
        return;
    };

    // A `same_session` routine reuses one chat: if a previous run left a live
    // session behind, the prompt goes in as a follow-up turn — queued behind a
    // running turn like any other message. A missing session falls through to a
    // fresh launch below, which re-points the routine at it.
    if matches!(fields.run_target, RoutineRunTarget::SameSession) {
        if let Some(session_id) = fields.last_session_id.clone() {
            match send_routine_follow_up(providers, &fields, provider, &session_id).await {
                FollowUpOutcome::Sent => {
                    let _ = mark(
                        database,
                        &fields,
                        &last_run,
                        stays_scheduled.next_run_at(next.as_ref()).as_deref(),
                        None,
                        stays_scheduled.enabled(),
                        None,
                    );
                    return;
                }
                FollowUpOutcome::Missing => {
                    let connection = database.connection();
                    let current = match routines::find_routine_by_id(&connection, &fields.id) {
                        Ok(current) if current.updated_at == fields.updated_at => current,
                        _ => return,
                    };
                    if routines::set_routine_last_session(&connection, &current.id, None).is_err() {
                        return;
                    }
                    let Ok(current) = routines::find_routine_by_id(&connection, &fields.id) else {
                        return;
                    };
                    fields = routines::routine_launch_fields(&current);
                }
                FollowUpOutcome::Failed(message) => {
                    let _ = mark(
                        database,
                        &fields,
                        &last_run,
                        stays_scheduled.next_run_at_or_retry(now).as_deref(),
                        Some(&message),
                        stays_scheduled.enabled(),
                        None,
                    );
                    return;
                }
            }
        }
    }

    let spec = LaunchSpec {
        alongside: None,
        project: Some(fields.project_id.clone()),
        prompt: fields.prompt.clone(),
        worktree: matches!(fields.run_target, RoutineRunTarget::Worktree),
        provider,
        model_label: fields.model_label.clone(),
        model_id: fields.model_id.clone(),
        reasoning_effort: None::<ReasoningEffort>,
        fast_mode: false,
        // Scheduled chats follow the same explicit app permission choice.
        // Native prompts remain pending until the user answers them.
        permission_mode,
        agent_mode: AgentMode::Auto,
        task_label: Some(fields.name.clone()),
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
            let _ = mark(
                database,
                &fields,
                &last_run,
                stays_scheduled.next_run_at(next.as_ref()).as_deref(),
                None,
                stays_scheduled.enabled(),
                matches!(fields.run_target, RoutineRunTarget::SameSession)
                    .then_some(launched.session_id.as_str()),
            );
        }
        Err(error) => {
            tracing::warn!(routine_id = %fields.id, code = %error.code, message = %error.message, "scheduled task launch failed");
            // No unbounded retries of a one-shot; the panel surfaces the error
            // and run-now can retry deliberately.
            let _ = mark(
                database,
                &fields,
                &last_run,
                stays_scheduled.next_run_at_or_retry(now).as_deref(),
                Some(&error.message),
                stays_scheduled.enabled(),
                None,
            );
        }
    }
}

/// What a shared-chat follow-up attempt decided. `Missing` means the chat is
/// gone (deleted session, archived workspace) and the caller should launch a
/// fresh chat instead; `Failed` is a real error to record with a backoff.
enum FollowUpOutcome {
    Sent,
    Missing,
    Failed(String),
}

async fn send_routine_follow_up(
    providers: &Arc<ProviderSessionService>,
    fields: &RoutineLaunchFields,
    provider: crate::providers::ProviderId,
    session_id: &str,
) -> FollowUpOutcome {
    let session_id = match SessionId::try_from(session_id.to_string()) {
        Ok(session_id) => session_id,
        Err(_) => return FollowUpOutcome::Missing,
    };
    let input = match Prompt::try_from(fields.prompt.clone()) {
        Ok(input) => input,
        Err(error) => return FollowUpOutcome::Failed(invalid_input_message(error)),
    };
    let model_label = match NonEmptyString::try_from(fields.model_label.clone()) {
        Ok(model_label) => model_label,
        Err(error) => return FollowUpOutcome::Failed(error.message),
    };
    let model_id = match NonEmptyString::try_from(fields.model_id.clone()) {
        Ok(model_id) => model_id,
        Err(error) => return FollowUpOutcome::Failed(error.message),
    };
    // The routine's current provider and model ride along, so editing the task
    // moves the shared chat with it. While a turn runs the switch is ignored
    // and the message queues under the current provider instead.
    let result = providers
        .send_input(ProvidersSendInput {
            session_id,
            input,
            provider: Some(provider),
            model_label: Some(model_label),
            model_id: Some(model_id),
            reasoning_effort: None,
            fast_mode: false,
            agent_mode: None,
            attachments: None,
            agent_references: None,
        })
        .await;
    match result {
        Ok(_) => FollowUpOutcome::Sent,
        Err(ArgmaxError::RecordNotFound { .. }) => FollowUpOutcome::Missing,
        Err(ArgmaxError::ServiceError { sub_code, .. })
            if sub_code == "WORKSPACE_ARCHIVING" || sub_code == "ARCHIVE_ALREADY_PENDING" =>
        {
            FollowUpOutcome::Missing
        }
        Err(error) => FollowUpOutcome::Failed(error.to_string()),
    }
}

fn invalid_input_message(error: crate::error::InvalidInputIssue) -> String {
    error.message
}

fn mark(
    database: &Arc<Database>,
    fields: &RoutineLaunchFields,
    last_run_at: &str,
    next_run_at: Option<&str>,
    last_error: Option<&str>,
    enabled: bool,
    launched_session_id: Option<&str>,
) -> ArgmaxResult<bool> {
    let connection = database.connection();
    routines::mark_routine_run(
        &connection,
        fields,
        last_run_at,
        next_run_at,
        last_error,
        enabled,
        launched_session_id,
    )
}

/// Whether a firing leaves the row scheduled. One helper so the follow-up
/// path and the fresh-launch path book the same `next_run_at`: recurring rows
/// keep their next occurrence (or a retry backoff on failure) while one-shots
/// and paused rows go quiet.
#[derive(Clone, Copy)]
struct StaysScheduled(bool);

impl StaysScheduled {
    fn enabled(self) -> bool {
        self.0
    }

    fn next_run_at(self, next: Option<&chrono::DateTime<chrono::Utc>>) -> Option<String> {
        if self.0 {
            next.map(|time| schedule::format_rfc3339(*time))
        } else {
            None
        }
    }

    fn next_run_at_or_retry(self, now: chrono::DateTime<chrono::Utc>) -> Option<String> {
        // A failure never keeps the precomputed occurrence: the row backs off
        // so a broken routine cannot retry on every future tick.
        if self.0 {
            Some(schedule::format_rfc3339(schedule::retry_after(now)))
        } else {
            None
        }
    }
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

    #[tokio::test]
    async fn routine_runs_guard_released_on_task_abort() {
        let runs = std::sync::Arc::new(RoutineRuns::default());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let task_runs = std::sync::Arc::clone(&runs);
        let handle = tokio::spawn(async move {
            let Some(_guard) = task_runs.try_start("same") else {
                return;
            };
            let _ = ready_tx.send(());
            std::future::pending::<()>().await;
        });
        ready_rx.await.expect("background task should claim");
        assert!(runs.try_start("same").is_none());
        assert!(runs.try_start("other").is_some());
        handle.abort();
        assert!(handle.await.unwrap_err().is_cancelled());
        assert!(runs.try_start("same").is_some());
    }

    #[test]
    fn provider_wire_strings_round_trip() {
        assert_eq!(parse_provider("claude"), Some(ProviderId::Claude));
        assert_eq!(parse_provider("opencode"), Some(ProviderId::Opencode));
        assert_eq!(parse_provider("gemini"), None);
    }
}
