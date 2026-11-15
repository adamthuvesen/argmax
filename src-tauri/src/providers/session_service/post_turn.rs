//! After a turn ends: scheduled after-turn actions, launcher and arc records, and completion notices.

use super::*;

impl ProviderSessionService {
    /// A queued follow-up and a scheduled disposal contradict each other: the
    /// follow-up expects the chat to still be here after this turn.
    pub fn ensure_after_turn_schedulable(
        &self,
        session_id: &str,
        action: AfterTurn,
    ) -> ArgmaxResult<()> {
        if self
            .queues
            .lock_or_recover("queues")
            .get(session_id)
            .is_some_and(|queue| !queue.is_empty())
        {
            return Err(match action {
                AfterTurn::Move => ArgmaxError::service(
                    "MOVE_HAS_QUEUED_MESSAGES",
                    "Send or cancel queued follow-ups before moving this chat.",
                ),
                AfterTurn::Archive => ArgmaxError::service(
                    "ARCHIVE_HAS_QUEUED_MESSAGES",
                    "Send or cancel queued follow-ups before archiving this chat.",
                ),
                AfterTurn::RemoveCheckout => ArgmaxError::service(
                    "ARCHIVE_HAS_QUEUED_MESSAGES",
                    "Send or cancel queued follow-ups before removing this chat's checkout.",
                ),
            });
        }
        Ok(())
    }

    pub(super) fn ensure_no_pending_after_turn(&self, session_id: &str) -> ArgmaxResult<()> {
        let Some(pending) = self
            .session_control
            .as_ref()
            .and_then(|registry| registry.pending_after_turn(session_id))
        else {
            return Ok(());
        };
        Err(match pending {
            AfterTurn::Move => ArgmaxError::service(
                "MOVE_ALREADY_PENDING",
                "This chat is moving after the current turn. New follow-ups are disabled.",
            ),
            AfterTurn::Archive => ArgmaxError::service(
                "ARCHIVE_ALREADY_PENDING",
                "This chat is archiving after the current turn. New follow-ups are disabled.",
            ),
            // Same code as an archive: the scheduler treats both as "the chat
            // is going away".
            AfterTurn::RemoveCheckout => ArgmaxError::service(
                "ARCHIVE_ALREADY_PENDING",
                "This chat's checkout is removed after the current turn. The chat stays listed, read-only. New follow-ups are disabled.",
            ),
        })
    }

    pub(super) fn settle_session_after_turn(&self, session_id: &str) {
        if let Some(registry) = self.session_control.as_ref() {
            registry.signal_turn_settled(session_id);
        }
    }

    /// Says on the chat that the turn ended before its message reached the
    /// model, so the bubble above it is not a question anyone is answering.
    ///
    /// Codex runs a context compaction ahead of ingesting the turn's input and
    /// emits nothing while it runs; a Stop in that window leaves the thread
    /// with no user message for the turn at all. Without this line the chat
    /// shows a sent message, a stop, and no reason the next turn acts as
    /// though it was never asked.
    pub(super) fn note_undelivered_turn_input(&self, session_id: &str) {
        let written = {
            let connection = self.database.connection();
            find_session_by_id(&connection, session_id).and_then(|session| {
                let event = persist_timeline_event(
                    &connection,
                    &PersistTimelineEventInput {
                        id: Uuid::new_v4().to_string(),
                        session_id: session_id.to_string(),
                        r#type: "session.note".to_string(),
                        message:
                            "Stopped before the agent read this message — it was compacting its \
                             context. Send it again."
                                .to_string(),
                        payload: json!({ "operation": "turn.input-undelivered" }),
                        created_at: None,
                    },
                )?;
                Ok((session, event))
            })
        };
        match written {
            Ok((session, event)) => self.publish(DashboardDelta {
                sessions: vec![session],
                events: vec![event],
                ..DashboardDelta::default()
            }),
            Err(error) => tracing::warn!(
                session_id,
                ?error,
                "could not record that a stopped turn never delivered its input"
            ),
        }
    }

