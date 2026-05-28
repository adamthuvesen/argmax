// Provider session service.
//
// Owns the per-session lifecycle state machine: launching, queuing
// follow-up messages, resizing, terminating, recovering orphans on boot,
// and translating provider runtime events into persisted timeline rows
// + `DashboardDelta` publishes.
//
// The process / PTY / IO substrate lives in `runtime.rs` — this module
// imports its handle traits and helpers and never touches a `Command` or
// reader thread directly.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::json;
use uuid::Uuid;

use super::{
    flush_queue::{DashboardDelta, PendingMessage, ProviderEventFlushQueue},
    normalizer::{NormalizerSessionContext, ProviderOutputEvent},
    runtime::{
        attention_for_state, composer_payload, parse_agent_mode, parse_permission_mode,
        parse_provider, parse_reasoning_effort, prompt_for_agent_mode, sqlite_error,
        DeltaPublisher, ProviderProcessLauncher, ProviderRuntimeEvent, ProviderRuntimeEventType,
        ProviderRuntimeHandle, RealProviderProcessLauncher,
    },
    AgentMode, PermissionMode, ProviderId, ProviderLaunchInput, ProviderMode,
};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    ipc::inputs::{
        ComposerAttachmentInput, ProvidersCancelQueuedMessageInput, ProvidersLaunchInput,
        ProvidersResizeInput, ProvidersSendInput, ProvidersTerminateInput,
    },
    persistence::{
        database::Database,
        events::{
            persist_raw_output, persist_timeline_event, PersistRawOutputInput,
            PersistTimelineEventInput,
        },
        projects::list_projects,
        sessions::{
            find_session_by_id, persist_session, update_session_agent_mode, update_session_model,
            update_session_provider_conversation_id, update_session_state, PersistSessionInput,
            SessionAgentModeInput, SessionModelInput, SessionStateInput, SessionSummary,
        },
        time::now_iso,
        workspaces::{find_workspace_by_id, update_workspace_state},
    },
};

const MAX_PENDING_QUEUE: usize = 64;
const STRUCTURED_LAUNCH_COLS: u16 = 120;
const STRUCTURED_LAUNCH_ROWS: u16 = 32;

#[derive(Clone)]
pub struct ProviderSessionService {
    database: Arc<Database>,
    launcher: Arc<dyn ProviderProcessLauncher>,
    publish_delta: DeltaPublisher,
    handles: Arc<Mutex<HashMap<String, HandleEntry>>>,
    queues: Arc<Mutex<HashMap<String, VecDeque<PendingMessage>>>>,
    flush_queue: Arc<Mutex<ProviderEventFlushQueue>>,
}

#[derive(Clone)]
enum HandleEntry {
    Pending(Vec<PendingOp>),
    Resolved(Arc<dyn ProviderRuntimeHandle>),
}

#[derive(Clone)]
enum PendingOp {
    Resize { cols: u16, rows: u16 },
}

