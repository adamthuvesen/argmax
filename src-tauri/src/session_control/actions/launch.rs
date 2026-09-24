use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};

use chrono::{Duration, Utc};

use super::super::{
    argmax_protocol_error, invalid_input_error,
    protocol::{
        LaunchAction, LaunchedSession, SessionControlError, SessionControlResponse,
        SessionControlResult,
    },
    protocol_error,
    registry::ParentLaunchSettings,
    MAX_LAUNCHES_PER_SESSION, MAX_LAUNCH_DEPTH,
};
use super::{
    project_tools::{schedule_same_session_wake, SameSessionWake},
    resolve_or_register_project, task_label, terminal_cols, terminal_rows,
};
use crate::{
    arcs::member_preamble,
    ipc::{
        inputs::{
            ProvidersLaunchInput, WorkspacesArchiveInput, WorkspacesCreateCurrentInput,
            WorkspacesCreateIsolatedInput,
        },
        validation::{BaseRef, NonEmptyString, ProjectId, Prompt, TaskLabel, WorkspaceId},
    },
    persistence::{
        arcs::{self, ArcRecord},
        database::Database,
        sessions::{
            find_session_by_id, record_session_launch, session_launch_lineage, LAUNCH_KIND_AGENT,
        },
        workspaces::find_workspace_by_id,
    },
    providers::session_service::ProviderSessionService,
    util::sync::LockOrRecover,
    workspaces::{
        orchestration::{resolve_registered_checkout, WorkspacesCreateAlongsideInput},
        WorkspaceService,
    },
};

/// One lock per budget, held from the launch caps check until the launch is
/// recorded. The caps are read before the launch and only counted once it
/// lands, with awaits between, so concurrent `session_launch` calls would
/// otherwise all pass the same check. An Arc's budget is shared by every
/// member, so a parent in an Arc takes the Arc's lock; any other parent takes
/// its own. Entries are never removed: one small lock per key that ever
/// launched, like the gh refresh locks.
static LAUNCH_BUDGET_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn launch_budget_lock(key: String) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = LAUNCH_BUDGET_LOCKS.lock_or_recover("launch budget locks");
    Arc::clone(locks.entry(key).or_default())
}

/// Everything needed to launch a top-level session. The session-launch
/// socket derives it from a parent session's settings; the scheduled-task
/// scheduler derives it from a stored routine row.
pub(crate) struct LaunchSpec {
    pub project: Option<String>,
    /// Run in an existing checkout rather than the project's own. A multitask
    /// shares the checkout of the chat that dispatched it, which is not the
    /// project root whenever that chat is itself in a worktree. Ignored when
    /// `worktree` is set, which asks for an isolated tree by definition.
    pub alongside: Option<AlongsideCheckout>,
    /// Existing checkout of the target project, from `git worktree list`.
    /// Mutually exclusive with `worktree`. Ignored when `alongside` is set.
    pub path: Option<String>,
    /// Git ref the new session should work from. With `worktree`, the isolated
    /// worktree forks from this ref. With `path`, the checkout must already be
    /// on this branch. Never switches another checkout's branch by itself.
    pub branch: Option<String>,
    pub prompt: String,
    pub worktree: bool,
    pub provider: crate::providers::ProviderId,
    pub model_label: String,
    pub model_id: String,
    pub reasoning_effort: Option<crate::providers::ReasoningEffort>,
    pub fast_mode: bool,
    pub permission_mode: crate::providers::PermissionMode,
    pub agent_mode: crate::providers::AgentMode,
    /// Sidebar label for the new workspace. Falls back to the prompt's first
    /// line, which is what every launch used before agents could name one.
    pub task_label: Option<String>,
    /// The Arc this session is attached to. Checked against the Arc's caps
    /// and attached to the session row inside the same write transaction as
    /// the insert (see `ProviderSessionService::launch`), rather than by a
    /// follow-up update once this call returns — closing the race where two
    /// concurrent launches could each pass the cap check before either
    /// session existed to count against it.
    pub arc_id: Option<String>,
    /// True only for the coordinator launching itself: `ARC_DONE` still
    /// applies, but the active-member and daily-launch-budget caps do not —
    /// the coordinator plans and delegates, it does not occupy a slot in the
    /// work it is delegating.
    pub arc_is_coordinator_launch: bool,
}

