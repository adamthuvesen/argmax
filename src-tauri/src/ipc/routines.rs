use std::sync::Arc;

use chrono::Utc;
use tauri::State;

use super::{inputs::*, live_database};
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};
use crate::persistence::routines::{
    self, find_routine_by_id, list_routines, set_routine_enabled, upsert_routine, Routine,
    RoutineRunTarget, UpsertRoutineInput,
};
use crate::providers::session_service::ProviderSessionService;
use crate::routines::{schedule, scheduler};
use crate::state::AppState;
use crate::workspaces::{WorkspaceService, SCRATCH_PROJECT_ID};

#[tauri::command(rename = "routines:list")]
#[specta::specta]
pub fn routines_list(
    state: State<'_, AppState>,
    _input: RoutinesListInput,
) -> ArgmaxResult<Vec<Routine>> {
    let database = live_database(&state)?;
    let connection = database.read_connection();
    list_routines(&connection)
}

#[tauri::command(rename = "routines:upsert")]
#[specta::specta]
pub async fn routines_upsert(
    state: State<'_, AppState>,
    input: RoutinesUpsertInput,
) -> ArgmaxResult<Routine> {
    let database = live_database(&state)?;
    let cron_expr = input
        .cron_expr
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let run_once_at = input
        .run_once_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    schedule::validate_schedule(cron_expr.as_deref(), run_once_at.as_deref())?;
    let run_once_at = run_once_at
        .as_deref()
        .map(schedule::normalize_once_input)
        .transpose()?;
    if input.project_id.as_str() == SCRATCH_PROJECT_ID {
        return Err(ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["projectId".into()],
            "PROJECT_NOT_ALLOWED",
            "scheduled tasks must target a registered repository, not the side-chats project",
        )));
    }
    let now = Utc::now();
    // A disabled routine keeps no next-run marker; the enabled toggle
    // recomputes one. A one-shot scheduled in the past keeps its stored
    // time so the next scheduler tick fires it immediately.
    let next_run_at = if input.enabled.unwrap_or(true) {
        match &run_once_at {
            Some(time) => Some(time.clone()),
            None => schedule::next_occurrence(cron_expr.as_deref(), None, now)?
                .as_ref()
                .map(|time| schedule::format_rfc3339(*time)),
        }
    } else {
        None
    };
    let connection = database.connection();
    // Newer renderers send the target outright; older ones only know the
    // boolean, which maps onto the two fresh-thread targets.
    let run_target = input.run_target.unwrap_or({
        if input.worktree {
            RoutineRunTarget::Worktree
        } else {
            RoutineRunTarget::NewSession
        }
    });
    upsert_routine(
        &connection,
        &UpsertRoutineInput {
            id: input.id.as_str().to_owned(),
            name: input.name.as_str().to_owned(),
            project_id: input.project_id.as_str().to_owned(),
            prompt: input.prompt.as_str().to_owned(),
            provider: input.provider.as_str().to_owned(),
            model_label: input.model_label.as_str().to_owned(),
            model_id: input.model_id.as_str().to_owned(),
            run_target,
            cron_expr,
            run_once_at,
            enabled: input.enabled.unwrap_or(true),
        },
        next_run_at,
    )
}

#[tauri::command(rename = "routines:delete")]
#[specta::specta]
pub fn routines_delete(state: State<'_, AppState>, input: RoutinesDeleteInput) -> ArgmaxResult<()> {
    let database = live_database(&state)?;
    let connection = database.connection();
    routines::delete_routine(&connection, input.id.as_str())
}

#[tauri::command(rename = "routines:set-enabled")]
#[specta::specta]
pub fn routines_set_enabled(
    state: State<'_, AppState>,
    input: RoutinesSetEnabledInput,
) -> ArgmaxResult<Routine> {
    let database = live_database(&state)?;
    let connection = database.connection();
    let next_run_at = if input.enabled {
        let existing = find_routine_by_id(&connection, input.id.as_str())?;
        schedule_next_run(&existing, Utc::now())?
    } else {
        None
    };
    set_routine_enabled(&connection, input.id.as_str(), input.enabled, next_run_at)
}

#[tauri::command(rename = "routines:run-now")]
#[specta::specta]
pub async fn routines_run_now(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: RoutinesRunNowInput,
) -> ArgmaxResult<Routine> {
    let _run = state
        .routine_runs
        .try_start(input.id.as_str())
        .ok_or_else(|| {
            ArgmaxError::service(
                "ROUTINE_ALREADY_RUNNING",
                "This scheduled task is already launching.",
            )
        })?;
    let database = live_database(&state)?;
    let (workspaces, providers) = launch_services(&state)?;
    let fields = {
        let connection = database.connection();
        let existing = find_routine_by_id(&connection, input.id.as_str())?;
        routines::routine_launch_fields(&existing)
    };
    let app_data = crate::util::data_dir::app_data_dir(&app)
        .map_err(|error| ArgmaxError::service("APP_DATA_DIR", error.to_string()))?;
    let default_agent = crate::default_agent::read_default_agent(&app_data);
    scheduler::fire_routine(&database, &workspaces, &providers, fields, &default_agent).await;
    let connection = database.connection();
    find_routine_by_id(&connection, input.id.as_str())
}

#[tauri::command(rename = "routines:reset-session")]
#[specta::specta]
pub fn routines_reset_session(
    state: State<'_, AppState>,
    input: RoutinesResetSessionInput,
) -> ArgmaxResult<Routine> {
    let database = live_database(&state)?;
    let connection = database.connection();
    let existing = find_routine_by_id(&connection, input.id.as_str())?;
    if !matches!(existing.run_target, RoutineRunTarget::SameSession) {
        return Err(ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["id".into()],
            "RUN_TARGET_NOT_SAME_SESSION",
            "only same-chat tasks can reset their shared chat pointer",
        )));
    }
    routines::set_routine_last_session(&connection, input.id.as_str(), None)?;
    find_routine_by_id(&connection, input.id.as_str())
}

/// The next stored `next_run_at` for a routine, recomputed from now. A
/// one-shot keeps its own time (past times stay due so the scheduler fires
/// them late-once); recurring schedules get their next future occurrence.
fn schedule_next_run(
    routine: &Routine,
    now: chrono::DateTime<Utc>,
) -> ArgmaxResult<Option<String>> {
    match &routine.run_once_at {
        Some(time) => Ok(Some(time.clone())),
        None => Ok(
            schedule::next_occurrence(routine.cron_expr.as_deref(), None, now)?
                .map(schedule::format_rfc3339),
        ),
    }
}

fn launch_services(
    state: &AppState,
) -> ArgmaxResult<(Arc<WorkspaceService>, Arc<ProviderSessionService>)> {
    match (state.workspaces.get(), state.providers.get()) {
        (Some(workspaces), Some(providers)) => Ok((Arc::clone(workspaces), Arc::clone(providers))),
        _ => Err(ArgmaxError::service(
            "SERVICES_NOT_READY",
            "session services are still starting up",
        )),
    }
}
