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
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};
use specta::Type;
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
const FOLLOW_UP_CONTEXT_MAX_MESSAGES: usize = 12;
const FOLLOW_UP_CONTEXT_MAX_CHARS: usize = 12_000;
/// After the last stdout/stderr chunk, flush any provider line still sitting in
/// the per-session stream buffer (no trailing `\n` yet). Interactive CLIs often
/// keep the process alive after a completed answer, so `flush_trailing` on exit
/// never runs until the user hits Stop — the chat would stay on "Thinking" even
/// though the response is already in SQLite.
///
/// 16 ms ≈ one frame at 60 Hz. The debounce still rebounces on every new
/// chunk, so this only fires when the provider pauses; the lower bound just
/// makes that pause-driven flush feel real-time instead of laggy.
const STREAM_IDLE_FLUSH_MS: u64 = 16;

#[derive(Clone)]
pub struct ProviderSessionService {
    database: Arc<Database>,
    launcher: Arc<dyn ProviderProcessLauncher>,
    publish_delta: DeltaPublisher,
    handles: Arc<Mutex<HashMap<String, HandleEntry>>>,
    queues: Arc<Mutex<HashMap<String, VecDeque<PendingMessage>>>>,
    flush_queue: Arc<Mutex<ProviderEventFlushQueue>>,
    /// Debounced `flush_trailing` for sessions with a partial provider line in
    /// the stream buffer (no newline delimiter yet).
    idle_flush_generation: Arc<Mutex<HashMap<String, u64>>>,
    idle_flush_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    /// Sessions currently being torn down by `terminate`. The lifecycle
    /// handler skips its own state update when a session is in here so
    /// the user-initiated `cancelled` state isn't overwritten by the
    /// wait-thread's `failed`/`complete` after the kill lands.
    terminating: Arc<Mutex<HashSet<String>>>,
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
            idle_flush_generation: Arc::new(Mutex::new(HashMap::new())),
            idle_flush_tasks: Arc::new(Mutex::new(HashMap::new())),
            terminating: Arc::new(Mutex::new(HashSet::new())),
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
            let provider = parse_provider(&session.provider)?;
            let permission_mode = parse_permission_mode(&session.permission_mode)?;
            let mut resume_conversation_id = session.provider_conversation_id.clone();
            if provider == ProviderId::Cursor && resume_conversation_id.is_none() {
                if let Some(provider_conversation_id) =
                    infer_cursor_provider_conversation_id(&connection, &session_id)?
                {
                    session = update_session_provider_conversation_id(
                        &connection,
                        &session_id,
                        &provider_conversation_id,
                    )?;
                    resume_conversation_id = session.provider_conversation_id.clone();
                }
            }
            let launch_prompt = compose_follow_up_prompt(&connection, &session_id, &message)?;
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
            let launch_input = ProviderLaunchInput {
                provider,
                session_id: session_id.clone(),
                workspace_path: PathBuf::from(workspace.path),
                prompt: launch_prompt,
                model_label: session.model_label.clone(),
                model_id: session.model_id.clone(),
                reasoning_effort: session
                    .reasoning_effort
                    .as_deref()
                    .and_then(parse_reasoning_effort),
                resume_conversation_id,
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
        // Drain ops the renderer queued while the launch future was in
        // flight — most notably resize ops issued from the very first
        // render of the resumed session. Mirrors the launch() path.
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
        self.cancel_idle_flush(&session_id);
        self.clear_queue(&session_id);
        // Mark before pulling the handle so a wait-thread exit event that
        // arrives mid-terminate sees the flag and skips its own state
        // write. Cleared after cancel_session lands `cancelled`.
        self.terminating
            .lock()
            .expect("terminating poisoned")
            .insert(session_id.clone());
        let entry = self
            .handles
            .lock()
            .expect("handles poisoned")
            .remove(&session_id);
        let result = async {
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
        .await;
        self.terminating
            .lock()
            .expect("terminating poisoned")
            .remove(&session_id);
        result
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
            // Mirror the session terminal-state onto the workspace so the
            // dashboard doesn't keep showing a `running` workspace whose
            // session was just marked `failed`.
            let workspace = update_workspace_state(&connection, &session.workspace_id, "failed")?;
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
                workspaces: vec![workspace],
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
            ProviderRuntimeEventType::StreamStarted => self.handle_stream_started(event),
            ProviderRuntimeEventType::Exit | ProviderRuntimeEventType::Error => {
                self.handle_lifecycle_event(event)
            }
        };
        if let Err(error) = result {
            tracing::warn!(error = ?error, "provider event handling failed");
        }
    }

