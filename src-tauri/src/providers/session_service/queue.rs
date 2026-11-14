//! The follow-up queue: enqueue, promote, steer, drain, and the multitask claims on queued rows.

use super::*;

impl ProviderSessionService {
    pub fn cancel_queued_message(
        &self,
        input: ProvidersCancelQueuedMessageInput,
    ) -> ArgmaxResult<()> {
        let session_id = input.session_id.as_str();
        let mut connection = self.database.connection();
        let mut queues = self.queues.lock_or_recover("queues");
        let Some(current) = queues.get(session_id) else {
            return Err(ArgmaxError::service("QUEUED_MESSAGE_NOT_CANCELLABLE", "This follow-up has already left the queue. Check the chat before sending another copy."));
        };
        let mut updated = current.clone();
        updated.retain(|message| message.id != input.message_id.as_str());
        if updated.len() == current.len() {
            return Err(ArgmaxError::service("QUEUED_MESSAGE_NOT_CANCELLABLE", "This follow-up has already left the queue. Check the chat before sending another copy."));
        }
        replace_session_queue(&mut connection, session_id, &updated)?;
        if updated.is_empty() {
            queues.remove(session_id);
        } else {
            queues.insert(session_id.to_string(), updated);
        }
        drop(queues);
        self.publish_pending_messages(session_id);
        Ok(())
    }

