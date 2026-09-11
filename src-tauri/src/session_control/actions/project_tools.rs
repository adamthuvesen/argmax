//! The project-scoped tools: project memory, the project list, and waking
//! this chat up later.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use super::super::{
    argmax_protocol_error,
    protocol::{
        LearningRecord, LearningsAddAction, LearningsSearchAction, LearningsSearchOutcome,
        ProjectEntry, ProjectListOutcome, ScheduleCancelAction, ScheduleCancelled, ScheduleEntry,
        ScheduleFollowupAction, ScheduleListAction, ScheduleListOutcome, ScheduleResumeAction,
        ScheduleResumed, ScheduledFollowup, SessionControlError, SessionControlResponse,
        SessionControlResult,
    },
    protocol_error,
    registry::ParentLaunchSettings,
    FOLLOWUP_MAX_SECONDS, FOLLOWUP_MIN_SECONDS, LEARNINGS_SEARCH_DEFAULT_LIMIT,
    LEARNINGS_SEARCH_MAX_LIMIT, SCHEDULE_LIST_LIMIT, SCHEDULE_PROMPT_CHARS,
};
use super::{
    messaging::cap_chars, resolve_project, task_label, workspace_tools::resolve_session_workspace,
};
use crate::{
    persistence::{
        database::Database,
        learnings::{
            insert_learning, record_learning_hits, search_learnings, InsertLearningInput, Learning,
        },
        projects::list_projects,
        routines::{
            delete_routine, find_routine_by_id, list_routines, set_routine_enabled,
            set_routine_last_session, upsert_routine, RoutineRunTarget, UpsertRoutineInput,
        },
    },
    routines::schedule,
};

/// The three kinds the `learnings` table accepts. Rejecting a fourth here
/// names the allowed set, rather than letting SQLite's CHECK constraint answer
/// with a constraint violation.
const LEARNING_KINDS: [&str; 3] = ["pitfall", "convention", "command"];

pub(super) fn add_learning(
    action: LearningsAddAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let kind = action.kind.trim().to_ascii_lowercase();
    if !LEARNING_KINDS.contains(&kind.as_str()) {
        return Err(protocol_error(
            "LEARNING_KIND_INVALID",
            format!(
                "'{}' is not a learning kind. Use {}.",
                action.kind,
                LEARNING_KINDS.join(", ")
            ),
        ));
    }
    let summary = action.summary.trim();
    if summary.is_empty() {
        return Err(protocol_error(
            "LEARNING_SUMMARY_EMPTY",
            "A learning needs a summary: one sentence the next agent can act on.",
        ));
    }
    let project_id = target_project(&database, &parent, action.project.as_deref())?;
    let learning = {
        let connection = database.connection();
        insert_learning(
            &connection,
            &InsertLearningInput {
                id: None,
                project_id,
                kind,
                summary: summary.to_string(),
                // The session is the evidence: it is where the learning was
                // earned, and the memory panel links back to it.
                evidence_session_id: Some(parent.session_id.clone()),
                evidence_event_id: None,
            },
        )
        .map_err(argmax_protocol_error)?
    };
    Ok(SessionControlResponse::new(SessionControlResult::Learned(
        learning_record(learning),
    )))
}

pub(super) fn search_learnings_action(
    action: LearningsSearchAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let project_id = target_project(&database, &parent, action.project.as_deref())?;
    let limit = action
        .limit
        .map(|value| (value as usize).clamp(1, LEARNINGS_SEARCH_MAX_LIMIT))
        .unwrap_or(LEARNINGS_SEARCH_DEFAULT_LIMIT);
    let query = action.query.unwrap_or_default();
    let found = {
        let connection = database.read_connection();
        // One extra row, so `truncated` reports whether narrowing the query
        // would show more rather than guessing from a full page.
        search_learnings(&connection, &project_id, &query, limit + 1)
            .map_err(argmax_protocol_error)?
    };
    let truncated = found.len() > limit;
    let learnings = found.into_iter().take(limit).collect::<Vec<_>>();
    {
        let connection = database.connection();
        let ids = learnings
            .iter()
            .map(|learning| learning.id.clone())
            .collect::<Vec<_>>();
        if let Err(error) = record_learning_hits(&connection, &ids) {
            // A missed hit count costs ranking, not the answer.
            tracing::warn!(?error, "could not record learning hits");
        }
    }
    Ok(SessionControlResponse::new(
        SessionControlResult::LearningsFound(LearningsSearchOutcome {
            project_id,
            learnings: learnings.into_iter().map(learning_record).collect(),
            truncated,
        }),
    ))
}

