//! `arc_status`: what the caller's own Arc looks like right now. Every other
//! Arc action (create, update, launch a coordinator) is a desktop IPC channel
//! — this is the one piece an agent needs and cannot get any other way, since
//! it is scoped to "my Arc" rather than any Arc by id.

use std::sync::Arc;

use super::super::{
    protocol::{
        ArcStatusLimits, ArcStatusMember, ArcStatusOutcome, SessionControlError,
        SessionControlResponse, SessionControlResult,
    },
    protocol_error,
    registry::ParentLaunchSettings,
    ARC_MAX_ACTIVE_MEMBERS, ARC_MAX_LAUNCHES_PER_DAY, ARC_STATUS_BRIEF_CHARS,
    ARC_STATUS_MEMBER_LIMIT,
};
use crate::persistence::{
    arcs, database::Database, gh::list_session_prs, sessions::find_session_by_id, time::hours_ago,
};

pub(super) fn arc_status(
    parent: ParentLaunchSettings,
    database: Arc<Database>,
) -> Result<SessionControlResponse, SessionControlError> {
    let connection = database.connection();
    let session = find_session_by_id(&connection, &parent.session_id)
        .map_err(|error| protocol_error("ARC_STATUS_FAILED", error.to_string()))?;
    let Some(arc_id) = session.arc_id else {
        return Err(protocol_error(
            "NOT_IN_ARC",
            "This session is not attached to an Arc.",
        ));
    };
    let arc = arcs::get_arc(&connection, &arc_id)
        .map_err(|error| protocol_error("ARC_STATUS_FAILED", error.to_string()))?;
    let all_members = arcs::list_members(&connection, &arc_id)
        .map_err(|error| protocol_error("ARC_STATUS_FAILED", error.to_string()))?;
    let truncated = all_members.len() > ARC_STATUS_MEMBER_LIMIT;
    let members = all_members
        .into_iter()
        .take(ARC_STATUS_MEMBER_LIMIT)
        .map(|member| {
            let primary_pr = list_session_prs(&connection, &member.session_id)
                .unwrap_or_default()
                .into_iter()
                .find(|pr| pr.is_primary);
            ArcStatusMember {
                session_id: member.session_id,
                task_label: member.task_label,
                project_name: member.project_name,
                state: member.state,
                pr_number: primary_pr.as_ref().map(|pr| pr.pr_number),
                pr_state: primary_pr.and_then(|pr| pr.pr_state),
            }
        })
        .collect();
    let launches_last_24h = arcs::count_launches_since(&connection, &arc_id, &hours_ago(24))
        .map_err(|error| protocol_error("ARC_STATUS_FAILED", error.to_string()))?;
    let brief_truncated = arc.brief.chars().count() > ARC_STATUS_BRIEF_CHARS;
    let brief = arc.brief.chars().take(ARC_STATUS_BRIEF_CHARS).collect();

    Ok(SessionControlResponse::new(
        SessionControlResult::ArcStatus(ArcStatusOutcome {
            arc_id: arc.id,
            name: arc.name,
            state: arc.state,
            dir: arc.dir,
            brief,
            brief_truncated,
            caller_is_coordinator: arc.coordinator_session_id.as_deref()
                == Some(parent.session_id.as_str()),
            coordinator_session_id: arc.coordinator_session_id,
            members,
            truncated,
            launches_last_24h,
            limits: ArcStatusLimits {
                max_active_members: ARC_MAX_ACTIVE_MEMBERS,
                max_launches_per_day: ARC_MAX_LAUNCHES_PER_DAY,
            },
        }),
    ))
}
