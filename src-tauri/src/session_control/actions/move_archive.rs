use std::sync::Arc;

use tokio::sync::oneshot;
use uuid::Uuid;

use super::super::{
    argmax_protocol_error, invalid_input_error,
    protocol::{
        ArchiveAction, MoveAction, ScheduledArchive, ScheduledMove, SessionControlError,
        SessionControlResponse, SessionControlResult,
    },
    protocol_error,
    registry::{AfterTurn, ParentLaunchSettings, SessionLaunchRegistry},
    MAX_CONTINUED_MOVES,
};
use super::resolve_project;
use crate::{
    error::ArgmaxError,
    ipc::{
        inputs::{ProvidersSendInput, WorkspacesArchiveInput},
        validation::{Prompt, SessionId, WorkspaceId},
    },
    persistence::{
        after_turn::{AfterTurnAction, ArchiveRequest, MoveDestinationRecord, MoveRequest},
        database::Database,
        events::{count_move_arrivals, persist_timeline_event, PersistTimelineEventInput},
        projects::list_projects,
        sessions::find_session_by_id,
        workspaces::find_workspace_by_id,
    },
    providers::session_service::ProviderSessionService,
    workspaces::{orchestration::MoveDestination, WorkspaceService},
};

/// Archive the caller's own workspace once its turn settles.
///
/// Scheduled rather than immediate for the same reason a move is: archiving
/// terminates every provider process in the workspace, and the agent asking
/// for it is one of them. Run inline, the tool call would kill the caller
/// before it could write its report — and the report is usually the point
/// (`ship`'s babysit hands one back after it lands a PR).
///
/// Never forced. A dirty checkout comes to rest as `kept` instead, which is
/// the existing answer to "archive refused because there is work here" and the
/// only safe one when an agent is the one asking.
pub(super) async fn schedule_workspace_archive(
    _action: ArchiveAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) -> Result<SessionControlResponse, SessionControlError> {
    let (session, workspace) = {
        let connection = database.connection();
        let session =
            find_session_by_id(&connection, &parent.session_id).map_err(argmax_protocol_error)?;
        let workspace = find_workspace_by_id(&connection, &session.workspace_id)
            .map_err(argmax_protocol_error)?;
        (session, workspace)
    };
    if workspace.state == "archived" {
        return Err(protocol_error(
            "WORKSPACE_ALREADY_ARCHIVED",
            "This workspace is already archived.",
        ));
    }

    // Validated here rather than inside the spawned task: the task runs after
    // the reply is gone, with nowhere to report a malformed id.
    WorkspaceId::try_from(workspace.id.clone()).map_err(invalid_input_error)?;
    let scheduled = AfterTurnAction::Archive(ArchiveRequest {
        workspace_id: workspace.id.clone(),
    });

    let (settled_tx, settled_rx) = oneshot::channel();
    registry.schedule_after_turn(&parent.session_id, &scheduled, settled_tx)?;
    if let Err(error) =
        providers.ensure_after_turn_schedulable(&parent.session_id, AfterTurn::Archive)
    {
        registry.cancel_after_turn(&parent.session_id);
        return Err(argmax_protocol_error(error));
    }

    let requested_event = {
        let connection = database.connection();
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: parent.session_id.clone(),
                r#type: "session.archive-requested".to_string(),
                message: if !workspace.shared_workspace {
                    "Archive scheduled: the checkout and its branch will be retained in the archive location when this turn ends."
                        .to_string()
                } else {
                    "Archive scheduled for the end of this turn.".to_string()
                },
                payload: serde_json::json!({
                    "workspaceId": workspace.id,
                    "retainsWorktree": true,
                }),
                created_at: None,
            },
        )
    };
    let requested_event = match requested_event {
        Ok(event) => event,
        Err(error) => {
            registry.cancel_after_turn(&parent.session_id);
            return Err(argmax_protocol_error(error));
        }
    };
    workspaces.publish_session_with_events(session, vec![requested_event]);

    let session_id = parent.session_id.clone();
    let workspace_id = workspace.id.clone();
    tauri::async_runtime::spawn(async move {
        if settled_rx.await.is_err() {
            // Nothing to clean up. The sender only goes away with the entry
            // that holds it, which is either a cancel that has already
            // cleared the row or the registry going down with the app — and
            // a promise made to the user has to survive that second one.
            return;
        }
        run_after_turn(
            scheduled, session_id, database, workspaces, providers, registry,
        )
        .await;
    });

    Ok(SessionControlResponse::new(
        SessionControlResult::Archiving(ScheduledArchive {
            scheduled: true,
            session_id: parent.session_id,
            workspace_id,
        }),
    ))
}