/// The checkout a session is asked to run beside, taken from the workspace of
/// the chat it was dispatched from.
pub(crate) struct AlongsideCheckout {
    pub path: String,
    pub branch: String,
    pub base_ref: String,
}

pub(crate) struct LaunchOutcome {
    pub session_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
    pub path: String,
    pub branch: String,
}

/// Resolve the project, create the workspace, and launch the provider —
/// the shared tail of every programmatic session launch.
pub(crate) async fn launch_with_spec(
    spec: LaunchSpec,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    fallback_project_id: &str,
) -> Result<LaunchOutcome, SessionControlError> {
    let prompt = Prompt::try_from(spec.prompt).map_err(invalid_input_error)?;
    let label = spec
        .task_label
        .as_deref()
        .map(task_label)
        .unwrap_or_else(|| task_label(prompt.as_str()));
    let task_label = TaskLabel::try_from(label).map_err(invalid_input_error)?;
    let project =
        resolve_or_register_project(&database, spec.project.as_deref(), fallback_project_id)
            .await?;
    let project_id = ProjectId::try_from(project.id.clone()).map_err(invalid_input_error)?;
    let model_label = NonEmptyString::try_from(spec.model_label).map_err(invalid_input_error)?;
    let model_id = NonEmptyString::try_from(spec.model_id).map_err(invalid_input_error)?;
    let cols = terminal_cols(120)?;
    let rows = terminal_rows(32)?;

    if spec.worktree && spec.path.is_some() {
        return Err(protocol_error(
            "LAUNCH_WORKTREE_WITH_PATH",
            "worktree creates a new worktree; path launches into one that exists. Pass only one.",
        ));
    }
    if spec.branch.is_some() && !spec.worktree && spec.path.is_none() {
        return Err(protocol_error(
            "LAUNCH_BRANCH_NEEDS_DESTINATION",
            "Pass worktree to fork an isolated worktree from this branch, or path to a checkout that already has it. Launch will not switch another checkout's branch.",
        ));
    }

    let workspace = if spec.worktree {
        let base_ref = match spec.branch.as_deref() {
            Some(branch) => Some(BaseRef::try_from(branch.to_string()).map_err(invalid_input_error)?),
            None => Some(
                BaseRef::try_from(project.current_branch.clone()).map_err(invalid_input_error)?,
            ),
        };
        workspaces
            .create_isolated(WorkspacesCreateIsolatedInput {
                project_id,
                task_label,
                base_ref,
            })
            .await
    } else if let Some(requested) = spec.path.as_deref() {
        let (path, branch) = resolve_registered_checkout(&project.repo_path, requested)
            .await
            .map_err(argmax_protocol_error)?;
        if let Some(expected) = spec.branch.as_deref() {
            if expected != branch {
                return Err(protocol_error(
                    "LAUNCH_BRANCH_MISMATCH",
                    format!(
                        "{path} is on '{branch}', not '{expected}'. Check out that branch there first, or omit branch to use '{branch}'."
                    ),
                ));
            }
        }
        workspaces.create_alongside(WorkspacesCreateAlongsideInput {
            project_id,
            task_label,
            path,
            branch,
            base_ref: project
                .default_branch
                .clone()
                .unwrap_or_else(|| project.current_branch.clone()),
        })
    } else if let Some(checkout) = spec.alongside {
        // The dispatching chat's own checkout, which is the project root only
        // when that chat is not in a worktree. Taking the project's instead put
        // the work in a different tree on a different branch than the one the
        // person was looking at, while both agents were told they shared it.
        workspaces.create_alongside(WorkspacesCreateAlongsideInput {
            project_id,
            task_label,
            path: checkout.path,
            branch: checkout.branch,
            base_ref: checkout.base_ref,
        })
    } else {
        workspaces.create_current(WorkspacesCreateCurrentInput {
            project_id,
            task_label,
        })
    }
    .map_err(argmax_protocol_error)?;

    let workspace_id = WorkspaceId::try_from(workspace.id.clone()).map_err(invalid_input_error)?;
    let launch_result = providers
        .launch(ProvidersLaunchInput {
            workspace_id,
            provider: spec.provider,
            prompt,
            model_label,
            model_id,
            reasoning_effort: spec.reasoning_effort,
            fast_mode: spec.fast_mode,
            agent_mode: Some(spec.agent_mode),
            permission_mode: Some(spec.permission_mode),
            cols,
            rows,
            attachments: None,
            goal_condition: None,
            goal_max_turns: None,
            arc_id: spec.arc_id,
            arc_is_coordinator_launch: spec.arc_is_coordinator_launch,
        })
        .await;
    let session = match launch_result {
        Ok(session) => session,
        Err(error) => {
            let _ = workspaces
                .archive(WorkspacesArchiveInput {
                    workspace_id: WorkspaceId::try_from(workspace.id.clone())
                        .map_err(invalid_input_error)?,
                    force: Some(false),
                })
                .await;
            return Err(argmax_protocol_error(error));
        }
    };
    Ok(LaunchOutcome {
        session_id: session.id,
        workspace_id: workspace.id,
        project_id: project.id,
        project_name: project.name,
        path: workspace.path,
        branch: workspace.branch,
    })
}

