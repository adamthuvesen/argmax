use std::sync::Arc;

use tokio::sync::oneshot;

use super::super::registry::{AfterTurn, SessionLaunchRegistry};
use super::move_archive::{record_after_turn_note, run_after_turn};
use crate::{
    error::ArgmaxResult,
    persistence::{
        after_turn::{
            delete_after_turn, list_after_turn, source_move_recorded, AfterTurnAction,
            AfterTurnRequest,
        },
        database::Database,
        sessions::find_session_by_id,
        workspaces::find_workspace_by_id,
    },
    providers::session_service::ProviderSessionService,
    workspaces::WorkspaceService,
};

/// Keep the disposals promised by a run that ended before they could happen.
///
/// `session_move` and `workspace_archive` answer `{scheduled: true}` mid-turn,
/// and the agent reports to the user on that answer. A quit or a crash before
/// the turn settled used to end the promise there: the fresh registry knew
/// nothing, and the workspace stayed live with a timeline that still said
/// "scheduled". Every row here is one of those promises.
///
/// Runs at boot, after orphaned sessions are recovered and after interrupted
/// archives are repaired — a half-finished archive has to be whole again
/// before we decide whether another one still has anything to do.
pub async fn resume_after_turn_actions(
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) {
    let scheduled = {
        let connection = database.read_connection();
        list_after_turn(&connection)
    };
    let scheduled = match scheduled {
        Ok(scheduled) => scheduled,
        Err(error) => {
            tracing::warn!(?error, "could not read the scheduled after-turn actions");
            return;
        }
    };
    for request in scheduled {
        resume_one(&request, &database, &workspaces, &providers, &registry).await;
    }
}

/// What a promise still needs from this launch.
enum Resumption {
    /// Nothing: the disposal already happened, or has nothing left to act on.
    Obsolete(&'static str),
    /// The session is somehow still mid-turn, so wait for it as before.
    AwaitTurnEnd,
    /// The process died with the app, so the turn is over by definition.
    RunNow,
}

async fn resume_one(
    request: &AfterTurnRequest,
    database: &Arc<Database>,
    workspaces: &Arc<WorkspaceService>,
    providers: &Arc<ProviderSessionService>,
    registry: &Arc<SessionLaunchRegistry>,
) {
    let session_id = request.session_id.as_str();
    let resumption = {
        let connection = database.read_connection();
        judge(request, &connection)
    };
    match resumption {
        Ok(Resumption::Obsolete(reason)) => {
            tracing::info!(session_id, reason, "dropping a scheduled after-turn action");
            let connection = database.connection();
            if let Err(error) = delete_after_turn(&connection, session_id) {
                tracing::warn!(
                    ?error,
                    session_id,
                    "could not drop an obsolete after-turn action"
                );
            }
        }
        // Should not happen — `recover_orphaned_sessions` has already settled
        // every session whose process died with the app — but a session that
        // is somehow still running gets what it was promised: the disposal
        // waits for the end of the turn, as it would have in the run that
        // scheduled it.
        Ok(Resumption::AwaitTurnEnd) => {
            let (settled_tx, settled_rx) = oneshot::channel();
            if let Err(error) =
                registry.adopt_after_turn(session_id, AfterTurn::of(&request.action), settled_tx)
            {
                tracing::warn!(
                    code = %error.code,
                    session_id,
                    "could not re-register a scheduled after-turn action"
                );
                return;
            }
            tracing::info!(
                session_id,
                "a scheduled after-turn action is waiting for a turn that is still running"
            );
            let action = request.action.clone();
            let session_id = request.session_id.clone();
            let database = Arc::clone(database);
            let workspaces = Arc::clone(workspaces);
            let providers = Arc::clone(providers);
            let registry = Arc::clone(registry);
            tauri::async_runtime::spawn(async move {
                // Cancelled, or the app going down again with the promise
                // still outstanding. Either way the row is in the right
                // state already.
                if settled_rx.await.is_err() {
                    return;
                }
                run_after_turn(
                    action, session_id, database, workspaces, providers, registry,
                )
                .await;
            });
        }
        Ok(Resumption::RunNow) => {
            record_after_turn_note(
                database,
                workspaces,
                session_id,
                operation(&request.action),
                match request.action {
                    AfterTurnAction::Archive(_) => {
                        "Resuming the archive scheduled before Argmax last quit.".to_string()
                    }
                    AfterTurnAction::Move(_) => {
                        "Resuming the move scheduled before Argmax last quit.".to_string()
                    }
                },
            );
            run_after_turn(
                request.action.clone(),
                request.session_id.clone(),
                Arc::clone(database),
                Arc::clone(workspaces),
                Arc::clone(providers),
                Arc::clone(registry),
            )
            .await;
        }
        Err(error) => tracing::warn!(
            ?error,
            session_id,
            "could not judge a scheduled after-turn action; leaving it for the next launch"
        ),
    }
}

fn judge(
    request: &AfterTurnRequest,
    connection: &rusqlite::Connection,
) -> ArgmaxResult<Resumption> {
    let Ok(session) = find_session_by_id(connection, &request.session_id) else {
        return Ok(Resumption::Obsolete("the session is gone"));
    };
    let Ok(workspace) = find_workspace_by_id(connection, &session.workspace_id) else {
        return Ok(Resumption::Obsolete("the workspace is gone"));
    };
    // Both disposals end with the source workspace archived, so an archived
    // one is the promise already kept.
    if workspace.state == "archived" {
        return Ok(Resumption::Obsolete("the workspace is already archived"));
    }
    if matches!(request.action, AfterTurnAction::Move(_))
        && source_move_recorded(connection, &request.session_id)?
    {
        return Ok(Resumption::Obsolete("the move already happened"));
    }
    if session.state.is_active() {
        return Ok(Resumption::AwaitTurnEnd);
    }
    Ok(Resumption::RunNow)
}

/// The `operation` a note carries, spelled the way the rest of the runtime
/// spells these two (`ProviderSessionService::abort_session_after_turn`).
fn operation(action: &AfterTurnAction) -> &'static str {
    match action {
        AfterTurnAction::Move(_) => "session.move",
        AfterTurnAction::Archive(_) => "workspace.archive",
    }
}