pub(super) fn list_projects_action(
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let connection = database.read_connection();
    let projects = list_projects(&connection).map_err(argmax_protocol_error)?;
    let entries = projects
        .into_iter()
        .filter(|project| project.id != crate::workspaces::SCRATCH_PROJECT_ID)
        .map(|project| ProjectEntry {
            project_id: project.id,
            name: project.name,
            repo_path: project.repo_path,
            current_branch: project.current_branch,
            default_branch: project.default_branch,
            check_commands: project.settings.check_commands,
            active_sessions: project.counts.active,
            latest_activity_at: project.latest_activity_at,
        })
        .collect::<Vec<_>>();
    Ok(SessionControlResponse::new(SessionControlResult::Projects(
        ProjectListOutcome { projects: entries },
    )))
}

pub(super) fn schedule_followup(
    action: ScheduleFollowupAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    if action.prompt.trim().is_empty() {
        return Err(protocol_error(
            "FOLLOWUP_PROMPT_EMPTY",
            "A follow-up needs a prompt: what this chat should do when it wakes.",
        ));
    }
    let run_at = followup_time(&action, Utc::now())?;
    let target = resolve_session_workspace(&database, &parent.session_id, None)?;
    if target.project.id == crate::workspaces::SCRATCH_PROJECT_ID {
        return Err(protocol_error(
            "PROJECT_NOT_ALLOWED",
            "A side chat has no repository to wake up in.",
        ));
    }
    let name = action
        .name
        .as_deref()
        .map(task_label)
        .unwrap_or_else(|| task_label(&action.prompt));
    let followup_id = Uuid::new_v4().to_string();
    let connection = database.connection();
    upsert_routine(
        &connection,
        &UpsertRoutineInput {
            id: followup_id.clone(),
            name: name.clone(),
            project_id: target.project.id,
            prompt: action.prompt,
            provider: parent.provider.as_str().to_string(),
            model_label: parent.model_label.clone(),
            model_id: parent.model_id.clone(),
            // The whole point is to wake *this* chat, with its transcript: the
            // scheduler sends a `same_session` prompt as a follow-up turn.
            run_target: RoutineRunTarget::SameSession,
            cron_expr: None,
            run_once_at: Some(run_at.clone()),
            enabled: true,
        },
        Some(run_at.clone()),
    )
    .map_err(argmax_protocol_error)?;
    set_routine_last_session(&connection, &followup_id, Some(&parent.session_id))
        .map_err(argmax_protocol_error)?;
    Ok(SessionControlResponse::new(SessionControlResult::Followup(
        ScheduledFollowup {
            followup_id,
            session_id: parent.session_id,
            name,
            run_at,
        },
    )))
}

pub(super) fn list_schedules(
    action: ScheduleListAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let project_id = target_project(&database, &parent, action.project.as_deref())?;
    let connection = database.read_connection();
    let found = list_routines(&connection).map_err(argmax_protocol_error)?;
    let mut schedules = found
        .into_iter()
        .filter(|routine| routine.project_id == project_id)
        .collect::<Vec<_>>();
    let truncated = schedules.len() > SCHEDULE_LIST_LIMIT;
    schedules.truncate(SCHEDULE_LIST_LIMIT);
    Ok(SessionControlResponse::new(
        SessionControlResult::Schedules(ScheduleListOutcome {
            project_id,
            schedules: schedules
                .into_iter()
                .map(|routine| ScheduleEntry {
                    schedule_id: routine.id,
                    name: routine.name,
                    prompt: cap_chars(&routine.prompt, SCHEDULE_PROMPT_CHARS),
                    enabled: routine.enabled,
                    cron_expr: routine.cron_expr,
                    run_once_at: routine.run_once_at,
                    run_target: routine.run_target.as_str().to_string(),
                    session_id: routine.last_session_id,
                    next_run_at: routine.next_run_at,
                    last_run_at: routine.last_run_at,
                    last_error: routine.last_error,
                })
                .collect(),
            truncated,
        }),
    ))
}

