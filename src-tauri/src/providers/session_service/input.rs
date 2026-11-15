//! Sending to a running chat: follow-ups, steering, routed sends, and resize.

use super::*;
use crate::providers::turn_waterfall;

impl ProviderSessionService {
    /// A follow-up no person typed into the composer (internal callers, tests).
    /// Its chat references grant nothing.
    pub async fn send_input(
        self: &Arc<Self>,
        input: ProvidersSendInput,
    ) -> ArgmaxResult<SendInputResult> {
        self.send_input_authored(input, None, PromptAuthor::unattested())
            .await
    }

    /// The composer's follow-up: fresh text the person wrote.
    pub async fn send_input_as_person(
        self: &Arc<Self>,
        input: ProvidersSendInput,
        attestation: PersonAttestation,
        waterfall_origin: Option<turn_waterfall::OriginToken>,
    ) -> ArgmaxResult<SendInputResult> {
        self.send_input_scoped(
            input,
            None,
            None,
            TurnStarter::Person,
            Queueing::Allowed,
            MidTurnDelivery::Queue,
            PromptAuthor::person(attestation),
            waterfall_origin,
        )
        .await
    }

    /// Deliver a composer follow-up as guidance inside an active turn. This
    /// uses the durable pending-message machinery first, then promotes that
    /// exact row to a steer, so a failed native delivery remains visible for
    /// retry rather than silently losing the user's text.
    pub async fn steer_input(
        self: &Arc<Self>,
        input: ProvidersSendInput,
    ) -> ArgmaxResult<SendInputResult> {
        self.steer_input_authored(input, PromptAuthor::unattested())
            .await
    }

    pub async fn steer_input_as_person(
        self: &Arc<Self>,
        input: ProvidersSendInput,
        attestation: PersonAttestation,
    ) -> ArgmaxResult<SendInputResult> {
        self.steer_input_authored(input, PromptAuthor::person(attestation))
            .await
    }

    pub(super) async fn steer_input_authored(
        self: &Arc<Self>,
        input: ProvidersSendInput,
        author: PromptAuthor,
    ) -> ArgmaxResult<SendInputResult> {
        self.send_input_scoped(
            input,
            None,
            None,
            TurnStarter::Person,
            Queueing::Allowed,
            MidTurnDelivery::Steer,
            author,
            None,
        )
        .await
    }

    /// The same turn, tagged with the session that wrote it. Everything the
    /// user's composer does goes through `send_input` with no origin; the
    /// agent tools and the completion notice pass one, and it rides all the
    /// way to the persisted `user.message` payload — including through the
    /// queue, when the recipient turns out to be mid-turn.
    pub async fn send_input_with_origin(
        self: &Arc<Self>,
        input: ProvidersSendInput,
        origin: Option<MessageOrigin>,
    ) -> ArgmaxResult<SendInputResult> {
        self.send_input_authored(input, origin, PromptAuthor::unattested())
            .await
    }

    /// Deliver a queued row (drain, Send now): it keeps the origin and the
    /// author the sender had when it was queued, so none of those actions can
    /// make an agent's text a person's or the reverse.
    pub(super) async fn send_input_authored(
        self: &Arc<Self>,
        input: ProvidersSendInput,
        origin: Option<MessageOrigin>,
        author: PromptAuthor,
    ) -> ArgmaxResult<SendInputResult> {
        self.send_input_scoped(
            input,
            origin,
            None,
            TurnStarter::Person,
            Queueing::Allowed,
            MidTurnDelivery::Queue,
            author,
            None,
        )
        .await
    }

    /// A message addressed to this session by another session, or a notice
    /// Argmax writes on one's behalf. A running Claude, Codex or OpenCode turn takes it
    /// as steering; every other provider, and a turn that cannot be steered
    /// right now, gets it when the turn ends. `queued` is false once the
    /// message reached the model either way.
    pub async fn send_agent_message(
        self: &Arc<Self>,
        input: ProvidersSendInput,
        origin: MessageOrigin,
    ) -> ArgmaxResult<SendInputResult> {
        self.send_input_scoped(
            input,
            Some(origin),
            None,
            TurnStarter::Person,
            Queueing::Allowed,
            MidTurnDelivery::SteerOrQueue,
            PromptAuthor::unattested(),
            None,
        )
        .await
    }