    fn handle_stream_started(&self, event: ProviderRuntimeEvent) -> ArgmaxResult<()> {
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

    fn handle_output_event(self: Arc<Self>, event: ProviderRuntimeEvent) -> ArgmaxResult<()> {
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
        let mut flush_queue = self.flush_queue.lock().expect("flush queue poisoned");
        tracing::trace!(
            session_id = %trace_session,
            "handle_output_event: acquired flush queue; queuing event",
        );
        let mut result = flush_queue.queue_output_event(
            &mut connection,
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
        drop(flush_queue);
        drop(connection);
        if let Some(delta) = result.delta {
            self.publish(delta);
        }
        // A completed answer can sit in the stream buffer without a trailing
        // newline while the provider process stays alive. Debounce-flush only
        // when a real fragment exists; newline-delimited JSONL chunks already
        // flushed above and should not spawn no-op idle tasks.
        if result.has_trailing_fragment {
            self.schedule_idle_flush(&event.session_id);
        } else {
            self.cancel_idle_flush(&event.session_id);
        }
        Ok(())
    }

    fn handle_lifecycle_event(self: &Arc<Self>, event: ProviderRuntimeEvent) -> ArgmaxResult<()> {
        self.cancel_idle_flush(&event.session_id);
        self.flush_trailing(&event.session_id)?;
        // If the user already initiated terminate(), let cancel_session
        // own the state transition. Writing `failed`/`complete` here
        // would race against (and could clobber) the `cancelled` state
        // the user just saw flash in the dashboard.
        if self
            .terminating
            .lock()
            .expect("terminating poisoned")
            .contains(&event.session_id)
        {
            self.handles
                .lock()
                .expect("handles poisoned")
                .remove(&event.session_id);
            self.flush_queue
                .lock()
                .expect("flush queue poisoned")
                .delete_session(&event.session_id);
            return Ok(());
        }
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
        let timeline_event = persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: event.session_id.clone(),
                r#type: timeline_type,
                message: timeline_message,
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
        // Keep a copy so a launch failure can restore the message instead of
        // silently dropping it after the UI already showed the queue drained.
        let restore = next.clone();
        let restore_session = session_id.clone();
        tokio::spawn(async move {
            let result = service
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
            if let Err(error) = result {
                tracing::warn!(
                    session_id = %restore_session,
                    ?error,
                    "failed to launch queued follow-up; restoring it to the queue"
                );
                {
                    let mut queues = service.queues.lock().expect("queues poisoned");
                    queues
                        .entry(restore_session.clone())
                        .or_default()
                        .push_front(restore);
                }
                service.publish_pending_messages(&restore_session);
            }
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

    fn cancel_idle_flush(&self, session_id: &str) {
        if let Some(handle) = self
            .idle_flush_tasks
            .lock()
            .expect("idle flush tasks poisoned")
            .remove(session_id)
        {
            handle.abort();
        }
        self.idle_flush_generation
            .lock()
            .expect("idle flush generation poisoned")
            .remove(session_id);
    }

    fn schedule_idle_flush(self: &Arc<Self>, session_id: &str) {
        let generation = {
            let mut generations = self
                .idle_flush_generation
                .lock()
                .expect("idle flush generation poisoned");
            let next = generations.get(session_id).copied().unwrap_or(0) + 1;
            generations.insert(session_id.to_string(), next);
            next
        };
        if let Some(handle) = self
            .idle_flush_tasks
            .lock()
            .expect("idle flush tasks poisoned")
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
                .lock()
                .expect("idle flush generation poisoned")
                .get(&session_id_owned)
                .copied();
            if current != Some(generation) {
                return;
            }
            let flush_result = service.flush_trailing(&session_id_owned);
            service
                .idle_flush_tasks
                .lock()
                .expect("idle flush tasks poisoned")
                .remove(&session_id_owned);
            if let Err(error) = flush_result {
                tracing::warn!(
                    ?error,
                    session_id = %session_id_owned,
                    "idle stream flush failed"
                );
            }
        });
        self.idle_flush_tasks
            .lock()
            .expect("idle flush tasks poisoned")
            .insert(session_id_for_map, handle);
    }

    fn publish(&self, delta: DashboardDelta) {
        if !delta.is_empty() {
            (self.publish_delta)(delta);
        }
    }
}

fn infer_cursor_provider_conversation_id(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> ArgmaxResult<Option<String>> {
    let mut statement = connection
        .prepare("SELECT content FROM raw_outputs WHERE session_id = ? ORDER BY rowid ASC")
        .map_err(sqlite_error)?;
    let mut rows = statement.query([session_id]).map_err(sqlite_error)?;
    while let Some(row) = rows.next().map_err(sqlite_error)? {
        let content: String = row.get(0).map_err(sqlite_error)?;
        for line in content
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let Ok(payload) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let provider_type = payload.get("type").and_then(Value::as_str);
            let subtype = payload.get("subtype").and_then(Value::as_str);
            if matches!(
                (provider_type, subtype),
                (Some("system"), Some("init")) | (Some("result"), Some("success"))
            ) {
                if let Some(id) = payload
                    .get("session_id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    return Ok(Some(id.to_string()));
                }
            }
        }
    }
    Ok(None)
}

fn compose_follow_up_prompt(
    connection: &rusqlite::Connection,
    session_id: &str,
    message: &str,
) -> ArgmaxResult<String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT type, message
            FROM events
            WHERE session_id = ?
              AND type IN ('user.message', 'message.completed', 'error')
              AND trim(message) <> ''
            ORDER BY rowid DESC
            LIMIT ?
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map((session_id, FOLLOW_UP_CONTEXT_MAX_MESSAGES as i64), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?;
    let mut transcript = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?
        .into_iter()
        .filter_map(|(event_type, text)| {
            let speaker = match event_type.as_str() {
                "user.message" => "User",
                "message.completed" => "Assistant",
                "error" => "System",
                _ => return None,
            };
            let text = text.trim();
            if text.is_empty() {
                None
            } else {
                Some(format!("{speaker}: {}", clamp_context_text(text)))
            }
        })
        .collect::<Vec<_>>();
    transcript.reverse();

    if transcript.is_empty() {
        return Ok(message.to_string());
    }

    let mut transcript_chars = transcript.iter().map(|line| line.len()).sum::<usize>()
        + transcript.len().saturating_sub(1);
    while transcript_chars > FOLLOW_UP_CONTEXT_MAX_CHARS && transcript.len() > 1 {
        transcript_chars = transcript_chars.saturating_sub(transcript[0].len() + 1);
        transcript.remove(0);
    }

    Ok(format!(
        "The user is continuing this Argmax chat session. Use the visible conversation transcript below as context for the new message. Continue naturally.\n\nConversation so far:\n{}\n\nNew user message:\n{}",
        transcript.join("\n"),
        message
    ))
}

fn clamp_context_text(text: &str) -> String {
    const MAX_LINE_CHARS: usize = 4_000;
    if text.len() <= MAX_LINE_CHARS {
        return text.to_string();
    }

    let mut end = 0;
    for (index, _) in text.char_indices() {
        if index > MAX_LINE_CHARS {
            break;
        }
        end = index;
    }
    format!("{}...", text[..end].trim_end())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SendInputResult {
    pub ok: bool,
    pub queued: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::database::Database;
    use serde_json::json;

    #[test]
    fn follow_up_prompt_reads_latest_messages_only() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_session(&connection);
        for index in 0..20 {
            persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: format!("event-{index}"),
                    session_id: "s1".to_string(),
                    r#type: "user.message".to_string(),
                    message: format!("message {index}"),
                    payload: json!({}),
                    created_at: Some(format!("2026-05-24T10:00:{index:02}.000Z")),
                },
            )
            .expect("insert event");
        }

        let prompt = compose_follow_up_prompt(&connection, "s1", "next").expect("prompt");

        assert!(!prompt.contains("message 7"));
        assert!(prompt.contains("message 8"));
        assert!(prompt.contains("message 19"));
        assert!(prompt.contains("New user message:\nnext"));
    }

    #[test]
    fn follow_up_prompt_keeps_newest_lines_under_char_budget() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_session(&connection);
        for index in 0..4 {
            persist_timeline_event(
                &connection,
                &PersistTimelineEventInput {
                    id: format!("large-{index}"),
                    session_id: "s1".to_string(),
                    r#type: "message.completed".to_string(),
                    message: format!("large {index} {}", "x".repeat(4_000)),
                    payload: json!({}),
                    created_at: Some(format!("2026-05-24T10:00:{index:02}.000Z")),
                },
            )
            .expect("insert event");
        }

        let prompt = compose_follow_up_prompt(&connection, "s1", "next").expect("prompt");

        assert!(!prompt.contains("large 0"));
        assert!(!prompt.contains("large 1"));
        assert!(prompt.contains("large 2"));
        assert!(prompt.contains("large 3"));
    }

    fn seed_session(connection: &rusqlite::Connection) {
        connection
            .execute(
                "INSERT INTO projects (id, name, repo_path, current_branch, default_provider, default_model_label, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', 'claude', 'Sonnet', '~/.argmax', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
                [],
            )
            .expect("insert project");
        connection
            .execute(
                "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES ('w1', 'p1', 'task', 'branch', 'main', '/tmp/w1', 'running', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
                [],
            )
            .expect("insert workspace");
        connection
            .execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, reasoning_effort, permission_mode, agent_mode, prompt, state, attention, started_at, last_activity_at) VALUES ('s1', 'w1', 'claude', 'Sonnet', 'claude-sonnet-4', NULL, 'auto-approve', 'auto', 'prompt', 'complete', 'none', '2026-05-24T10:00:00.000Z', '2026-05-24T10:00:00.000Z')",
                [],
            )
            .expect("insert session");
    }
}