    /// Claim a queued follow-up before dispatching it as a multitask. The
    /// promotion guard stays active across the sibling launch so the ordinary
    /// turn-end drain cannot race the prompt into the parent session.
    pub(crate) fn claim_queued_message_for_multitask(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> ArgmaxResult<PendingMessage> {
        if !self
            .queue_promotions
            .lock_or_recover("queue promotions")
            .insert(session_id.to_string())
        {
            return Err(ArgmaxError::service(
                "QUEUED_MESSAGE_SEND_IN_PROGRESS",
                "Another queued follow-up is already being sent. Wait for it to finish.",
            ));
        }
        let claimed = (|| {
            let connection = self.database.connection();
            let mut queues = self.queues.lock_or_recover("queues");
            let queue = queues.get_mut(session_id).ok_or_else(|| {
                ArgmaxError::service(
                    "QUEUED_MESSAGE_NOT_FOUND",
                    "Queued follow-up no longer exists.",
                )
            })?;
            let index = queue
                .iter()
                .position(|message| message.id == message_id)
                .ok_or_else(|| {
                    ArgmaxError::service(
                        "QUEUED_MESSAGE_NOT_FOUND",
                        "Queued follow-up no longer exists.",
                    )
                })?;
            mark_message_launching(&connection, session_id, message_id)?;
            let message = queue
                .remove(index)
                .expect("queued message index must exist");
            if queue.is_empty() {
                queues.remove(session_id);
            }
            Ok(message)
        })();
        let message = match claimed {
            Ok(message) => message,
            Err(error) => {
                self.queue_promotions
                    .lock_or_recover("queue promotions")
                    .remove(session_id);
                return Err(error);
            }
        };
        if origin_row_is_delivered(self, &message) {
            let delete_result = {
                let connection = self.database.connection();
                delete_pending_message(&connection, session_id, message_id)
            };
            self.queue_promotions
                .lock_or_recover("queue promotions")
                .remove(session_id);
            delete_result?;
            self.publish_pending_messages(session_id);
            return Err(ArgmaxError::service(
                "QUEUED_MESSAGE_ALREADY_DELIVERED",
                "This follow-up was already collected from the chat inbox.",
            ));
        }
        self.publish_pending_messages(session_id);
        Ok(message)
    }

    /// Return a cleanly failed multitask dispatch to its durable queue slot.
    /// Reload from SQLite before releasing the promotion guard so concurrent
    /// edits are retained and the turn-end drain cannot claim the row early.
    pub(crate) fn restore_queued_message_multitask(
        &self,
        session_id: &str,
        message: PendingMessage,
    ) -> ArgmaxResult<()> {
        let result = (|| {
            let connection = self.database.connection();
            restore_launching_message(
                &connection,
                session_id,
                &message.id,
                message.recovery_status.as_deref(),
            )?;
            let queue = list_session_pending_messages(&connection, session_id)?;
            self.queues
                .lock_or_recover("queues")
                .insert(session_id.to_string(), queue);
            Ok(())
        })();
        self.queue_promotions
            .lock_or_recover("queue promotions")
            .remove(session_id);
        if result.is_ok() {
            self.publish_pending_messages(session_id);
        }
        result
    }

    /// Finish a successful queued-message multitask promotion. Even if SQLite
    /// cleanup fails, the in-memory row stays absent and the guard is released;
    /// the durable `launching` row then recovers as delivery-uncertain after a
    /// restart instead of becoming runnable again in this process.
    pub(crate) fn finish_queued_message_multitask(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> ArgmaxResult<()> {
        let result = {
            let connection = self.database.connection();
            delete_pending_message(&connection, session_id, message_id)
        };
        self.queue_promotions
            .lock_or_recover("queue promotions")
            .remove(session_id);
        if result.is_ok() {
            self.publish_pending_messages(session_id);
        }
        result
    }

    pub async fn send_queued_message_now(
        self: &Arc<Self>,
        input: ProvidersSendQueuedMessageNowInput,
    ) -> ArgmaxResult<SendInputResult> {
        self.promote_queued_message(input, false).await
    }

    pub(super) fn is_waiting_on_inbox(&self, session_id: &str) -> bool {
        self.session_control
            .as_ref()
            .is_some_and(|registry| registry.is_waiting_on_inbox(session_id))
    }

    pub(super) async fn steer_queued_row(
        self: &Arc<Self>,
        session_id: String,
        message_id: String,
        mid_turn_delivery: MidTurnDelivery,
    ) -> ArgmaxResult<SendInputResult> {
        let input = ProvidersSendQueuedMessageNowInput {
            session_id: SessionId::try_from(session_id).map_err(ArgmaxError::invalid)?,
            message_id: NonEmptyString::try_from(message_id).map_err(ArgmaxError::invalid)?,
            delivery: Some(QueuedMessageDelivery::Steer),
        };
        if mid_turn_delivery != MidTurnDelivery::SteerOrQueue {
            return self.promote_queued_message(input, false).await;
        }
        match self.promote_queued_message(input, true).await {
            Ok(result) => Ok(result),
            // Collected from the inbox, or the ack was lost after the write:
            // either way the model has it, and resending would duplicate it.
            Err(ArgmaxError::ServiceError { sub_code, .. })
                if sub_code == "QUEUED_MESSAGE_ALREADY_DELIVERED"
                    || sub_code == "STEER_DELIVERY_UNKNOWN" =>
            {
                Ok(SendInputResult {
                    ok: true,
                    queued: false,
                })
            }
            // Any other refusal left the row in the ordinary queue (or a
            // drain already took it), so it arrives when the turn ends.
            Err(error) => {
                tracing::debug!(?error, "agent message not steered; queued for turn end");
                Ok(SendInputResult {
                    ok: true,
                    queued: true,
                })
            }
        }
    }

    /// `requeue_on_steer_failure` is for messages no person is watching: a
    /// definite steering failure returns the row to the ordinary queue so it
    /// drains at turn end, instead of parking it unsent for a manual retry.
    pub(super) async fn promote_queued_message(
        self: &Arc<Self>,
        input: ProvidersSendQueuedMessageNowInput,
        requeue_on_steer_failure: bool,
    ) -> ArgmaxResult<SendInputResult> {
        let session_id = input.session_id.as_str().to_string();
        if !self
            .queue_promotions
            .lock_or_recover("queue promotions")
            .insert(session_id.clone())
        {
            return Err(ArgmaxError::service(
                "QUEUED_MESSAGE_SEND_IN_PROGRESS",
                "Another queued follow-up is already being sent. Wait for it to finish.",
            ));
        }
        let queued_message = {
            let connection = self.database.connection();
            let mut queues = self.queues.lock_or_recover("queues");
            if let Some(queue) = queues.get_mut(&session_id) {
                if let Some(index) = queue
                    .iter()
                    .position(|message| message.id == input.message_id.as_str())
                {
                    if let Err(error) =
                        mark_message_launching(&connection, &session_id, input.message_id.as_str())
                    {
                        drop(queues);
                        drop(connection);
                        self.queue_promotions
                            .lock_or_recover("queue promotions")
                            .remove(&session_id);
                        return Err(error);
                    }
                    let message = queue
                        .remove(index)
                        .expect("queued message index must exist");
                    if queue.is_empty() {
                        queues.remove(&session_id);
                    }
                    Some(message)
                } else {
                    None
                }
            } else {
                None
            }
        };
        let Some(message) = queued_message else {
            self.queue_promotions
                .lock_or_recover("queue promotions")
                .remove(&session_id);
            return Err(ArgmaxError::service(
                "QUEUED_MESSAGE_NOT_FOUND",
                "Queued follow-up no longer exists.",
            ));
        };
        let message_id = message.id.clone();

        if origin_row_is_delivered(self, &message) {
            let delete_result = {
                let connection = self.database.connection();
                delete_pending_message(&connection, &session_id, &message_id)
            };
            self.queue_promotions
                .lock_or_recover("queue promotions")
                .remove(&session_id);
            delete_result?;
            self.publish_pending_messages(&session_id);
            return Err(ArgmaxError::service(
                "QUEUED_MESSAGE_ALREADY_DELIVERED",
                "This follow-up was already collected from the chat inbox.",
            ));
        }

        let restore = |service: &Self, message: PendingMessage| -> ArgmaxResult<()> {
            let connection = service.database.connection();
            restore_launching_message(
                &connection,
                &session_id,
                &message.id,
                message.recovery_status.as_deref(),
            )?;
            let queue = list_session_pending_messages(&connection, &session_id)?;
            let mut queues = service.queues.lock_or_recover("queues");
            queues.insert(session_id.clone(), queue);
            drop(queues);
            service.publish_pending_messages(&session_id);
            Ok(())
        };

        if input.delivery == Some(QueuedMessageDelivery::Steer) {
            let mut result = self.steer_queued_message(&session_id, &message).await;
            if let Err(error) = &result {
                let mut message = message;
                if matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "QUEUED_MESSAGE_ALREADY_DELIVERED")
                {
                    let connection = self.database.connection();
                    if let Err(error) =
                        delete_pending_message(&connection, &session_id, &message.id)
                    {
                        result = Err(error);
                    }
                } else {
                    let delivery_unknown = matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "STEER_DELIVERY_UNKNOWN");
                    message.recovery_status = if delivery_unknown {
                        Some("delivery-unknown".to_string())
                    } else if requeue_on_steer_failure {
                        None
                    } else {
                        Some("unsent".to_string())
                    };
                    // A person's unsuccessful steer must never auto-drain as a
                    // new turn; they chose to interrupt, not to wait. An
                    // automatic message only ever wanted to arrive, so it
                    // drains. Stop may have explicitly discarded this row
                    // during delivery.
                    if let Err(restore_error) = restore(self, message) {
                        tracing::warn!(session_id, error = %restore_error, "could not restore steered follow-up");
                    }
                }
            }
            self.queue_promotions
                .lock_or_recover("queue promotions")
                .remove(&session_id);
            self.publish_pending_messages(&session_id);
            self.drain_queue_if_turn_ended(&session_id);
            return result;
        }

        let done = match self.start_termination(session_id.clone(), true) {
            Ok(done) => done,
            Err(error) => {
                self.queue_promotions
                    .lock_or_recover("queue promotions")
                    .remove(&session_id);
                restore(self, message)?;
                return Err(error);
            }
        };
        self.publish_pending_messages(&session_id);
        if let Err(error) = wait_for_termination(done).await {
            self.queue_promotions
                .lock_or_recover("queue promotions")
                .remove(&session_id);
            restore(self, message)?;
            return Err(error);
        }
        if !self
            .queue_promotions
            .lock_or_recover("queue promotions")
            .contains(&session_id)
        {
            // Stop took the promotion away while this send waited for the
            // provider to stop. The row is still marked `launching`, which the
            // composer hides, so put it back like every other failure here.
            // Stop discards the queue as it goes, so the row may already be
            // gone — that is not a failure worth reporting over the cancel.
            if let Err(error) = restore(self, message) {
                tracing::debug!(
                    session_id,
                    error = %error,
                    "queued follow-up was already discarded by Stop"
                );
            }
            return Err(ArgmaxError::service(
                "QUEUED_SEND_CANCELLED",
                "Queued follow-up was cancelled by Stop.",
            ));
        }

        let send_input = match pending_message_to_send_input(session_id.clone(), message.clone()) {
            Ok(send_input) => send_input,
            Err(error) => {
                self.queue_promotions
                    .lock_or_recover("queue promotions")
                    .remove(&session_id);
                restore(self, message)?;
                return Err(error);
            }
        };
        // The row keeps the origin it was queued with: an agent's message sent
        // now must still read "From <agent>" and must not become a person's
        // prompt, which would let it grant chat references.
        let result = match self
            .send_input_authored(send_input, message.origin.clone(), message.author)
            .await
        {
            Ok(result) => result,
            Err(error) => {
                // send_input can reject before the message is persisted as a
                // user.message — an archiving workspace, a refused lifecycle
                // admission, a pending move, a terminating provider. Put the
                // follow-up back instead of losing what the user typed.
                tracing::warn!(
                    session_id,
                    error = %error,
                    "restoring queued follow-up after a failed send"
                );
                self.queue_promotions
                    .lock_or_recover("queue promotions")
                    .remove(&session_id);
                restore(self, message)?;
                return Err(error);
            }
        };
        let promotion_active = self
            .queue_promotions
            .lock_or_recover("queue promotions")
            .remove(&session_id);
        {
            let connection = self.database.connection();
            delete_pending_message(&connection, &session_id, &message_id)?;
        }
        if !promotion_active {
            let done = self.start_termination(session_id.clone(), false)?;
            wait_for_termination(done).await?;
            return Err(ArgmaxError::service(
                "QUEUED_SEND_CANCELLED",
                "Queued follow-up was cancelled by Stop.",
            ));
        }
        Ok(result)
    }