pub(super) async fn launch_session(
    action: LaunchAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
) -> Result<SessionControlResponse, SessionControlError> {
    // Before the workspace, the worktree and the provider process: a bad
    // check-in is worth refusing while nothing has been spent on it.
    let check_in_minutes = check_in_minutes(action.check_in_minutes)?;
    let budget_key = {
        let connection = database.read_connection();
        match find_session_by_id(&connection, &parent.session_id)
            .map_err(argmax_protocol_error)?
            .arc_id
        {
            Some(arc_id) => format!("arc:{arc_id}"),
            None => format!("session:{}", parent.session_id),
        }
    };
    let launch_budget_lock = launch_budget_lock(budget_key);
    let launch_budget_turn = launch_budget_lock.lock().await;
    let (parent_project_id, lineage, parent_arc) = {
        let connection = database.connection();
        let parent_session =
            find_session_by_id(&connection, &parent.session_id).map_err(argmax_protocol_error)?;
        let project_id = find_workspace_by_id(&connection, &parent_session.workspace_id)
            .map_err(argmax_protocol_error)?
            .project_id;
        let lineage = session_launch_lineage(&connection, &parent.session_id)
            .map_err(argmax_protocol_error)?;
        let parent_arc = match parent_session.arc_id.as_deref() {
            Some(arc_id) => {
                Some(arcs::get_arc(&connection, arc_id).map_err(argmax_protocol_error)?)
            }
            None => None,
        };
        (project_id, lineage, parent_arc)
    };
    let depth = lineage.depth + 1;
    if depth > MAX_LAUNCH_DEPTH {
        return Err(protocol_error(
            "LAUNCH_DEPTH_EXCEEDED",
            format!(
                "Launched sessions may go {MAX_LAUNCH_DEPTH} levels deep and this session is already at {}. Do the work here, or message a session nearer the top to launch it.",
                lineage.depth
            ),
        ));
    }
    // The Arc's current coordinator plans and delegates for the whole Arc, so
    // its own lifetime launch count would otherwise starve it after ten
    // pieces of work. Every other session, coordinator or not, still counts.
    let is_current_coordinator = parent_arc.as_ref().is_some_and(|arc| {
        arc.coordinator_session_id.as_deref() == Some(parent.session_id.as_str())
    });
    if !is_current_coordinator && lineage.launched >= MAX_LAUNCHES_PER_SESSION {
        return Err(protocol_error(
            "LAUNCH_LIMIT_REACHED",
            format!(
                "This session has already launched {MAX_LAUNCHES_PER_SESSION} sessions, which is the per-session cap. Message one of them instead."
            ),
        ));
    }
    if let Some(arc) = &parent_arc {
        check_arc_launch_budget(arc, &database)?;
    }
    let provider = action.provider.unwrap_or(parent.provider);
    // A model id names a model the CLI accepts; Rust has no label catalog
    // (labels live in `src/shared/providerModels.ts`), so an explicit id is
    // its own sidebar label — the same fallback session sync uses.
    let (model_label, model_id, reasoning_effort) =
        match (action.model, provider == parent.provider) {
            (Some(model), _) => (model.clone(), model, provider_effort(provider, &parent)),
            (None, true) => (
                parent.model_label.clone(),
                parent.model_id.clone(),
                parent.reasoning_effort,
            ),
            (None, false) => {
                let defaults = crate::provider_defaults(provider.as_str());
                (
                    defaults.model_label.to_string(),
                    defaults.model_id.to_string(),
                    parse_reasoning_effort(defaults.reasoning_effort),
                )
            }
        };
    // The sidebar label the new session is about to get, read here as well so
    // a check-in wake can name the work rather than quote its whole prompt.
    let label = action
        .task_label
        .as_deref()
        .map(task_label)
        .unwrap_or_else(|| task_label(&action.prompt));
    // A session launched from inside an Arc carries the Arc's member
    // preamble: the folder to read before starting, and the "do not write
    // there" rule that keeps the coordinator the only writer.
    let prompt = match &parent_arc {
        Some(arc) => format!("{}\n\n{}", member_preamble(arc), action.prompt),
        None => action.prompt,
    };
    let outcome = launch_with_spec(
        LaunchSpec {
            // An agent-launched session is its own piece of work, not a chat
            // running beside this one: it takes the project's checkout, or its
            // own worktree.
            alongside: None,
            project: action.project,
            path: action.path,
            branch: action.branch,
            prompt,
            worktree: action.worktree,
            provider,
            model_label,
            model_id,
            // An explicit effort wins over whatever the model choice implied,
            // so `reasoning` means the same thing whether or not `model` was
            // named alongside it.
            reasoning_effort: action.reasoning.or(reasoning_effort),
            fast_mode: parent.fast_mode,
            permission_mode: action.permission_mode.unwrap_or(parent.permission_mode),
            agent_mode: parent.agent_mode,
            task_label: action.task_label,
            arc_id: parent_arc.as_ref().map(|arc| arc.id.clone()),
            arc_is_coordinator_launch: false,
        },
        Arc::clone(&database),
        workspaces,
        providers,
        &parent_project_id,
    )
    .await?;
    {
        let connection = database.connection();
        record_session_launch(
            &connection,
            &outcome.session_id,
            &parent.session_id,
            depth,
            LAUNCH_KIND_AGENT,
        )
        .map_err(argmax_protocol_error)?;
    }
    drop(launch_budget_turn);
    if let Some(minutes) = check_in_minutes {
        schedule_check_in(
            &database,
            &parent,
            &parent_project_id,
            &outcome.session_id,
            &label,
            minutes,
        )?;
    }
    Ok(SessionControlResponse::new(SessionControlResult::Launched(
        LaunchedSession {
            session_id: outcome.session_id,
            workspace_id: outcome.workspace_id,
            project_id: outcome.project_id,
            project_name: outcome.project_name,
            path: outcome.path,
            branch: outcome.branch,
        },
    )))
}

