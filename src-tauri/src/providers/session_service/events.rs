//! Provider runtime events: stream start, output, lifecycle, and the Cursor result that ends a turn.

use super::*;

impl ProviderSessionService {
    pub(super) fn is_current_provider_invocation(
        &self,
        session_id: &str,
        provider_invocation_id: &str,
    ) -> bool {
        self.flush_queue
            .lock_or_recover("flush queue")
            .is_current_invocation(session_id, provider_invocation_id)
    }

    pub(super) fn handle_provider_event(
        self: Arc<Self>,
        event: ProviderRuntimeEvent,
        provider_invocation_id: String,
    ) {
        if !self.is_current_provider_invocation(&event.session_id, &provider_invocation_id) {
            return;
        }
        let result = match event.r#type {
            ProviderRuntimeEventType::Output => {
                self.handle_output_event(event, provider_invocation_id)
            }
            ProviderRuntimeEventType::StreamStarted => self.handle_stream_started(event),
            ProviderRuntimeEventType::Exit | ProviderRuntimeEventType::Error => {
                self.handle_lifecycle_event(event)
            }
        };
        if let Err(error) = result {
            tracing::warn!(error = ?error, "provider event handling failed");
        }
    }

    pub(super) fn handle_stream_started(&self, event: ProviderRuntimeEvent) -> ArgmaxResult<()> {
        // Persist a one-shot `session.streaming` marker so the renderer can
        // hide the "Thinking" bubble the moment the child writes its first
        // byte. Originally Codex-only because Claude/Cursor "stream message
        // deltas soon after" — but on the Tauri/PTY path "soon after" turned
        // out to be several seconds while the provider emits system-init /
        // tool-use prelude JSON that the normalizer produces zero timeline
        // events for. Empty Thinking bubble for 4 s is the reported bug; the
        // beacon clears it on first byte for every provider.
        let connection = self.database.connection();
        let timeline_event = persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: event.session_id.clone(),
                r#type: "session.streaming".to_string(),
                message: String::new(),
                payload: json!({}),
                created_at: Some(event.created_at),
            },
        )?;
        drop(connection);
        self.publish(DashboardDelta {
            events: vec![timeline_event],
            ..DashboardDelta::default()
        });
        Ok(())
    }

    pub(super) fn handle_output_event(
        self: Arc<Self>,
        event: ProviderRuntimeEvent,
        provider_invocation_id: String,
    ) -> ArgmaxResult<()> {
        self.output_events.fetch_add(1, Ordering::Relaxed);
        let trace_bytes = event.message.len();
        let trace_session = event.session_id.clone();
        tracing::trace!(
            session_id = %trace_session,
            bytes = trace_bytes,
            "handle_output_event: acquiring DB connection",
        );
        let mut connection = self.database.connection();
        tracing::trace!(
            session_id = %trace_session,
            "handle_output_event: acquired DB; acquiring flush queue",
        );
        let mut flush_queue = self.flush_queue.lock_or_recover("flush queue");
        tracing::trace!(
            session_id = %trace_session,
            "handle_output_event: acquired flush queue; queuing event",
        );
        // Kept before the line is consumed: it names the turn a Codex run began.
        let turn_started_line = event
            .message
            .contains("\"thread.started\"")
            .then(|| event.message.clone());
        let mut result = flush_queue.queue_output_event(
            &mut connection,
            &provider_invocation_id,
            ProviderOutputEvent {
                session_id: event.session_id.clone(),
                stream: event.stream,
                message: event.message,
                created_at: event.created_at,
            },
        )?;
        tracing::trace!(
            session_id = %trace_session,
            has_delta = result.delta.is_some(),
            "handle_output_event: queue_output_event returned",
        );
        if let Some(provider_conversation_id) = result.provider_conversation_id.take() {
            let session = update_session_provider_conversation_id(
                &connection,
                &event.session_id,
                &provider_conversation_id,
            )?;
            result
                .delta
                .get_or_insert_with(DashboardDelta::default)
                .sessions
                .push(session);
        }
        // Output proves the conversation holds what a rejoin owed it.
        if let Some(delta) = &result.delta {
            if let Err(error) = continuity::note_provider_output(
                &connection,
                &event.session_id,
                delta.events.iter().map(|event| event.r#type.as_str()),
            ) {
                tracing::warn!(session_id = %event.session_id, ?error, "could not settle a rejoined conversation");
            }
        }
        if let Some(line) = turn_started_line {
            if let Err(error) =
                continuity::observe_provider_line(&connection, &event.session_id, &line)
            {
                tracing::warn!(session_id = %event.session_id, ?error, "could not record provider turn");
            }
        }
        drop(flush_queue);
        drop(connection);
        let cursor_turn_finished = result.delta.as_ref().is_some_and(|delta| {
            delta.events.iter().any(|event| {
                event.r#type == "session.completed"
                    && event.payload.get("cursorResultSuccess") == Some(&json!(true))
            })
        });
        if let Some(delta) = result.delta.as_mut() {
            if delta_has_session_completed_event(delta) {
                self.append_reconciled_subagent_events(&event.session_id, delta);
            }
        }
        let reconcile_subagents = result.delta.as_ref().is_some_and(|delta| {
            !delta_has_session_completed_event(delta) && delta_has_subagent_control_event(delta)
        });
        if let Some(delta) = result.delta {
            self.schedule_measured_diffs(&event.session_id, &delta);
            self.schedule_observed_prs(&event.session_id, &delta);
            self.publish(delta);
        }
        if reconcile_subagents {
            self.schedule_subagent_trace_reconciliation(&event.session_id);
        }
        if cursor_turn_finished {
            let service = Arc::clone(&self);
            let session_id = event.session_id.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = service.complete_cursor_turn_after_result(&session_id).await {
                    tracing::warn!(
                        ?error,
                        session_id = %session_id,
                        "cursor turn completion after result/success failed"
                    );
                }
            });
        }
        if result.has_pending_batch {
            self.schedule_batch_flush(&event.session_id);
        } else {
            self.cancel_batch_flush(&event.session_id);
        }
        if result.has_trailing_fragment {
            self.schedule_idle_flush(&event.session_id);
        } else {
            self.cancel_idle_flush(&event.session_id);
        }
        Ok(())
    }

    pub(super) fn handle_lifecycle_event(
        self: &Arc<Self>,
        event: ProviderRuntimeEvent,
    ) -> ArgmaxResult<()> {
        self.cancel_stream_flushes(&event.session_id);
        // A genuine process exit is the one place a Cursor turn that never sent
        // `result/success` should be synthesized as completed — but not when the
        // user cancelled (the session is heading to `cancelled`, not `complete`).
        let is_terminating = self
            .terminating
            .lock_or_recover("terminating")
            .contains(&event.session_id);
        #[cfg(test)]
        if let Some(hook) = self
            .after_lifecycle_marker_check
            .lock_or_recover("lifecycle test hook")
            .clone()
        {
            hook();
        }
        self.flush_trailing(&event.session_id, !is_terminating)?;
        // If the user already initiated terminate(), let cancel_session
        // own the state transition. Writing `failed`/`complete` here
        // would race against (and could clobber) the `cancelled` state
        // the user just saw flash in the dashboard.
        if is_terminating {
            self.handles
                .lock_or_recover("handles")
                .remove(&event.session_id);
            self.flush_queue
                .lock_or_recover("flush queue")
                .delete_session(&event.session_id);
            self.cancel_pending_interactions(&event.session_id)?;
            return Ok(());
        }
        self.capture_pr_branch(&event.session_id);
        let succeeded =
            event.r#type == ProviderRuntimeEventType::Exit && event.exit_code == Some(0);
        let state = if succeeded {
            SessionState::Complete
        } else {
            SessionState::Failed
        };
        let session_id = event.session_id.clone();
        let completed_at = event.created_at.clone();
        let ended = self.commit_turn_end(
            TurnEnd {
                session_id: &session_id,
                state,
                finished_at: &completed_at,
                may_end: |_| true,
                // Stop sets the marker before disposal, so an exit that passed
                // the first check cannot overwrite it.
                yields_to_stop: true,
                remove_handle: true,
                pause_queue: !succeeded,
                reconcile_subagents: true,
            },
            |transaction| {
                let raw_output = persist_raw_output(
                    transaction,
                    &PersistRawOutputInput {
                        id: Uuid::new_v4().to_string(),
                        session_id: event.session_id.clone(),
                        stream: event.stream.as_str().to_string(),
                        content: event.message.clone(),
                        created_at: Some(event.created_at.clone()),
                    },
                )?;
                // For successful exits, persist `session.completed` with an empty
                // message — the wait-thread's raw text ("X structured probe exited
                // with code 0") is debug noise that was leaking into the chat
                // bubble next to the actual assistant response. The exit code
                // stays in the payload for diagnostics, and the raw message is
                // preserved in `raw_outputs` above.
                let (timeline_type, timeline_message) = if succeeded {
                    ("session.completed".to_string(), String::new())
                } else {
                    ("error".to_string(), event.message)
                };
                // Cursor and OpenCode already recorded this turn's completion from
                // their own output; a second `session.completed` from the exit would
                // count the turn twice.
                let already_completed = succeeded
                    && argmax_store::events::turn_completion_recorded(
                        transaction,
                        &event.session_id,
                    )?;
                let events = if already_completed {
                    Vec::new()
                } else {
                    vec![persist_timeline_event(
                        transaction,
                        &PersistTimelineEventInput {
                            id: Uuid::new_v4().to_string(),
                            session_id: event.session_id.clone(),
                            r#type: timeline_type,
                            message: timeline_message,
                            payload: json!({ "exitCode": event.exit_code }),
                            created_at: Some(event.created_at),
                        },
                    )?]
                };
                Ok(TurnRows {
                    events,
                    raw_outputs: vec![raw_output],
                })
            },
        )?;
        let Some(ended) = ended else {
            return Ok(());
        };
        // The drain is what sends a follow-up the user queued during the turn.
        // It must not depend on the approvals cleanup succeeding: an error
        // there used to return early and strand the queue until the next turn.
        let interactions_cancelled = self.cancel_pending_interactions(&session_id);
        self.announce_turn_end(
            &session_id,
            state,
            &completed_at,
            TurnFollowUp {
                settle: true,
                drain_queue: succeeded,
            },
        );
        interactions_cancelled.and(ended.queue_paused)
    }

    /// Cursor's `cursor-agent` often emits `result/success` while the child
    /// process stays alive (same class of bug as the idle-flush comment above).
    /// Mark the session complete and dispose the handle so the UI does not
    /// sit on "Working" / thinking verbs until the user hits Stop.
    pub(super) async fn complete_cursor_turn_after_result(
        self: Arc<Self>,
        session_id: &str,
    ) -> ArgmaxResult<()> {
        if self
            .terminating
            .lock_or_recover("terminating")
            .contains(session_id)
        {
            return Ok(());
        }
        {
            let connection = self.database.connection();
            let session = find_session_by_id(&connection, session_id)?;
            if session.state != SessionState::Running {
                return Ok(());
            }
        }
        self.cancel_stream_flushes(session_id);
        // `result/success` already emitted the completion via the normalizer, so
        // no exit synth here.
        self.flush_trailing(session_id, false)?;

        self.capture_pr_branch(session_id);
        let completed_at = now_iso();
        let ended = self.commit_turn_end(
            TurnEnd {
                session_id,
                state: SessionState::Complete,
                finished_at: &completed_at,
                may_end: |state| state == SessionState::Running,
                yields_to_stop: true,
                remove_handle: true,
                pause_queue: false,
                reconcile_subagents: false,
            },
            |_| Ok(TurnRows::default()),
        )?;
        let Some(ended) = ended else {
            return Ok(());
        };

        // The turn is over here, so its approvals are stale — the exit path
        // clears them at this same point. Like there, a failure must not return
        // early: the queue drain below is what sends a follow-up the user typed
        // during the turn.
        let mut first_error = self.cancel_pending_interactions(session_id).err();
        if let Some(HandleEntry::Resolved(handle)) = ended.handle {
            if let Err(error) = handle.terminate().await {
                let _ = self.abort_session_after_turn(
                    session_id,
                    "Could not move this chat because the Cursor turn did not stop safely.",
                );
                first_error.get_or_insert(error);
            }
        }
        // Cursor ends a turn on `result/success` rather than on a process exit,
        // so this is that provider's only turn-end seam.
        self.announce_turn_end(
            session_id,
            SessionState::Complete,
            &completed_at,
            TurnFollowUp {
                settle: true,
                drain_queue: true,
            },
        );
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
