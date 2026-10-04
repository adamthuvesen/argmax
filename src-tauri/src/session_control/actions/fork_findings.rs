//! `session_message` with `forkFindings`: the fork's own agent sends its new
//! work back to the chat it was forked from. The range, cursor and queueing are
//! `providers::fork_merge`'s; this only translates the tool call.

use std::sync::Arc;

use super::{
    super::{
        protocol::{
            MessageAction, MessageDelivery, SessionControlError, SessionControlResponse,
            SessionControlResult,
        },
        registry::ParentLaunchSettings,
    },
    argmax_protocol_error, protocol_error,
};
use crate::persistence::{continuity::fork_for_child, database::Database};
use crate::providers::{
    fork_merge::{confirm, preview, ClaimOptions},
    session_service::ProviderSessionService,
};

pub(super) async fn bring_fork_findings(
    action: MessageAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    providers: Arc<ProviderSessionService>,
) -> Result<SessionControlResponse, SessionControlError> {
    let fork = {
        let connection = database.connection();
        fork_for_child(&connection, &parent.session_id).map_err(argmax_protocol_error)?
    };
    let Some(fork) = fork else {
        return Err(protocol_error(
            "FORK_NOT_FOUND",
            "This chat was not forked from another chat, so it has no findings to bring back.",
        ));
    };
    if fork.source_session_id.as_deref() != Some(action.session_id.as_str()) {
        return Err(protocol_error(
            "FORK_SOURCE_MISMATCH",
            "forkFindings can only go to the chat this one was forked from.",
        ));
    }
    let previewed = {
        let database = Arc::clone(&database);
        let child = parent.session_id.clone();
        tokio::task::spawn_blocking(move || preview(&database, &child))
            .await
            .map_err(|error| protocol_error("FORK_MERGE_JOIN", error.to_string()))?
            .map_err(argmax_protocol_error)?
    };
    let Some(through_event_id) = previewed
        .through_event_id
        .filter(|_| !previewed.nothing_new)
    else {
        return Err(protocol_error(
            "FORK_NOTHING_NEW",
            "Nothing new to bring back since the fork or your last forkFindings.",
        ));
    };
    let result = confirm(
        &database,
        &providers,
        &parent.session_id,
        &through_event_id,
        ClaimOptions {
            note: Some(action.message),
            from_inside_fork: true,
        },
    )
    .await
    .map_err(argmax_protocol_error)?;
    if !result.merged {
        return Err(protocol_error(
            "FORK_NOTHING_NEW",
            "Those findings were already brought back.",
        ));
    }
    Ok(SessionControlResponse::new(SessionControlResult::Messaged(
        MessageDelivery {
            session_id: action.session_id,
            queued: result.queued,
        },
    )))
}
