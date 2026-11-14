//! Stopping turns: terminate, clear, workspace teardown, and the owned termination jobs.

use super::*;

impl ProviderSessionService {
    pub async fn terminate(self: &Arc<Self>, input: ProvidersTerminateInput) -> ArgmaxResult<()> {
        let session_id = input.session_id.as_str().to_string();
        self.queue_promotions
            .lock_or_recover("queue promotions")
            .remove(&session_id);
        let done = self.start_termination(session_id, false)?;
        wait_for_termination(done).await
    }

    /// Drop the provider conversation in place: same workspace, same session
    /// row, no resume id, and a `session.cleared` watermark so the next turn
    /// and the chat surface both start empty. A live provider is stopped first.
    pub async fn clear(self: &Arc<Self>, input: SessionClearInput) -> ArgmaxResult<SessionSummary> {
        let session_id = input.session_id.as_str().to_string();
        let live = {
            let connection = self.database.connection();
            let session = find_session_by_id(&connection, &session_id)?;
            session.state.is_active()
        };
        if live {
            self.terminate(ProvidersTerminateInput {
                session_id: input.session_id.clone(),
            })
            .await?;
        } else {
            self.clear_queue(&session_id)?;
        }

        let (session, event) = {
            let connection = self.database.connection();
            let session = clear_session_conversation(&connection, &session_id)?;
            let event = persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.clone(),
                    r#type: "session.cleared".to_string(),
                    message: "Cleared conversation.".to_string(),
                    payload: json!({}),
                    created_at: None,
                },
            )?;
            (session, event)
        };
        // The writer connection is dropped before publishing: the delta's
        // push body reads through `read_connection`, whose fallback would
        // re-lock the writer this thread may still be holding.
        self.publish(DashboardDelta {
            sessions: vec![session.clone()],
            events: vec![event],
            ..DashboardDelta::default()
        });
        Ok(session)
    }

    pub async fn terminate_workspace(self: &Arc<Self>, workspace_id: &str) -> ArgmaxResult<()> {
        let sessions = {
            let connection = self.database.connection();
            let mut statement = connection
                .prepare_cached("SELECT id, state FROM sessions WHERE workspace_id = ?")
                .map_err(sqlite_error)?;
            let sessions = statement
                .query_map([workspace_id], |row| {
                    Ok((row.get::<_, String>("id")?, row.get::<_, String>("state")?))
                })
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            sessions
        };
        // The workspace is being archived, so no session in it takes another
        // turn. Drop their launch credentials — a background process the agent
        // left behind would otherwise keep a working token indefinitely.
        if let Some(registry) = self.session_control.as_ref() {
            for (session_id, _) in &sessions {
                registry.revoke(session_id);
            }
        }
        // Transfer every live handle into an owned job before waiting for any
        // of them. Archive timeouts may cancel these waiters, but the jobs
        // continue disposing their provider processes and persisting state.
        let mut done = Vec::new();
        for (session_id, state) in sessions {
            if !matches!(state.as_str(), "running" | "waiting" | "blocked") {
                continue;
            }
            done.push(self.start_termination(session_id, false)?);
        }
        for ticket in done {
            wait_for_termination(ticket).await?;
        }
        Ok(())
    }

    pub(super) fn start_termination(
        self: &Arc<Self>,
        session_id: String,
        preserve_queue: bool,
    ) -> ArgmaxResult<watch::Receiver<Option<ArgmaxResult<()>>>> {
        let mut jobs = {
            let mut generations = self.send_generations.lock_or_recover("send generations");
            let generation = generations.entry(session_id.clone()).or_default();
            *generation = generation.wrapping_add(1);
            let jobs = self.termination_jobs.lock_or_recover("termination jobs");
            if let Some(done) = jobs.get(&session_id) {
                return Ok(done.clone());
            }
            // Publish the transient marker before releasing the generation.
            // A send that starts during Stop then sees either this marker or a
            // later generation mismatch, including after the marker clears.
            self.terminating
                .lock_or_recover("terminating")
                .insert(session_id.clone());
            jobs
        };
        self.cancel_stream_flushes(&session_id);
        if !preserve_queue {
            if let Err(error) = self.clear_queue(&session_id) {
                self.terminating
                    .lock_or_recover("terminating")
                    .remove(&session_id);
                return Err(error);
            }
        }
        // The marker was set with the generation before any teardown work, so
        // a wait-thread exit event cannot clobber the cancellation state.
        let entry = self.handles.lock_or_recover("handles").remove(&session_id);
        let (done_tx, done_rx) = watch::channel::<Option<ArgmaxResult<()>>>(None);
        jobs.insert(session_id.clone(), done_rx.clone());
        drop(jobs);

        let service = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let result = service.finish_termination(&session_id, entry).await;
            // Retire the job before waking the waiters. Woken on another
            // worker, a waiter that then starts its own turn would otherwise
            // still find this finished job and be rejected as
            // PROVIDER_TERMINATING.
            service
                .termination_jobs
                .lock_or_recover("termination jobs")
                .remove(&session_id);
            let _ = done_tx.send(Some(result));
        });
        Ok(done_rx)
    }

    pub(super) async fn finish_termination(
        self: &Arc<Self>,
        session_id: &str,
        entry: Option<HandleEntry>,
    ) -> ArgmaxResult<()> {
        let mut first_error = None;
        // Release native permission waiters before waiting for provider cancel.
        // ACP cannot finish session/cancel until pending requests are answered.
        if let Err(error) = self.cancel_pending_interactions(session_id) {
            first_error = Some(error);
        }

        // Read before disposal: the handle owns the answer and is dropped below.
        let mut input_undelivered = false;
        match entry {
            Some(HandleEntry::Resolved(handle)) => {
                // User-initiated cancel: flush buffered text but don't
                // synthesize a Cursor turn completion — the turn didn't
                // finish, it was cancelled.
                if let Err(error) = self.flush_trailing(session_id, false) {
                    first_error = Some(error);
                }
                input_undelivered = !handle.input_delivered();
                if let Err(error) = handle.terminate().await {
                    first_error.get_or_insert(error);
                }
            }
            Some(HandleEntry::Pending(_)) | None => {}
        }

        // Persist cancellation even when provider disposal reports an error.
        // The process exit callback observes the terminating marker and cannot
        // clobber this state, while archive can report a teardown failure.
        if let Err(error) = self.cancel_session(session_id) {
            first_error.get_or_insert(error);
        }
        if let Err(error) = self.cancel_pending_interactions(session_id) {
            first_error.get_or_insert(error);
        }
        if input_undelivered {
            // After the cancellation row, so the transcript reads in the order
            // it happened: the message, the stop, then why the message went
            // unanswered.
            self.note_undelivered_turn_input(session_id);
        }
        self.terminating
            .lock_or_recover("terminating")
            .remove(session_id);
        if let Some(error) = first_error {
            let _ = self.abort_session_after_turn(
                session_id,
                "Could not move this chat because the agent process did not stop safely.",
            );
            Err(error)
        } else {
            self.settle_session_after_turn(session_id);
            Ok(())
        }
    }
}
