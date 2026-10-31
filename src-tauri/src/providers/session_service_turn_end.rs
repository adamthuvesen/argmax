//! The one way a turn ends. Each path that ends a turn calls
//! [`ProviderSessionService::commit_turn_end`], so the session row, its
//! workspace, the turn's rows, and the delta commit together. A new turn-end
//! side effect belongs here.

use std::sync::Arc;

use rusqlite::Transaction;

use super::{
    sqlite_error, update_workspace_state_for_session_state_within_transaction, HandleEntry,
    ProviderSessionService,
};
use crate::error::ArgmaxResult;
use crate::persistence::events::{RawProviderOutput, TimelineEvent};
use crate::persistence::projects::list_projects;
use crate::persistence::sessions::{update_session_state, SessionStateInput};
use crate::providers::flush_queue::DashboardDelta;
use crate::sessions::state::SessionState;
use crate::util::sync::LockOrRecover;

/// How one path ends a turn. Every field is required, so a new path has to
/// decide each effect.
pub(super) struct TurnEnd<'a> {
    pub session_id: &'a str,
    pub state: SessionState,
    pub finished_at: &'a str,
    /// Returns false when this path no longer owns the session's end.
    pub may_end: fn(SessionState) -> bool,
    /// Skip the end when Stop already owns it. The lock stays held through the
    /// commit, so an exit cannot overwrite the cancelled state.
    pub yields_to_stop: bool,
    pub remove_handle: bool,
    pub pause_queue: bool,
    pub reconcile_subagents: bool,
}

#[derive(Default)]
pub(super) struct TurnRows {
    pub events: Vec<TimelineEvent>,
    pub raw_outputs: Vec<RawProviderOutput>,
}

pub(super) struct TurnFollowUp {
    pub settle: bool,
    pub drain_queue: bool,
}

pub(super) struct EndedTurn {
    pub handle: Option<HandleEntry>,
    pub queue_paused: ArgmaxResult<()>,
}

impl ProviderSessionService {
    /// Returns `None` when the turn did not end here. The caller runs the
    /// effects that follow the published delta.
    pub(super) fn commit_turn_end(
        &self,
        end: TurnEnd<'_>,
        rows: impl FnOnce(&Transaction<'_>) -> ArgmaxResult<TurnRows>,
    ) -> ArgmaxResult<Option<EndedTurn>> {
        let terminating = end
            .yields_to_stop
            .then(|| self.terminating.lock_or_recover("terminating"));
        if terminating
            .as_ref()
            .is_some_and(|sessions| sessions.contains(end.session_id))
        {
            return Ok(None);
        }
        let connection = self.database.connection();
        let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
        let current =
            crate::persistence::sessions::find_session_by_id(&transaction, end.session_id)?;
        if !(end.may_end)(current.state) {
            return Ok(None);
        }
        let session = update_session_state(
            &transaction,
            end.session_id,
            &SessionStateInput::transition(end.state).finished_at(end.finished_at.to_string()),
        )?;
        let workspace = update_workspace_state_for_session_state_within_transaction(
            &transaction,
            &session.workspace_id,
            end.state,
        )?;
        let rows = rows(&transaction)?;
        let mut delta = DashboardDelta {
            projects: list_projects(&transaction)?,
            workspaces: vec![workspace],
            sessions: vec![session],
            events: rows.events,
            raw_outputs: rows.raw_outputs,
            ..DashboardDelta::default()
        };
        transaction.commit().map_err(sqlite_error)?;
        drop(terminating);

        let handle = end
            .remove_handle
            .then(|| {
                self.handles
                    .lock_or_recover("handles")
                    .remove(end.session_id)
            })
            .flatten();
        self.flush_queue
            .lock_or_recover("flush queue")
            .delete_session(end.session_id);
        let queue_paused = if end.pause_queue {
            self.pause_queue_with_connection(&connection, end.session_id)
        } else {
            Ok(())
        };
        // The delta's push body reads through `read_connection`, whose fallback
        // would lock the writer again if this thread still held it.
        drop(connection);
        if end.reconcile_subagents {
            self.append_reconciled_subagent_events(end.session_id, &mut delta);
        }
        self.publish(delta);
        Ok(Some(EndedTurn {
            handle,
            queue_paused,
        }))
    }

    /// Tells the launcher that the turn ended, and sends the next queued
    /// follow-up when the turn can continue.
    pub(super) fn announce_turn_end(
        self: &Arc<Self>,
        session_id: &str,
        state: SessionState,
        finished_at: &str,
        after: TurnFollowUp,
    ) {
        if after.settle {
            self.settle_session_after_turn(session_id);
        }
        self.notify_launcher_of_turn_end(session_id, state, finished_at);
        if after.drain_queue {
            self.drain_queue_after_complete(session_id.to_string());
        }
    }
}