    pub(super) async fn steer_queued_message(
        &self,
        session_id: &str,
        message: &PendingMessage,
    ) -> ArgmaxResult<SendInputResult> {
        let send_generation = self
            .send_generations
            .lock_or_recover("send generations")
            .get(session_id)
            .copied()
            .unwrap_or(0);
        self.ensure_no_pending_after_turn(session_id)?;
        let (handle, prompt, agent_mode, _admission) = {
            let connection = self.database.connection();
            let session = find_session_by_id(&connection, session_id)?;
            if session.state != SessionState::Running {
                return Err(ArgmaxError::service(
                    "STEER_NOT_RUNNING",
                    "The turn has finished. This follow-up is still queued.",
                ));
            }
            if !has_steering_context_headroom(&session) {
                return Err(ArgmaxError::service(
                    "STEER_CONTEXT_COMPACTION",
                    "Codex is close to compacting its context. This follow-up is still queued for the next turn.",
                ));
            }
            let handle = self.live_handle(session_id).ok_or_else(|| {
                ArgmaxError::service("STEER_NOT_RUNNING", "The agent is not ready for steering.")
            })?;
            if !handle.supports_steering() {
                return Err(ArgmaxError::service(
                    "STEER_UNSUPPORTED",
                    "This provider does not support steering the running turn.",
                ));
            }
            if message
                .provider
                .is_some_and(|provider| provider.as_str() != session.provider)
                || message
                    .model_id
                    .as_deref()
                    .is_some_and(|id| !runs_stored_model(&session, id))
                || message
                    .reasoning_effort
                    .as_deref()
                    .is_some_and(|effort| Some(effort) != session.reasoning_effort.as_deref())
            {
                return Err(ArgmaxError::service(
                    "STEER_SETTINGS_CHANGED",
                    "Steering uses the running turn's model and effort. Queue this follow-up or use Stop and send to change them.",
                ));
            }
            let agent_mode = parse_agent_mode(&message.agent_mode).ok_or_else(|| {
                ArgmaxError::service(
                    "STEER_INVALID_MODE",
                    "The queued follow-up has an invalid mode.",
                )
            })?;
            let workspace = find_workspace_by_id(&connection, &session.workspace_id)?;
            if matches!(
                workspace.state.as_str(),
                "archiving" | "archive-failed" | "archived"
            ) {
                return Err(ArgmaxError::service(
                    "WORKSPACE_ARCHIVING",
                    "Workspace archive is in progress; no new provider input can be sent.",
                ));
            }
            let admission = self.lifecycle.admit(&session.workspace_id)?;
            ensure_agent_references_supported(
                &session.provider,
                &session.model_id,
                &message.agent_references,
            )?;
            let prompt = agent_reference_prompt(
                &connection,
                session_id,
                &message.content,
                &message.agent_references,
            )?;
            (handle, prompt, agent_mode, admission)
        };
        let created_at = now_iso();
        let inbox_id = message
            .origin
            .as_ref()
            .and_then(|origin| origin.message_id.as_deref());
        let inbox_created_at: Option<String> = if let Some(id) = inbox_id {
            // Claim the route atomically before touching the provider. Otherwise
            // inbox_read can deliver the same message while we await its echo.
            let claimed = self.database.connection().query_row(
                "UPDATE session_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL RETURNING created_at",
                (&created_at, id),
                |row| row.get(0),
            ).optional().map_err(sqlite_error)?;
            if claimed.is_none() {
                return Err(ArgmaxError::service(
                    "QUEUED_MESSAGE_ALREADY_DELIVERED",
                    "This follow-up was already collected from the chat inbox.",
                ));
            }
            claimed
        } else {
            None
        };
        if let Err(error) = handle.steer(&prompt).await {
            if !matches!(&error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "STEER_DELIVERY_UNKNOWN")
            {
                if let Some(id) = inbox_id {
                    self.database.connection().execute(
                        "UPDATE session_messages SET delivered_at = NULL WHERE id = ? AND delivered_at = ?",
                        (id, &created_at),
                    ).map_err(sqlite_error)?;
                }
            }
            return Err(error);
        }

        // Stop/clear may have completed while the acknowledgement was in flight.
        // Do not append guidance from the old invocation to a fresh conversation.
        let _send_generation = self
            .lock_send_generation(session_id, send_generation)
            .map_err(|_| {
                ArgmaxError::service(
                    "STEER_DELIVERY_UNKNOWN",
                    "Stop interrupted guidance delivery. Check the chat before sending it again.",
                )
            })?;

        // Delivery and the local journal cannot share a transaction. Once the
        // provider acknowledges, any local commit failure is delivery-unknown.
        let persist = || -> ArgmaxResult<TimelineEvent> {
            let mut connection = self.database.connection();
            let transaction = connection.transaction().map_err(sqlite_error)?;
            let mut payload = composer_payload(agent_mode, Some(&message.attachments));
            payload["delivery"] = json!("steer");
            if let Some(origin) = &message.origin {
                payload["origin"] =
                    serde_json::to_value(origin).map_err(argmax_store::json_error)?;
            }
            let event = persist_user_prompt(
                &transaction,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.to_string(),
                    r#type: "user.message".to_string(),
                    message: message.content.clone(),
                    payload,
                    created_at: Some(created_at),
                },
                message.author,
            )?;
            delete_pending_message(&transaction, session_id, &message.id)?;
            transaction.commit().map_err(sqlite_error)?;
            Ok(event)
        };
        let event = persist().map_err(|error| ArgmaxError::service(
            "STEER_DELIVERY_UNKNOWN",
            format!("The agent accepted the guidance, but it could not be saved: {error}. Check the chat before sending again."),
        ))?;
        if let (Some(id), Some(created_at)) = (inbox_id, inbox_created_at) {
            argmax_store::session_messages::log_handover("steer", id, &created_at);
        }
        self.publish(DashboardDelta {
            events: vec![event],
            ..DashboardDelta::default()
        });
        Ok(SendInputResult {
            ok: true,
            queued: false,
        })
    }

    pub(super) fn enqueue_pending_message(
        &self,
        session_id: &str,
        content: &str,
        agent_mode: AgentMode,
        input: &ProvidersSendInput,
        origin: Option<MessageOrigin>,
        author: PromptAuthor,
    ) -> ArgmaxResult<Option<PendingMessage>> {
        let mut connection = self.database.connection();
        // The inbox is visible before send_input can acquire the checkout lock.
        // Collection may therefore finish before there is a queue copy to remove.
        // Keep this check under the writer lock through the queue insertion so
        // collection either wins here or removes the inserted copy afterward.
        if let Some(message_id) = origin
            .as_ref()
            .and_then(|origin| origin.message_id.as_deref())
        {
            if is_message_delivered(&connection, message_id)? {
                return Ok(None);
            }
        }
        let session = find_session_by_id(&connection, session_id)?;
        self.ensure_no_pending_after_turn(session_id)?;
        let mut queues = self.queues.lock_or_recover("queues");
        let mut queue = queues.get(session_id).cloned().unwrap_or_default();
        if queue.len() >= MAX_PENDING_QUEUE {
            return Err(ArgmaxError::service(
                "PENDING_QUEUE_FULL",
                format!("Pending follow-up queue is full ({MAX_PENDING_QUEUE})."),
            ));
        }
        // A provider the sender named is kept on its row whatever the chat or
        // the rows ahead of it are on. Rows drain in order and can be removed
        // or reordered first, so a row that said "Codex" must still say it
        // when the one that switched to Codex is gone. `None` therefore means
        // the sender named no provider.
        let (provider, model_label, model_id, reasoning_effort, fast_mode) =
            if let Some(requested) = input.provider {
                // Refused now, while the sender is still looking, rather than
                // when the row drains with nobody watching.
                let (Some(label), Some(model)) =
                    (input.model_label.as_ref(), input.model_id.as_ref())
                else {
                    return Err(ArgmaxError::service(
                        "SWITCH_PROVIDER_REQUIRES_MODEL",
                        "Naming a provider requires a model for it.",
                    ));
                };
                ensure_permission_mode_supported(
                    requested,
                    parse_permission_mode(&session.permission_mode)?,
                )?;
                (
                    Some(requested),
                    Some(label.as_str().to_string()),
                    Some(model.as_str().to_string()),
                    input
                        .reasoning_effort
                        .map(|value| value.as_str().to_string()),
                    input.fast_mode,
                )
            } else {
                // No provider named: only a model or effort the user actually
                // picked is kept. A send that merely echoes the chat's current
                // model would, once drained after the router (or a goal) moved
                // the chat, read as a pin to the old model.
                let picks_model = input
                    .model_id
                    .as_ref()
                    .is_some_and(|model_id| !runs_stored_model(&session, model_id.as_str()))
                    || input.reasoning_effort.is_some_and(|effort| {
                        Some(effort)
                            != session
                                .reasoning_effort
                                .as_deref()
                                .and_then(parse_reasoning_effort)
                    });
                if picks_model {
                    (
                        None,
                        input
                            .model_label
                            .as_ref()
                            .map(|value| value.as_str().to_string()),
                        input
                            .model_id
                            .as_ref()
                            .map(|value| value.as_str().to_string()),
                        input
                            .reasoning_effort
                            .map(|value| value.as_str().to_string()),
                        input.fast_mode,
                    )
                } else {
                    (None, None, None, None, input.fast_mode)
                }
            };
        let pending = PendingMessage {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            content: content.to_string(),
            agent_mode: agent_mode.as_str().to_string(),
            provider,
            model_label,
            model_id,
            reasoning_effort,
            fast_mode,
            attachments: input.attachments.clone().unwrap_or_default(),
            agent_references: input.agent_references.clone().unwrap_or_default(),
            origin,
            recovery_status: None,
            queued_at: now_iso(),
            author,
        };
        queue.push_back(pending.clone());
        replace_session_queue(&mut connection, session_id, &queue)?;
        queues.insert(session_id.to_string(), queue);
        drop(queues);
        self.publish_pending_messages(session_id);
        Ok(Some(pending))
    }

    pub(super) fn clear_queue(&self, session_id: &str) -> ArgmaxResult<()> {
        let connection = self.database.connection();
        clear_session_queue(&connection, session_id)?;
        let removed = self
            .queues
            .lock_or_recover("queues")
            .remove(session_id)
            .is_some();
        if removed {
            self.publish_pending_messages(session_id);
        }
        Ok(())
    }

    /// Provider failures are not a user request to discard unsent work.
    /// Pause it durably so a later turn cannot silently drain the old queue.
    pub(super) fn pause_queue_with_connection(
        &self,
        connection: &rusqlite::Connection,
        session_id: &str,
    ) -> ArgmaxResult<()> {
        connection
            .execute(
                "UPDATE pending_messages SET delivery_state = 'recovered', updated_at = ?2
             WHERE session_id = ?1 AND delivery_state = 'pending'",
                (session_id, now_iso()),
            )
            .map_err(argmax_store::sqlite_error)?;
        let mut queues = self.queues.lock_or_recover("queues");
        if let Some(queue) = queues.get_mut(session_id) {
            for message in queue {
                if message.recovery_status.is_none() {
                    message.recovery_status = Some("unsent".to_string());
                }
            }
        }
        drop(queues);
        self.publish_pending_messages(session_id);
        Ok(())
    }

    pub fn pending_messages_snapshot(&self) -> BTreeMap<String, Vec<PendingMessage>> {
        self.queues
            .lock_or_recover("queues")
            .iter()
            .map(|(session_id, queue)| (session_id.clone(), queue.iter().cloned().collect()))
            .collect()
    }

    /// Remove the queue copies of inbox messages the agent just collected.
    ///
    /// The persistence helper skips `launching` rows because their sender owns
    /// the in-flight hand-off. Holding the writer until the in-memory queue is
    /// updated keeps a concurrent drain from claiming a row between the two.
    pub fn reconcile_collected_messages(
        &self,
        session_id: &str,
        collected_message_ids: &[String],
    ) -> ArgmaxResult<()> {
        let mut connection = self.database.connection();
        let removed = delete_messages_for_collected_origins(
            &mut connection,
            session_id,
            collected_message_ids,
        )?;
        if removed.is_empty() {
            return Ok(());
        }
        let removed: HashSet<&str> = removed.iter().map(String::as_str).collect();
        let mut queues = self.queues.lock_or_recover("queues");
        if let Some(queue) = queues.get_mut(session_id) {
            queue.retain(|message| !removed.contains(message.id.as_str()));
            if queue.is_empty() {
                queues.remove(session_id);
            }
        }
        drop(queues);
        drop(connection);
        self.publish_pending_messages(session_id);
        Ok(())
    }

    pub(super) fn publish_pending_messages(&self, session_id: &str) {
        let queue = self
            .queues
            .lock_or_recover("queues")
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        let mut pending_messages = BTreeMap::new();
        pending_messages.insert(session_id.to_string(), queue.into_iter().collect());
        self.publish(DashboardDelta {
            pending_messages: Some(pending_messages),
            ..DashboardDelta::default()
        });
    }

    /// A follow-up can be queued against a process that has just exited:
    /// `send_input` saw the live handle, then the exit handler removed it,
    /// wrote the terminal state, and drained a still-empty queue before the
    /// enqueue landed. Nothing would send that message until the next turn.
    /// So once a message is queued, look again: no handle and a settled
    /// session means the turn is over, and the queue drains now. A drain that
    /// races this one pops under the same lock and finds the queue empty.
    pub(super) fn drain_queue_if_turn_ended(self: &Arc<Self>, session_id: &str) {
        if self
            .handles
            .lock_or_recover("handles")
            .contains_key(session_id)
        {
            return;
        }
        let state = {
            let connection = self.database.connection();
            find_session_by_id(&connection, session_id).map(|session| session.state)
        };
        // A session still mid-turn, or one we could not read, keeps its queue:
        // the drain belongs to whoever ends the turn.
        if matches!(state, Ok(state) if state.is_settled()) {
            self.drain_queue_after_complete(session_id.to_string());
        }
    }

    pub(super) fn drain_queue_after_complete(self: &Arc<Self>, session_id: String) {
        let next = match self.pop_next_undelivered(&session_id) {
            Ok(Some(next)) => next,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(session_id, ?error, "failed to claim pending follow-up");
                return;
            }
        };
        self.publish_pending_messages(&session_id);
        let service = Arc::clone(self);
        // Keep a copy so a launch failure can restore the message instead of
        // silently dropping it after the UI already showed the queue drained.
        let restore = next.clone();
        let restore_session = session_id.clone();
        tauri::async_runtime::spawn(async move {
            // The recipient may have collected this very message between the
            // pop and this task running. Re-check: sending a turn for a row
            // that was already handed over through the inbox would deliver it
            // twice.
            if origin_row_is_delivered(&service, &next) {
                let connection = service.database.connection();
                if let Err(error) = delete_pending_message(&connection, &restore_session, &next.id)
                {
                    tracing::warn!(
                        session_id = %restore_session,
                        ?error,
                        "failed to delete collected pending follow-up"
                    );
                    return;
                }
                drop(connection);
                service.drain_queue_after_complete(restore_session);
                return;
            }
            let origin = next.origin.clone();
            let author = next.author;
            let inbox_row = origin.as_ref().and_then(|origin| origin.message_id.clone());
            let send_input = match pending_message_to_send_input(session_id, next) {
                Ok(input) => input,
                Err(error) => {
                    tracing::warn!(
                        session_id = %restore_session,
                        ?error,
                        "dropping invalid queued follow-up"
                    );
                    let connection = service.database.connection();
                    if let Err(delete_error) =
                        delete_pending_message(&connection, &restore_session, &restore.id)
                    {
                        tracing::warn!(
                            session_id = %restore_session,
                            ?delete_error,
                            "failed to delete invalid pending follow-up"
                        );
                    }
                    return;
                }
            };
            match service
                .send_input_authored(send_input, origin, author)
                .await
            {
                // The queue's whole reason to exist is that the recipient was
                // busy; this is the moment the wait ends. Closing the inbox row
                // here is what the immediate path already does on its own
                // `!queued` branch — without it the row stays open forever, so
                // every later tool result flags unread mail and `inbox_read`
                // hands the agent a message it has just taken as a turn.
                Ok(result) if !result.queued => {
                    let connection = service.database.connection();
                    if let Err(error) =
                        delete_pending_message(&connection, &restore_session, &restore.id)
                    {
                        tracing::warn!(
                            session_id = %restore_session,
                            ?error,
                            "failed to finish pending follow-up delivery"
                        );
                    }
                    if let Some(id) = inbox_row {
                        if let Err(error) = mark_message_delivered(&connection, &id) {
                            tracing::warn!(
                                session_id = %restore_session,
                                ?error,
                                "failed to mark a drained follow-up delivered"
                            );
                        }
                    }
                }
                // A turn started between the pop and the send, so this is
                // pending under a fresh queue id. The claimed row is complete.
                Ok(_) => {
                    let connection = service.database.connection();
                    if let Err(error) =
                        delete_pending_message(&connection, &restore_session, &restore.id)
                    {
                        tracing::warn!(
                            session_id = %restore_session,
                            ?error,
                            "failed to replace a raced pending follow-up"
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        session_id = %restore_session,
                        ?error,
                        "failed to launch queued follow-up; restoring it to the queue"
                    );
                    {
                        let connection = service.database.connection();
                        let restore_result = restore_launching_message(
                            &connection,
                            &restore_session,
                            &restore.id,
                            restore.recovery_status.as_deref(),
                        )
                        .and_then(|_| list_session_pending_messages(&connection, &restore_session));
                        let mut queues = service.queues.lock_or_recover("queues");
                        match restore_result {
                            Ok(queue) => {
                                queues.insert(restore_session.clone(), queue);
                            }
                            Err(persist_error) => {
                                tracing::error!(
                                    session_id = %restore_session,
                                    ?persist_error,
                                    "failed to restore pending follow-up after launch failure"
                                );
                            }
                        }
                    }
                    service.publish_pending_messages(&restore_session);
                }
            }
        });
    }

    /// Pop the next follow-up worth sending: one whose inbox row, if it has
    /// one, has not been collected. A message the recipient read mid-turn
    /// through `inbox_read` is dropped here rather than also arriving as a
    /// turn — and popping continues to the message behind it, since no turn
    /// will start to trigger the next drain.
    pub(super) fn pop_next_undelivered(
        &self,
        session_id: &str,
    ) -> ArgmaxResult<Option<PendingMessage>> {
        loop {
            let next = {
                let connection = self.database.connection();
                let mut queues = self.queues.lock_or_recover("queues");
                if self
                    .queue_promotions
                    .lock_or_recover("queue promotions")
                    .contains(session_id)
                {
                    return Ok(None);
                }
                let Some(queue) = queues.get_mut(session_id) else {
                    return Ok(None);
                };
                // Recovered items require explicit user action, but they do
                // not block newer in-process follow-ups from draining.
                let Some(index) = queue
                    .iter()
                    .position(|message| message.recovery_status.is_none())
                else {
                    return Ok(None);
                };
                let message_id = queue[index].id.clone();
                mark_message_launching(&connection, session_id, &message_id)?;
                let next = queue.remove(index);
                if queue.is_empty() {
                    queues.remove(session_id);
                }
                next
            };
            let Some(next) = next else {
                return Ok(None);
            };
            if !origin_row_is_delivered(self, &next) {
                return Ok(Some(next));
            }
            tracing::info!(
                session_id,
                message_id = next
                    .origin
                    .as_ref()
                    .and_then(|origin| origin.message_id.as_deref()),
                "dropping a queued follow-up the recipient already collected from its inbox"
            );
            let connection = self.database.connection();
            delete_pending_message(&connection, session_id, &next.id)?;
            self.publish_pending_messages(session_id);
        }
    }
}