pub(super) async fn schedule_session_move(
    action: MoveAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) -> Result<SessionControlResponse, SessionControlError> {
    // Validated before anything is scheduled: a move whose continuation could
    // never be delivered would strand the chat in the destination. Trimmed
    // first — `Prompt` allows whitespace, but a blank turn is dropped on the
    // way to the provider, which is the same dead end.
    let continuation =
        Prompt::try_from(action.prompt.trim().to_string()).map_err(invalid_input_error)?;
    // Exactly one destination. Both, or neither, is a caller mistake worth
    // naming rather than silently preferring one.
    let checkout_path = match (action.project.as_deref(), action.path.as_deref()) {
        (Some(_), Some(_)) => {
            return Err(protocol_error(
                "MOVE_DESTINATION_AMBIGUOUS",
                "Pass either project or path, not both.",
            ))
        }
        (None, None) => {
            return Err(protocol_error(
                "MOVE_DESTINATION_MISSING",
                "Pass the project to move to, or the path of a checkout of this project.",
            ))
        }
        (None, Some(path)) => {
            if action.worktree {
                return Err(protocol_error(
                    "MOVE_WORKTREE_WITH_PATH",
                    "worktree creates a new worktree; path moves into one that exists. Pass only one.",
                ));
            }
            Some(path.to_string())
        }
        (Some(_), None) => None,
    };
    let (source_session, source_workspace, destination) = {
        let connection = database.connection();
        let source_session =
            find_session_by_id(&connection, &parent.session_id).map_err(argmax_protocol_error)?;
        let source_workspace = find_workspace_by_id(&connection, &source_session.workspace_id)
            .map_err(argmax_protocol_error)?;
        if checkout_path.is_some() && source_workspace.kind != "git" {
            return Err(protocol_error(
                "MOVE_PATH_WITHOUT_REPO",
                "This chat has no repository, so it has no checkouts to move between.",
            ));
        }
        let projects = list_projects(&connection).map_err(argmax_protocol_error)?;
        // A checkout move stays in the project it is already in, which is what
        // `resolve_project` returns for a `None` selector.
        let destination = resolve_project(
            &projects,
            action.project.as_deref(),
            &source_workspace.project_id,
        )?;
        (source_session, source_workspace, destination)
    };
    if checkout_path.is_none() && destination.id == source_workspace.project_id {
        return Err(protocol_error(
            "MOVE_SAME_PROJECT",
            "The destination must be a different project.",
        ));
    }

    let scheduled = AfterTurnAction::Move(MoveRequest {
        destination: match checkout_path.clone() {
            Some(path) => MoveDestinationRecord::Checkout { path },
            None => MoveDestinationRecord::Project {
                project_id: destination.id.clone(),
                worktree: action.worktree,
            },
        },
        keep_source: action.keep_source,
        prompt: continuation.as_str().to_string(),
    });
    let (settled_tx, settled_rx) = oneshot::channel();
    registry.schedule_after_turn(&parent.session_id, &scheduled, settled_tx)?;
    if let Err(error) = providers.ensure_after_turn_schedulable(&parent.session_id, AfterTurn::Move)
    {
        registry.cancel_after_turn(&parent.session_id);
        return Err(argmax_protocol_error(error));
    }
    let requested_event = {
        let connection = database.connection();
        persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: parent.session_id.clone(),
                r#type: "session.move-requested".to_string(),
                message: match checkout_path.as_deref() {
                    Some(path) => format!("Move to {path} scheduled."),
                    None => format!("Move to {} scheduled.", destination.name),
                },
                payload: serde_json::json!({
                    "destinationProjectId": destination.id,
                    "destinationProjectName": destination.name,
                    "destinationPath": checkout_path,
                    "worktree": action.worktree,
                    "keepSource": action.keep_source,
                }),
                created_at: None,
            },
        )
    };
    let requested_event = match requested_event {
        Ok(event) => event,
        Err(error) => {
            registry.cancel_after_turn(&parent.session_id);
            return Err(argmax_protocol_error(error));
        }
    };
    workspaces.publish_session_with_events(source_session, vec![requested_event]);

    let source_session_id = parent.session_id.clone();
    let destination_project_id = destination.id.clone();
    let destination_project_name = destination.name.clone();
    tauri::async_runtime::spawn(async move {
        // A cancelled or shut-down promise, as in the archive above: the row
        // is either already gone or deliberately left for the next launch.
        if settled_rx.await.is_err() {
            return;
        }
        run_after_turn(
            scheduled,
            source_session_id,
            database,
            workspaces,
            providers,
            registry,
        )
        .await;
    });

    Ok(SessionControlResponse::new(
        SessionControlResult::Scheduled(ScheduledMove {
            scheduled: true,
            source_session_id: parent.session_id,
            project_id: destination_project_id,
            project_name: destination_project_name,
            path: checkout_path,
        }),
    ))
}

