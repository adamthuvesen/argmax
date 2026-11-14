//! Starting a provider turn: the launch paths and the background spawn.

use super::*;

impl ProviderSessionService {
    /// A launch whose prompt no person typed (check-failure follow-ups, tests).
    /// Its chat references grant nothing.
    pub async fn launch(
        self: &Arc<Self>,
        input: ProvidersLaunchInput,
    ) -> ArgmaxResult<SessionSummary> {
        self.launch_with_session_id(input, None, PromptAuthor::unattested())
            .await
    }

    /// The composer's launch: the opening prompt is the person's own.
    pub async fn launch_as_person(
        self: &Arc<Self>,
        input: ProvidersLaunchInput,
        attestation: PersonAttestation,
    ) -> ArgmaxResult<SessionSummary> {
        self.launch_with_session_id(input, None, PromptAuthor::person(attestation))
            .await
    }

    /// `session_id` is for a caller that recorded the id before launching (a
    /// launch receipt), so a crash leaves a record that names the session.
    pub async fn launch_with_session_id(
        self: &Arc<Self>,
        input: ProvidersLaunchInput,
        session_id: Option<String>,
        author: PromptAuthor,
    ) -> ArgmaxResult<SessionSummary> {
        let initial_goal = match input.goal_condition.as_deref() {
            Some(condition) => {
                let goals = self.goals.get().and_then(Weak::upgrade).ok_or_else(|| {
                    ArgmaxError::service(
                        "GOAL_SERVICE_NOT_READY",
                        "Goal service is not initialized",
                    )
                })?;
                let config = GoalService::validate_config(condition, input.goal_max_turns)?;
                Some((goals, config))
            }
            None if input.goal_max_turns.is_some() => {
                return Err(ArgmaxError::service(
                    "GOAL_INVALID_CONDITION",
                    "goalMaxTurns requires goalCondition.",
                ));
            }
            None => None,
        };
        let session_id = session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let agent_mode = input.agent_mode.unwrap_or(AgentMode::Auto);
        let permission_mode = input
            .permission_mode
            .unwrap_or(PermissionMode::ProviderDefaults);
        let provider = input.provider;
        ensure_permission_mode_supported(provider, permission_mode)?;
        let admission = self.lifecycle.admit(input.workspace_id.as_str())?;
        let checkout_path = {
            let connection = self.database.read_connection();
            find_workspace_by_id(&connection, input.workspace_id.as_str())?.path
        };
        let checkout_lock = checkout_write_lock(std::path::Path::new(&checkout_path)).await?;
        let checkout_guard = checkout_lock.lock().await;

        let (session, workspace_path, goal, delta) = {
            let mut connection = self.database.connection();
            let transaction = connection.transaction().map_err(sqlite_error)?;
            let workspace = find_workspace_by_id(&transaction, input.workspace_id.as_str())?;
            if matches!(
                workspace.state.as_str(),
                "archiving" | "archive-failed" | "archived"
            ) {
                return Err(ArgmaxError::service(
                    "WORKSPACE_ARCHIVING",
                    "Workspace archive is in progress; no new provider can be started.",
                ));
            }
            // Checked here, inside the same write transaction the session
            // insert below runs in, rather than by a caller that queried the
            // caps before this transaction opened: SQLite's single writer
            // serialises two concurrent launches racing the cap, since only
            // one of them can hold the write lock when the count is taken,
            // and the other sees this session already counted against it.
            if let Some(arc_id) = input.arc_id.as_deref() {
                arcs::check_launch_caps(&transaction, arc_id, input.arc_is_coordinator_launch)?;
            }
            let mut session = persist_session(
                &transaction,
                &PersistSessionInput {
                    id: session_id.clone(),
                    workspace_id: workspace.id.clone(),
                    provider: provider.as_str().to_string(),
                    model_label: input.model_label.as_str().to_string(),
                    model_id: input.model_id.as_str().to_string(),
                    reasoning_effort: input
                        .reasoning_effort
                        .map(|effort| effort.as_str().to_string()),
                    permission_mode: Some(permission_mode.as_wire().to_string()),
                    agent_mode: Some(agent_mode.as_str().to_string()),
                    prompt: input.prompt.as_str().to_string(),
                    state: SessionState::Running,
                },
            )?;
            if let Some(arc_id) = input.arc_id.as_deref() {
                record_session_arc(&transaction, &session_id, arc_id)?;
                session.arc_id = Some(arc_id.to_string());
                // The coordinator's own launch is recorded as
                // `coordinator_started` by whoever points the Arc at it.
                if !input.arc_is_coordinator_launch {
                    let label = workspace.task_label.trim();
                    let mut event = NewArcEvent::new(
                        format!("launched:{session_id}"),
                        arc_id,
                        ArcEventKind::MemberLaunched,
                        if label.is_empty() {
                            "Member chat"
                        } else {
                            label
                        },
                    );
                    event.occurred_at = Some(session.started_at.clone());
                    event.session_id = Some(&session_id);
                    event.project_id = Some(&workspace.project_id);
                    record_arc_event(&transaction, &event)?;
                }
            }
            // Claude and Grok are both handed `--session-id <our id>`, so the
            // CLI conversation is known before a single event arrives. Seeding
            // it here is what lets the very next turn resume: without it the
            // follow-up launches fresh and loses the history.
            if matches!(provider, ProviderId::Claude | ProviderId::Grok) {
                session = update_session_provider_conversation_id(
                    &transaction,
                    &session_id,
                    &session_id,
                )?;
            }
            let workspace = update_workspace_state_for_session_state_within_transaction(
                &transaction,
                &workspace.id,
                SessionState::Running,
            )?;
            let user_message = persist_user_prompt(
                &transaction,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.clone(),
                    r#type: "user.message".to_string(),
                    message: input.prompt.as_str().to_string(),
                    payload: composer_payload(agent_mode, input.attachments.as_deref()),
                    created_at: None,
                },
                author,
            )?;
            let session_started = persist_timeline_event(
                &transaction,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.clone(),
                    r#type: "session.started".to_string(),
                    message: format!("{} session started.", provider.as_str()),
                    payload: json!({
                        "provider": provider.as_str(),
                        "workspacePath": workspace.path,
                        "modelLabel": input.model_label.as_str(),
                        "agentMode": agent_mode.as_str(),
                        "providerConversationId": session.provider_conversation_id,
                    }),
                    created_at: None,
                },
            )?;
            let goal = initial_goal
                .as_ref()
                .map(|(goals, config)| {
                    goals.insert_initial_goal(&transaction, &workspace.id, &session.id, config)
                })
                .transpose()?;
            let delta = DashboardDelta {
                projects: list_projects(&transaction)?,
                workspaces: vec![workspace.clone()],
                sessions: vec![session.clone()],
                events: vec![user_message, session_started],
                ..DashboardDelta::default()
            };
            transaction.commit().map_err(sqlite_error)?;
            (session, PathBuf::from(workspace.path), goal, delta)
        };
        self.publish(delta);

        if let (Some((goals, _)), Some(goal)) = (initial_goal.as_ref(), goal.as_ref()) {
            goals.start_initial_goal(goal);
        }

        let provider_invocation_id = Uuid::new_v4().to_string();
        let launch_model_id = ModelId::resolve(provider, input.model_id.as_str());
        self.flush_queue
            .lock_or_recover("flush queue")
            .initialize_session(
                session_id.clone(),
                provider,
                provider_invocation_id.clone(),
                NormalizerSessionContext::for_provider(
                    provider,
                    usage_model_id(provider, &launch_model_id),
                ),
            );
        self.mark_turn_start(&session_id, workspace_path.clone());
        self.handles
            .lock_or_recover("handles")
            .insert(session_id.clone(), HandleEntry::Pending(Vec::new()));
        drop(checkout_guard);

        let launch_input = ProviderLaunchInput {
            provider,
            session_id: session_id.clone(),
            workspace_path,
            prompt: input.prompt.as_str().to_string(),
            model_label: input.model_label.as_str().to_string(),
            model_id: launch_model_id,
            reasoning_effort: input.reasoning_effort,
            fast_mode: input.fast_mode,
            resume_conversation_id: None,
            resume_fork: false,
            continuity: None,
            permission_mode,
            agent_mode,
            cols: input.cols.get(),
            rows: input.rows.get(),
        };
        // Spawn the provider process in the background instead of awaiting it
        // here. The session row, user.message, and session.started are already
        // persisted and broadcast above, so returning now lets the renderer
        // switch to the chat view instantly — the PTY/CLI spawn (hundreds of ms
        // on a cold launch) no longer blocks the IPC response. The Pending
        // handle inserted above keeps send_input queueing (not relaunching) and
        // resize buffering until the handle resolves; a terminate during the
        // window removes the Pending entry, which the spawn task treats as
        // cancellation and disposes the child.
        self.spawn_provider_in_background(
            session_id,
            provider,
            launch_input,
            provider_invocation_id,
            admission,
            |_| {},
        );
        Ok(session)
    }

    /// Drive the PTY/CLI spawn off the IPC caller. `launch` and idle follow-up
    /// `send_input` both persist the turn first, then return while this task
    /// finishes spawning. Hundreds of ms of process start must not hold the
    /// composer open. The Pending handle inserted by the caller queues later
    /// input and resize until this resolves; terminate removes that entry,
    /// which this task treats as cancellation and disposes the child.
    pub(super) fn spawn_provider_in_background(
        self: &Arc<Self>,
        session_id: String,
        provider: ProviderId,
        launch_input: ProviderLaunchInput,
        provider_invocation_id: String,
        admission: WorkspaceAdmission,
        on_launched: impl FnOnce(&Arc<Self>) + Send + 'static,
    ) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            // Keep the workspace admission through the real provider spawn
            // and handle registration. Archive must not remove the worktree
            // while a cold launcher still owns its current directory.
            let _admission = admission;
            let event_service = Arc::clone(&service);
            let callback_invocation_id = provider_invocation_id.clone();
            // One fresh retry exists only for a native resume or fork the
            // provider definitely refused before it admitted the turn.
            let fresh_retry = continuity::fresh_retry_input(&launch_input);
            let rejected_conversation = launch_input.resume_conversation_id.clone();
            let launch_result = async {
                service.capture_before_provider_turn(&session_id).await?;
                if !matches!(
                    service.handles.lock_or_recover("handles").get(&session_id),
                    Some(HandleEntry::Pending(_))
                ) {
                    return Err(ArgmaxError::service(
                        "PROVIDER_LAUNCH_CANCELLED",
                        "The turn was cancelled before launch.",
                    ));
                }
                let on_event: crate::providers::runtime::EventCallback = Arc::new(move |event| {
                    let event_service = Arc::clone(&event_service);
                    event_service.handle_provider_event(event, callback_invocation_id.clone());
                });
                match service
                    .launcher
                    .launch(launch_input, Arc::clone(&on_event))
                    .await
                {
                    Err(error) if continuity::is_definite_rejection(&error) => {
                        let (Some(retry), Some(rejected)) = (fresh_retry, rejected_conversation)
                        else {
                            return Err(error);
                        };
                        tracing::warn!(
                            session_id = %session_id,
                            "provider rejected the native resume; retrying once fresh"
                        );
                        continuity::record_resume_rejected(
                            &service.database.connection(),
                            &retry,
                            &rejected,
                        )?;
                        service.launcher.launch(retry, on_event).await
                    }
                    other => other,
                }
            }
            .await;
            let handle = match launch_result {
                Ok(handle) => handle,
                Err(error) => {
                    let prior = service
                        .handles
                        .lock_or_recover("handles")
                        .remove(&session_id);
                    // Only flip to `failed` if the session was still pending; if
                    // terminate already removed the entry, it's cancelled and
                    // must not be overwritten with a failure.
                    if matches!(prior, Some(HandleEntry::Pending(_))) {
                        if let Err(persist_error) =
                            service.record_launch_failure(&session_id, provider, error)
                        {
                            tracing::error!(
                                ?persist_error,
                                "failed to record provider launch failure"
                            );
                        }
                    }
                    return;
                }
            };
            on_launched(&service);
            // Swap the Pending entry for the resolved handle. Keep the lock
            // scoped to this block so it's released before any await below.
            let pending_ops = {
                let mut handles = service.handles.lock_or_recover("handles");
                match handles.insert(
                    session_id.clone(),
                    HandleEntry::Resolved(Arc::clone(&handle)),
                ) {
                    Some(HandleEntry::Pending(ops)) => Some(ops),
                    // The Pending entry is gone — terminate() removed it while
                    // the process was spawning. Drop our Resolved insertion so
                    // the handle can be disposed below (outside the lock).
                    _ => {
                        handles.remove(&session_id);
                        None
                    }
                }
            };
            let Some(pending_ops) = pending_ops else {
                // Cancelled during spawn: dispose the freshly spawned handle so
                // the provider process doesn't run orphaned.
                if let Err(error) = handle.terminate().await {
                    tracing::error!(?error, "failed to dispose handle cancelled during spawn");
                }
                return;
            };
            for op in pending_ops {
                match op {
                    PendingOp::Resize { cols, rows } => handle.resize(cols, rows),
                }
            }
            if provider == ProviderId::Codex {
                service.watch_codex_subagent_traces(session_id, provider_invocation_id, handle);
            }
        });
    }

    pub(super) fn watch_codex_subagent_traces(
        self: &Arc<Self>,
        session_id: String,
        provider_invocation_id: String,
        handle: Arc<dyn ProviderRuntimeHandle>,
    ) {
        let service = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let Some(service) = service.upgrade() else {
                    break;
                };
                if handle.disposed()
                    || !service.is_current_provider_invocation(&session_id, &provider_invocation_id)
                    || !service
                        .handles
                        .lock_or_recover("handles")
                        .contains_key(&session_id)
                {
                    break;
                }
                // Codex can omit every spawn and wait notification. Discover
                // disk-backed children even while the parent emits no output.
                service.schedule_subagent_trace_reconciliation(&session_id);
            }
        });
    }
}
