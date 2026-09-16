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

pub use preamble::{coordinator_preamble, member_preamble};

use std::sync::Arc as StdArc;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::arcs::{self, ArcRecord, ArcState};
use crate::persistence::Database;
use crate::providers::session_service::ProviderSessionService;
use crate::session_control::{launch_with_spec, LaunchSpec};
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
    arcs::set_arc_coordinator_session(&connection, &arc.id, Some(&outcome.session_id))
}

fn parse_reasoning_effort(value: Option<&str>) -> Option<crate::providers::ReasoningEffort> {
    serde_json::from_value(serde_json::json!(value?)).ok()
}