    pub async fn send_goal_input(
        self: &Arc<Self>,
        input: ProvidersSendInput,
        identity: GoalTurnIdentity,
    ) -> ArgmaxResult<SendInputResult> {
        self.send_input_scoped(
            input,
            None,
            Some(identity),
            TurnStarter::Goal,
            Queueing::Refused,
            MidTurnDelivery::Queue,
            PromptAuthor::unattested(),
            None,
        )
        .await
    }

    /// The turn a session move starts in its destination: the prompt the moving
    /// agent wrote, queued like any follow-up. Tagged so it is not mistaken for
    /// something the person typed.
    pub async fn send_moved_input(
        self: &Arc<Self>,
        input: ProvidersSendInput,
    ) -> ArgmaxResult<SendInputResult> {
        self.send_input_scoped(
            input,
            None,
            None,
            TurnStarter::Move,
            Queueing::Allowed,
            MidTurnDelivery::Queue,
            PromptAuthor::unattested(),
            None,
        )
        .await
    }

    /// A scheduled task's turn in a chat it shares. Like a goal turn it is
    /// refused rather than queued while the chat is mid-turn; the scheduler
    /// leaves the row due and takes the next tick.
    pub async fn send_scheduled_input(
        self: &Arc<Self>,
        input: ProvidersSendInput,
    ) -> ArgmaxResult<SendInputResult> {
        self.send_input_scoped(
            input,
            None,
            None,
            TurnStarter::Schedule,
            Queueing::Refused,
            MidTurnDelivery::Queue,
            PromptAuthor::unattested(),
            None,
        )
        .await
    }