/// Carry out a disposal whose turn is over. Both the task the scheduling call
/// spawns and boot recovery come through here, so a promise kept a second
/// after the turn ended and one kept a day later run the same code.
pub(super) async fn run_after_turn(
    action: AfterTurnAction,
    session_id: String,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) {
    match action {
        AfterTurnAction::Archive(request) => {
            run_archive(request, &session_id, &workspaces, &registry).await
        }
        AfterTurnAction::Move(request) => {
            run_move(
                request,
                session_id,
                &database,
                &workspaces,
                &providers,
                &registry,
            )
            .await
        }
    }
}

async fn run_archive(
    request: ArchiveRequest,
    session_id: &str,
    workspaces: &Arc<WorkspaceService>,
    registry: &Arc<SessionLaunchRegistry>,
) {
    let workspace_id = request.workspace_id.clone();
    let archive_target = match WorkspaceId::try_from(request.workspace_id) {
        Ok(workspace_id) => workspace_id,
        Err(error) => {
            registry.finish_after_turn(session_id);
            tracing::error!(
                ?error,
                %workspace_id,
                "the scheduled archive names a workspace id that does not validate"
            );
            return;
        }
    };
    let outcome = workspaces
        .archive(WorkspacesArchiveInput {
            workspace_id: archive_target,
            force: Some(false),
        })
        .await;
    registry.finish_after_turn(session_id);
    match outcome {
        // `kept` is the refusal, not a failure: the checkout had
        // uncommitted work and stays live. Worth a line, because the agent
        // that asked has already reported the workspace gone.
        Ok(result) if result.workspace.state == "kept" => tracing::info!(
            %workspace_id,
            "scheduled archive kept the workspace: it has uncommitted changes"
        ),
        Ok(_) => tracing::info!(
            %workspace_id,
            "archived the workspace its agent asked to close"
        ),
        Err(error) => tracing::warn!(
            ?error,
            %workspace_id,
            "scheduled workspace archive failed"
        ),
    }
}

async fn run_move(
    request: MoveRequest,
    source_session_id: String,
    database: &Arc<Database>,
    workspaces: &Arc<WorkspaceService>,
    providers: &Arc<ProviderSessionService>,
    registry: &Arc<SessionLaunchRegistry>,
) {
    let continuation = match Prompt::try_from(request.prompt) {
        Ok(prompt) => prompt,
        Err(error) => {
            registry.finish_after_turn(&source_session_id);
            tracing::error!(
                ?error,
                session_id = %source_session_id,
                "the scheduled move carries a prompt that does not validate"
            );
            return;
        }
    };
    let result = workspaces
        .move_session(
            &source_session_id,
            move_destination(request.destination),
            request.keep_source,
        )
        .await;
    // The pending-move guard belongs to the source and the move is over
    // either way. Holding it across the destination's launch would refuse
    // a follow-up in a kept source chat that is no longer going anywhere.
    registry.finish_after_turn(&source_session_id);
    match result {
        Ok(moved) => {
            continue_moved_session(
                database,
                workspaces,
                providers,
                &moved.session.id,
                continuation,
            )
            .await
        }
        Err(error) => {
            tracing::warn!(
                ?error,
                session_id = %source_session_id,
                "scheduled session move failed"
            );
            if let Err(record_error) =
                workspaces.record_session_move_failure(&source_session_id, &error)
            {
                tracing::error!(
                    ?record_error,
                    session_id = %source_session_id,
                    "failed to record session move failure"
                );
            }
        }
    }
}