pub(super) fn cancel_schedule(
    action: ScheduleCancelAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let routine = own_project_routine(&database, &parent, &action.schedule_id)?;
    let connection = database.connection();
    if action.disable {
        set_routine_enabled(&connection, &action.schedule_id, false, None)
            .map_err(argmax_protocol_error)?;
    } else {
        delete_routine(&connection, &action.schedule_id).map_err(argmax_protocol_error)?;
    }
    Ok(SessionControlResponse::new(
        SessionControlResult::ScheduleCancelled(ScheduleCancelled {
            schedule_id: action.schedule_id,
            name: routine.name,
            deleted: !action.disable,
        }),
    ))
}

pub(super) fn resume_schedule(
    action: ScheduleResumeAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let routine = own_project_routine(&database, &parent, &action.schedule_id)?;
    // The stored time is stale by the length of the pause, so a recurring
    // task resumes at its next occurrence rather than firing on the next tick
    // for every run it slept through.
    let next_run_at =
        schedule::next_run_from_now(&routine, Utc::now()).map_err(argmax_protocol_error)?;
    let connection = database.connection();
    let resumed = set_routine_enabled(&connection, &action.schedule_id, true, next_run_at.clone())
        .map_err(argmax_protocol_error)?;
    Ok(SessionControlResponse::new(
        SessionControlResult::ScheduleResumed(ScheduleResumed {
            schedule_id: resumed.id,
            name: resumed.name,
            next_run_at,
        }),
    ))
}

/// The routine a cancel or a resume names, refused unless it is scheduled in
/// the caller's own project. Scoped for the same reason a launch is: a chat
/// working in one repository has no business switching another repository's
/// routines on or off.
/// Both reads run before the caller takes the write connection: with no
/// reader pool open, `read_connection` hands back the writer's own guard, and
/// taking it twice would deadlock the socket.
fn own_project_routine(
    database: &Database,
    parent: &ParentLaunchSettings,
    schedule_id: &str,
) -> Result<crate::persistence::routines::Routine, SessionControlError> {
    let own_project = resolve_session_workspace(database, &parent.session_id, None)?
        .project
        .id;
    let connection = database.read_connection();
    let routine = find_routine_by_id(&connection, schedule_id).map_err(argmax_protocol_error)?;
    if routine.project_id != own_project {
        return Err(protocol_error(
            "SCHEDULE_OTHER_PROJECT",
            format!(
                "'{}' is scheduled in another project. schedule_list shows the ones you can change.",
                routine.name
            ),
        ));
    }
    Ok(routine)
}