    /// Decides Auto routing for an idle follow-up; `apply_auto_follow_up`
    /// applies it once the send is admitted. `None` for a chat the router does
    /// not drive. A chat the user pinned by picking another model stops being
    /// routed. Otherwise Jev classifies the message (only when `classify`) and
    /// the break-even rule decides (routing/reroute.rs). A classifier failure
    /// or a missing key leaves the follow-up on its model.
    pub(super) async fn route_follow_up(
        &self,
        input: &ProvidersSendInput,
        message: &str,
        classify: bool,
    ) -> ArgmaxResult<Option<AutoFollowUp>> {
        let session_id = input.session_id.as_str();
        let session = find_session_by_id(&self.database.read_connection(), session_id)?;
        let Some(tier) = session
            .auto_tier
            .as_deref()
            .and_then(crate::routing::parse_tier)
        else {
            return Ok(None);
        };
        let current_provider = parse_provider(&session.provider)?;
        let current_effort = session
            .reasoning_effort
            .as_deref()
            .and_then(parse_reasoning_effort);
        // A follow-up with no model (an agent's message, a script) carries no
        // override, so the router may still act on it.
        let pinned = input
            .model_id
            .as_ref()
            .is_some_and(|model_id| !runs_stored_model(&session, model_id.as_str()))
            || input
                .provider
                .is_some_and(|provider| provider != current_provider)
            || input
                .reasoning_effort
                .is_some_and(|effort| Some(effort) != current_effort);
        if pinned {
            // Not a turn and not a switch: the row only closes the last
            // route's window for the Router cost card.
            return Ok(Some(AutoFollowUp::Pinned(
                argmax_contracts::routing::RouteDecision {
                    tier,
                    provider: input.provider.unwrap_or(current_provider),
                    model_id: input
                        .model_id
                        .as_ref()
                        .map_or_else(|| session.model_id.clone(), |id| id.as_str().to_string()),
                    model_label: input.model_label.as_ref().map_or_else(
                        || session.model_label.clone(),
                        |label| label.as_str().to_string(),
                    ),
                    effort: input.reasoning_effort.or(current_effort),
                    kind: None,
                    difficulty: None,
                    kind_confidence: None,
                    difficulty_confidence: None,
                    decision: argmax_contracts::routing::RouteDecisionKind::Pinned,
                    reason: "user picked a model".to_string(),
                    signals: None,
                },
            )));
        }
        if !classify {
            return Ok(Some(AutoFollowUp::Routed(None, Box::new(session))));
        }
        let retained = |reason: &str| {
            Some(AutoFollowUp::Routed(
                Some(argmax_contracts::routing::RouteDecision {
                    tier,
                    provider: current_provider,
                    model_id: session.model_id.clone(),
                    model_label: session.model_label.clone(),
                    effort: current_effort,
                    kind: None,
                    difficulty: None,
                    kind_confidence: None,
                    difficulty_confidence: None,
                    decision: argmax_contracts::routing::RouteDecisionKind::Kept,
                    reason: reason.to_string(),
                    signals: None,
                }),
                Box::new(session.clone()),
            ))
        };
        let api_key = match crate::routing::api_key::read_key() {
            Ok(Some(api_key)) => api_key,
            Ok(None) => {
                return Ok(retained(
                    "Routing key unavailable, retaining the current model and effort",
                ));
            }
            Err(error) => {
                tracing::warn!(target: "argmax::routing", "routing key read failed: {error}");
                return Ok(retained(
                    "Routing key could not be read, retaining the current model and effort",
                ));
            }
        };
        // Discovery and bounded transcript reads must not block the async
        // runtime. A context failure is a retained route, never a failed send.
        let database = self.database.clone();
        let context_session_id = session_id.to_string();
        let context_message = message.to_string();
        let context_workspace_id = session.workspace_id.clone();
        let context = tauri::async_runtime::spawn_blocking(move || {
            let connection = database.read_connection();
            let workspace = find_workspace_by_id(&connection, &context_workspace_id)?;
            crate::routing::context::build_follow_up_context(
                &connection,
                &context_session_id,
                &context_message,
                current_provider,
                Some(std::path::Path::new(&workspace.path)),
            )
        })
        .await;
        let context = match context {
            Ok(Ok(context)) => context,
            _ => {
                return Ok(retained(
                    "Follow-up context unavailable, retaining the current model and effort",
                ))
            }
        };
        let classification = match crate::routing::jev::classify_follow_up(&context, &api_key).await
        {
            Ok(classification) => classification,
            Err(error) => {
                tracing::warn!(target: "argmax::routing", session_id, "follow-up not routed: {error}");
                return Ok(retained(
                    "Follow-up classifier unavailable, retaining the current model and effort",
                ));
            }
        };
        let last_turn = argmax_store::turn_routes::last_turn_usage(
            &self.database.read_connection(),
            session_id,
        )?;
        let available = self.available_providers().await;
        let state = crate::routing::reroute::FollowUpState {
            tier,
            provider: current_provider,
            available,
            model_id: ModelId::resolve(current_provider, &session.model_id),
            effort: current_effort,
            context_tokens: session.context_tokens.max(0) as u64,
            last_turn,
            // Jev sees text only. Referenced agents and attachments can carry
            // material task scope that the bounded text does not describe.
            downgrade_safe: context.downgrade_safe
                && input.attachments.as_ref().is_none_or(Vec::is_empty)
                && input.agent_references.as_ref().is_none_or(Vec::is_empty),
            resume_target: context
                .routes
                .iter()
                .find(|route| {
                    Some(route.id.as_str()) == classification.resume_route.as_deref()
                        && route.provider == current_provider
                        && route.user_task.is_some()
                })
                .and_then(|route| {
                    crate::routing::table::route_model(&route.model_id).map(|model| {
                        crate::routing::table::RoutedModel {
                            model,
                            effort: route.effort.and_then(|effort| {
                                crate::routing::table::clamp_effort(effort, model)
                            }),
                        }
                    })
                }),
            idle: Some(elapsed_since(&session.last_activity_at)),
        };
        Ok(Some(AutoFollowUp::Routed(
            Some(crate::routing::reroute::follow_up_route(
                &state,
                &classification,
            )),
            Box::new(session),
        )))
    }

