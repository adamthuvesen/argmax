//! Launching an Arc's coordinator: an ordinary, disposable session that plans
//! and delegates for the Arc, named by `arcs.coordinator_session_id`.
//!
//! The coordinator is not a special kind of session — it runs through the
//! same [`crate::session_control::launch_with_spec`] tail every other launch
//! does, in the home project's shared checkout (not a worktree, so its
//! members can find the same tree the person is looking at), with no launcher
//! of its own and `launch_depth` left at its default of 0: it is a top-level
//! chat, not something this call itself launched. "Plans and delegates, never
//! codes" is the [`preamble`] it starts with, not a permission — see
//! `docs/agent-tools.md`'s Arcs section for the caps and inheritance rules
//! that make the rest of the Arc's sessions work the same way.

pub mod preamble;

pub use preamble::{coordinator_preamble, member_preamble, promoted_coordinator_preamble};

use std::sync::Arc as StdArc;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::arc_events::{record_arc_event, ArcEventKind, NewArcEvent};
use crate::persistence::arcs::{self, ArcRecord, ArcState};
use crate::persistence::sessions::{find_session_by_id, record_session_arc};
use crate::persistence::workspaces::find_workspace_by_id;
use crate::persistence::Database;
use crate::providers::session_service::ProviderSessionService;
use crate::session_control::{launch_with_spec, LaunchSpec};
use crate::sessions::state::SessionState;
use crate::workspaces::orchestration::WorkspaceService;

pub struct LaunchCoordinatorRequest {
    pub arc_id: String,
    pub provider: crate::providers::ProviderId,
    pub model_label: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<crate::providers::ReasoningEffort>,
    /// Resolved by the caller the same way every other launch path resolves
    /// it — the user's default-agent permission choice for this provider —
    /// since this module has no app data dir of its own to read it from.
    pub permission_mode: crate::providers::PermissionMode,
}

/// Launch (or relaunch) this Arc's coordinator and point the Arc at it.
///
/// A previous coordinator, if any, is left exactly as it is: its own
/// `arc_id` and transcript are untouched, and it is not stopped. The Arc's
/// pointer simply moves to the new session, which is how a person restarts a
/// coordinator that stalled or was closed without losing the old chat.
pub async fn launch_coordinator(
    request: LaunchCoordinatorRequest,
    database: StdArc<Database>,
    workspaces: StdArc<WorkspaceService>,
    providers: StdArc<ProviderSessionService>,
) -> ArgmaxResult<ArcRecord> {
    let arc = {
        let connection = database.connection();
        arcs::get_arc(&connection, &request.arc_id)?
    };
    if arc.state == ArcState::Done {
        return Err(ArgmaxError::service(
            "ARC_DONE",
            "This Arc is done. Set it back to active or paused before launching a coordinator.",
        ));
    }

    let defaults = crate::provider_defaults(request.provider.as_str());
    let model_label = request
        .model_label
        .clone()
        .unwrap_or_else(|| defaults.model_label.to_string());
    let model_id = request
        .model_id
        .clone()
        .unwrap_or_else(|| defaults.model_id.to_string());
    let reasoning_effort = request
        .reasoning_effort
        .or_else(|| parse_reasoning_effort(defaults.reasoning_effort));

    let outcome = launch_with_spec(
        LaunchSpec {
            project: Some(arc.home_project_id.clone()),
            // The home project's own checkout, shared rather than isolated:
            // the coordinator's members work in the same tree a person
            // looking at this Arc would open.
            alongside: None,
            path: None,
            branch: None,
            prompt: coordinator_preamble(&arc),
            worktree: false,
            provider: request.provider,
            model_label,
            model_id,
            reasoning_effort,
            fast_mode: false,
            permission_mode: request.permission_mode,
            agent_mode: crate::providers::AgentMode::Auto,
            task_label: Some(format!("{} · coordinator", arc.name)),
            // Checked and attached inside the launch's own write transaction
            // (see `ProviderSessionService::launch`): `ARC_DONE` still
            // applies to the coordinator launching itself, but the
            // active-member and daily-launch-budget caps do not — it plans
            // and delegates, it does not occupy a slot in the work it is
            // delegating.
            arc_id: Some(arc.id.clone()),
            arc_is_coordinator_launch: true,
        },
        StdArc::clone(&database),
        workspaces,
        providers,
        &arc.home_project_id,
    )
    .await
    // The launch path speaks the socket protocol's error shape; carry its
    // code through so a failure reads the same here as it does to an agent.
    .map_err(|error| ArgmaxError::service(error.code, error.message))?;

    let connection = database.connection();
    // No `record_session_launch`: the coordinator has no launcher, and
    // `launch_depth` stays at its default of 0 — it is a top-level chat.
    // `sessions.arc_id` is already set: the launch transaction attached it
    // alongside the session insert.
    let updated =
        arcs::set_arc_coordinator_session(&connection, &arc.id, Some(&outcome.session_id))?;
    let title = if arc.coordinator_session_id.is_some() {
        "Coordinator replaced"
    } else {
        "Coordinator started"
    };
    let mut event = NewArcEvent::new(
        format!("coordinator:{}", outcome.session_id),
        &arc.id,
        ArcEventKind::CoordinatorStarted,
        title,
    );
    event.session_id = Some(&outcome.session_id);
    event.project_id = Some(&arc.home_project_id);
    record_arc_event(&connection, &event)?;
    Ok(updated)
}

