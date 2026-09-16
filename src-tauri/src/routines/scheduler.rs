//! Scheduled-task scheduler: a slow tokio loop that fires stored routines
//! as normal top-level sessions when their `next_run_at` passes.
//!
//! Missed-while-closed semantics: tokio timers do not run while the app is
//! dead, and macOS sleeps pause them, so an overdue routine fires once on
//! the first tick after wake — the next occurrence is computed strictly
//! after the fire time, collapsing any backlog into a single late run.
//! A one-shot the user wrote is disabled once it fires, while a wake a chat
//! set for itself is deleted: the chat holds the record. A recurring launch
//! failure backs off by [`crate::routines::schedule::retry_after`] so a
//! broken routine can never retry on every future tick.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use tauri::Manager;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::inputs::ProvidersSendInput;
use crate::ipc::validation::{NonEmptyString, Prompt, SessionId};
use crate::persistence::database::Database;
use crate::persistence::routines::{self, RoutineAuthor, RoutineLaunchFields, RoutineRunTarget};
use crate::persistence::time::now_iso;
use crate::providers::session_service::{self, ProviderSessionService};
use crate::providers::{AgentMode, ProviderId, ReasoningEffort};
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
    let default_agent = crate::default_agent::read_default_agent(&app_data);
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
        fire_routine(&database, &workspaces, &providers, fields, &default_agent).await;
    }
    Ok(())
}

/// Whether the attempt landed on the row. `Recorded` covers a launch, a
/// follow-up, and the failures that book a `last_error`; `Deferred` means the
/// row was left exactly as it was, still due for a later tick. The tick has
/// nowhere to report the difference, but `routines:run-now` does — a button
/// press that starts nothing has to say why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FireOutcome {
    Recorded,
    Deferred,
}

