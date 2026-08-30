use std::sync::Arc;

use chrono::Utc;
use tauri::State;

use super::{inputs::*, live_database};
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};
use crate::persistence::routines::{
    self, find_routine_by_id, list_routines, set_routine_enabled, upsert_routine, Routine,
    UpsertRoutineInput,
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
    let connection = database.connection();
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
            worktree: input.worktree,
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
    state: State<'_, AppState>,
    input: RoutinesRunNowInput,
) -> ArgmaxResult<Routine> {
    let database = live_database(&state)?;
    let (workspaces, providers) = launch_services(&state)?;
    let fields = {
        let connection = database.connection();
        let existing = find_routine_by_id(&connection, input.id.as_str())?;
        routine_launch_fields(&existing)
    };
    scheduler::fire_routine(&database, &workspaces, &providers, fields).await;
    let connection = database.connection();
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
                .map(|time| schedule::format_rfc3339(time)),
        ),
    }
}

fn routine_launch_fields(routine: &Routine) -> crate::persistence::routines::RoutineLaunchFields {
    crate::persistence::routines::RoutineLaunchFields {
        id: routine.id.clone(),
        name: routine.name.clone(),
        project_id: routine.project_id.clone(),
        prompt: routine.prompt.clone(),
        provider: routine.provider.clone(),
        model_label: routine.model_label.clone(),
        model_id: routine.model_id.clone(),
        worktree: routine.worktree,
        cron_expr: routine.cron_expr.clone(),
        run_once_at: routine.run_once_at.clone(),
        enabled: routine.enabled,
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
