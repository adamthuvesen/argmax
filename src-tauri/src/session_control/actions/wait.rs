use std::sync::Arc;
use std::time::Duration;

use super::super::{
    argmax_protocol_error,
    protocol::{
        SessionControlError, SessionControlResponse, SessionControlResult, WaitAction, WaitOutcome,
        WaitedSession,
    },
    protocol_error,
    registry::{ParentLaunchSettings, SessionLaunchRegistry},
    INBOX_READ_BYTE_BUDGET, INBOX_READ_LIMIT, WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS,
    WAIT_POLL_INTERVAL,
};
use super::messaging::{session_task_label, to_inbox_messages};
use crate::{
    persistence::{
        database::Database,
        session_messages::{count_undelivered_messages, take_undelivered_messages},
        sessions::{find_session_by_id, sessions_launched_by},
    },
    providers::session_service::ProviderSessionService,
};

/// Block until something the caller cares about happens.
///
/// The two wake-ups are a watched session settling and a message arriving for
/// the caller. Both are in-process broadcasts, subscribed to *before* the
/// first database read, so an edge that lands between subscribing and reading
/// is queued rather than lost. Nothing here holds a database connection across
/// an await: every look at the rows opens and drops its own.
pub(super) async fn wait_for_sessions(
    action: WaitAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    providers: Arc<ProviderSessionService>,
    registry: Arc<SessionLaunchRegistry>,
) -> Result<SessionControlResponse, SessionControlError> {
    let timeout = Duration::from_secs(
        action
            .timeout_s
            .unwrap_or(WAIT_DEFAULT_SECONDS)
            .clamp(1, WAIT_MAX_SECONDS),
    );
    let mut states = providers.subscribe_session_states();
    let mut inbox = registry.subscribe_inbox();

    let watched = {
        let connection = database.read_connection();
        match action.sessions {
            Some(ids) => {
                if ids.is_empty() {
                    return Err(protocol_error(
                        "WAIT_NO_SESSIONS",
                        "The sessions list is empty. Name session ids, or omit it to wait on the sessions you launched.",
                    ));
                }
                for id in &ids {
                    find_session_by_id(&connection, id).map_err(argmax_protocol_error)?;
                }
                ids
            }
            None => {
                let launched = sessions_launched_by(&connection, &parent.session_id)
                    .map_err(argmax_protocol_error)?;
                if launched.is_empty() {
                    return Err(protocol_error(
                        "WAIT_NOTHING_TO_WATCH",
                        "This session has not launched any sessions, so there is nothing to wait for. Name sessions explicitly to watch other ones.",
                    ));
                }
                launched
            }
        }
    };

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(outcome) = collect_wait_outcome(&database, &parent.session_id, &watched)? {
            return Ok(SessionControlResponse::new(SessionControlResult::Waited(
                outcome,
            )));
        }
        let woken = tokio::select! {
            _ = tokio::time::sleep_until(deadline) => false,
            // A lagged subscriber has missed edges; the re-read at the top of
            // the loop is what recovers them, so any result wakes us.
            _ = states.recv() => true,
            _ = inbox.recv() => true,
            // The safety re-read. State written outside the provider service
            // (or a burst that overran a subscriber) still surfaces here.
            _ = tokio::time::sleep(WAIT_POLL_INTERVAL) => true,
        };
        if !woken {
            return Ok(SessionControlResponse::new(SessionControlResult::Waited(
                WaitOutcome {
                    timed_out: true,
                    sessions: Vec::new(),
                    messages: Vec::new(),
                },
            )));
        }
    }
}

/// What the wait would report right now, or `None` while nothing has happened.
fn collect_wait_outcome(
    database: &Database,
    caller_session_id: &str,
    watched: &[String],
) -> Result<Option<WaitOutcome>, SessionControlError> {
    let settled = {
        let connection = database.read_connection();
        let mut settled = Vec::new();
        for session_id in watched {
            let Ok(session) = find_session_by_id(&connection, session_id) else {
                continue;
            };
            if session.state.is_active() {
                continue;
            }
            settled.push(WaitedSession {
                task_label: session_task_label(&connection, session_id),
                session_id: session.id,
                state: session.state,
            });
        }
        settled
    };
    let has_message = {
        let connection = database.read_connection();
        count_undelivered_messages(&connection, caller_session_id).map_err(argmax_protocol_error)?
            > 0
    };
    if settled.is_empty() && !has_message {
        return Ok(None);
    }
    // Taking the messages needs the writer, so it happens only once the wait
    // is actually returning.
    let messages = {
        let mut connection = database.connection();
        let taken = take_undelivered_messages(
            &mut connection,
            caller_session_id,
            INBOX_READ_LIMIT,
            INBOX_READ_BYTE_BUDGET,
        )
        .map_err(argmax_protocol_error)?;
        to_inbox_messages(&connection, taken)
    };
    Ok(Some(WaitOutcome {
        timed_out: false,
        sessions: settled,
        messages,
    }))
}