    // The send's whole shape is one call; grouping the knobs would only move them.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn send_input_scoped(
        self: &Arc<Self>,
        input: ProvidersSendInput,
        origin: Option<MessageOrigin>,
        goal_turn: Option<GoalTurnIdentity>,
        starter: TurnStarter,
        queueing: Queueing,
        mid_turn_delivery: MidTurnDelivery,
        author: PromptAuthor,
        waterfall_origin: Option<turn_waterfall::OriginToken>,
    ) -> ArgmaxResult<SendInputResult> {
        // A message another session sent is never the person's own text, so a
        // send that claims both is a bug in the caller, not something to
        // quietly downgrade.
        if author.is_person() && (origin.is_some() || !matches!(starter, TurnStarter::Person)) {
            return Err(ArgmaxError::service(
                "PROMPT_AUTHOR_CONFLICT",
                "A person's prompt cannot carry another session's origin or a system starter.",
            ));
        }
        let session_id = input.session_id.as_str().to_string();
        let message = input.input.as_str().trim().to_string();
        if message.is_empty() {
            return Ok(SendInputResult {
                ok: true,
                queued: false,
            });
        }
        let send_generation = self
            .send_generations
            .lock_or_recover("send generations")
            .get(&session_id)
            .copied()
            .unwrap_or(0);
        self.ensure_no_pending_after_turn(&session_id)?;

        let (
            workspace_id,
            session_provider,
            session_permission_mode,
            session_agent_mode,
            steering_context_headroom,
        ) = {
            let _send_generation = self.lock_send_generation(&session_id, send_generation)?;
            let connection = self.database.connection();
            let session = find_session_by_id(&connection, &session_id)?;
            if let Some(goal_turn) = goal_turn.as_ref() {
                ensure_goal_turn_admitted(&connection, &session_id, goal_turn)?;
            }
            let target_provider = input.provider.unwrap_or(parse_provider(&session.provider)?);
            let target_model_id = input
                .model_id
                .as_ref()
                .map(|model_id| model_id.as_str())
                .unwrap_or(&session.model_id);
            ensure_agent_references_supported(
                target_provider.as_str(),
                target_model_id,
                input.agent_references.as_deref().unwrap_or_default(),
            )?;
            if session.imported {
                // Continuing an imported session is what adopts it: from here
                // it is an ordinary session and the sync pruner leaves it
                // alone, however the sync settings change.
                if argmax_store::synced::mark_synced_session_adopted(&connection, &session_id)? {
                    tracing::info!(session_id = %session_id, "imported session adopted");
                }
            }
            let steering_context_headroom = has_steering_context_headroom(&session);
            (
                session.workspace_id,
                parse_provider(&session.provider)?,
                parse_permission_mode(&session.permission_mode)?,
                session.agent_mode.as_deref().and_then(parse_agent_mode),
                steering_context_headroom,
            )
        };
        // A queued row without a mode of its own (an agent's message, a
        // notice) keeps the chat's mode, the same fallback a relaunch uses.
        // Queued as `auto`, it could never steer a plan-mode turn.
        let queued_agent_mode = input
            .agent_mode
            .or(session_agent_mode)
            .unwrap_or(AgentMode::Auto);
        if self
            .termination_jobs
            .lock_or_recover("termination jobs")
            .contains_key(&session_id)
            || self
                .terminating
                .lock_or_recover("terminating")
                .contains(&session_id)
        {
            return Err(ArgmaxError::service(
                "PROVIDER_TERMINATING",
                "Provider chat is being terminated; wait for cancellation to finish.",
            ));
        }
        #[cfg(test)]
        let test_gate = self
            .send_input_test_gate
            .lock_or_recover("send input test gate")
            .clone();
        #[cfg(test)]
        if let Some(gate) = test_gate {
            gate.reached.notify_one();
            gate.release.notified().await;
        }
        // Auto chats may move to another model or effort for this turn. Jev is
        // a network call, so it runs before the checkout lock, and only for a
        // send headed for a relaunch: one with a live or starting provider is
        // steered or queued, and a queued row is routed when it drains.
        let auto_follow_up = if goal_turn.is_none()
            && !self
                .handles
                .lock_or_recover("handles")
                .contains_key(&session_id)
        {
            Some(self.route_follow_up(&input, &message, true).await?)
        } else {
            None
        };
        let mut input = input;
        if matches!(&auto_follow_up, Some(Some(AutoFollowUp::Routed(_, _)))) {
            // These fields were echoes, not user pins. Another admitted send
            // may change the route while Jev runs or this send waits for the
            // checkout. A queued copy must classify using the dispatch state.
            input.provider = None;
            input.model_id = None;
            input.model_label = None;
            input.reasoning_effort = None;
        }
        // Stop may have completed while this send was between its initial
        // session read and checkout admission. Reject that generation before
        // touching a checkout that the cancelled send no longer owns.
        drop(self.lock_send_generation(&session_id, send_generation)?);
        ensure_permission_mode_supported(session_provider, session_permission_mode)?;
        let admission = self.lifecycle.admit(&workspace_id)?;
        let workspace_path = {
            let connection = self.database.connection();
            let workspace = find_workspace_by_id(&connection, &workspace_id)?;
            if matches!(
                workspace.state.as_str(),
                "archiving" | "archive-failed" | "archived"
            ) {
                return Err(ArgmaxError::service(
                    "WORKSPACE_ARCHIVING",
                    "Workspace archive is in progress; no new provider input can be sent.",
                ));
            }
            PathBuf::from(workspace.path)
        };
        let checkout_lock = checkout_write_lock(&workspace_path).await?;
        let checkout_guard = checkout_lock.lock().await;
        let admitted_at = std::time::Instant::now();
        if let Some(goal_turn) = goal_turn.as_ref() {
            let connection = self.database.read_connection();
            ensure_goal_turn_admitted(&connection, &session_id, goal_turn)?;
        }

        let send_generation_guard = self.lock_send_generation(&session_id, send_generation)?;
        if let Some(handle) = self.live_handle(&session_id) {
            if !handle.accepts_input() {
                if queueing == Queueing::Refused {
                    return Err(turn_in_flight_error());
                }
                let Some(pending) = self.enqueue_pending_message(
                    &session_id,
                    &message,
                    queued_agent_mode,
                    &input,
                    origin,
                    author,
                )?
                else {
                    return Ok(SendInputResult {
                        ok: true,
                        queued: false,
                    });
                };
                drop(send_generation_guard);
                drop(admission);
                let steer = match mid_turn_delivery {
                    MidTurnDelivery::Queue => false,
                    MidTurnDelivery::Steer => steering_context_headroom,
                    MidTurnDelivery::SteerOrQueue => {
                        steering_context_headroom
                            && handle.supports_steering()
                            && !self.is_waiting_on_inbox(&session_id)
                    }
                };
                if steer {
                    return Box::pin(self.steer_queued_row(
                        session_id,
                        pending.id,
                        mid_turn_delivery,
                    ))
                    .await;
                }
                self.drain_queue_if_turn_ended(&session_id);
                return Ok(SendInputResult {
                    ok: true,
                    queued: true,
                });
            }
            let prompt = {
                let connection = self.database.connection();
                agent_reference_prompt(
                    &connection,
                    &session_id,
                    &message,
                    input.agent_references.as_deref().unwrap_or_default(),
                )?
            };
            turn_waterfall::admit(&self.database, &session_id, admitted_at, waterfall_origin);
            self.mark_turn_start(&session_id, workspace_path);
            turn_waterfall::mark_typed_input(&session_id);
            handle.send_input(&format!("{}\r", prompt));
            turn_waterfall::stamp(&session_id, turn_waterfall::Stamp::PromptWritten);
            let persisted = self.persist_user_message(
                &session_id,
                &message,
                input.agent_mode.unwrap_or(AgentMode::Auto),
                input.attachments.as_deref(),
                origin.as_ref(),
                author,
            );
            // Typing into a live terminal has no turn-end event to wait for,
            // and the terminal's echo is not the provider answering.
            turn_waterfall::turn_ended(&self.database, &session_id);
            persisted?;
            drop(send_generation_guard);
            drop(admission);
            return Ok(SendInputResult {
                ok: true,
                queued: false,
            });
        }

        // The session still owns an entry we cannot route through: the process
        // is either not up yet (Pending) or already gone — the runtime marks a
        // handle disposed before it emits Exit, so the whole exit teardown runs
        // with a Resolved-but-dead handle in the map. Either way we must NOT
        // fall through to the relaunch path below: it would double-spawn, and
        // in the exit window the teardown then removes that fresh entry and its
        // flush queue, dropping every event of the new turn. Queue the message;
        // it drains after the in-flight turn completes, exactly like a follow-up
        // sent while the agent is working.
        if matches!(
            self.handles.lock_or_recover("handles").get(&session_id),
            Some(HandleEntry::Pending(_)) | Some(HandleEntry::Resolved(_))
        ) {
            let Some(pending) = self.enqueue_pending_message(
                &session_id,
                &message,
                queued_agent_mode,
                &input,
                origin,
                author,
            )?
            else {
                return Ok(SendInputResult {
                    ok: true,
                    queued: false,
                });
            };
            drop(send_generation_guard);
            drop(admission);
            // No live provider to steer into: an automatic message just waits.
            if mid_turn_delivery == MidTurnDelivery::Steer && steering_context_headroom {
                return Box::pin(self.steer_queued_row(session_id, pending.id, mid_turn_delivery))
                    .await;
            }
            self.drain_queue_if_turn_ended(&session_id);
            return Ok(SendInputResult {
                ok: true,
                queued: true,
            });
        }
        drop(send_generation_guard);

        // The provider went away after routing was skipped for it: settle the
        // pin without classifying, so the user's pick still ends Auto.
        let auto_follow_up = match auto_follow_up {
            Some(auto_follow_up) => auto_follow_up,
            None if goal_turn.is_none() => self.route_follow_up(&input, &message, false).await?,
            None => None,
        };
        let admitted_session = find_session_by_id(&self.database.read_connection(), &session_id)?;
        let auto_route = apply_auto_follow_up(&mut input, auto_follow_up, &admitted_session)?;
        let send_generation_guard = self.lock_send_generation(&session_id, send_generation)?;
        let (provider, launch_input, pending_results) = {
            let connection = self.database.connection();
            let mut session = find_session_by_id(&connection, &session_id)?;
            let workspace = find_workspace_by_id(&connection, &session.workspace_id)?;
            let agent_mode = input
                .agent_mode
                .or_else(|| session.agent_mode.as_deref().and_then(parse_agent_mode))
                .unwrap_or(AgentMode::Auto);
            // A provider override that differs from the session's current
            // provider switches the agent for this turn: persist the new provider
            // + model, drop the (provider-specific) native resume id, and relaunch
            // fresh — context survives via the visible transcript in the prompt.
            let current_provider = parse_provider(&session.provider)?;
            let switched_provider = input
                .provider
                .filter(|requested| *requested != current_provider);
            let mut switch_event = None;
            if let Some(requested_provider) = switched_provider {
                let (Some(model_label), Some(model_id)) =
                    (input.model_label.as_ref(), input.model_id.as_ref())
                else {
                    return Err(ArgmaxError::service(
                        "SWITCH_PROVIDER_REQUIRES_MODEL",
                        "Switching provider requires a model for the new provider.",
                    ));
                };
                session = update_session_provider(
                    &connection,
                    &session_id,
                    &SessionProviderInput {
                        provider: requested_provider.as_str().to_string(),
                        model_label: model_label.as_str().to_string(),
                        model_id: model_id.as_str().to_string(),
                        reasoning_effort: input
                            .reasoning_effort
                            .map(|effort| effort.as_str().to_string()),
                    },
                )?;
                switch_event = Some(persist_timeline_event(
                    &connection,
                    &PersistTimelineEventInput {
                        id: Uuid::new_v4().to_string(),
                        session_id: session_id.clone(),
                        r#type: "session.provider-changed".to_string(),
                        message: format!(
                            "Switched provider to {}.",
                            get_provider_definition(requested_provider).display_name
                        ),
                        // The chat surface renders this seam from the payload:
                        // it names both ends of the handoff and the model the
                        // new provider is picking up with.
                        payload: json!({
                            "from": current_provider.as_str(),
                            "provider": requested_provider.as_str(),
                            "modelLabel": model_label.as_str(),
                        }),
                        created_at: None,
                    },
                )?);
            } else if let (Some(model_label), Some(model_id)) =
                (&input.model_label, &input.model_id)
            {
                session = update_session_model(
                    &connection,
                    &session_id,
                    &SessionModelInput {
                        model_label: model_label.as_str().to_string(),
                        model_id: model_id.as_str().to_string(),
                        reasoning_effort: input
                            .reasoning_effort
                            .map(|effort| effort.as_str().to_string()),
                    },
                )?;
            }
            // Recorded only now that the send is admitted, so a send Stop
            // cancelled leaves no route behind for the chip or the hysteresis.
            if let Some(route) = &auto_route {
                argmax_store::turn_routes::record_route(&connection, &session_id, route)?;
                if route.decision == argmax_contracts::routing::RouteDecisionKind::Pinned {
                    argmax_store::turn_routes::clear_auto_tier(&connection, &session_id)?;
                }
            }
            if session.agent_mode.as_deref() != Some(agent_mode.as_str()) {
                session = update_session_agent_mode(
                    &connection,
                    &session_id,
                    &SessionAgentModeInput {
                        agent_mode: agent_mode.as_str().to_string(),
                    },
                )?;
            }
            let provider = parse_provider(&session.provider)?;
            let permission_mode = parse_permission_mode(&session.permission_mode)?;
            ensure_permission_mode_supported(provider, permission_mode)?;
            // A just-switched session starts the new provider fresh, or rejoins
            // the conversation it parked there; never resurrect a stale Cursor
            // resume id from an earlier Cursor segment.
            if switch_event.is_none()
                && provider == ProviderId::Cursor
                && session.provider_conversation_id.is_none()
                && continuity::may_infer_cursor_conversation(&connection, &session_id)?
            {
                if let Some(provider_conversation_id) =
                    infer_cursor_provider_conversation_id(&connection, &session_id)?
                {
                    session = update_session_provider_conversation_id(
                        &connection,
                        &session_id,
                        &provider_conversation_id,
                    )?;
                }
            }
            let mut plan = continuity::plan_launch(
                &connection,
                &mut session,
                provider,
                std::path::Path::new(&workspace.path),
                switch_event.is_some(),
            )?;
            // A switch NULLs the resume id, so a missing id also carries the
            // switched-agent case: no rollout on the other side, rebuild the
            // context from the visible transcript. A binding rejoined after a
            // switch sends only what it missed.
            let launch_prompt = compose_follow_up_prompt_since(
                &connection,
                &session_id,
                &message,
                plan.resume_conversation_id.is_some(),
                plan.since_event_id.as_deref(),
            )?;
            let agent_references = input.agent_references.as_deref().unwrap_or_default();
            let launch_prompt =
                agent_reference_prompt(&connection, &session_id, &launch_prompt, agent_references)?;
            // Composed before the current message is persisted, so the retry
            // prompt cannot carry it twice. Native agent references only make
            // sense inside the native conversation, so they get no retry.
            let fallback_prompt = (plan.needs_fallback_prompt && agent_references.is_empty())
                .then(|| compose_follow_up_prompt(&connection, &session_id, &message, false))
                .transpose()?;
            // A multitask that finished while this session was busy is told to
            // the agent here, on the front of the prompt — never as a turn of
            // its own. The person's own message is persisted unchanged: the
            // timeline already carries the finish marker.
            let pending_results = crate::multitask::results_preamble(&connection, &session_id)?;
            let (launch_prompt, fallback_prompt) = match &pending_results {
                Some(results) => (
                    format!("{}\n\n{launch_prompt}", results.block),
                    fallback_prompt.map(|prompt| format!("{}\n\n{prompt}", results.block)),
                ),
                None => (launch_prompt, fallback_prompt),
            };
            plan.continuity.fresh_fallback_prompt = fallback_prompt;
            turn_waterfall::admit(&self.database, &session_id, admitted_at, waterfall_origin);
            let user_message = self.persist_user_message_locked(
                &connection,
                &session_id,
                &message,
                agent_mode,
                input.attachments.as_deref(),
                TurnAuthorship {
                    origin: origin.as_ref(),
                    starter,
                    author,
                },
            )?;
            let running_session = update_session_state(
                &connection,
                &session_id,
                &SessionStateInput::transition(SessionState::Running),
            )?;
            let running_workspace = update_workspace_state_for_session_state(
                &connection,
                &workspace.id,
                SessionState::Running,
            )?;
            self.publish(DashboardDelta {
                projects: list_projects(&connection)?,
                workspaces: vec![running_workspace],
                sessions: vec![running_session.clone()],
                events: switch_event.into_iter().chain([user_message]).collect(),
                ..DashboardDelta::default()
            });
            let launch_input = ProviderLaunchInput {
                provider,
                session_id: session_id.clone(),
                workspace_path: PathBuf::from(workspace.path),
                prompt: launch_prompt,
                model_label: session.model_label.clone(),
                model_id: ModelId::resolve(provider, &session.model_id),
                reasoning_effort: session
                    .reasoning_effort
                    .as_deref()
                    .and_then(parse_reasoning_effort),
                fast_mode: input.fast_mode,
                // A forked session's first resume must diverge into a new
                // provider conversation; the flag is cleared once the new
                // conversation id lands.
                resume_fork: plan.resume_fork,
                resume_conversation_id: plan.resume_conversation_id,
                permission_mode,
                agent_mode,
                cols: STRUCTURED_LAUNCH_COLS,
                rows: STRUCTURED_LAUNCH_ROWS,
                continuity: (plan.continuity != LaunchContinuity::default())
                    .then_some(plan.continuity),
            };
            (provider, launch_input, pending_results)
        };

        let provider_invocation_id = Uuid::new_v4().to_string();
        self.flush_queue
            .lock_or_recover("flush queue")
            .initialize_session(
                session_id.clone(),
                provider,
                provider_invocation_id.clone(),
                {
                    let context = NormalizerSessionContext::for_provider(
                        provider,
                        usage_model_id(provider, &launch_input.model_id),
                    );
                    if provider == ProviderId::Codex
                        && launch_input.resume_conversation_id.is_some()
                    {
                        // A resumed thread gets a fresh app-server, whose token
                        // counters start at zero like any other turn's, so the
                        // baseline is zero too. Seeding it from what the session
                        // has already spent — which the old CLI transport needed,
                        // because there the totals really were thread-cumulative —
                        // subtracts the whole conversation from one follow-up and
                        // bills it as nothing.
                        context.resuming_codex(
                            launch_input.resume_conversation_id.clone(),
                            Some(CodexCumulativeUsage::default()),
                        )
                    } else if launch_input.resume_conversation_id.is_some() {
                        context.resuming()
                    } else {
                        context
                    }
                },
            );
        self.mark_turn_start(&session_id, workspace_path);
        // Claim the entry before releasing this send's generation. Stop either
        // invalidates the generation before the database writes above, or waits
        // and then finds this Pending entry so the spawn disposes its child.
        {
            let jobs = self.termination_jobs.lock_or_recover("termination jobs");
            let terminating = self.terminating.lock_or_recover("terminating");
            if jobs.contains_key(&session_id) || terminating.contains(&session_id) {
                return Err(ArgmaxError::service(
                    "PROVIDER_TERMINATING",
                    "Provider chat is being terminated; wait for cancellation to finish.",
                ));
            }
            self.handles.lock_or_recover("handles").insert(
                session_id.clone(),
                HandleEntry::Pending(PendingLaunch::default()),
            );
        }
        drop(checkout_guard);
        drop(send_generation_guard);
        // Same background spawn as `launch`: the user.message and running
        // state are already persisted and broadcast, so the composer can
        // clear as soon as this returns. Waiting on the PTY/CLI here is
        // what made follow-up Enter feel lagged.
        let results_session_id = session_id.clone();
        self.spawn_provider_in_background(
            session_id,
            provider,
            launch_input,
            provider_invocation_id,
            admission,
            move |service| {
                // The prompt carrying them reached the provider, so the
                // results are spent. Marking them while the preamble was
                // built would have lost them to a launch that then failed.
                if let Some(results) = &pending_results {
                    let connection = service.database.connection();
                    if let Err(error) =
                        crate::multitask::mark_results_delivered(&connection, &results.ids)
                    {
                        tracing::warn!(
                            session_id = %results_session_id,
                            ?error,
                            "failed to mark multitask results delivered"
                        );
                    }
                }
            },
        );
        Ok(SendInputResult {
            ok: true,
            queued: false,
        })
    }

    pub fn resize(&self, input: ProvidersResizeInput) {
        let session_id = input.session_id.as_str();
        let entry = self
            .handles
            .lock_or_recover("handles")
            .get_mut(session_id)
            .cloned();
        match entry {
            Some(HandleEntry::Resolved(handle)) if !handle.disposed() => {
                handle.resize(input.cols.get(), input.rows.get())
            }
            Some(HandleEntry::Pending(_)) => {
                let mut handles = self.handles.lock_or_recover("handles");
                if let Some(HandleEntry::Pending(launch)) = handles.get_mut(session_id) {
                    let ops = &mut launch.ops;
                    ops.retain(|op| !matches!(op, PendingOp::Resize { .. }));
                    ops.push(PendingOp::Resize {
                        cols: input.cols.get(),
                        rows: input.rows.get(),
                    });
                }
            }
            _ => {}
        }
    }
}