/// A check-in may land no sooner than the next minute and no further out than
/// a day: past that the launched session has either finished — dropping the
/// wake — or is stuck in a way a calendar reminder will not rescue.
const CHECK_IN_MAX_MINUTES: u32 = 24 * 60;

/// The check-in delay a launch asked for, refused rather than clamped: a
/// caller that wrote 0 or 2000 meant something the wake cannot deliver, and
/// silently rounding it would wake the chat at a time nobody chose.
fn check_in_minutes(requested: Option<u32>) -> Result<Option<u32>, SessionControlError> {
    let Some(minutes) = requested else {
        return Ok(None);
    };
    if minutes == 0 || minutes > CHECK_IN_MAX_MINUTES {
        return Err(protocol_error(
            "CHECK_IN_OUT_OF_RANGE",
            format!(
                "check_in_minutes is 1 to {CHECK_IN_MAX_MINUTES} minutes; {minutes} is outside it. Omit it for no check-in."
            ),
        ));
    }
    Ok(Some(minutes))
}

/// The routine id a check-in takes. Deterministic on the launched session, so
/// the completion notice can drop the wake knowing only the session that
/// finished, and a re-launch can never leave two wakes for one session.
pub(crate) fn check_in_routine_id(session_id: &str) -> String {
    format!("check-in:{session_id}")
}

