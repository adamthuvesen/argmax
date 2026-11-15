//! Output flushing: the per-session batch and idle flush timers and the dashboard publish.

use super::*;

impl ProviderSessionService {
    /// `synthesize_cursor_exit` is `true` only on a genuine Cursor process exit
    /// (see `flush_trailing_fragments`). Mid-turn batch flushes and user
    /// terminates pass `false` so they don't prematurely complete the turn.
    pub(super) fn flush_trailing(
        self: &Arc<Self>,
        session_id: &str,
        synthesize_cursor_exit: bool,
    ) -> ArgmaxResult<()> {
        let mut connection = self.database.connection();
        let delta = self
            .flush_queue
            .lock_or_recover("flush queue")
            .flush_trailing_fragments(
                &mut connection,
                session_id,
                &now_iso(),
                synthesize_cursor_exit,
            )?;
        drop(connection);
        self.publish_flushed_delta(session_id, delta);
        Ok(())
    }

    pub(super) fn flush_pending(self: &Arc<Self>, session_id: &str) -> ArgmaxResult<()> {
        let mut connection = self.database.connection();
        let delta = self
            .flush_queue
            .lock_or_recover("flush queue")
            .flush_pending_output(&mut connection, session_id)?;
        drop(connection);
        self.publish_flushed_delta(session_id, delta);
        Ok(())
    }

    pub(super) fn publish_flushed_delta(
        self: &Arc<Self>,
        session_id: &str,
        mut delta: Option<DashboardDelta>,
    ) {
        if let Some(delta) = delta.as_mut() {
            if delta_has_session_completed_event(delta) {
                self.append_reconciled_subagent_events(session_id, delta);
            }
        }
        let reconcile_subagents = delta.as_ref().is_some_and(|delta| {
            !delta_has_session_completed_event(delta) && delta_has_subagent_control_event(delta)
        });
        if let Some(delta) = delta {
            self.schedule_measured_diffs(session_id, &delta);
            self.schedule_observed_prs(session_id, &delta);
            self.publish(delta);
        }
        if reconcile_subagents {
            self.schedule_subagent_trace_reconciliation(session_id);
        }
    }

    pub(super) fn cancel_stream_flushes(&self, session_id: &str) {
        self.cancel_batch_flush(session_id);
        self.cancel_idle_flush(session_id);
    }

    pub(super) fn cancel_batch_flush(&self, session_id: &str) {
        if let Some(handle) = self
            .batch_flush_tasks
            .lock_or_recover("batch flush tasks")
            .remove(session_id)
        {
            handle.abort();
        }
        self.batch_flush_generation
            .lock_or_recover("batch flush generation")
            .remove(session_id);
    }

    pub(super) fn schedule_batch_flush(self: &Arc<Self>, session_id: &str) {
        let mut tasks = self.batch_flush_tasks.lock_or_recover("batch flush tasks");
        if tasks.contains_key(session_id) {
            return;
        }
        let generation = {
            let mut generations = self
                .batch_flush_generation
                .lock_or_recover("batch flush generation");
            let next = generations.get(session_id).copied().unwrap_or(0) + 1;
            generations.insert(session_id.to_string(), next);
            next
        };
        let service = Arc::clone(self);
        let session_id_owned = session_id.to_string();
        let session_id_for_map = session_id_owned.clone();
        let handle = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(STREAM_BATCH_FLUSH_MS)).await;
            let current = service
                .batch_flush_generation
                .lock_or_recover("batch flush generation")
                .get(&session_id_owned)
                .copied();
            if current != Some(generation) {
                return;
            }
            service
                .batch_flush_tasks
                .lock_or_recover("batch flush tasks")
                .remove(&session_id_owned);
            let mut generations = service
                .batch_flush_generation
                .lock_or_recover("batch flush generation");
            if generations.get(&session_id_owned) == Some(&generation) {
                generations.remove(&session_id_owned);
            }
            drop(generations);
            let flush_result = service.flush_pending(&session_id_owned);
            if let Err(error) = flush_result {
                tracing::warn!(
                    ?error,
                    session_id = %session_id_owned,
                    "batched stream flush failed"
                );
            }
        });
        tasks.insert(session_id_for_map, handle);
    }

    pub(super) fn cancel_idle_flush(&self, session_id: &str) {
        if let Some(handle) = self
            .idle_flush_tasks
            .lock_or_recover("idle flush tasks")
            .remove(session_id)
        {
            handle.abort();
        }
        self.idle_flush_generation
            .lock_or_recover("idle flush generation")
            .remove(session_id);
    }

    pub(super) fn schedule_idle_flush(self: &Arc<Self>, session_id: &str) {
        let generation = {
            let mut generations = self
                .idle_flush_generation
                .lock_or_recover("idle flush generation");
            let next = generations.get(session_id).copied().unwrap_or(0) + 1;
            generations.insert(session_id.to_string(), next);
            next
        };
        if let Some(handle) = self
            .idle_flush_tasks
            .lock_or_recover("idle flush tasks")
            .remove(session_id)
        {
            handle.abort();
        }
        let service = Arc::clone(self);
        let session_id_owned = session_id.to_string();
        let session_id_for_map = session_id_owned.clone();
        let handle = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(STREAM_IDLE_FLUSH_MS)).await;
            let current = service
                .idle_flush_generation
                .lock_or_recover("idle flush generation")
                .get(&session_id_owned)
                .copied();
            if current != Some(generation) {
                return;
            }
            service
                .idle_flush_tasks
                .lock_or_recover("idle flush tasks")
                .remove(&session_id_owned);
            let mut generations = service
                .idle_flush_generation
                .lock_or_recover("idle flush generation");
            if generations.get(&session_id_owned) == Some(&generation) {
                generations.remove(&session_id_owned);
            }
            drop(generations);
            service.cancel_batch_flush(&session_id_owned);
            let flush_result = service.flush_trailing(&session_id_owned, false);
            if let Err(error) = flush_result {
                tracing::warn!(
                    ?error,
                    session_id = %session_id_owned,
                    "idle stream flush failed"
                );
            }
        });
        self.idle_flush_tasks
            .lock_or_recover("idle flush tasks")
            .insert(session_id_for_map, handle);
    }

    pub(crate) fn publish(&self, delta: DashboardDelta) {
        // Before the emptiness check and before the renderer hop: a blocked
        // `session_wait` is waiting on exactly this edge, and a send to a
        // channel with no subscribers is a cheap no-op.
        for session in &delta.sessions {
            let _ = self.session_states.send(SessionStateChange {
                session_id: session.id.clone(),
                state: session.state,
            });
        }
        if !delta.is_empty() {
            (self.publish_delta)(delta);
        }
    }
}