/// When the wake lands. Exactly one of `in_seconds` and `at` may be given,
/// and both are held to the same floor: the scheduler ticks every 30 seconds,
/// so promising anything sooner would be a lie.
fn followup_time(
    action: &ScheduleFollowupAction,
    now: DateTime<Utc>,
) -> Result<String, SessionControlError> {
    let at = match (action.in_seconds, action.at.as_deref()) {
        (Some(_), Some(_)) => {
            return Err(protocol_error(
                "FOLLOWUP_TIME_AMBIGUOUS",
                "Give either in_seconds or at, not both.",
            ))
        }
        (None, None) => {
            return Err(protocol_error(
                "FOLLOWUP_TIME_MISSING",
                "Say when to wake: in_seconds from now, or at an RFC 3339 instant.",
            ))
        }
        (Some(seconds), None) => {
            if seconds > FOLLOWUP_MAX_SECONDS {
                return Err(protocol_error(
                    "FOLLOWUP_TOO_FAR",
                    format!(
                        "A follow-up may be at most {} days out.",
                        FOLLOWUP_MAX_SECONDS / 86_400
                    ),
                ));
            }
            now + Duration::seconds(seconds.max(FOLLOWUP_MIN_SECONDS) as i64)
        }
        (None, Some(at)) => {
            let normalized = schedule::normalize_once_input(at).map_err(argmax_protocol_error)?;
            let parsed = DateTime::parse_from_rfc3339(&normalized)
                .map_err(|error| protocol_error("FOLLOWUP_TIME_INVALID", error.to_string()))?
                .with_timezone(&Utc);
            let floor = now + Duration::seconds(FOLLOWUP_MIN_SECONDS as i64);
            if parsed > now + Duration::seconds(FOLLOWUP_MAX_SECONDS as i64) {
                return Err(protocol_error(
                    "FOLLOWUP_TOO_FAR",
                    format!(
                        "A follow-up may be at most {} days out.",
                        FOLLOWUP_MAX_SECONDS / 86_400
                    ),
                ));
            }
            parsed.max(floor)
        }
    };
    Ok(schedule::format_rfc3339(at))
}

/// Which project a memory action is filed under: the named one, or the
/// project of the caller's own workspace.
fn target_project(
    database: &Database,
    parent: &ParentLaunchSettings,
    selector: Option<&str>,
) -> Result<String, SessionControlError> {
    let own = resolve_session_workspace(database, &parent.session_id, None)?;
    if selector.is_none() {
        return Ok(own.project.id);
    }
    let connection = database.read_connection();
    let projects = list_projects(&connection).map_err(argmax_protocol_error)?;
    Ok(resolve_project(&projects, selector, &own.project.id)?.id)
}

fn learning_record(learning: Learning) -> LearningRecord {
    LearningRecord {
        id: learning.id,
        project_id: learning.project_id,
        kind: learning.kind,
        summary: learning.summary,
        verified: learning.verified,
        hits: learning.hits,
        created_at: learning.created_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(in_seconds: Option<u64>, at: Option<&str>) -> ScheduleFollowupAction {
        ScheduleFollowupAction {
            prompt: "Check the CI run".to_string(),
            in_seconds,
            at: at.map(str::to_string),
            name: None,
        }
    }

    #[test]
    fn a_followup_never_lands_sooner_than_the_scheduler_ticks() {
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        // Asked for five seconds, and for a moment already past: both are
        // held to the tick, because a wake can be late but never early.
        assert_eq!(
            followup_time(&action(Some(5), None), now).unwrap(),
            "2026-01-01T00:00:30.000Z"
        );
        assert_eq!(
            followup_time(&action(None, Some("2025-12-31T23:00:00Z")), now).unwrap(),
            "2026-01-01T00:00:30.000Z"
        );
        assert_eq!(
            followup_time(&action(Some(600), None), now).unwrap(),
            "2026-01-01T00:10:00.000Z"
        );
    }

    #[test]
    fn a_followup_refuses_two_times_no_time_and_a_far_one() {
        let now = Utc::now();
        assert_eq!(
            followup_time(&action(Some(60), Some("2026-01-01T00:00:00Z")), now)
                .unwrap_err()
                .code,
            "FOLLOWUP_TIME_AMBIGUOUS"
        );
        assert_eq!(
            followup_time(&action(None, None), now).unwrap_err().code,
            "FOLLOWUP_TIME_MISSING"
        );
        assert_eq!(
            followup_time(&action(Some(FOLLOWUP_MAX_SECONDS + 1), None), now)
                .unwrap_err()
                .code,
            "FOLLOWUP_TOO_FAR"
        );
        assert_eq!(
            followup_time(&action(None, Some("not-a-time")), now)
                .unwrap_err()
                .code,
            "SCHEDULE_INVALID"
        );
    }
}