    /// Says on the chat that the disposal it was promised is off. The turn's
    /// own failure is already an error row, so this line is a notice about the
    /// promise rather than a second failure to act on.
    pub(super) fn abort_session_after_turn(
        &self,
        session_id: &str,
        message: &str,
    ) -> ArgmaxResult<()> {
        let Some(registry) = self.session_control.as_ref() else {
            return Ok(());
        };
        let Some(pending) = registry.pending_after_turn(session_id) else {
            return Ok(());
        };
        registry.cancel_after_turn(session_id);
        let (session, event) = {
            let connection = self.database.connection();
            let session = find_session_by_id(&connection, session_id)?;
            let event = persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.to_string(),
                    r#type: "session.note".to_string(),
                    message: message.to_string(),
                    payload: json!({ "operation": match pending {
                        AfterTurn::Move => "session.move",
                        AfterTurn::Archive => "workspace.archive",
                        AfterTurn::RemoveCheckout => "pr.cleanup",
                    } }),
                    created_at: None,
                },
            )?;
            (session, event)
        };
        self.publish(DashboardDelta {
            sessions: vec![session],
            events: vec![event],
            ..DashboardDelta::default()
        });
        Ok(())
    }

    /// Arc and multitask writes are lifecycle effects. Ordinary completion
    /// notices are independent policy and may fail without blocking the queue.
    pub(super) fn notify_launcher_of_turn_end(
        self: &Arc<Self>,
        session_id: &str,
        state: SessionState,
        at: &str,
    ) {
        if let Err(error) = self.record_arc_turn_end(session_id, state, at) {
            tracing::warn!(
                session_id,
                ?error,
                "failed to record the arc timeline row for a turn end"
            );
        }
        if matches!(
            session_launch_kind(&self.database.connection(), session_id).as_deref(),
            Ok(LAUNCH_KIND_MULTITASK)
        ) {
            self.record_multitask_finish(session_id, state, at);
            return;
        }
        if let Err(error) = self.completion_notices.turn_ended(session_id, state, at) {
            tracing::warn!(
                session_id,
                ?error,
                "failed to prepare the completion notice"
            );
        }
    }

    /// The Arc timeline's view of a turn end. A member's turn becomes a
    /// `member_finished` row carrying the opening of its answer. A
    /// coordinator's turn leaves a row only when it changed `NOTES.md`: the
    /// coordinator wakes on every notice, and a turn that wrote nothing down
    /// is not part of the Arc's story. Keyed by the turn end, so Cursor's
    /// second turn-end report writes nothing new.
    pub(super) fn record_arc_turn_end(
        &self,
        session_id: &str,
        state: SessionState,
        at: &str,
    ) -> ArgmaxResult<()> {
        let arc = {
            let connection = self.database.connection();
            match arcs::find_session_arc(&connection, session_id)? {
                Some(arc) => arc,
                None => return Ok(()),
            }
        };
        let is_coordinator = arc.coordinator_session_id.as_deref() == Some(session_id);
        // Read outside the database lock: the notes file can be large.
        let notes = is_coordinator
            .then(|| std::fs::read_to_string(arcs::notes_path(&arc)).ok())
            .flatten();

        let connection = self.database.connection();
        let session = find_session_by_id(&connection, session_id)?;
        let workspace = find_workspace_by_id(&connection, &session.workspace_id)?;
        let answer = latest_agent_message(&connection, session_id)?.unwrap_or_default();

        if is_coordinator {
            let Some(notes) = notes else {
                return Ok(());
            };
            let Some(before) = arcs::notes_snapshot(&connection, &arc.id)? else {
                // An Arc from before the timeline: start diffing from here.
                return arcs::set_notes_snapshot(&connection, &arc.id, &notes);
            };
            let Some(change) = argmax_store::arc_events::notes_change(&before, &notes) else {
                return Ok(());
            };
            let mut event = NewArcEvent::new(
                format!("notes:{session_id}:{at}"),
                &arc.id,
                ArcEventKind::NotesUpdated,
                change
                    .first_new_line
                    .clone()
                    .unwrap_or_else(|| "Notes updated".to_string()),
            );
            event.occurred_at = Some(at.to_string());
            event.session_id = Some(session_id);
            event.project_id = Some(&workspace.project_id);
            event.status = Some(format!("+{} −{}", change.added, change.removed));
            event.detail = Some(argmax_store::arc_events::first_paragraph(&answer));
            record_arc_event(&connection, &event)?;
            return arcs::set_notes_snapshot(&connection, &arc.id, &notes);
        }

        let label = workspace.task_label.trim();
        let mut event = NewArcEvent::new(
            format!("finished:{session_id}:{at}"),
            &arc.id,
            ArcEventKind::MemberFinished,
            if label.is_empty() {
                "Member chat"
            } else {
                label
            },
        );
        event.occurred_at = Some(at.to_string());
        event.session_id = Some(session_id);
        event.project_id = Some(&workspace.project_id);
        event.status = Some(state.as_str().to_string());
        event.detail = Some(argmax_store::arc_events::first_paragraph(&answer));
        record_arc_event(&connection, &event)?;
        Ok(())
    }

    /// Passive delivery of a finished multitask: a timeline row the parent's
    /// chat renders as a tail marker, plus the inbox row `inbox_read` and the
    /// next prompt's preamble pick up. No turn is started.
    pub(super) fn record_multitask_finish(&self, session_id: &str, state: SessionState, at: &str) {
        let (parent_id, event) =
            match crate::multitask::record_finished(&self.database, session_id, state, at) {
                Ok(Some(recorded)) => recorded,
                Ok(None) => return,
                Err(error) => {
                    tracing::warn!(
                        session_id,
                        ?error,
                        "failed to record the finished multitask"
                    );
                    return;
                }
            };
        if let Some(registry) = self.session_control.as_ref() {
            registry.notify_inbox(&parent_id);
        }
        // The parent is not otherwise touched by this turn ending, so its
        // timeline row needs its own delta to reach the renderer.
        let connection = self.database.connection();
        let Ok(parent) = find_session_by_id(&connection, &parent_id) else {
            return;
        };
        drop(connection);
        self.publish(DashboardDelta {
            sessions: vec![parent],
            events: vec![event],
            ..DashboardDelta::default()
        });
    }

    pub(super) async fn deliver_notice(self: Arc<Self>, notice: CompletionNotice) {
        let input = match (
            SessionId::try_from(notice.to_session_id.clone()),
            Prompt::try_from(notice.body),
        ) {
            (Ok(session_id), Ok(input)) => ProvidersSendInput {
                submitted_at_ms: None,
                agent_references: None,
                session_id,
                input,
                provider: None,
                model_label: None,
                model_id: None,
                reasoning_effort: None,
                fast_mode: false,
                agent_mode: None,
                attachments: None,
            },
            _ => return,
        };
        match self.send_agent_message(input, notice.origin).await {
            // Only a notice that actually reached the launcher as a turn has
            // been delivered. One that queued behind a running turn has not,
            // and stays collectable from the inbox — the same rule an agent's
            // own message follows in `session_control`.
            Ok(result) if !result.queued => {
                let connection = self.database.connection();
                if let Err(error) = mark_message_delivered(&connection, &notice.message_id) {
                    tracing::warn!(?error, "failed to mark a completion notice delivered");
                }
            }
            Ok(_) => {}
            // The row stays undelivered, so `inbox_read` still hands it over.
            Err(error) => tracing::warn!(
                to_session_id = %notice.to_session_id,
                ?error,
                "could not start a turn with the completion notice"
            ),
        }
    }

    /// A message from Argmax itself rather than another session — no sender
    /// session, just a body and a caller-chosen origin label/session for the
    /// "From <label>" bubble and the click-to-open target (a related session
    /// the reader would want to jump to, not necessarily who "wrote" this).
    /// Used by the gh poller's Arc PR/CI events, on the same delivery path
    /// `session_message` and the completion notice use: the row lands in
    /// `session_messages` before delivery is attempted, so `inbox_read` and
    /// `session_wait` see it even when the turn below only queues.
    ///
    /// `message_id` is the caller's dedup key — a deterministic id an
    /// `INSERT OR IGNORE` makes idempotent across ticks and restarts. Returns
    /// `false` without sending anything when that id was already inserted.
    /// Returns `Err` when the send itself failed — the insert is rolled back
    /// first, so a caller checking whether this id's row exists sees a clean
    /// "not delivered" rather than a row that looks successful.
    pub async fn send_system_notice(
        self: &Arc<Self>,
        message_id: String,
        to_session_id: &str,
        origin_session_id: String,
        origin_label: String,
        body: String,
    ) -> ArgmaxResult<bool> {
        let inserted = {
            let connection = self.database.connection();
            insert_session_message(
                &connection,
                &NewSessionMessage {
                    id: message_id.clone(),
                    from_session_id: None,
                    to_session_id: to_session_id.to_string(),
                    body: body.clone(),
                    kind: MESSAGE_KIND.to_string(),
                },
            )?
        };
        if !inserted {
            return Ok(false);
        }
        if let Some(registry) = self.session_control.as_ref() {
            registry.notify_inbox(to_session_id);
        }
        let (Ok(session_id), Ok(input)) = (
            SessionId::try_from(to_session_id.to_string()),
            Prompt::try_from(body),
        ) else {
            return Ok(true);
        };
        let send_input = ProvidersSendInput {
            submitted_at_ms: None,
            agent_references: None,
            session_id,
            input,
            provider: None,
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: false,
            agent_mode: None,
            attachments: None,
        };
        let origin = MessageOrigin {
            session_id: origin_session_id,
            label: origin_label,
            kind: MESSAGE_KIND.to_string(),
            message_id: Some(message_id.clone()),
        };
        match self.send_agent_message(send_input, origin).await {
            // Only a notice that actually reached the recipient as a turn has
            // been delivered; one still queued has not, and stays collectable
            // from the inbox — the same rule the completion notice follows.
            Ok(result) if !result.queued => {
                let connection = self.database.connection();
                if let Err(error) = mark_message_delivered(&connection, &message_id) {
                    tracing::warn!(?error, "failed to mark a system notice delivered");
                }
                Ok(true)
            }
            Ok(_) => Ok(true),
            // A genuine send failure leaves nothing behind: an inserted-but-
            // never-delivered row would be indistinguishable from a delivered
            // one to a caller checking existence (the gh poller's Arc event
            // fallback does exactly that), so roll the insert back before
            // propagating the error.
            Err(error) => {
                tracing::warn!(
                    to_session_id,
                    ?error,
                    "could not start a turn with a system notice"
                );
                let connection = self.database.connection();
                if let Err(delete_error) =
                    delete_undelivered_session_message(&connection, &message_id)
                {
                    tracing::warn!(
                        ?delete_error,
                        "failed to roll back an undelivered system notice"
                    );
                }
                Err(error)
            }
        }
    }
}
