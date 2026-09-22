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
        sessions::{
            find_session_by_id, mark_wait_reported, sessions_launched_by, wait_report_is_due,
        },
        time::now_iso,
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
    let _waiting = registry.wait_on_inbox(&parent.session_id);

    // Naming ids asks a question about those sessions; omitting them asks
    // "what have my children done that I have not been told about". Only the
    // second form keeps a high-water mark, so a named read is repeatable.
    let report_once = action.sessions.is_none();
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
        // A tool call only happens mid-turn, so a caller whose turn is over
        // (the user pressed Stop, the provider died) has no one left to read
        // the reply. Collecting now would mark finishes reported and messages
        // delivered into a closed socket, and the next wait would never see
        // them.
        if !caller_turn_is_running(&database, &parent.session_id) {
            return Err(protocol_error(
                "WAIT_CALLER_ENDED",
                "The calling session's turn ended while it was waiting, so nothing was collected.",
            ));
        }
        if let Some(outcome) = collect_wait_outcome(
            &database,
            &providers,
            &parent.session_id,
            &watched,
            report_once,
        )? {
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

fn caller_turn_is_running(database: &Database, caller_session_id: &str) -> bool {
    let connection = database.read_connection();
    find_session_by_id(&connection, caller_session_id)
        .is_ok_and(|session| session.state.is_active())
}

/// What the wait would report right now, or `None` while nothing has happened.
///
/// `report_once` is the argument-less form: a session it has already handed
/// over is held back until that session runs again, so a parent waiting on its
/// second child is not answered with its first one forever.
fn collect_wait_outcome(
    database: &Database,
    providers: &ProviderSessionService,
    caller_session_id: &str,
    watched: &[String],
    report_once: bool,
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
            if report_once
                && !wait_report_is_due(&connection, session_id).map_err(argmax_protocol_error)?
            {
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
    // Both writes need the writer, so they happen only once the wait is
    // actually returning, and on the one connection: a crash cannot mark a
    // finish reported without also having handed the messages over.
    let (messages, collected_message_ids) = {
        let mut connection = database.connection();
        let taken = take_undelivered_messages(
            &mut connection,
            caller_session_id,
            INBOX_READ_LIMIT,
            INBOX_READ_BYTE_BUDGET,
        )
        .map_err(argmax_protocol_error)?;
        if report_once && !settled.is_empty() {
            let reported = settled
                .iter()
                .map(|session| session.session_id.clone())
                .collect::<Vec<_>>();
            mark_wait_reported(&connection, &reported, &now_iso())
                .map_err(argmax_protocol_error)?;
        }
        let collected_message_ids = taken
            .iter()
            .map(|message| message.id.clone())
            .collect::<Vec<_>>();
        (to_inbox_messages(&connection, taken), collected_message_ids)
    };
    // The inbox hand-over is already committed. Queue reconciliation is best
    // effort so a cleanup failure cannot turn a delivered reply into an error.
    if let Err(error) =
        providers.reconcile_collected_messages(caller_session_id, &collected_message_ids)
    {
        tracing::warn!(
            session_id = caller_session_id,
            ?error,
            "failed to remove waited messages from the pending queue"
        );
    }
    Ok(Some(WaitOutcome {
        timed_out: false,
        sessions: settled,
        messages,
    }))
}