/// Launches one routine as a top-level session and records the outcome.
/// Callers hold a RoutineRun claim until this returns. Ticks also launch their
/// due routines sequentially to bound concurrent worktree creation.
pub(crate) async fn fire_routine(
    database: &Arc<Database>,
    workspaces: &Arc<WorkspaceService>,
    providers: &Arc<ProviderSessionService>,
    mut fields: RoutineLaunchFields,
    default_agent: &crate::default_agent::DefaultAgent,
) -> FireOutcome {
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
            return FireOutcome::Recorded;
        }
    };

    let Some((provider, permission_mode)) =
        resolve_routine_permissions(&fields.provider, default_agent)
    else {
        let _ = mark(
            database,
            &fields,
            &last_run,
            None,
            Some("stored provider is not recognized"),
            false,
            None,
        );
        return FireOutcome::Recorded;
    };

    // An `arc_coordinator` routine has no chat of its own to launch or reuse:
    // it resolves the Arc's *current* coordinator fresh on every fire (so
    // repointing the Arc mid-schedule is picked up automatically) and either
    // delivers, defers behind a running turn exactly like `same_session`, or
    // backs off with an error. A paused/done Arc is not a failure — the
    // occurrence is simply skipped and the schedule advances.
    if matches!(fields.run_target, RoutineRunTarget::ArcCoordinator) {
        let resolution = {
            let connection = database.connection();
            resolve_arc_coordinator(&connection, fields.arc_id.as_deref())
        };
        return match resolution {
            ArcCoordinatorResolution::Skip => {
                settle_success(
                    database,
                    &fields,
                    &last_run,
                    stays_scheduled,
                    next.as_ref(),
                    None,
                );
                FireOutcome::Recorded
            }
            ArcCoordinatorResolution::NoCoordinator => {
                let _ = mark(
                    database,
                    &fields,
                    &last_run,
                    stays_scheduled.next_run_at_or_retry(now).as_deref(),
                    Some("Arc has no coordinator"),
                    stays_scheduled.enabled(),
                    None,
                );
                FireOutcome::Recorded
            }
            ArcCoordinatorResolution::Coordinator(session_id) => {
                match send_routine_follow_up(providers, &fields, provider, &session_id).await {
                    FollowUpOutcome::Sent => {
                        settle_success(
                            database,
                            &fields,
                            &last_run,
                            stays_scheduled,
                            next.as_ref(),
                            None,
                        );
                        FireOutcome::Recorded
                    }
                    FollowUpOutcome::Busy => {
                        tracing::debug!(
                            routine_id = %fields.id,
                            session_id = %session_id,
                            "scheduled task is waiting for its arc coordinator to finish its turn"
                        );
                        FireOutcome::Deferred
                    }
                    // The coordinator vanished between resolution and send
                    // (deleted, archived mid-flight) — the same shape as no
                    // coordinator at all, so it backs off the same way rather
                    // than retrying every tick.
                    FollowUpOutcome::Missing => {
                        let _ = mark(
                            database,
                            &fields,
                            &last_run,
                            stays_scheduled.next_run_at_or_retry(now).as_deref(),
                            Some("Arc has no coordinator"),
                            stays_scheduled.enabled(),
                            None,
                        );
                        FireOutcome::Recorded
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
                        FireOutcome::Recorded
                    }
                }
            }
        };
    }

    // A `same_session` routine reuses one chat: if a previous run left a live
    // session behind, the prompt goes in as a turn of its own. A chat that is
    // still mid-turn leaves the row due for the next tick instead. A missing
    // session falls through to a fresh launch below, which re-points the
    // routine at it.
    if matches!(fields.run_target, RoutineRunTarget::SameSession) {
        if let Some(session_id) = fields.last_session_id.clone() {
            match send_routine_follow_up(providers, &fields, provider, &session_id).await {
                FollowUpOutcome::Sent => {
                    settle_success(
                        database,
                        &fields,
                        &last_run,
                        stays_scheduled,
                        next.as_ref(),
                        None,
                    );
                    return FireOutcome::Recorded;
                }
                // Nothing is recorded and nothing is queued: `next_run_at` is
                // already in the past, so the row stays due and the wake lands
                // as its own turn on the first tick after the chat settles.
                // Ticks that pass while it is busy collapse into that one run,
                // the same way a backlog missed while the app was closed does.
                FollowUpOutcome::Busy => {
                    tracing::debug!(
                        routine_id = %fields.id,
                        session_id = %session_id,
                        "scheduled task is waiting for its chat to finish its turn"
                    );
                    return FireOutcome::Deferred;
                }
                FollowUpOutcome::Missing => {
                    let connection = database.connection();
                    let current = match routines::find_routine_by_id(&connection, &fields.id) {
                        Ok(current) if current.updated_at == fields.updated_at => current,
                        _ => return FireOutcome::Recorded,
                    };
                    if routines::set_routine_last_session(&connection, &current.id, None).is_err() {
                        return FireOutcome::Recorded;
                    }
                    let Ok(current) = routines::find_routine_by_id(&connection, &fields.id) else {
                        return FireOutcome::Recorded;
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
                    return FireOutcome::Recorded;
                }
            }
        }
    }

    let spec = LaunchSpec {
        alongside: None,
        project: Some(fields.project_id.clone()),
        path: None,
        branch: None,
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
        // A scheduled/routine launch is never attached to an Arc today.
        arc_id: None,
        arc_is_coordinator_launch: false,
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
            settle_success(
                database,
                &fields,
                &last_run,
                stays_scheduled,
                next.as_ref(),
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
    FireOutcome::Recorded
}

/// What a shared-chat follow-up attempt decided. `Busy` means a turn is still
/// running there, so the wake waits for the chat rather than joining the user's
/// follow-up queue. `Missing` means the chat is gone (deleted session, archived
/// workspace) and the caller should launch a fresh chat instead; `Failed` is a
/// real error to record with a backoff.
enum FollowUpOutcome {
    Sent,
    Busy,
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
        Err(error) => return FollowUpOutcome::Failed(error.message),
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
    // moves the shared chat with it.
    let result = providers
        .send_scheduled_input(ProvidersSendInput {
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
            if sub_code == session_service::TURN_IN_FLIGHT =>
        {
            FollowUpOutcome::Busy
        }
        Err(ArgmaxError::ServiceError { sub_code, .. })
            if sub_code == "WORKSPACE_ARCHIVING" || sub_code == "ARCHIVE_ALREADY_PENDING" =>
        {
            FollowUpOutcome::Missing
        }
        Err(error) => FollowUpOutcome::Failed(error.to_string()),
    }
}

/// Books a firing that landed. A one-shot the user wrote is disabled and kept,
/// so their task list still shows what ran; a wake a chat set for itself is
/// spent the moment it lands and is deleted, because the chat it woke holds
/// the record and a paused row nobody wrote only piles up. Failures never come
/// through here: those stay on the list with their `last_error`.
fn settle_success(
    database: &Arc<Database>,
    fields: &RoutineLaunchFields,
    last_run: &str,
    stays_scheduled: StaysScheduled,
    next: Option<&chrono::DateTime<chrono::Utc>>,
    launched_session_id: Option<&str>,
) {
    if fields.run_once_at.is_some() && fields.created_by == RoutineAuthor::Agent {
        match routines::delete_spent_routine(&database.connection(), &fields.id, &fields.updated_at)
        {
            // `false` is an edit made while the launch was awaiting: the row
            // is no longer the wake that fired, so leave it as the user left it.
            Ok(_) => return,
            Err(error) => {
                tracing::warn!(routine_id = %fields.id, ?error, "spent wake could not be deleted; disabling instead");
            }
        }
    }
    let _ = mark(
        database,
        fields,
        last_run,
        stays_scheduled.next_run_at(next).as_deref(),
        None,
        stays_scheduled.enabled(),
        launched_session_id,
    );
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

fn resolve_routine_permissions(
    provider: &str,
    default_agent: &crate::default_agent::DefaultAgent,
) -> Option<(ProviderId, crate::providers::PermissionMode)> {
    let provider = crate::providers::runtime::parse_provider(provider).ok()?;
    Some((provider, default_agent.permission_mode_for(provider)))
}

/// What firing an `arc_coordinator` routine should do, resolved fresh from
/// the Arc row rather than a cached session id — a coordinator repointed
/// since the last run is picked up automatically.
enum ArcCoordinatorResolution {
    /// Paused or done: not a failure, just nothing to deliver this occurrence.
    Skip,
    /// Active with no live coordinator — missing, or its workspace is
    /// archiving/archived (see `crate::persistence::arcs::arc_is_live`).
    NoCoordinator,
    Coordinator(String),
}

fn resolve_arc_coordinator(
    connection: &rusqlite::Connection,
    arc_id: Option<&str>,
) -> ArcCoordinatorResolution {
    let Some(arc_id) = arc_id else {
        return ArcCoordinatorResolution::NoCoordinator;
    };
    let arc = match crate::persistence::arcs::get_arc(connection, arc_id) {
        Ok(arc) => arc,
        Err(_) => return ArcCoordinatorResolution::NoCoordinator,
    };
    if !matches!(arc.state, crate::persistence::arcs::ArcState::Active) {
        return ArcCoordinatorResolution::Skip;
    }
    match crate::persistence::arcs::arc_is_live(connection, &arc) {
        Ok(true) => ArcCoordinatorResolution::Coordinator(
            arc.coordinator_session_id
                .expect("arc_is_live implies a coordinator session id"),
        ),
        Ok(false) => ArcCoordinatorResolution::NoCoordinator,
        Err(_) => ArcCoordinatorResolution::NoCoordinator,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::default_agent::DefaultAgent;
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use crate::providers::runtime::{
        BoxFuture, EventCallback, ProviderProcessLauncher, ProviderRuntimeHandle,
    };
    use crate::providers::{PermissionMode, ProviderLaunchInput};
    use crate::sessions::state::SessionState;
    use std::collections::HashMap;

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

    fn database_with_project() -> Arc<Database> {
        let database = Arc::new(Database::open_in_memory().expect("open db"));
        {
            let connection = database.connection();
            connection
                .execute(
                    r#"
                INSERT INTO projects (
                    id, name, repo_path, current_branch,
                    worktree_location, created_at, updated_at
                )
                VALUES ('p1', 'Demo', '/tmp/demo', 'main', '/tmp/worktrees',
                        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
                "#,
                    [],
                )
                .expect("insert project");
        }
        database
    }

    fn once_routine(database: &Arc<Database>, id: &str, created_by: RoutineAuthor) {
        let connection = database.connection();
        routines::upsert_routine(
            &connection,
            &routines::UpsertRoutineInput {
                id: id.to_string(),
                name: "Check CI".to_string(),
                project_id: "p1".to_string(),
                prompt: "Check CI".to_string(),
                provider: "claude".to_string(),
                model_label: "Opus 5".to_string(),
                model_id: "claude-opus-5".to_string(),
                run_target: RoutineRunTarget::SameSession,
                arc_id: None,
                cron_expr: None,
                run_once_at: Some("2026-01-01T09:00:00.000Z".to_string()),
                enabled: true,
                created_by,
            },
            Some("2026-01-01T09:00:00.000Z".to_string()),
        )
        .expect("insert routine");
    }

    fn seed_arc(
        database: &Arc<Database>,
        arc_id: &str,
        state: &str,
        coordinator_session_id: Option<&str>,
    ) {
        let connection = database.connection();
        connection
            .execute(
                "INSERT INTO arcs (id, name, brief, state, home_project_id, coordinator_session_id, dir, created_at, updated_at)
                 VALUES (?1, 'Test Arc', '', ?2, 'p1', ?3, '/tmp/argmax-scheduler-arc', ?4, ?4)",
                rusqlite::params![arc_id, state, coordinator_session_id, now_iso()],
            )
            .expect("seed arc");
    }

    fn repoint_arc_coordinator(
        database: &Arc<Database>,
        arc_id: &str,
        coordinator_session_id: &str,
    ) {
        let connection = database.connection();
        connection
            .execute(
                "UPDATE arcs SET coordinator_session_id = ? WHERE id = ?",
                rusqlite::params![coordinator_session_id, arc_id],
            )
            .expect("repoint arc coordinator");
    }

    /// A coordinator session in its own workspace. `path` has to exist on
    /// disk once a test actually fires the routine: a launch attempt
    /// canonicalizes the workspace path before it ever reaches the launcher.
    fn seed_coordinator_session(
        database: &Arc<Database>,
        workspace_id: &str,
        session_id: &str,
        path: &str,
    ) {
        let connection = database.connection();
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: workspace_id.to_string(),
                project_id: "p1".to_string(),
                task_label: "coordinator".to_string(),
                branch: "coordinator".to_string(),
                base_ref: "main".to_string(),
                path: path.to_string(),
                state: "running".to_string(),
                shared_workspace: false,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("coordinator workspace");
        persist_session(
            &connection,
            &PersistSessionInput {
                id: session_id.to_string(),
                workspace_id: workspace_id.to_string(),
                provider: "claude".to_string(),
                model_label: "Opus 5".to_string(),
                model_id: "claude-opus-5".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "coordinate".to_string(),
                state: SessionState::Complete,
            },
        )
        .expect("coordinator session");
    }

    fn arc_coordinator_routine(database: &Arc<Database>, id: &str, arc_id: &str) {
        let connection = database.connection();
        routines::upsert_routine(
            &connection,
            &routines::UpsertRoutineInput {
                id: id.to_string(),
                name: "Coordinate".to_string(),
                project_id: "p1".to_string(),
                prompt: "Status, please".to_string(),
                provider: "claude".to_string(),
                model_label: "Opus 5".to_string(),
                model_id: "claude-opus-5".to_string(),
                run_target: RoutineRunTarget::ArcCoordinator,
                arc_id: Some(arc_id.to_string()),
                cron_expr: Some("0 0 9 * * *".to_string()),
                run_once_at: None,
                enabled: true,
                created_by: RoutineAuthor::User,
            },
            Some("2026-01-01T09:00:00.000Z".to_string()),
        )
        .expect("insert arc_coordinator routine");
    }

    fn arc_coordinator_fields(database: &Arc<Database>, id: &str) -> RoutineLaunchFields {
        let connection = database.connection();
        routines::routine_launch_fields(
            &routines::find_routine_by_id(&connection, id).expect("routine row"),
        )
    }

    /// Records the session id every launch attempt was addressed to, then
    /// stops — the test only needs proof of *who* fire_routine tried to
    /// reach, not a working provider turn.
    #[derive(Default)]
    struct RecordingLauncher {
        session_ids: Mutex<Vec<String>>,
        // The real spawn path launches in a detached `tokio::spawn` rather
        // than awaiting it inline, so a caller that wants proof the launcher
        // ran has to wait on something — this is that something.
        launched: tokio::sync::Notify,
    }

    impl ProviderProcessLauncher for RecordingLauncher {
        fn launch<'a>(
            &'a self,
            input: ProviderLaunchInput,
            _on_event: EventCallback,
        ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
            self.session_ids
                .lock_or_recover("recorded session ids")
                .push(input.session_id.clone());
            self.launched.notify_one();
            Box::pin(async {
                Err(ArgmaxError::service(
                    "TEST_LAUNCH_STOP",
                    "recording launcher stops here",
                ))
            })
        }
    }

    fn test_default_agent() -> crate::default_agent::DefaultAgent {
        DefaultAgent::factory()
    }

    #[test]
    fn resolve_arc_coordinator_skips_a_paused_or_done_arc() {
        let database = database_with_project();
        seed_coordinator_session(
            &database,
            "w-coord",
            "coord-a",
            "/tmp/argmax-arc-coord-paused",
        );
        for state in ["paused", "done"] {
            seed_arc(&database, &format!("arc-{state}"), state, Some("coord-a"));
            let connection = database.connection();
            assert!(matches!(
                resolve_arc_coordinator(&connection, Some(&format!("arc-{state}"))),
                ArcCoordinatorResolution::Skip
            ));
        }
    }

    #[test]
    fn resolve_arc_coordinator_reports_no_coordinator() {
        let database = database_with_project();
        let connection = database.connection();
        // No `arc_id` at all.
        assert!(matches!(
            resolve_arc_coordinator(&connection, None),
            ArcCoordinatorResolution::NoCoordinator
        ));
        // An active Arc with nobody pointed at it.
        drop(connection);
        seed_arc(&database, "arc-empty", "active", None);
        let connection = database.connection();
        assert!(matches!(
            resolve_arc_coordinator(&connection, Some("arc-empty")),
            ArcCoordinatorResolution::NoCoordinator
        ));
    }

    #[test]
    fn resolve_arc_coordinator_reports_no_coordinator_when_its_workspace_is_archived() {
        let database = database_with_project();
        seed_coordinator_session(
            &database,
            "w-coord",
            "coord-a",
            "/tmp/argmax-arc-coord-archived",
        );
        database
            .connection()
            .execute(
                "UPDATE workspaces SET state = 'archived' WHERE id = 'w-coord'",
                [],
            )
            .expect("archive coordinator workspace");
        seed_arc(&database, "arc-1", "active", Some("coord-a"));
        let connection = database.connection();
        assert!(matches!(
            resolve_arc_coordinator(&connection, Some("arc-1")),
            ArcCoordinatorResolution::NoCoordinator
        ));
    }

    #[test]
    fn resolve_arc_coordinator_finds_the_current_coordinator_and_a_repointed_one() {
        let database = database_with_project();
        seed_coordinator_session(&database, "w-coord-a", "coord-a", "/tmp/argmax-arc-coord-a");
        seed_coordinator_session(&database, "w-coord-b", "coord-b", "/tmp/argmax-arc-coord-b");
        seed_arc(&database, "arc-1", "active", Some("coord-a"));

        let connection = database.connection();
        assert!(matches!(
            resolve_arc_coordinator(&connection, Some("arc-1")),
            ArcCoordinatorResolution::Coordinator(session_id) if session_id == "coord-a"
        ));
        drop(connection);

        repoint_arc_coordinator(&database, "arc-1", "coord-b");
        let connection = database.connection();
        assert!(matches!(
            resolve_arc_coordinator(&connection, Some("arc-1")),
            ArcCoordinatorResolution::Coordinator(session_id) if session_id == "coord-b"
        ));
    }

    #[tokio::test]
    async fn arc_coordinator_errors_when_there_is_no_coordinator() {
        let database = database_with_project();
        seed_arc(&database, "arc-1", "active", None);
        arc_coordinator_routine(&database, "r1", "arc-1");
        let fields = arc_coordinator_fields(&database, "r1");

        let providers = ProviderSessionService::new(Arc::clone(&database));
        let workspaces = Arc::new(WorkspaceService::new(Arc::clone(&database)));
        let outcome = fire_routine(
            &database,
            &workspaces,
            &providers,
            fields,
            &test_default_agent(),
        )
        .await;

        assert_eq!(outcome, FireOutcome::Recorded);
        let routine = routines::find_routine_by_id(&database.connection(), "r1").unwrap();
        assert_eq!(
            routine.last_error.as_deref(),
            Some("Arc has no coordinator")
        );
        // A recurring routine still gets a fresh `next_run_at` — this is a
        // back-off, not a disable.
        assert!(routine.enabled);
        assert!(routine.next_run_at.is_some());
    }

    #[tokio::test]
    async fn arc_coordinator_skips_a_paused_arc_and_advances_the_schedule() {
        let database = database_with_project();
        seed_coordinator_session(
            &database,
            "w-coord",
            "coord-a",
            "/tmp/argmax-arc-coord-skip",
        );
        seed_arc(&database, "arc-1", "paused", Some("coord-a"));
        arc_coordinator_routine(&database, "r1", "arc-1");
        let fields = arc_coordinator_fields(&database, "r1");

        let providers = ProviderSessionService::new(Arc::clone(&database));
        let workspaces = Arc::new(WorkspaceService::new(Arc::clone(&database)));
        let outcome = fire_routine(
            &database,
            &workspaces,
            &providers,
            fields,
            &test_default_agent(),
        )
        .await;

        assert_eq!(outcome, FireOutcome::Recorded);
        let routine = routines::find_routine_by_id(&database.connection(), "r1").unwrap();
        assert_eq!(routine.last_error, None);
        assert!(routine.enabled);
        assert!(routine.next_run_at.is_some());
    }

    #[tokio::test]
    async fn arc_coordinator_delivers_to_the_current_and_then_a_replaced_coordinator() {
        let database = database_with_project();
        // A launch attempt canonicalizes the workspace path before it ever
        // reaches the launcher, so these have to exist on disk.
        let path_a = "/tmp/argmax-arc-coord-deliver-a";
        let path_b = "/tmp/argmax-arc-coord-deliver-b";
        std::fs::create_dir_all(path_a).expect("coordinator workspace dir a");
        std::fs::create_dir_all(path_b).expect("coordinator workspace dir b");
        seed_coordinator_session(&database, "w-coord-a", "coord-a", path_a);
        seed_coordinator_session(&database, "w-coord-b", "coord-b", path_b);
        seed_arc(&database, "arc-1", "active", Some("coord-a"));
        arc_coordinator_routine(&database, "r1", "arc-1");

        let launcher = Arc::new(RecordingLauncher::default());
        let providers =
            ProviderSessionService::with_launcher(Arc::clone(&database), launcher.clone(), |_| {});
        let workspaces = Arc::new(WorkspaceService::new(Arc::clone(&database)));
        let default_agent = test_default_agent();

        // The background spawn path launches asynchronously, so wait on the
        // launcher's own signal rather than the `fire_routine` future.
        let wait_for_launch = |launcher: &Arc<RecordingLauncher>| {
            let launcher = Arc::clone(launcher);
            async move {
                tokio::time::timeout(Duration::from_secs(2), launcher.launched.notified())
                    .await
                    .expect("launcher should have been reached");
            }
        };

        let fields = arc_coordinator_fields(&database, "r1");
        fire_routine(&database, &workspaces, &providers, fields, &default_agent).await;
        wait_for_launch(&launcher).await;
        assert_eq!(
            launcher
                .session_ids
                .lock_or_recover("recorded session ids")
                .as_slice(),
            ["coord-a"]
        );

        repoint_arc_coordinator(&database, "arc-1", "coord-b");
        let fields = arc_coordinator_fields(&database, "r1");
        fire_routine(&database, &workspaces, &providers, fields, &default_agent).await;
        wait_for_launch(&launcher).await;
        assert_eq!(
            launcher
                .session_ids
                .lock_or_recover("recorded session ids")
                .as_slice(),
            ["coord-a", "coord-b"]
        );
    }

    /// The point of the whole author column: a wake a chat set for itself
    /// leaves nothing behind, while a one-shot the user wrote stays on their
    /// list as a paused record of what ran.
    #[test]
    fn a_spent_wake_is_deleted_while_the_users_one_shot_is_kept() {
        let database = database_with_project();
        once_routine(&database, "wake", RoutineAuthor::Agent);
        once_routine(&database, "theirs", RoutineAuthor::User);

        for id in ["wake", "theirs"] {
            let fields = {
                let connection = database.connection();
                routines::routine_launch_fields(
                    &routines::find_routine_by_id(&connection, id).expect("row"),
                )
            };
            settle_success(
                &database,
                &fields,
                "2026-01-01T09:00:00.000Z",
                StaysScheduled(false),
                None,
                Some("session-1"),
            );
        }

        let connection = database.connection();
        assert!(routines::find_routine_by_id(&connection, "wake").is_err());
        let theirs = routines::find_routine_by_id(&connection, "theirs").expect("kept");
        assert!(!theirs.enabled);
        assert_eq!(theirs.next_run_at, None);
        assert_eq!(
            theirs.last_run_at.as_deref(),
            Some("2026-01-01T09:00:00.000Z")
        );
    }

    #[test]
    fn routine_uses_its_provider_permission_when_the_default_model_uses_another_provider() {
        let default_agent = DefaultAgent {
            provider: "claude".to_string(),
            permission_mode: PermissionMode::AskEachTime,
            permission_modes: HashMap::from([(
                ProviderId::Codex,
                PermissionMode::ProviderDefaults,
            )]),
            ..DefaultAgent::factory()
        };

        assert_eq!(
            resolve_routine_permissions("codex", &default_agent),
            Some((ProviderId::Codex, PermissionMode::ProviderDefaults))
        );
    }
}