impl ProviderSessionService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Self::with_launcher(
            database,
            Arc::new(RealProviderProcessLauncher::new()),
            |_| {},
        )
    }

    pub fn with_launcher(
        database: Arc<Database>,
        launcher: Arc<dyn ProviderProcessLauncher>,
        publish_delta: impl Fn(DashboardDelta) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            launcher,
            publish_delta: Arc::new(publish_delta),
            handles: Arc::new(Mutex::new(HashMap::new())),
            queues: Arc::new(Mutex::new(HashMap::new())),
            flush_queue: Arc::new(Mutex::new(ProviderEventFlushQueue::new())),
        })
    }

    pub fn open_handle_count(&self) -> usize {
        self.handles.lock().expect("handles poisoned").len()
    }

    pub async fn launch(
        self: &Arc<Self>,
        input: ProvidersLaunchInput,
    ) -> ArgmaxResult<SessionSummary> {
        let session_id = Uuid::new_v4().to_string();
        let agent_mode = input.agent_mode.unwrap_or(AgentMode::Auto);
        let permission_mode = input.permission_mode.unwrap_or(PermissionMode::AutoApprove);
        let provider = input.provider;

        let (session, workspace_path) = {
            let connection = self.database.connection();
            let workspace = find_workspace_by_id(&connection, input.workspace_id.as_str())?;
            let mut session = persist_session(
                &connection,
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
                    state: "running".to_string(),
                    attention: attention_for_state("running").to_string(),
                },
            )?;
            if provider == ProviderId::Claude {
                session =
                    update_session_provider_conversation_id(&connection, &session_id, &session_id)?;
            }
            let workspace = update_workspace_state(&connection, &workspace.id, "running")?;
            let user_message = persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.clone(),
                    r#type: "user.message".to_string(),
                    message: input.prompt.as_str().to_string(),
                    payload: composer_payload(agent_mode, input.attachments.as_deref()),
                    created_at: None,
                },
            )?;
            let session_started = persist_timeline_event(
                &connection,
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
            self.publish(DashboardDelta {
                projects: list_projects(&connection)?,
                workspaces: vec![workspace.clone()],
                sessions: vec![session.clone()],
                events: vec![user_message, session_started],
                ..DashboardDelta::default()
            });
            (session, PathBuf::from(workspace.path))
        };

        self.flush_queue
            .lock()
            .expect("flush queue poisoned")
            .initialize_session(
                session_id.clone(),
                provider,
                NormalizerSessionContext::default(),
            );
        self.handles
            .lock()
            .expect("handles poisoned")
            .insert(session_id.clone(), HandleEntry::Pending(Vec::new()));

        let launch_input = ProviderLaunchInput {
            provider,
            session_id: session_id.clone(),
            workspace_path,
            prompt: input.prompt.as_str().to_string(),
            model_label: input.model_label.as_str().to_string(),
            model_id: input.model_id.as_str().to_string(),
            reasoning_effort: input.reasoning_effort,
            resume_conversation_id: None,
            mode: ProviderMode::StructuredJson,
            permission_mode,
            agent_mode,
            cols: input.cols.get(),
            rows: input.rows.get(),
        };
        let service = Arc::clone(self);
        let handle = match self
            .launcher
            .launch(
                launch_input,
                Arc::new(move |event| {
                    let service = Arc::clone(&service);
                    service.handle_provider_event(event);
                }),
            )
            .await
        {
            Ok(handle) => handle,
            Err(error) => {
                self.handles
                    .lock()
                    .expect("handles poisoned")
                    .remove(&session_id);
                self.record_launch_failure(&session_id, provider, error.clone())?;
                return Err(error);
            }
        };
        let pending_ops = {
            let mut handles = self.handles.lock().expect("handles poisoned");
            match handles.insert(
                session_id.clone(),
                HandleEntry::Resolved(Arc::clone(&handle)),
            ) {
                Some(HandleEntry::Pending(ops)) => ops,
                _ => Vec::new(),
            }
        };
        for op in pending_ops {
            self.apply_op(&handle, op).await?;
        }
        Ok(session)
    }

    pub async fn send_input(
        self: &Arc<Self>,
        input: ProvidersSendInput,
    ) -> ArgmaxResult<SendInputResult> {
        let session_id = input.session_id.as_str().to_string();
        let message = input.input.as_str().trim().to_string();
        if message.is_empty() {
            return Ok(SendInputResult {
                ok: true,
                queued: false,
            });
        }

        if let Some(handle) = self.live_handle(&session_id) {
            if !handle.accepts_input() {
                self.enqueue_pending_message(
                    &session_id,
                    &message,
                    input.agent_mode.unwrap_or(AgentMode::Auto),
                    &input,
                )?;
                return Ok(SendInputResult {
                    ok: true,
                    queued: true,
                });
            }
            handle.send_input(&format!(
                "{}\r",
                prompt_for_agent_mode(&message, input.agent_mode.unwrap_or(AgentMode::Auto))
            ));
            self.persist_user_message(
                &session_id,
                &message,
                input.agent_mode.unwrap_or(AgentMode::Auto),
                input.attachments.as_deref(),
            )?;
            return Ok(SendInputResult {
                ok: true,
                queued: false,
            });
        }

        let (workspace_id, provider, permission_mode, agent_mode, launch_input) = {
            let connection = self.database.connection();
            let mut session = find_session_by_id(&connection, &session_id)?;
            let workspace = find_workspace_by_id(&connection, &session.workspace_id)?;
            let agent_mode = input
                .agent_mode
                .or_else(|| session.agent_mode.as_deref().and_then(parse_agent_mode))
                .unwrap_or(AgentMode::Auto);
            if let (Some(model_label), Some(model_id)) = (&input.model_label, &input.model_id) {
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
            if session.agent_mode.as_deref() != Some(agent_mode.as_str()) {
                session = update_session_agent_mode(
                    &connection,
                    &session_id,
                    &SessionAgentModeInput {
                        agent_mode: agent_mode.as_str().to_string(),
                    },
                )?;
            }
            let user_message = self.persist_user_message_locked(
                &connection,
                &session_id,
                &message,
                agent_mode,
                input.attachments.as_deref(),
            )?;
            let running_session = update_session_state(
                &connection,
                &session_id,
                &SessionStateInput {
                    state: "running".to_string(),
                    attention: attention_for_state("running").to_string(),
                    completed_at: None,
                    last_activity_at: None,
                },
            )?;
            let running_workspace = update_workspace_state(&connection, &workspace.id, "running")?;
            self.publish(DashboardDelta {
                projects: list_projects(&connection)?,
                workspaces: vec![running_workspace],
                sessions: vec![running_session.clone()],
                events: vec![user_message],
                ..DashboardDelta::default()
            });
            let provider = parse_provider(&session.provider)?;
            let permission_mode = parse_permission_mode(&session.permission_mode)?;
            let launch_input = ProviderLaunchInput {
                provider,
                session_id: session_id.clone(),
                workspace_path: PathBuf::from(workspace.path),
                prompt: message.clone(),
                model_label: session.model_label.clone(),
                model_id: session.model_id.clone(),
                reasoning_effort: session
                    .reasoning_effort
                    .as_deref()
                    .and_then(parse_reasoning_effort),
                resume_conversation_id: session.provider_conversation_id.clone(),
                mode: ProviderMode::StructuredJson,
                permission_mode,
                agent_mode,
                cols: STRUCTURED_LAUNCH_COLS,
                rows: STRUCTURED_LAUNCH_ROWS,
            };
            (
                workspace.id,
                provider,
                permission_mode,
                agent_mode,
                launch_input,
            )
        };

        self.flush_queue
            .lock()
            .expect("flush queue poisoned")
            .initialize_session(
                session_id.clone(),
                provider,
                NormalizerSessionContext::default(),
            );
        self.handles
            .lock()
            .expect("handles poisoned")
            .insert(session_id.clone(), HandleEntry::Pending(Vec::new()));
        let service = Arc::clone(self);
        let handle = match self
            .launcher
            .launch(
                launch_input,
                Arc::new(move |event| {
                    let service = Arc::clone(&service);
                    service.handle_provider_event(event);
                }),
            )
            .await
        {
            Ok(handle) => handle,
            Err(error) => {
                self.handles
                    .lock()
                    .expect("handles poisoned")
                    .remove(&session_id);
                self.record_launch_failure(&session_id, provider, error.clone())?;
                return Err(error);
            }
        };
        self.handles
            .lock()
            .expect("handles poisoned")
            .insert(session_id, HandleEntry::Resolved(handle));
        let _ = (workspace_id, permission_mode, agent_mode);
        Ok(SendInputResult {
            ok: true,
            queued: false,
        })
    }

    pub fn resize(&self, input: ProvidersResizeInput) {
        let session_id = input.session_id.as_str();
        let entry = self
            .handles
            .lock()
            .expect("handles poisoned")
            .get_mut(session_id)
            .cloned();
        match entry {
            Some(HandleEntry::Resolved(handle)) if !handle.disposed() => {
                handle.resize(input.cols.get(), input.rows.get())
            }
            Some(HandleEntry::Pending(_)) => {
                let mut handles = self.handles.lock().expect("handles poisoned");
                if let Some(HandleEntry::Pending(ops)) = handles.get_mut(session_id) {
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

    pub async fn terminate(&self, input: ProvidersTerminateInput) -> ArgmaxResult<()> {
        let session_id = input.session_id.as_str().to_string();
        self.clear_queue(&session_id);
        let entry = self
            .handles
            .lock()
            .expect("handles poisoned")
            .remove(&session_id);
        match entry {
            Some(HandleEntry::Resolved(handle)) => {
                self.flush_trailing(&session_id)?;
                handle.terminate().await?;
                self.cancel_session(&session_id)?;
            }
            Some(HandleEntry::Pending(_)) => {
                self.cancel_session(&session_id)?;
            }
            None => {}
        }
        Ok(())
    }

    pub fn cancel_queued_message(&self, input: ProvidersCancelQueuedMessageInput) {
        let session_id = input.session_id.as_str();
        let mut queues = self.queues.lock().expect("queues poisoned");
        if let Some(queue) = queues.get_mut(session_id) {
            queue.retain(|message| message.id != input.message_id.as_str());
            if queue.is_empty() {
                queues.remove(session_id);
            }
        }
        drop(queues);
        self.publish_pending_messages(session_id);
    }

    pub fn recover_orphaned_sessions(&self) -> ArgmaxResult<usize> {
        let mut recovered = Vec::new();
        {
            let connection = self.database.connection();
            let mut statement = connection
                .prepare("SELECT id FROM sessions WHERE state = 'running'")
                .map_err(sqlite_error)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(sqlite_error)?;
            for row in rows {
                recovered.push(row.map_err(sqlite_error)?);
            }
        }
        for session_id in &recovered {
            let connection = self.database.connection();
            let session = update_session_state(
                &connection,
                session_id,
                &SessionStateInput {
                    state: "failed".to_string(),
                    attention: attention_for_state("failed").to_string(),
                    completed_at: Some(now_iso()),
                    last_activity_at: None,
                },
            )?;
            let event = persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.clone(),
                    r#type: "process_did_not_survive_restart".to_string(),
                    message: "Provider process did not survive restart.".to_string(),
                    payload: json!({}),
                    created_at: None,
                },
            )?;
            self.publish(DashboardDelta {
                projects: list_projects(&connection)?,
                sessions: vec![session],
                events: vec![event],
                ..DashboardDelta::default()
            });
        }
        Ok(recovered.len())
    }

    pub async fn dispose_all(&self) -> ArgmaxResult<()> {
        let entries = self
            .handles
            .lock()
            .expect("handles poisoned")
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        let mut tasks = Vec::new();
        for entry in entries {
            if let HandleEntry::Resolved(handle) = entry {
                tasks.push(tokio::spawn(async move {
                    tokio::time::timeout(Duration::from_millis(2500), handle.terminate()).await
                }));
            }
        }
        for task in tasks {
            let _ = task.await;
        }
        Ok(())
    }

    fn handle_provider_event(self: Arc<Self>, event: ProviderRuntimeEvent) {
        let result = match event.r#type {
            ProviderRuntimeEventType::Output => self.handle_output_event(event),
            ProviderRuntimeEventType::Exit | ProviderRuntimeEventType::Error => {
                self.handle_lifecycle_event(event)
            }
        };
        if let Err(error) = result {
            tracing::warn!(error = ?error, "provider event handling failed");
        }
    }

    fn handle_output_event(&self, event: ProviderRuntimeEvent) -> ArgmaxResult<()> {
        let mut connection = self.database.connection();
        let mut flush_queue = self.flush_queue.lock().expect("flush queue poisoned");
        let mut result = flush_queue.queue_output_event(
            &mut connection,
            ProviderOutputEvent {
                session_id: event.session_id.clone(),
                stream: event.stream,
                message: event.message,
                created_at: event.created_at,
            },
        )?;
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
        drop(flush_queue);
        drop(connection);
        if let Some(delta) = result.delta {
            self.publish(delta);
        }
        Ok(())
    }

    fn handle_lifecycle_event(self: &Arc<Self>, event: ProviderRuntimeEvent) -> ArgmaxResult<()> {
        self.flush_trailing(&event.session_id)?;
        let connection = self.database.connection();
        let succeeded =
            event.r#type == ProviderRuntimeEventType::Exit && event.exit_code == Some(0);
        let state = if succeeded { "complete" } else { "failed" };
        let raw_output = persist_raw_output(
            &connection,
            &PersistRawOutputInput {
                id: Uuid::new_v4().to_string(),
                session_id: event.session_id.clone(),
                stream: event.stream.as_str().to_string(),
                content: event.message.clone(),
                created_at: Some(event.created_at.clone()),
            },
        )?;
        let session = update_session_state(
            &connection,
            &event.session_id,
            &SessionStateInput {
                state: state.to_string(),
                attention: attention_for_state(state).to_string(),
                completed_at: Some(event.created_at.clone()),
                last_activity_at: Some(event.created_at.clone()),
            },
        )?;
        let workspace = update_workspace_state(&connection, &session.workspace_id, state)?;
        let timeline_event = persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: event.session_id.clone(),
                r#type: if succeeded {
                    "session.completed"
                } else {
                    "error"
                }
                .to_string(),
                message: event.message,
                payload: json!({ "exitCode": event.exit_code }),
                created_at: Some(event.created_at),
            },
        )?;
        self.handles
            .lock()
            .expect("handles poisoned")
            .remove(&event.session_id);
        self.flush_queue
            .lock()
            .expect("flush queue poisoned")
            .delete_session(&event.session_id);
        if !succeeded {
            self.clear_queue(&event.session_id);
        }
        self.publish(DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace],
            sessions: vec![session],
            events: vec![timeline_event],
            raw_outputs: vec![raw_output],
            ..DashboardDelta::default()
        });
        drop(connection);
        if succeeded {
            self.drain_queue_after_complete(event.session_id);
        }
        Ok(())
    }

    fn record_launch_failure(
        &self,
        session_id: &str,
        provider: ProviderId,
        error: ArgmaxError,
    ) -> ArgmaxResult<()> {
        self.flush_queue
            .lock()
            .expect("flush queue poisoned")
            .delete_session(session_id);
        let connection = self.database.connection();
        let session = update_session_state(
            &connection,
            session_id,
            &SessionStateInput {
                state: "failed".to_string(),
                attention: attention_for_state("failed").to_string(),
                completed_at: Some(now_iso()),
                last_activity_at: None,
            },
        )?;
        let workspace = update_workspace_state(&connection, &session.workspace_id, "failed")?;
        let event = persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                r#type: "error".to_string(),
                message: error.to_string(),
                payload: json!({ "provider": provider.as_str() }),
                created_at: None,
            },
        )?;
        self.clear_queue(session_id);
        self.publish(DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace],
            sessions: vec![session],
            events: vec![event],
            ..DashboardDelta::default()
        });
        Ok(())
    }

    fn cancel_session(&self, session_id: &str) -> ArgmaxResult<()> {
        let connection = self.database.connection();
        let completed_at = now_iso();
        let session = update_session_state(
            &connection,
            session_id,
            &SessionStateInput {
                state: "cancelled".to_string(),
                attention: attention_for_state("cancelled").to_string(),
                completed_at: Some(completed_at.clone()),
                last_activity_at: Some(completed_at.clone()),
            },
        )?;
        let workspace = update_workspace_state(&connection, &session.workspace_id, "cancelled")?;
        let event = persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                r#type: "session.cancelled".to_string(),
                message: "Provider session cancelled.".to_string(),
                payload: json!({}),
                created_at: Some(completed_at),
            },
        )?;
        self.flush_queue
            .lock()
            .expect("flush queue poisoned")
            .delete_session(session_id);
        self.publish(DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace],
            sessions: vec![session],
            events: vec![event],
            ..DashboardDelta::default()
        });
        Ok(())
    }

    fn live_handle(&self, session_id: &str) -> Option<Arc<dyn ProviderRuntimeHandle>> {
        match self
            .handles
            .lock()
            .expect("handles poisoned")
            .get(session_id)
        {
            Some(HandleEntry::Resolved(handle)) if !handle.disposed() => Some(Arc::clone(handle)),
            _ => None,
        }
    }

    async fn apply_op(
        &self,
        handle: &Arc<dyn ProviderRuntimeHandle>,
        op: PendingOp,
    ) -> ArgmaxResult<()> {
        match op {
            PendingOp::Resize { cols, rows } => handle.resize(cols, rows),
        }
        Ok(())
    }

    fn persist_user_message(
        &self,
        session_id: &str,
        message: &str,
        agent_mode: AgentMode,
        attachments: Option<&[ComposerAttachmentInput]>,
    ) -> ArgmaxResult<()> {
        let connection = self.database.connection();
        let event = self.persist_user_message_locked(
            &connection,
            session_id,
            message,
            agent_mode,
            attachments,
        )?;
        self.publish(DashboardDelta {
            events: vec![event],
            ..DashboardDelta::default()
        });
        Ok(())
    }

    fn persist_user_message_locked(
        &self,
        connection: &rusqlite::Connection,
        session_id: &str,
        message: &str,
        agent_mode: AgentMode,
        attachments: Option<&[ComposerAttachmentInput]>,
    ) -> ArgmaxResult<crate::persistence::events::TimelineEvent> {
        persist_timeline_event(
            connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                r#type: "user.message".to_string(),
                message: message.to_string(),
                payload: composer_payload(agent_mode, attachments),
                created_at: None,
            },
        )
    }

    fn enqueue_pending_message(
        &self,
        session_id: &str,
        content: &str,
        agent_mode: AgentMode,
        input: &ProvidersSendInput,
    ) -> ArgmaxResult<()> {
        let mut queues = self.queues.lock().expect("queues poisoned");
        let queue = queues.entry(session_id.to_string()).or_default();
        if queue.len() >= MAX_PENDING_QUEUE {
            return Err(ArgmaxError::service(
                "PENDING_QUEUE_FULL",
                format!("Pending follow-up queue is full ({MAX_PENDING_QUEUE})."),
            ));
        }
        queue.push_back(PendingMessage {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            content: content.to_string(),
            agent_mode: agent_mode.as_str().to_string(),
            model_label: input
                .model_label
                .as_ref()
                .map(|value| value.as_str().to_string()),
            model_id: input
                .model_id
                .as_ref()
                .map(|value| value.as_str().to_string()),
            reasoning_effort: input
                .reasoning_effort
                .map(|value| value.as_str().to_string()),
            queued_at: now_iso(),
        });
        drop(queues);
        self.publish_pending_messages(session_id);
        Ok(())
    }

    fn clear_queue(&self, session_id: &str) {
        let removed = self
            .queues
            .lock()
            .expect("queues poisoned")
            .remove(session_id)
            .is_some();
        if removed {
            self.publish_pending_messages(session_id);
        }
    }

    fn publish_pending_messages(&self, session_id: &str) {
        let queue = self
            .queues
            .lock()
            .expect("queues poisoned")
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

    fn drain_queue_after_complete(self: &Arc<Self>, session_id: String) {
        let next = {
            let mut queues = self.queues.lock().expect("queues poisoned");
            let Some(queue) = queues.get_mut(&session_id) else {
                return;
            };
            let next = queue.pop_front();
            if queue.is_empty() {
                queues.remove(&session_id);
            }
            next
        };
        let Some(next) = next else {
            return;
        };
        self.publish_pending_messages(&session_id);
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let _ = service
                .send_input(ProvidersSendInput {
                    session_id: crate::ipc::validation::SessionId::try_from(session_id)
                        .expect("existing session id valid"),
                    input: crate::ipc::validation::Prompt::try_from(next.content)
                        .expect("queued prompt valid"),
                    model_label: next.model_label.map(|value| {
                        crate::ipc::validation::NonEmptyString::try_from(value)
                            .expect("queued label valid")
                    }),
                    model_id: next.model_id.map(|value| {
                        crate::ipc::validation::NonEmptyString::try_from(value)
                            .expect("queued model valid")
                    }),
                    reasoning_effort: next
                        .reasoning_effort
                        .as_deref()
                        .and_then(parse_reasoning_effort),
                    agent_mode: parse_agent_mode(&next.agent_mode),
                    attachments: None,
                })
                .await;
        });
    }

    fn flush_trailing(&self, session_id: &str) -> ArgmaxResult<()> {
        let mut connection = self.database.connection();
        let delta = self
            .flush_queue
            .lock()
            .expect("flush queue poisoned")
            .flush_trailing_fragments(&mut connection, session_id, &now_iso())?;
        drop(connection);
        if let Some(delta) = delta {
            self.publish(delta);
        }
        Ok(())
    }

    fn publish(&self, delta: DashboardDelta) {
        if !delta.is_empty() {
            (self.publish_delta)(delta);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendInputResult {
    pub ok: bool,
    pub queued: bool,
}