fn parse_reasoning_effort(value: Option<&str>) -> Option<crate::providers::ReasoningEffort> {
    serde_json::from_value(serde_json::json!(value?)).ok()
}

pub struct PromoteSessionRequest {
    pub session_id: String,
    pub name: String,
    pub brief: String,
    pub dir: Option<String>,
}

/// How many sessions a promoted chat launched earlier come along with it.
/// The same number as the active-member cap, so adoption can never start an
/// Arc over its own limit.
const MAX_ADOPTED_MEMBERS: i64 = arcs::ARC_MAX_ACTIVE_MEMBERS;

/// Start an Arc from an existing chat, which becomes its coordinator.
///
/// One write transaction creates the Arc in the chat's project, points it at
/// the chat, and brings along the sessions the chat already launched (their
/// PRs are part of the work). Then the chat is told its new role through the
/// same notice path PR events use, since no provider can change a running
/// conversation's instructions any other way.
pub async fn promote_session(
    request: PromoteSessionRequest,
    app_data_dir: &std::path::Path,
    database: StdArc<Database>,
    providers: StdArc<ProviderSessionService>,
) -> ArgmaxResult<ArcRecord> {
    let (arc, adopted) = {
        let mut connection = database.connection();
        let transaction = connection
            .transaction()
            .map_err(crate::persistence::sqlite_error)?;
        let session = find_session_by_id(&transaction, &request.session_id)?;
        if session.arc_id.is_some() {
            return Err(ArgmaxError::service(
                "ARC_SESSION_IN_ARC",
                "This chat already belongs to an arc.",
            ));
        }
        if matches!(
            session.state,
            SessionState::Created | SessionState::Running | SessionState::Blocked
        ) {
            return Err(ArgmaxError::service(
                "ARC_SESSION_BUSY",
                "Wait for this chat's turn to finish before starting an arc from it.",
            ));
        }
        let workspace = find_workspace_by_id(&transaction, &session.workspace_id)?;
        if matches!(
            workspace.state.as_str(),
            "archiving" | "archive-failed" | "archived"
        ) {
            return Err(ArgmaxError::service(
                "ARC_SESSION_ARCHIVED",
                "This chat's workspace is archived, so it cannot coordinate an arc.",
            ));
        }

        let created = arcs::create_arc(
            &transaction,
            app_data_dir,
            &arcs::ArcCreateInput {
                name: request.name,
                brief: request.brief,
                home_project_id: workspace.project_id.clone(),
                dir: request.dir,
            },
        )?;
        record_session_arc(&transaction, &session.id, &created.id)?;
        let arc = arcs::set_arc_coordinator_session(&transaction, &created.id, Some(&session.id))?;
        let mut started = NewArcEvent::new(
            format!("coordinator:{}", session.id),
            &arc.id,
            ArcEventKind::CoordinatorStarted,
            "Started from an existing chat",
        );
        started.session_id = Some(&session.id);
        started.project_id = Some(&workspace.project_id);
        record_arc_event(&transaction, &started)?;

        let children = adoptable_children(&transaction, &session.id)?;
        for (child_id, project_id, label) in &children {
            record_session_arc(&transaction, child_id, &arc.id)?;
            let mut event = NewArcEvent::new(
                format!("launched:{child_id}"),
                &arc.id,
                ArcEventKind::MemberLaunched,
                if label.trim().is_empty() {
                    "Member chat"
                } else {
                    label.trim()
                },
            );
            event.session_id = Some(child_id);
            event.project_id = Some(project_id);
            event.status = Some("adopted".to_string());
            record_arc_event(&transaction, &event)?;
        }
        transaction
            .commit()
            .map_err(crate::persistence::sqlite_error)?;
        (arc, children.len())
    };

    providers
        .send_system_notice(
            format!("arc:{}:promoted", arc.id),
            &request.session_id,
            request.session_id.clone(),
            arc.name.clone(),
            promoted_coordinator_preamble(&arc, adopted),
        )
        .await
        .map_err(|error| {
            ArgmaxError::service(
                "ARC_PROMOTE_NOTICE_FAILED",
                format!(
                    "The arc was created, but this chat could not be told it is now the coordinator: {error}"
                ),
            )
        })?;
    Ok(arc)
}

/// The sessions a chat launched directly whose workspace is still around,
/// newest first, capped. Returns `(session id, project id, task label)`.
pub fn adoptable_children(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<(String, String, String)>> {
    connection
        .prepare_cached(
            r#"
            SELECT sessions.id, workspaces.project_id, workspaces.task_label
            FROM sessions
            JOIN workspaces ON workspaces.id = sessions.workspace_id
            WHERE sessions.launched_by_session_id = ?1
              AND sessions.arc_id IS NULL
              AND workspaces.state NOT IN ('archiving', 'archive-failed', 'archived')
            ORDER BY sessions.started_at DESC, sessions.id DESC
            LIMIT ?2
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?
        .query_map((session_id, MAX_ADOPTED_MEMBERS), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(crate::persistence::sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::persistence::sqlite_error)
}