fn move_destination(destination: MoveDestinationRecord) -> MoveDestination {
    match destination {
        MoveDestinationRecord::Project {
            project_id,
            worktree,
        } => MoveDestination::Project {
            project_id,
            worktree,
        },
        MoveDestinationRecord::Checkout { path } => MoveDestination::Checkout { path },
    }
}

/// The destination's first turn. A move always carries the transcript, and
/// carries the provider conversation only where the provider supports it
/// (`move_carries_conversation`). Nothing runs there until a turn is sent —
/// this is that turn, the handoff the moving agent wrote. `send_input`
/// composes it with the move seam's own handoff note (`providers::follow_up`),
/// so the agent that wakes up in the destination is told where it is and what
/// came before.
async fn continue_moved_session(
    database: &Database,
    workspaces: &Arc<WorkspaceService>,
    providers: &Arc<ProviderSessionService>,
    destination_session_id: &str,
    prompt: Prompt,
) {
    let arrivals = {
        let connection = database.read_connection();
        count_move_arrivals(&connection, destination_session_id)
    };
    match arrivals {
        // Two agents that each conclude the work belongs in the other repo
        // would otherwise bounce a live turn between them, unattended. The
        // prompt rides along in the note: whoever takes over needs to know
        // what the chat was about to do.
        Ok(arrivals) if arrivals > MAX_CONTINUED_MOVES => {
            record_move_continuation_note(
                database,
                workspaces,
                destination_session_id,
                format!(
                    "This chat has moved {arrivals} times, so it is not picking the work up on its own again. Send the next message yourself. It was about to start on: {prompt}"
                ),
            );
            return;
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(
            ?error,
            session_id = destination_session_id,
            "could not count this chat's moves; continuing anyway"
        ),
    }

    let session_id = match SessionId::try_from(destination_session_id.to_string()) {
        Ok(session_id) => session_id,
        Err(error) => {
            tracing::error!(?error, "the moved session's id did not validate");
            return;
        }
    };
    let asked = prompt.as_str().to_string();
    if let Err(error) = providers
        .send_input(ProvidersSendInput {
            agent_references: None,
            session_id,
            input: prompt,
            provider: None,
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: false,
            agent_mode: None,
            attachments: None,
        })
        .await
    {
        // The move is already committed and the source is likely archived, so
        // this lands on the destination — the only chat still worth reading.
        // A turn that failed after its user message was persisted has spent
        // the seam's handoff note, so the note says where the work was headed
        // rather than assuming the next message will carry it.
        record_move_continuation_note(
            database,
            workspaces,
            destination_session_id,
            format!("Moved here, but the work could not start: {error}. It was about to start on: {asked}"),
        );
    }
}

/// Says on the destination chat why it is sitting still after a move. The
/// source is usually archived by now, so a note there would go unread.
fn record_move_continuation_note(
    database: &Database,
    workspaces: &Arc<WorkspaceService>,
    session_id: &str,
    message: String,
) {
    record_after_turn_note(
        database,
        workspaces,
        session_id,
        "session.move-continuation",
        message,
    );
}

/// One line in a chat's own timeline about the disposal it is carrying. The
/// `error` kind is what the transcript already renders as a system line for
/// this family of notes, so a disposal never speaks in a shape the chat
/// surface would drop.
pub(super) fn record_after_turn_note(
    database: &Database,
    workspaces: &Arc<WorkspaceService>,
    session_id: &str,
    operation: &str,
    message: String,
) {
    let recorded = (|| {
        let connection = database.connection();
        let session = find_session_by_id(&connection, session_id)?;
        let event = persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                r#type: "error".to_string(),
                message,
                payload: serde_json::json!({ "operation": operation }),
                created_at: None,
            },
        )?;
        Ok::<_, ArgmaxError>((session, event))
    })();
    match recorded {
        Ok((session, event)) => workspaces.publish_session_with_events(session, vec![event]),
        Err(error) => tracing::warn!(
            ?error,
            session_id,
            operation,
            "could not record a note about this chat's scheduled disposal"
        ),
    }
}