/// Wake the launcher if the session it just started has not reported back.
/// A launch into the scratch project has no repository to wake up in, so the
/// wake is skipped rather than refused — the session itself launched fine,
/// and failing the call now would leave it running with nothing said.
fn schedule_check_in(
    database: &Database,
    parent: &ParentLaunchSettings,
    parent_project_id: &str,
    launched_session_id: &str,
    label: &str,
    minutes: u32,
) -> Result<(), SessionControlError> {
    if parent_project_id == crate::workspaces::SCRATCH_PROJECT_ID {
        tracing::info!(
            session_id = launched_session_id,
            "a side chat has no repository to hold a check-in; skipping the wake"
        );
        return Ok(());
    }
    let id = check_in_routine_id(launched_session_id);
    let run_at = crate::routines::schedule::format_rfc3339(
        Utc::now() + Duration::minutes(i64::from(minutes)),
    );
    schedule_same_session_wake(
        database,
        parent,
        SameSessionWake {
            id: id.clone(),
            name: task_label(&format!("Check in: {label}")),
            project_id: parent_project_id.to_string(),
            prompt: format!(
                "Check-in: session {launched_session_id} (\"{label}\") was launched {minutes} minutes ago and has not reported finishing. Read its state with session_status, its latest answer with session_read, and decide: wait longer, steer it with session_message, or stop it. Argmax drops this wake when the session finishes, so it fired because the session is still running or stalled."
            ),
            run_at: run_at.clone(),
        },
    )?;
    tracing::info!(routine_id = %id, run_at = %run_at, "scheduled a launch check-in");
    Ok(())
}

/// The fast-path rejection: the same three Arc-scoped refusals
/// `ProviderSessionService::launch` checks again inside its write
/// transaction, run here first so the common (non-racing) case fails before
/// this call pays for a workspace/worktree it would only have to archive.
/// This copy is not itself race-safe — two concurrent launches can both pass
/// it — which is exactly why the transactional check is the one that counts;
/// see `arcs::check_launch_caps`.
fn check_arc_launch_budget(
    arc: &ArcRecord,
    database: &Database,
) -> Result<(), SessionControlError> {
    let connection = database.connection();
    arcs::check_launch_caps(&connection, &arc.id, false).map_err(argmax_protocol_error)
}

/// The effort to carry onto an explicitly named model: the caller's own when
/// it stays on its provider, that provider's default otherwise.
fn provider_effort(
    provider: crate::providers::ProviderId,
    parent: &ParentLaunchSettings,
) -> Option<crate::providers::ReasoningEffort> {
    if provider == parent.provider {
        return parent.reasoning_effort;
    }
    parse_reasoning_effort(crate::provider_defaults(provider.as_str()).reasoning_effort)
}

fn parse_reasoning_effort(value: Option<&str>) -> Option<crate::providers::ReasoningEffort> {
    serde_json::from_value(serde_json::json!(value?)).ok()
}
