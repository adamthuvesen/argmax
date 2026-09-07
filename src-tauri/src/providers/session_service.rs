// Provider session service.
//
// Owns the per-session lifecycle state machine: launching, queuing
// follow-up messages, resizing, terminating, clearing conversation context,
// recovering orphans on boot, and translating provider runtime events into
// persisted timeline rows + `DashboardDelta` publishes.
//
// The process / PTY / IO substrate lives in `runtime.rs` — this module
// imports its handle traits and helpers. Follow-up transcript assembly and
// detached-process cleanup live in adjacent provider modules.

use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use crate::util::sync::LockOrRecover;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use tokio::sync::{broadcast, watch};
use uuid::Uuid;

use super::{
    adapters::{get_provider_definition, prompt_for_agent_mode},
    flush_queue::{DashboardDelta, PendingMessage, ProviderEventFlushQueue},
    follow_up::{
        agent_reference_prompt, compose_follow_up_prompt, ensure_agent_references_supported,
    },
    measured_diffs::{
        capture_opening_mark, merge_measured_diffs, paths_awaiting_diff, MeasuredDiff,
        MeasuredDiffs,
    },
    normalizer::{CodexCumulativeUsage, NormalizerSessionContext, ProviderOutputEvent},
    orphan_cleanup::{terminate_orphaned_provider_processes, RecoveredProviderSession},
    runtime::{
        composer_payload, parse_agent_mode, parse_permission_mode, parse_provider,
        parse_reasoning_effort, sqlite_error, DeltaPublisher, ProviderProcessLauncher,
        ProviderRuntimeEvent, ProviderRuntimeEventType, ProviderRuntimeHandle,
        RealProviderProcessLauncher,
    },
    subagent_trace::reconcile_session_subagent_traces,
    AgentMode, ApprovalSupport, PermissionMode, ProviderId, ProviderLaunchInput,
};
use crate::sessions::state::SessionState;
use crate::{
    approvals::service::ApprovalService,
    error::{ArgmaxError, ArgmaxResult},
    gh::service::{pr_numbers_from_command_event, GhService},
    ipc::inputs::{
        ComposerAttachmentInput, ProvidersCancelQueuedMessageInput, ProvidersLaunchInput,
        ProvidersResizeInput, ProvidersSendInput, ProvidersSendQueuedMessageNowInput,
        ProvidersTerminateInput, SessionClearInput,
    },
    ipc::validation::{NonEmptyString, Prompt, SessionId},
    persistence::{
        database::Database,
        events::{
            find_event_by_id, latest_agent_message, list_session_events_since, persist_raw_output,
            persist_timeline_event, update_event_payload, PersistRawOutputInput,
            PersistTimelineEventInput, TimelineEvent,
        },
        pending_messages::{
            clear_session_queue, delete_message as delete_pending_message,
            list_session_pending_messages, mark_message_launching, recover_pending_messages,
            replace_session_queue, restore_launching_message,
        },
        projects::list_projects,
        session_messages::{
            insert_session_message, is_message_delivered, mark_message_delivered,
            NewSessionMessage, COMPLETION_KIND,
        },
        sessions::{
            clear_session_conversation, find_session_by_id, persist_session, session_launch_kind,
            session_resume_fork, update_session_agent_mode, update_session_model,
            update_session_provider, update_session_provider_conversation_id, update_session_state,
            PersistSessionInput, SessionAgentModeInput, SessionModelInput, SessionProviderInput,
            SessionStateInput, SessionSummary, LAUNCH_KIND_MULTITASK,
        },
        time::now_iso,
        workspaces::{find_workspace_by_id, update_workspace_state, WorkspaceSummary},
    },
    session_control::{AfterTurn, SessionLaunchRegistry},
    workspaces::lifecycle::{WorkspaceAdmission, WorkspaceLifecycle},
};

const MAX_PENDING_QUEUE: usize = 64;
/// How many state changes a `session_wait` subscriber may fall behind before
/// it is told to re-read the rows instead. A blocked waiter wakes on every
/// message, so this only ever fills during a burst.
const SESSION_STATE_BROADCAST_CAPACITY: usize = 256;
const STRUCTURED_LAUNCH_COLS: u16 = 120;
const STRUCTURED_LAUNCH_ROWS: u16 = 32;
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
/// How much of a child's final answer a completion notice carries. The notice
/// is a summary handed back through the inbox, which has its own reply ceiling
/// — a whole transcript-length answer belongs to `session_read`.
const NOTICE_ANSWER_CHARS: usize = 4 * 1024;

fn ensure_permission_mode_supported(
    provider: ProviderId,
    permission_mode: PermissionMode,
) -> ArgmaxResult<()> {
    if permission_mode == PermissionMode::AskEachTime
        && get_provider_definition(provider).approval_support != ApprovalSupport::Respondable
    {
        return Err(ArgmaxError::service(
            "PROVIDER_APPROVAL_UNSUPPORTED",
            format!(
                "{} cannot answer live approval requests in this runtime. Update the provider CLI to a version with live approval support.",
                get_provider_definition(provider).display_name
            ),
        ));
    }
    Ok(())
}

fn cap_notice_answer(answer: &str) -> String {
    if answer.chars().count() <= NOTICE_ANSWER_CHARS {
        return answer.to_string();
    }
    let mut capped: String = answer.chars().take(NOTICE_ANSWER_CHARS).collect();
    capped.push_str("\n\n(truncated)");
    capped
}

/// Where a user turn came from, when it was not the person at the keyboard.
/// Written onto the `user.message` payload as `origin`, which is what the chat
/// renders as a "From <label>" bubble instead of an ordinary prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MessageOrigin {
    /// The session that wrote it.
    pub session_id: String,
    /// That session's sidebar task label, resolved once at send time so the
    /// bubble still names it after the sender is archived.
    pub label: String,
    /// `message` when another agent wrote here, `completion` when a session
    /// this one launched has finished.
    pub kind: String,
    /// The `session_messages` row this turn delivers, when there is one. The
    /// follow-up queue consults it at drain time so a message the recipient
    /// already collected mid-turn — through `inbox_read`, while the queue held
    /// it — is not also sent as a turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

/// A recorded completion notice, on its way to the launching session as a
/// turn. The row is already in `session_messages`; this is the delivery.
struct CompletionNotice {
    message_id: String,
    to_session_id: String,
    body: String,
    origin: MessageOrigin,
}

/// A session's state as it was just written. Broadcast in-process so a blocked
/// `session_wait` wakes on the change instead of polling the database.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionStateChange {
    pub session_id: String,
    pub state: SessionState,
}

#[derive(Clone)]
pub struct ProviderSessionService {
    database: Arc<Database>,
    launcher: Arc<dyn ProviderProcessLauncher>,
    publish_delta: DeltaPublisher,
    handles: Arc<Mutex<HashMap<String, HandleEntry>>>,
    queues: Arc<Mutex<HashMap<String, VecDeque<PendingMessage>>>>,
    queue_promotions: Arc<Mutex<HashSet<String>>>,
    flush_queue: Arc<Mutex<ProviderEventFlushQueue>>,
    /// Debounced `flush_trailing` for sessions with a partial provider line in
    /// the stream buffer (no newline delimiter yet).
    idle_flush_generation: Arc<Mutex<HashMap<String, u64>>>,
    idle_flush_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    /// Sessions being reconciled, with a queued-rescan flag. A control event
    /// that lands during a scan requests one follow-up instead of starting a
    /// concurrent walk or disappearing.
    subagent_reconciliations: Arc<Mutex<HashMap<String, bool>>>,
    /// Sessions currently being torn down by `terminate`. The lifecycle
    /// handler skips its own state update when a session is in here so
    /// the user-initiated `cancelled` state isn't overwritten by the
    /// wait-thread's `failed`/`complete` after the kill lands.
    terminating: Arc<Mutex<HashSet<String>>>,
    /// Owned termination jobs. A caller may stop waiting when an archive
    /// bound expires, but the job itself continues until the provider handle
    /// is disposed and the cancelled state is persisted.
    termination_jobs: Arc<Mutex<HashMap<String, TerminationJob>>>,
    lifecycle: Arc<WorkspaceLifecycle>,
    approvals: Option<Arc<ApprovalService>>,
    session_control: OnceLock<Arc<SessionLaunchRegistry>>,
    /// Per-turn git marks, for providers that report a file write without
    /// saying what changed. See `measured_diffs`.
    measured_diffs: Arc<MeasuredDiffs>,
    /// Every session state this service writes, for `session_wait`.
    session_states: broadcast::Sender<SessionStateChange>,
}

/// The result slot a termination job publishes to; `None` while the job runs.
type TerminationJob = watch::Receiver<Option<ArgmaxResult<()>>>;

#[derive(Clone)]
enum HandleEntry {
    Pending(Vec<PendingOp>),
    Resolved(Arc<dyn ProviderRuntimeHandle>),
}

#[derive(Clone)]
enum PendingOp {
    Resize { cols: u16, rows: u16 },
}

async fn wait_for_termination(
    mut done: watch::Receiver<Option<ArgmaxResult<()>>>,
) -> ArgmaxResult<()> {
    loop {
        if let Some(result) = done.borrow().clone() {
            return result;
        }
        done.changed().await.map_err(|_| {
            ArgmaxError::service(
                "PROVIDER_TERMINATION_LOST",
                "Provider termination job stopped before reporting completion.",
            )
        })?;
    }
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
        Self::with_launcher_and_lifecycle(
            database,
            launcher,
            publish_delta,
            WorkspaceLifecycle::new(),
        )
    }

    pub fn with_launcher_and_lifecycle(
        database: Arc<Database>,
        launcher: Arc<dyn ProviderProcessLauncher>,
        publish_delta: impl Fn(DashboardDelta) + Send + Sync + 'static,
        lifecycle: Arc<WorkspaceLifecycle>,
    ) -> Arc<Self> {
        Self::with_launcher_and_lifecycle_and_approvals(
            database,
            launcher,
            publish_delta,
            lifecycle,
            None,
        )
    }

    pub fn with_launcher_and_lifecycle_and_approvals(
        database: Arc<Database>,
        launcher: Arc<dyn ProviderProcessLauncher>,
        publish_delta: impl Fn(DashboardDelta) + Send + Sync + 'static,
        lifecycle: Arc<WorkspaceLifecycle>,
        approvals: Option<Arc<ApprovalService>>,
    ) -> Arc<Self> {
        let recovered_queues = {
            let mut connection = database.connection();
            recover_pending_messages(&mut connection)
                .expect("durable pending-message journal must be readable")
        };
        Arc::new(Self {
            database,
            launcher,
            publish_delta: Arc::new(publish_delta),
            handles: Arc::new(Mutex::new(HashMap::new())),
            queues: Arc::new(Mutex::new(recovered_queues)),
            queue_promotions: Arc::new(Mutex::new(HashSet::new())),
            flush_queue: Arc::new(Mutex::new(ProviderEventFlushQueue::new())),
            idle_flush_generation: Arc::new(Mutex::new(HashMap::new())),
            idle_flush_tasks: Arc::new(Mutex::new(HashMap::new())),
            subagent_reconciliations: Arc::new(Mutex::new(HashMap::new())),
            terminating: Arc::new(Mutex::new(HashSet::new())),
            termination_jobs: Arc::new(Mutex::new(HashMap::new())),
            lifecycle,
            approvals,
            session_control: OnceLock::new(),
            measured_diffs: Arc::new(MeasuredDiffs::default()),
            session_states: broadcast::channel(SESSION_STATE_BROADCAST_CAPACITY).0,
        })
    }

    pub fn set_session_control(&self, registry: Arc<SessionLaunchRegistry>) {
        if self.session_control.set(registry).is_err() {
            tracing::warn!("session control registry was already installed");
        }
    }

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
            });
        }
        Ok(())
    }

    fn ensure_no_pending_after_turn(&self, session_id: &str) -> ArgmaxResult<()> {
        let Some(pending) = self
            .session_control
            .get()
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
        })
    }

    fn settle_session_after_turn(&self, session_id: &str) {
        if let Some(registry) = self.session_control.get() {
            registry.signal_turn_settled(session_id);
        }
    }

    /// Says on the chat that the disposal it was promised is off. The turn's
    /// own failure is already an error row, so this line is a notice about the
    /// promise rather than a second failure to act on.
    fn abort_session_after_turn(&self, session_id: &str, message: &str) -> ArgmaxResult<()> {
        let Some(registry) = self.session_control.get() else {
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

    pub fn open_handle_count(&self) -> usize {
        self.handles.lock_or_recover("handles").len()
    }

    /// Whether the session's provider handle has finished spawning (`Resolved`)
    /// rather than still launching in the background (`Pending`).
    /// Whether this turn's git mark is in place, so a file write the provider
    /// reports without a diff can be measured against it.
    pub fn has_turn_mark(&self, session_id: &str) -> bool {
        self.measured_diffs.is_marked(session_id)
    }

    pub fn is_handle_resolved(&self, session_id: &str) -> bool {
        matches!(
            self.handles.lock_or_recover("handles").get(session_id),
            Some(HandleEntry::Resolved(handle)) if !handle.disposed()
        )
    }

    pub async fn launch(
        self: &Arc<Self>,
        input: ProvidersLaunchInput,
    ) -> ArgmaxResult<SessionSummary> {
        let session_id = Uuid::new_v4().to_string();
        let agent_mode = input.agent_mode.unwrap_or(AgentMode::Auto);
        let permission_mode = input
            .permission_mode
            .unwrap_or(PermissionMode::ProviderDefaults);
        let provider = input.provider;
        ensure_permission_mode_supported(provider, permission_mode)?;
        let admission = self.lifecycle.admit(input.workspace_id.as_str())?;

        let (session, workspace_path) = {
            let connection = self.database.connection();
            let workspace = find_workspace_by_id(&connection, input.workspace_id.as_str())?;
            if matches!(
                workspace.state.as_str(),
                "archiving" | "archive-failed" | "archived"
            ) {
                return Err(ArgmaxError::service(
                    "WORKSPACE_ARCHIVING",
                    "Workspace archive is in progress; no new provider can be started.",
                ));
            }
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
                    state: SessionState::Running,
                },
            )?;
            // Claude and Grok are both handed `--session-id <our id>`, so the
            // CLI conversation is known before a single event arrives. Seeding
            // it here is what lets the very next turn resume: without it the
            // follow-up launches fresh and loses the history.
            if matches!(provider, ProviderId::Claude | ProviderId::Grok) {
                session =
                    update_session_provider_conversation_id(&connection, &session_id, &session_id)?;
            }
            let workspace = update_workspace_state_for_session_state(
                &connection,
                &workspace.id,
                SessionState::Running,
            )?;
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

        let provider_invocation_id = Uuid::new_v4().to_string();
        self.flush_queue
            .lock_or_recover("flush queue")
            .initialize_session(
                session_id.clone(),
                provider,
                provider_invocation_id.clone(),
                NormalizerSessionContext::for_provider(provider, input.model_id.as_str()),
            );
        self.mark_turn_start(&session_id, workspace_path.clone());
        self.handles
            .lock_or_recover("handles")
            .insert(session_id.clone(), HandleEntry::Pending(Vec::new()));

        let launch_input = ProviderLaunchInput {
            provider,
            session_id: session_id.clone(),
            workspace_path,
            prompt: input.prompt.as_str().to_string(),
            model_label: input.model_label.as_str().to_string(),
            model_id: input.model_id.as_str().to_string(),
            reasoning_effort: input.reasoning_effort,
            fast_mode: input.fast_mode,
            resume_conversation_id: None,
            resume_fork: false,
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
    fn spawn_provider_in_background(
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
            let callback_invocation_id = provider_invocation_id;
            let handle = match service
                .launcher
                .launch(
                    launch_input,
                    Arc::new(move |event| {
                        let event_service = Arc::clone(&event_service);
                        event_service.handle_provider_event(event, callback_invocation_id.clone());
                    }),
                )
                .await
            {
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
                if let Err(error) = service.apply_op(&handle, op).await {
                    tracing::error!(?error, "failed to apply queued op after launch");
                }
            }
        });
    }

    pub async fn send_input(
        self: &Arc<Self>,
        input: ProvidersSendInput,
    ) -> ArgmaxResult<SendInputResult> {
        self.send_input_with_origin(input, None).await
    }

    /// The same turn, tagged with the session that wrote it. Everything the
    /// user's composer does goes through `send_input` with no origin; the
    /// agent tools and the completion notice pass one, and it rides all the
    /// way to the persisted `user.message` payload — including through the
    /// queue, when the recipient turns out to be mid-turn.
    #[allow(clippy::unused_async)] // Callers await; the provider spawn is backgrounded.
    pub async fn send_input_with_origin(
        self: &Arc<Self>,
        input: ProvidersSendInput,
        origin: Option<MessageOrigin>,
    ) -> ArgmaxResult<SendInputResult> {
        let session_id = input.session_id.as_str().to_string();
        let message = input.input.as_str().trim().to_string();
        if message.is_empty() {
            return Ok(SendInputResult {
                ok: true,
                queued: false,
            });
        }
        self.ensure_no_pending_after_turn(&session_id)?;

        let (workspace_id, session_provider, session_permission_mode) = {
            let connection = self.database.connection();
            let session = find_session_by_id(&connection, &session_id)?;
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
                if crate::persistence::synced::mark_synced_session_adopted(
                    &connection,
                    &session_id,
                )? {
                    tracing::info!(session_id = %session_id, "imported session adopted");
                }
            }
            (
                session.workspace_id,
                parse_provider(&session.provider)?,
                parse_permission_mode(&session.permission_mode)?,
            )
        };
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

        if let Some(handle) = self.live_handle(&session_id) {
            if !handle.accepts_input() {
                self.enqueue_pending_message(
                    &session_id,
                    &message,
                    input.agent_mode.unwrap_or(AgentMode::Auto),
                    &input,
                    origin,
                )?;
                drop(admission);
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
            self.mark_turn_start(&session_id, workspace_path);
            handle.send_input(&format!(
                "{}\r",
                prompt_for_agent_mode(&prompt, input.agent_mode.unwrap_or(AgentMode::Auto))
            ));
            self.persist_user_message(
                &session_id,
                &message,
                input.agent_mode.unwrap_or(AgentMode::Auto),
                input.attachments.as_deref(),
                origin.as_ref(),
            )?;
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
            self.enqueue_pending_message(
                &session_id,
                &message,
                input.agent_mode.unwrap_or(AgentMode::Auto),
                &input,
                origin,
            )?;
            drop(admission);
            self.drain_queue_if_turn_ended(&session_id);
            return Ok(SendInputResult {
                ok: true,
                queued: true,
            });
        }

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
            let mut resume_conversation_id = session.provider_conversation_id.clone();
            // A just-switched session always starts the new provider fresh; never
            // resurrect a stale Cursor resume id from an earlier Cursor segment.
            if switch_event.is_none()
                && provider == ProviderId::Cursor
                && resume_conversation_id.is_none()
            {
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
            // A provider switch NULLs the resume id, so this same flag also
            // carries the switched-agent case: no rollout on the other side,
            // rebuild the context from the visible transcript.
            let launch_prompt = compose_follow_up_prompt(
                &connection,
                &session_id,
                &message,
                resume_conversation_id.is_some(),
            )?;
            let launch_prompt = agent_reference_prompt(
                &connection,
                &session_id,
                &launch_prompt,
                input.agent_references.as_deref().unwrap_or_default(),
            )?;
            // A multitask that finished while this session was busy is told to
            // the agent here, on the front of the prompt — never as a turn of
            // its own. The person's own message is persisted unchanged: the
            // timeline already carries the finish marker.
            let pending_results = crate::multitask::results_preamble(&connection, &session_id)?;
            let launch_prompt = match &pending_results {
                Some(results) => format!("{}\n\n{launch_prompt}", results.block),
                None => launch_prompt,
            };
            let user_message = self.persist_user_message_locked(
                &connection,
                &session_id,
                &message,
                agent_mode,
                input.attachments.as_deref(),
                origin.as_ref(),
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
                model_id: session.model_id.clone(),
                reasoning_effort: session
                    .reasoning_effort
                    .as_deref()
                    .and_then(parse_reasoning_effort),
                fast_mode: input.fast_mode,
                // A forked session's first resume must diverge into a new
                // provider conversation; the flag is cleared once the new
                // conversation id lands.
                resume_fork: resume_conversation_id.is_some()
                    && session_resume_fork(&connection, &session_id)?,
                resume_conversation_id,
                permission_mode,
                agent_mode,
                cols: STRUCTURED_LAUNCH_COLS,
                rows: STRUCTURED_LAUNCH_ROWS,
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
                        launch_input.model_id.as_str(),
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
        // Stop can have landed since the check above, while this relaunch was
        // reading the database: `start_termination` has then already taken the
        // old handle away, so nothing here would stop a fresh process coming up
        // under the row cancellation is about to write. Claim the entry while
        // holding the termination markers, in the same order `start_termination`
        // takes them, so exactly one of the two wins: either terminate finds
        // this Pending entry and the spawn disposes the child, or the relaunch
        // is refused here.
        {
            let jobs = self.termination_jobs.lock_or_recover("termination jobs");
            let terminating = self.terminating.lock_or_recover("terminating");
            if jobs.contains_key(&session_id) || terminating.contains(&session_id) {
                return Err(ArgmaxError::service(
                    "PROVIDER_TERMINATING",
                    "Provider chat is being terminated; wait for cancellation to finish.",
                ));
            }
            self.handles
                .lock_or_recover("handles")
                .insert(session_id.clone(), HandleEntry::Pending(Vec::new()));
        }
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
        if let Some(registry) = self.session_control.get() {
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

    fn start_termination(
        self: &Arc<Self>,
        session_id: String,
        preserve_queue: bool,
    ) -> ArgmaxResult<watch::Receiver<Option<ArgmaxResult<()>>>> {
        self.cancel_idle_flush(&session_id);
        if !preserve_queue {
            self.clear_queue(&session_id)?;
        }
        let mut jobs = self.termination_jobs.lock_or_recover("termination jobs");
        if let Some(done) = jobs.get(&session_id) {
            return Ok(done.clone());
        }

        // Mark before transferring the handle so a wait-thread exit event
        // arriving mid-terminate skips its own terminal-state write.
        self.terminating
            .lock_or_recover("terminating")
            .insert(session_id.clone());
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

    async fn finish_termination(
        self: &Arc<Self>,
        session_id: &str,
        entry: Option<HandleEntry>,
    ) -> ArgmaxResult<()> {
        let mut first_error = None;
        // Release native permission waiters before waiting for provider cancel.
        // ACP cannot finish session/cancel until pending requests are answered.
        if let Some(approvals) = self.approvals.as_ref() {
            if let Err(error) = approvals.cancel_session_pending(session_id) {
                first_error = Some(error);
            }
        }

        match entry {
            Some(HandleEntry::Resolved(handle)) => {
                // User-initiated cancel: flush buffered text but don't
                // synthesize a Cursor turn completion — the turn didn't
                // finish, it was cancelled.
                if let Err(error) = self.flush_trailing(session_id, false) {
                    first_error = Some(error);
                }
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
        if let Some(approvals) = self.approvals.as_ref() {
            if let Err(error) = approvals.cancel_session_pending(session_id) {
                first_error.get_or_insert(error);
            }
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

    pub async fn send_queued_message_now(
        self: &Arc<Self>,
        input: ProvidersSendQueuedMessageNowInput,
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
                    Some((index, message))
                } else {
                    None
                }
            } else {
                None
            }
        };
        let Some((_queue_index, message)) = queued_message else {
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
        let result = match self.send_input(send_input).await {
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

    pub fn recover_orphaned_sessions(&self) -> ArgmaxResult<usize> {
        let mut recovered = Vec::new();
        let mut cleanup_sessions = Vec::new();
        {
            let connection = self.database.connection();
            let mut statement = connection
                .prepare(
                    "SELECT id, provider, provider_conversation_id FROM sessions WHERE state IN ('running', 'waiting', 'blocked')",
                )
                .map_err(sqlite_error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok(RecoveredProviderSession {
                        id: row.get(0)?,
                        provider: row.get(1)?,
                        provider_conversation_id: row.get(2)?,
                    })
                })
                .map_err(sqlite_error)?;
            for row in rows {
                recovered.push(row.map_err(sqlite_error)?);
            }
            let mut statement = connection
                .prepare(
                    r#"
                    SELECT DISTINCT s.id, s.provider, s.provider_conversation_id
                    FROM sessions s
                    WHERE s.state IN ('running', 'waiting', 'blocked')
                       OR EXISTS (
                         SELECT 1 FROM events e
                         WHERE e.session_id = s.id
                           AND e.type = 'process_did_not_survive_restart'
                       )
                    "#,
                )
                .map_err(sqlite_error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok(RecoveredProviderSession {
                        id: row.get(0)?,
                        provider: row.get(1)?,
                        provider_conversation_id: row.get(2)?,
                    })
                })
                .map_err(sqlite_error)?;
            for row in rows {
                cleanup_sessions.push(row.map_err(sqlite_error)?);
            }
        }
        // Off the boot path: the scan shells out to `ps` (~50 ms) and sleeps
        // 250 ms between TERM and KILL when it finds orphans. It only signals
        // provider CLIs already reparented to init (ppid == 1), so nothing it
        // kills can belong to this or any live Argmax instance — deferring it
        // past setup() is safe.
        if !cleanup_sessions.is_empty() {
            std::thread::spawn(move || terminate_orphaned_provider_processes(&cleanup_sessions));
        }
        for recovered_session in &recovered {
            let session_id = &recovered_session.id;
            let connection = self.database.connection();
            let session = update_session_state(
                &connection,
                session_id,
                &SessionStateInput::transition(SessionState::Failed).finished_at(now_iso()),
            )?;
            // Mirror the session terminal-state onto the workspace so the
            // dashboard doesn't keep showing a `running` workspace whose
            // session was just marked `failed`.
            let workspace = update_workspace_state_for_session_state(
                &connection,
                &session.workspace_id,
                SessionState::Failed,
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
                workspaces: vec![workspace],
                sessions: vec![session],
                events: vec![event],
                ..DashboardDelta::default()
            });
            let is_multitask = session_launch_kind(&connection, session_id)
                .is_ok_and(|kind| kind == LAUNCH_KIND_MULTITASK);
            drop(connection);
            // A multitask that was mid-turn when the app went down never wrote
            // its finish row, so the chat that dispatched it would keep saying
            // "running alongside" for a process that died with the app. Boot is
            // where that becomes knowable, and the row says `failed` because
            // that is what happened to it.
            if is_multitask {
                self.record_multitask_finish(session_id, SessionState::Failed, &now_iso());
            }
            if let Some(approvals) = self.approvals.as_ref() {
                approvals.cancel_session_pending(session_id)?;
            }
        }
        Ok(recovered.len())
    }

    fn is_current_provider_invocation(
        &self,
        session_id: &str,
        provider_invocation_id: &str,
    ) -> bool {
        self.flush_queue
            .lock_or_recover("flush queue")
            .is_current_invocation(session_id, provider_invocation_id)
    }

    fn handle_provider_event(
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

    fn handle_output_event(
        self: Arc<Self>,
        event: ProviderRuntimeEvent,
        provider_invocation_id: String,
    ) -> ArgmaxResult<()> {
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
        // A genuine process exit is the one place a Cursor turn that never sent
        // `result/success` should be synthesized as completed — but not when the
        // user cancelled (the session is heading to `cancelled`, not `complete`).
        let is_terminating = self
            .terminating
            .lock_or_recover("terminating")
            .contains(&event.session_id);
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
            if let Some(approvals) = self.approvals.as_ref() {
                approvals.cancel_session_pending(&event.session_id)?;
            }
            return Ok(());
        }
        self.capture_pr_branch(&event.session_id);
        let connection = self.database.connection();
        let succeeded =
            event.r#type == ProviderRuntimeEventType::Exit && event.exit_code == Some(0);
        let state = if succeeded {
            SessionState::Complete
        } else {
            SessionState::Failed
        };
        let completed_at = event.created_at.clone();
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
            &SessionStateInput::transition(state).finished_at(event.created_at.clone()),
        )?;
        let workspace =
            update_workspace_state_for_session_state(&connection, &session.workspace_id, state)?;
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
            .lock_or_recover("handles")
            .remove(&event.session_id);
        self.flush_queue
            .lock_or_recover("flush queue")
            .delete_session(&event.session_id);
        if !succeeded {
            self.pause_queue_with_connection(&connection, &event.session_id)?;
        }
        let mut delta = DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace],
            sessions: vec![session],
            events: vec![timeline_event],
            raw_outputs: vec![raw_output],
            ..DashboardDelta::default()
        };
        drop(connection);
        self.append_reconciled_subagent_events(&event.session_id, &mut delta);
        self.publish(delta);
        // The drain is what sends a follow-up the user queued during the turn.
        // It must not depend on the approvals cleanup succeeding: an error
        // there used to return early and strand the queue until the next turn.
        let approvals_cancelled = match self.approvals.as_ref() {
            Some(approvals) => approvals.cancel_session_pending(&event.session_id),
            None => Ok(()),
        };
        self.settle_session_after_turn(&event.session_id);
        self.notify_launcher_of_turn_end(&event.session_id, state, &completed_at);
        if succeeded {
            self.drain_queue_after_complete(event.session_id);
        }
        approvals_cancelled
    }

    /// One completion notice per turn end, addressed to whoever launched this
    /// session.
    ///
    /// The notice is both an inbox row (what `inbox_read` and `session_wait`
    /// read) and an ordinary turn in the launching session, delivered through
    /// the same queue-until-idle path a person's follow-up takes — so an idle
    /// parent wakes up on its child finishing.
    ///
    /// Why this cannot ping-pong: `launched_by_session_id` is a strict tree
    /// rooted at the sessions a person or a routine started, and a launch is
    /// capped at depth 2. A session with no launcher emits nothing, so a
    /// notice climbs at most two hops and never comes back down. That is also
    /// the answer to "does the parent's completion-triggered turn notify the
    /// grandparent?" — it does, but only when the parent was itself launched,
    /// because otherwise it has no launcher to notify.
    fn notify_launcher_of_turn_end(
        self: &Arc<Self>,
        session_id: &str,
        state: SessionState,
        at: &str,
    ) {
        // A multitask is the one launch whose finish must not wake its parent:
        // the person dispatched it while watching another turn, and a turn that
        // says "noted" costs a provider relaunch to interrupt what they were
        // reading. Its result lands in the parent's timeline and inbox instead,
        // and rides along on the next thing they type. See crate::multitask.
        let is_multitask = matches!(
            session_launch_kind(&self.database.connection(), session_id).as_deref(),
            Ok(LAUNCH_KIND_MULTITASK)
        );
        if is_multitask {
            self.record_multitask_finish(session_id, state, at);
            return;
        }
        match self.build_completion_notice(session_id, state, at) {
            Ok(Some(notice)) => {
                if let Some(registry) = self.session_control.get() {
                    registry.notify_inbox(&notice.to_session_id);
                }
                let service = Arc::clone(self);
                tauri::async_runtime::spawn(async move { service.deliver_notice(notice).await });
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(
                session_id,
                ?error,
                "failed to record the completion notice for the launching session"
            ),
        }
    }

    /// Passive delivery of a finished multitask: a timeline row the parent's
    /// chat renders as a tail marker, plus the inbox row `inbox_read` and the
    /// next prompt's preamble pick up. No turn is started.
    fn record_multitask_finish(&self, session_id: &str, state: SessionState, at: &str) {
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
        if let Some(registry) = self.session_control.get() {
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

    fn build_completion_notice(
        &self,
        session_id: &str,
        state: SessionState,
        at: &str,
    ) -> ArgmaxResult<Option<CompletionNotice>> {
        let connection = self.database.connection();
        let session = find_session_by_id(&connection, session_id)?;
        let Some(parent_id) = session.launched_by_session_id.clone() else {
            return Ok(None);
        };
        if parent_id == session_id {
            return Ok(None);
        }
        let Ok(parent) = find_session_by_id(&connection, &parent_id) else {
            return Ok(None);
        };
        let parent_workspace = find_workspace_by_id(&connection, &parent.workspace_id)?;
        if matches!(
            parent_workspace.state.as_str(),
            "archiving" | "archive-failed" | "archived"
        ) {
            return Ok(None);
        }
        let label = find_workspace_by_id(&connection, &session.workspace_id)
            .map(|workspace| workspace.task_label)
            .unwrap_or_else(|_| session_id.to_string());
        let answer = latest_agent_message(&connection, session_id)?
            .filter(|text| !text.trim().is_empty())
            .map(|text| cap_notice_answer(&text))
            .unwrap_or_else(|| "(the session produced no assistant message)".to_string());
        let body = format!(
            "Session {session_id} ({label}) finished with state {state}. Final answer:\n{answer}"
        );
        let message = NewSessionMessage {
            // Deterministic, so a retry of the same turn end writes the same
            // row rather than a second notice.
            id: format!("completion:{session_id}:{at}"),
            from_session_id: Some(session_id.to_string()),
            to_session_id: parent_id.clone(),
            body: body.clone(),
            kind: COMPLETION_KIND.to_string(),
        };
        if !insert_session_message(&connection, &message)? {
            return Ok(None);
        }
        Ok(Some(CompletionNotice {
            message_id: message.id.clone(),
            to_session_id: parent_id,
            body,
            origin: MessageOrigin {
                session_id: session_id.to_string(),
                label,
                kind: COMPLETION_KIND.to_string(),
                message_id: Some(message.id),
            },
        }))
    }

    async fn deliver_notice(self: Arc<Self>, notice: CompletionNotice) {
        let input = match (
            SessionId::try_from(notice.to_session_id.clone()),
            Prompt::try_from(notice.body),
        ) {
            (Ok(session_id), Ok(input)) => ProvidersSendInput {
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
        match self
            .send_input_with_origin(input, Some(notice.origin))
            .await
        {
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

    fn record_launch_failure(
        self: &Arc<Self>,
        session_id: &str,
        provider: ProviderId,
        error: ArgmaxError,
    ) -> ArgmaxResult<()> {
        self.flush_queue
            .lock_or_recover("flush queue")
            .delete_session(session_id);
        let connection = self.database.connection();
        let completed_at = now_iso();
        let session = update_session_state(
            &connection,
            session_id,
            &SessionStateInput::transition(SessionState::Failed).finished_at(completed_at.clone()),
        )?;
        let workspace = update_workspace_state_for_session_state(
            &connection,
            &session.workspace_id,
            SessionState::Failed,
        )?;
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
        self.pause_queue_with_connection(&connection, session_id)?;
        self.publish(DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace],
            sessions: vec![session],
            events: vec![event],
            ..DashboardDelta::default()
        });
        drop(connection);
        // A launch that never started is still this session's turn ending, and
        // whoever launched it is owed that news: without it a multitask whose
        // CLI could not start leaves a row that says "Running" for as long as
        // the transcript lives, since the finish row it falls back to was never
        // written.
        self.notify_launcher_of_turn_end(session_id, SessionState::Failed, &completed_at);
        Ok(())
    }

    fn cancel_session(self: &Arc<Self>, session_id: &str) -> ArgmaxResult<()> {
        self.capture_pr_branch(session_id);
        let connection = self.database.connection();
        let current = find_session_by_id(&connection, session_id)?;
        if !current.state.is_active() {
            return Ok(());
        }
        let completed_at = now_iso();
        let session = update_session_state(
            &connection,
            session_id,
            &SessionStateInput::transition(SessionState::Cancelled)
                .finished_at(completed_at.clone()),
        )?;
        let workspace = update_workspace_state_for_session_state(
            &connection,
            &session.workspace_id,
            SessionState::Cancelled,
        )?;
        let event = persist_timeline_event(
            &connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                r#type: "session.cancelled".to_string(),
                message: "Provider chat cancelled.".to_string(),
                payload: json!({}),
                created_at: Some(completed_at.clone()),
            },
        )?;
        self.flush_queue
            .lock_or_recover("flush queue")
            .delete_session(session_id);
        let delta = DashboardDelta {
            projects: list_projects(&connection)?,
            workspaces: vec![workspace],
            sessions: vec![session],
            events: vec![event],
            ..DashboardDelta::default()
        };
        drop(connection);
        self.publish(delta);
        self.notify_launcher_of_turn_end(session_id, SessionState::Cancelled, &completed_at);
        Ok(())
    }

    fn live_handle(&self, session_id: &str) -> Option<Arc<dyn ProviderRuntimeHandle>> {
        match self.handles.lock_or_recover("handles").get(session_id) {
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
        origin: Option<&MessageOrigin>,
    ) -> ArgmaxResult<()> {
        let connection = self.database.connection();
        let event = self.persist_user_message_locked(
            &connection,
            session_id,
            message,
            agent_mode,
            attachments,
            origin,
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
        origin: Option<&MessageOrigin>,
    ) -> ArgmaxResult<crate::persistence::events::TimelineEvent> {
        let mut payload = composer_payload(agent_mode, attachments);
        if let Some(origin) = origin {
            payload["origin"] = serde_json::to_value(origin).unwrap_or(Value::Null);
        }
        persist_timeline_event(
            connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                r#type: "user.message".to_string(),
                message: message.to_string(),
                payload,
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
        origin: Option<MessageOrigin>,
    ) -> ArgmaxResult<()> {
        // A drained follow-up always keeps the session's current provider (see
        // pending_message_to_send_input), so when this send asked for a
        // different provider its model metadata belongs to that switch and
        // must not survive the queue either — persisting it would write e.g. a
        // Codex model id onto a Claude session and relaunch with a foreign
        // --model flag.
        let mut connection = self.database.connection();
        let switches_provider = match input.provider {
            Some(requested) => {
                find_session_by_id(&connection, session_id)?.provider != requested.as_str()
            }
            None => false,
        };
        let (model_label, model_id, reasoning_effort, fast_mode) = if switches_provider {
            (None, None, None, false)
        } else {
            (
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
        };
        self.ensure_no_pending_after_turn(session_id)?;
        let mut queues = self.queues.lock_or_recover("queues");
        let mut queue = queues.get(session_id).cloned().unwrap_or_default();
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
            model_label,
            model_id,
            reasoning_effort,
            fast_mode,
            attachments: input.attachments.clone().unwrap_or_default(),
            agent_references: input.agent_references.clone().unwrap_or_default(),
            origin,
            recovery_status: None,
            queued_at: now_iso(),
        });
        replace_session_queue(&mut connection, session_id, &queue)?;
        queues.insert(session_id.to_string(), queue);
        drop(queues);
        self.publish_pending_messages(session_id);
        Ok(())
    }

    fn clear_queue(&self, session_id: &str) -> ArgmaxResult<()> {
        let connection = self.database.connection();
        self.clear_queue_with_connection(&connection, session_id)
    }

    fn clear_queue_with_connection(
        &self,
        connection: &rusqlite::Connection,
        session_id: &str,
    ) -> ArgmaxResult<()> {
        clear_session_queue(connection, session_id)?;
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
    fn pause_queue_with_connection(
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
            .map_err(crate::persistence::sqlite_error)?;
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

    fn publish_pending_messages(&self, session_id: &str) {
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
    fn drain_queue_if_turn_ended(self: &Arc<Self>, session_id: &str) {
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

    fn drain_queue_after_complete(self: &Arc<Self>, session_id: String) {
        let (_queue_index, next) = match self.pop_next_undelivered(&session_id) {
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
            match service.send_input_with_origin(send_input, origin).await {
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
    fn pop_next_undelivered(
        &self,
        session_id: &str,
    ) -> ArgmaxResult<Option<(usize, PendingMessage)>> {
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
                next.map(|message| (index, message))
            };
            let Some((index, next)) = next else {
                return Ok(None);
            };
            if !origin_row_is_delivered(self, &next) {
                return Ok(Some((index, next)));
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

    /// `synthesize_cursor_exit` is `true` only on a genuine Cursor process exit
    /// (see `flush_trailing_fragments`). Mid-turn idle flushes and user
    /// terminates pass `false` so they don't prematurely complete the turn.
    fn flush_trailing(&self, session_id: &str, synthesize_cursor_exit: bool) -> ArgmaxResult<()> {
        let mut connection = self.database.connection();
        let mut delta = self
            .flush_queue
            .lock_or_recover("flush queue")
            .flush_trailing_fragments(
                &mut connection,
                session_id,
                &now_iso(),
                synthesize_cursor_exit,
            )?;
        drop(connection);
        if let Some(delta) = delta.as_mut() {
            if delta_has_session_completed_event(delta) {
                self.append_reconciled_subagent_events(session_id, delta);
            }
        }
        let reconcile_subagents = delta.as_ref().is_some_and(|delta| {
            !delta_has_session_completed_event(delta) && delta_has_subagent_control_event(delta)
        });
        if let Some(delta) = delta {
            self.publish(delta);
        }
        if reconcile_subagents {
            self.schedule_subagent_trace_reconciliation(session_id);
        }
        Ok(())
    }

    /// Cursor's `cursor-agent` often emits `result/success` while the child
    /// process stays alive (same class of bug as the idle-flush comment above).
    /// Mark the session complete and dispose the handle so the UI does not
    /// sit on "Working" / thinking verbs until the user hits Stop.
    async fn complete_cursor_turn_after_result(
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
        self.cancel_idle_flush(session_id);
        // `result/success` already emitted the completion via the normalizer, so
        // no exit synth here.
        self.flush_trailing(session_id, false)?;

        self.capture_pr_branch(session_id);
        let completed_at = now_iso();
        let (session, workspace, projects) = {
            let connection = self.database.connection();
            let session = update_session_state(
                &connection,
                session_id,
                &SessionStateInput::transition(SessionState::Complete)
                    .finished_at(completed_at.clone()),
            )?;
            let workspace = update_workspace_state_for_session_state(
                &connection,
                &session.workspace_id,
                SessionState::Complete,
            )?;
            let projects = list_projects(&connection)?;
            (session, workspace, projects)
        };

        let entry = self.handles.lock_or_recover("handles").remove(session_id);
        self.flush_queue
            .lock_or_recover("flush queue")
            .delete_session(session_id);

        self.publish(DashboardDelta {
            projects,
            workspaces: vec![workspace],
            sessions: vec![session],
            ..DashboardDelta::default()
        });

        // The turn is over here, so its approvals are stale — the exit path
        // clears them at this same point. Like there, a failure must not return
        // early: the queue drain below is what sends a follow-up the user typed
        // during the turn.
        let approvals_cancelled = match self.approvals.as_ref() {
            Some(approvals) => approvals.cancel_session_pending(session_id),
            None => Ok(()),
        };
        let mut first_error = approvals_cancelled.err();
        if let Some(HandleEntry::Resolved(handle)) = entry {
            if let Err(error) = handle.terminate().await {
                let _ = self.abort_session_after_turn(
                    session_id,
                    "Could not move this chat because the Cursor turn did not stop safely.",
                );
                first_error.get_or_insert(error);
            }
        }
        self.settle_session_after_turn(session_id);
        // Cursor ends a turn on `result/success` rather than on a process exit,
        // so this is that provider's only turn-end seam — and whoever launched
        // this session is told here, exactly as the exit path tells them. Left
        // out, a Cursor child never reported back at all: no completion notice
        // for an agent's launch, and no `multitask.finished` row, so its chat
        // row could only say that it had stopped, never what it found.
        self.notify_launcher_of_turn_end(session_id, SessionState::Complete, &completed_at);
        self.drain_queue_after_complete(session_id.to_string());
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn cancel_idle_flush(&self, session_id: &str) {
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

    fn schedule_idle_flush(self: &Arc<Self>, session_id: &str) {
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
            // Mid-turn idle flush: never synthesize a Cursor completion, or the
            // turn completes prematurely and the next delta duplicates.
            let flush_result = service.flush_trailing(&session_id_owned, false);
            service
                .idle_flush_tasks
                .lock_or_recover("idle flush tasks")
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
            .lock_or_recover("idle flush tasks")
            .insert(session_id_for_map, handle);
    }

    fn publish(&self, delta: DashboardDelta) {
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

    /// Every session state this service writes from now on. `session_wait`
    /// subscribes before it reads the current states, so an edge that lands
    /// between the two is queued rather than missed.
    pub fn subscribe_session_states(&self) -> broadcast::Receiver<SessionStateChange> {
        self.session_states.subscribe()
    }

    /// Mark the worktree where this turn starts, so a provider that reports a
    /// file write without saying what changed can still get a line stat. Off
    /// the send path: the mark costs a few hundred milliseconds on a large
    /// repo, while the agent's first write is a model round-trip away.
    fn mark_turn_start(&self, session_id: &str, workspace_path: PathBuf) {
        self.capture_pr_branch(session_id);
        let mark = self.measured_diffs.open_turn(session_id, workspace_path);
        tauri::async_runtime::spawn(capture_opening_mark(mark));
    }

    // Watcher delivery can lag behind the last checkout command of a turn.
    // Reading symbolic HEAD is small local I/O and also handles linked worktrees.
    fn capture_pr_branch(&self, session_id: &str) {
        let result = (|| -> ArgmaxResult<()> {
            let workspace_path = {
                let connection = self.database.read_connection();
                let session = find_session_by_id(&connection, session_id)?;
                if !session.state.is_active() {
                    return Ok(());
                }
                find_workspace_by_id(&connection, &session.workspace_id)?.path
            };
            let Some(branch) = checkout_head_branch(std::path::Path::new(&workspace_path)) else {
                return Ok(());
            };
            let connection = self.database.connection();
            crate::persistence::sessions::record_session_pr_branch(&connection, session_id, &branch)
        })();
        if let Err(error) = result {
            tracing::warn!(%session_id, %error, "could not capture session PR branch");
        }
    }

    /// When a tool's stdout contains a GitHub PR URL (typically `gh pr create`),
    /// cache that PR immediately. The poller only views `workspace.branch` in
    /// `workspace.path`, so a PR opened from another worktree would otherwise
    /// never appear on the sidebar.
    fn schedule_observed_prs(self: &Arc<Self>, session_id: &str, delta: &DashboardDelta) {
        let mut numbers = Vec::new();
        for event in &delta.events {
            for number in
                pr_numbers_from_command_event(&event.r#type, &event.message, &event.payload)
            {
                if !numbers.contains(&number) {
                    numbers.push(number);
                }
            }
        }
        if numbers.is_empty() {
            return;
        }
        let service = Arc::clone(self);
        let session_id = session_id.to_string();
        tauri::async_runtime::spawn(async move {
            let gh = GhService::new(Arc::clone(&service.database));
            // Refresh scans the persisted events with project identity intact.
            // A bare PR number from another repository is not attribution.
            if let Err(error) = gh.refresh(&session_id).await {
                tracing::warn!(%error, %session_id, "could not cache PR from command output");
                return;
            }
            let workspaces = {
                let connection = service.database.connection();
                crate::gh::workspaces_for_pr_refresh(&connection, &session_id)
            };
            match workspaces {
                Ok(workspaces) => service.publish(DashboardDelta {
                    workspaces,
                    ..DashboardDelta::default()
                }),
                Err(error) => tracing::warn!(
                    %error,
                    session_id,
                    "could not publish workspace after observing a PR"
                ),
            }
        });
    }

    /// Measure the diffs a provider left out, then rewrite the tool's own
    /// `command.completed` row with them.
    ///
    /// The row is already on screen by the time this runs, so the stat arrives
    /// a moment after the file name. Updating the row in place (same id, same
    /// rowid) means the renderer's upsert replaces it and the chat keeps
    /// reading tool input, rather than learning about a second kind of event.
    fn schedule_measured_diffs(self: &Arc<Self>, session_id: &str, delta: &DashboardDelta) {
        let pending = delta
            .events
            .iter()
            .filter_map(|event| {
                let paths = paths_awaiting_diff(event);
                (!paths.is_empty()).then(|| (event.id.clone(), paths))
            })
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return;
        }
        let service = Arc::clone(self);
        let session_id = session_id.to_string();
        tauri::async_runtime::spawn(async move {
            for (event_id, paths) in pending {
                let measured = service.measured_diffs.measure(&session_id, &paths).await;
                match service.rewrite_event_with_measured_diffs(&event_id, &measured) {
                    Ok(Some(event)) => service.publish(DashboardDelta {
                        events: vec![event],
                        ..DashboardDelta::default()
                    }),
                    Ok(None) => {}
                    Err(error) => tracing::warn!(
                        %error,
                        session_id,
                        event_id,
                        "could not store measured file-change diffs"
                    ),
                }
            }
        });
    }

    fn rewrite_event_with_measured_diffs(
        &self,
        event_id: &str,
        measured: &[MeasuredDiff],
    ) -> ArgmaxResult<Option<TimelineEvent>> {
        if measured.is_empty() {
            return Ok(None);
        }
        let connection = self.database.connection();
        let Some(mut event) = find_event_by_id(&connection, event_id)? else {
            return Ok(None);
        };
        if !merge_measured_diffs(&mut event.payload, measured) {
            return Ok(None);
        }
        update_event_payload(&connection, event_id, &event.payload)?;
        Ok(Some(event))
    }

    fn schedule_subagent_trace_reconciliation(&self, session_id: &str) {
        let session_id = session_id.to_string();
        {
            let mut reconciliations = self
                .subagent_reconciliations
                .lock_or_recover("subagent reconciliations");
            if let Some(rescan) = reconciliations.get_mut(&session_id) {
                *rescan = true;
                return;
            }
            reconciliations.insert(session_id.clone(), false);
        }
        let database = Arc::clone(&self.database);
        let in_flight = Arc::clone(&self.subagent_reconciliations);
        tauri::async_runtime::spawn_blocking(move || loop {
            if let Err(error) = reconcile_session_subagent_traces(&database, &session_id) {
                tracing::warn!(
                    error = %error,
                    session_id,
                    "failed to reconcile live subagent trace events"
                );
            }
            let should_rescan = {
                let mut reconciliations = in_flight.lock_or_recover("subagent reconciliations");
                match reconciliations.get_mut(&session_id) {
                    Some(rescan) if *rescan => {
                        *rescan = false;
                        true
                    }
                    _ => {
                        reconciliations.remove(&session_id);
                        false
                    }
                }
            };
            if !should_rescan {
                break;
            }
        });
    }

    fn append_reconciled_subagent_events(&self, session_id: &str, delta: &mut DashboardDelta) {
        let cursor = delta
            .events
            .iter()
            .filter_map(|event| event.row_cursor)
            .max()
            .unwrap_or(0);
        if let Err(error) = reconcile_session_subagent_traces(&self.database, session_id) {
            tracing::warn!(
                error = %error,
                session_id,
                "failed to reconcile terminal subagent trace events"
            );
            return;
        }
        let connection = self.database.read_connection();
        match list_session_events_since(&connection, session_id, Some(cursor), Some(i64::MAX)) {
            Ok(result) => delta.events.extend(result.events),
            Err(error) => tracing::warn!(
                error = %error,
                session_id,
                "failed to read reconciled terminal subagent events"
            ),
        }
    }
}

/// A turn ending, and only that. `error` rows are transient — stderr lines,
/// tracing-format output, per-item provider errors — and treating them as
/// terminal ran a synchronous subagent-trace sweep on the PTY reader thread for
/// every one. The real process-exit path reconciles unconditionally.
fn checkout_head_branch(workspace_path: &std::path::Path) -> Option<String> {
    let dot_git = workspace_path.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let pointer = std::fs::read_to_string(dot_git).ok()?;
        workspace_path.join(pointer.trim().strip_prefix("gitdir:")?.trim())
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .filter(|branch| !branch.is_empty())
        .map(str::to_owned)
}

fn delta_has_session_completed_event(delta: &DashboardDelta) -> bool {
    delta
        .events
        .iter()
        .any(|event| event.r#type == "session.completed")
}

fn delta_has_subagent_control_event(delta: &DashboardDelta) -> bool {
    delta.events.iter().any(|event| {
        matches!(
            event.r#type.as_str(),
            "command.started" | "command.completed"
        ) && matches!(
            event.message.to_ascii_lowercase().as_str(),
            "spawn_agent" | "wait" | "close_agent" | "send_message_to_thread"
        )
    })
}

fn pending_message_to_send_input(
    session_id: String,
    message: PendingMessage,
) -> ArgmaxResult<ProvidersSendInput> {
    let message_id = message.id;
    let queued_session_id = message.session_id;
    let session_id = SessionId::try_from(session_id).map_err(ArgmaxError::invalid)?;
    let input = Prompt::try_from(message.content).map_err(ArgmaxError::invalid)?;
    Ok(ProvidersSendInput {
        agent_references: (!message.agent_references.is_empty())
            .then_some(message.agent_references),
        session_id,
        input,
        // Queued follow-ups never switch provider — provider switching is gated to
        // idle sessions, so a drained message keeps the session's current provider.
        provider: None,
        model_label: pending_model_metadata(
            &queued_session_id,
            &message_id,
            "modelLabel",
            message.model_label,
        ),
        model_id: pending_model_metadata(
            &queued_session_id,
            &message_id,
            "modelId",
            message.model_id,
        ),
        reasoning_effort: message
            .reasoning_effort
            .as_deref()
            .and_then(parse_reasoning_effort),
        fast_mode: message.fast_mode,
        agent_mode: parse_agent_mode(&message.agent_mode),
        attachments: (!message.attachments.is_empty()).then_some(message.attachments),
    })
}

fn pending_model_metadata(
    session_id: &str,
    message_id: &str,
    field: &'static str,
    value: Option<String>,
) -> Option<NonEmptyString> {
    value.and_then(|value| match NonEmptyString::try_from(value) {
        Ok(value) => Some(value),
        Err(error) => {
            tracing::warn!(
                session_id,
                message_id,
                field,
                ?error,
                "dropping invalid queued model metadata"
            );
            None
        }
    })
}

/// Whether a queued follow-up's inbox row has already been handed over. Only
/// agent messages and completion notices carry a row; a user-typed follow-up
/// never does, and always sends.
fn origin_row_is_delivered(service: &ProviderSessionService, message: &PendingMessage) -> bool {
    message
        .origin
        .as_ref()
        .and_then(|origin| origin.message_id.as_deref())
        .and_then(|id| is_message_delivered(&service.database.read_connection(), id).ok())
        .unwrap_or(false)
}

/// Provider lifecycle updates must not overwrite the authoritative workspace
/// archive state. The transaction closes the read/update race with an archive
/// coordinator that has already entered `archiving`.
fn update_workspace_state_for_session_state(
    connection: &rusqlite::Connection,
    workspace_id: &str,
    state: SessionState,
) -> ArgmaxResult<WorkspaceSummary> {
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let current = find_workspace_by_id(&transaction, workspace_id)?;
    let workspace = if matches!(
        current.state.as_str(),
        "archiving" | "archive-failed" | "archived"
    ) {
        current
    } else {
        update_workspace_state(&transaction, workspace_id, state.as_str())?
    };
    transaction.commit().map_err(sqlite_error)?;
    Ok(workspace)
}

fn infer_cursor_provider_conversation_id(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> ArgmaxResult<Option<String>> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT content FROM raw_outputs
            WHERE session_id = ?
              AND created_at > COALESCE((
                SELECT created_at FROM events
                WHERE events.session_id = raw_outputs.session_id
                  AND events.type = 'session.cleared'
                ORDER BY rowid DESC
                LIMIT 1
              ), '')
            ORDER BY rowid ASC
            "#,
        )
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SendInputResult {
    pub ok: bool,
    pub queued: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_branch_capture_reads_checkout_and_linked_worktree_heads() {
        let directory = tempfile::tempdir().unwrap();
        let checkout = directory.path().join("checkout");
        let linked = directory.path().join("linked");
        let metadata = checkout.join(".git/worktrees/linked");
        std::fs::create_dir_all(&metadata).unwrap();
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(checkout.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(
            linked.join(".git"),
            "gitdir: ../checkout/.git/worktrees/linked\n",
        )
        .unwrap();
        std::fs::write(metadata.join("HEAD"), "ref: refs/heads/feature/final\n").unwrap();
        assert_eq!(checkout_head_branch(&checkout).as_deref(), Some("main"));
        assert_eq!(
            checkout_head_branch(&linked).as_deref(),
            Some("feature/final")
        );
        std::fs::write(metadata.join("HEAD"), "0123456789abcdef\n").unwrap();
        assert_eq!(checkout_head_branch(&linked), None);
    }

    #[test]
    fn queued_follow_up_keeps_native_agent_references() {
        let references = serde_json::from_value(json!([{
            "name": "Gauss",
            "providerChildSessionId": "child-1",
            "providerParentConversationId": "parent-1"
        }]))
        .expect("references");
        let message = PendingMessage {
            id: "queued-reference".to_string(),
            session_id: "s1".to_string(),
            content: "Ask Gauss again".to_string(),
            agent_mode: "auto".to_string(),
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: false,
            attachments: Vec::new(),
            agent_references: references,
            origin: None,
            recovery_status: None,
            queued_at: now_iso(),
        };
        let expected = message.agent_references.clone();
        let input = pending_message_to_send_input("s1".to_string(), message).expect("queued input");
        assert_eq!(input.input.as_str(), "Ask Gauss again");
        assert_eq!(input.agent_references.as_deref(), Some(expected.as_slice()));
    }

    #[tokio::test]
    async fn cursor_composer_reference_is_rejected_before_a_queued_model_update() {
        use crate::persistence::{
            projects::{persist_project, PersistProjectInput, ProjectSettings},
            workspaces::{persist_workspace, PersistWorkspaceInput},
        };

        let database = Arc::new(Database::open_in_memory().expect("open db"));
        {
            let connection = database.connection();
            persist_project(
                &connection,
                &PersistProjectInput {
                    id: "project-1".to_string(),
                    name: "argmax-test".to_string(),
                    repo_path: "/tmp/repo".to_string(),
                    current_branch: "main".to_string(),
                    default_branch: Some("main".to_string()),
                    settings: ProjectSettings {
                        archive_on_merge: false,
                        worktree_location: "/tmp/worktrees".to_string(),
                        setup_command: String::new(),
                        check_commands: Vec::new(),
                    },
                },
            )
            .expect("persist project");
            persist_workspace(
                &connection,
                &PersistWorkspaceInput {
                    id: "workspace-1".to_string(),
                    project_id: "project-1".to_string(),
                    task_label: "test workspace".to_string(),
                    branch: "feature/test".to_string(),
                    base_ref: "main".to_string(),
                    path: "/tmp/repo".to_string(),
                    state: "complete".to_string(),
                    shared_workspace: false,
                    kind: "git".to_string(),
                    dirty: false,
                    changed_files: 0,
                },
            )
            .expect("persist workspace");
            persist_session(
                &connection,
                &PersistSessionInput {
                    id: "session-1".to_string(),
                    workspace_id: "workspace-1".to_string(),
                    provider: "cursor".to_string(),
                    model_label: "Safe one-shot".to_string(),
                    model_id: "gpt-5".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "hello".to_string(),
                    state: SessionState::Complete,
                },
            )
            .expect("persist session");
        }
        let references = serde_json::from_value(json!([{
            "name": "Gauss",
            "providerChildSessionId": "child-1",
            "providerParentConversationId": "parent-1"
        }]))
        .expect("references");
        let queued = PendingMessage {
            id: "queued-reference".to_string(),
            session_id: "session-1".to_string(),
            content: "Ask Gauss again".to_string(),
            agent_mode: "auto".to_string(),
            model_label: Some("Composer".to_string()),
            model_id: Some("composer-2.5".to_string()),
            reasoning_effort: None,
            fast_mode: false,
            attachments: Vec::new(),
            agent_references: references,
            origin: None,
            recovery_status: None,
            queued_at: now_iso(),
        };
        let input =
            pending_message_to_send_input("session-1".to_string(), queued).expect("queued input");
        let service = ProviderSessionService::new(Arc::clone(&database));
        let error = service
            .send_input(input)
            .await
            .expect_err("Composer references must be rejected");
        assert!(matches!(
            error,
            ArgmaxError::ServiceError { ref sub_code, .. }
                if sub_code == "AGENT_REFERENCE_UNAVAILABLE"
        ));
        let connection = database.connection();
        let session = find_session_by_id(&connection, "session-1").expect("session remains");
        assert_eq!(session.model_id, "gpt-5");
        assert!(service.pending_messages_snapshot().is_empty());
    }

    #[test]
    fn only_agent_control_events_trigger_trace_reconciliation() {
        let mut delta = DashboardDelta {
            events: vec![crate::persistence::events::TimelineEvent {
                id: "wait".to_string(),
                session_id: "session".to_string(),
                r#type: "command.started".to_string(),
                message: "wait".to_string(),
                payload: json!({}),
                created_at: now_iso(),
                row_cursor: Some(1),
            }],
            ..DashboardDelta::default()
        };
        assert!(delta_has_subagent_control_event(&delta));
        assert!(!delta_has_session_completed_event(&delta));

        delta.events[0].message = "shell".to_string();
        assert!(!delta_has_subagent_control_event(&delta));

        delta.events[0].message = "spawn_agent".to_string();
        delta.events[0].r#type = "message.completed".to_string();
        assert!(!delta_has_subagent_control_event(&delta));

        delta.events[0].r#type = "session.completed".to_string();
        assert!(delta_has_session_completed_event(&delta));

        // A transient error line (stderr, a tracing-format line, a failed
        // provider item) is not the end of the turn — treating it as one made
        // every such line walk the subagent trace directory synchronously.
        delta.events[0].r#type = "error".to_string();
        assert!(!delta_has_session_completed_event(&delta));
    }

    /// "Send now" pops the follow-up out of the queue before it reaches the
    /// provider. When the send is then refused — here by an archiving
    /// workspace — the message must come back rather than vanish.
    #[tokio::test]
    async fn send_now_restores_the_follow_up_when_the_send_is_refused() {
        use crate::persistence::{
            projects::{persist_project, PersistProjectInput, ProjectSettings},
            workspaces::{persist_workspace, PersistWorkspaceInput},
        };

        let database = Arc::new(Database::open_in_memory().expect("open db"));
        {
            let connection = database.connection();
            persist_project(
                &connection,
                &PersistProjectInput {
                    id: "project-1".to_string(),
                    name: "argmax-test".to_string(),
                    repo_path: "/tmp/repo".to_string(),
                    current_branch: "main".to_string(),
                    default_branch: Some("main".to_string()),
                    settings: ProjectSettings {
                        archive_on_merge: false,
                        worktree_location: "/tmp/worktrees".to_string(),
                        setup_command: String::new(),
                        check_commands: Vec::new(),
                    },
                },
            )
            .expect("persist project");
            persist_workspace(
                &connection,
                &PersistWorkspaceInput {
                    id: "workspace-1".to_string(),
                    project_id: "project-1".to_string(),
                    task_label: "test workspace".to_string(),
                    branch: "feature/test".to_string(),
                    base_ref: "main".to_string(),
                    path: "/tmp/repo".to_string(),
                    state: "archiving".to_string(),
                    shared_workspace: false,
                    kind: "git".to_string(),
                    dirty: false,
                    changed_files: 0,
                },
            )
            .expect("persist workspace");
            persist_session(
                &connection,
                &PersistSessionInput {
                    id: "session-1".to_string(),
                    workspace_id: "workspace-1".to_string(),
                    provider: "claude".to_string(),
                    model_label: "Sonnet 5".to_string(),
                    model_id: "claude-sonnet-5".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "hello".to_string(),
                    state: SessionState::Running,
                },
            )
            .expect("persist session");
        }

        let service = ProviderSessionService::new(database);
        let message_id = Uuid::new_v4().to_string();
        let queued = VecDeque::from([PendingMessage {
            id: message_id.clone(),
            session_id: "session-1".to_string(),
            content: "please keep this".to_string(),
            agent_mode: AgentMode::Auto.as_str().to_string(),
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: false,
            attachments: Vec::new(),
            agent_references: Vec::new(),
            origin: None,
            recovery_status: None,
            queued_at: now_iso(),
        }]);
        {
            let mut connection = service.database.connection();
            replace_session_queue(&mut connection, "session-1", &queued).expect("persist queue");
        }
        service
            .queues
            .lock_or_recover("queues")
            .insert("session-1".to_string(), queued);

        service
            .queue_promotions
            .lock_or_recover("queue promotions")
            .insert("session-1".to_string());
        let concurrent = service
            .send_queued_message_now(ProvidersSendQueuedMessageNowInput {
                session_id: SessionId::try_from("session-1".to_string()).unwrap(),
                message_id: NonEmptyString::try_from(message_id.clone()).unwrap(),
            })
            .await
            .expect_err("a second promotion must not claim another message");
        assert!(
            matches!(concurrent, ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "QUEUED_MESSAGE_SEND_IN_PROGRESS")
        );
        assert_eq!(
            service.pending_messages_snapshot()["session-1"][0].id,
            message_id
        );
        service
            .queue_promotions
            .lock_or_recover("queue promotions")
            .remove("session-1");

        let error = service
            .send_queued_message_now(ProvidersSendQueuedMessageNowInput {
                session_id: SessionId::try_from("session-1".to_string()).expect("session id"),
                message_id: NonEmptyString::try_from(message_id.clone()).expect("message id"),
            })
            .await
            .expect_err("archiving workspace refuses the send");
        assert!(matches!(
            error,
            ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "WORKSPACE_ARCHIVING"
        ));

        let queue = service
            .queues
            .lock_or_recover("queues")
            .get("session-1")
            .cloned()
            .expect("follow-up restored to the queue");
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].id, message_id);
        assert_eq!(queue[0].content, "please keep this");
        let snapshot = service.pending_messages_snapshot();
        assert_eq!(snapshot["session-1"][0].id, message_id);
        {
            let connection = service.database.connection();
            let durable = crate::persistence::pending_messages::list_pending_messages(&connection)
                .expect("durable queue");
            assert_eq!(durable.len(), 1);
            assert_eq!(durable[0].id, message_id);
        }
        service
            .record_launch_failure(
                "session-1",
                ProviderId::Claude,
                ArgmaxError::service("SPAWN_FAILED", "fixture provider could not start"),
            )
            .expect("record launch failure without discarding pending work");
        assert_eq!(
            service.pending_messages_snapshot()["session-1"][0].id,
            message_id
        );
        assert_eq!(
            service.pending_messages_snapshot()["session-1"][0]
                .recovery_status
                .as_deref(),
            Some("unsent")
        );
        assert!(service.pop_next_undelivered("session-1").unwrap().is_none());
        {
            let connection = service.database.connection();
            let durable =
                crate::persistence::pending_messages::list_pending_messages(&connection).unwrap();
            assert_eq!(durable[0].id, message_id);
            assert_eq!(durable[0].recovery_status.as_deref(), Some("unsent"));
        }
        service.clear_queue("session-1").expect("clear queue");
        assert!(service.pending_messages_snapshot().is_empty());
        assert!(
            service
                .cancel_queued_message(ProvidersCancelQueuedMessageInput {
                    session_id: SessionId::try_from("session-1".to_string()).unwrap(),
                    message_id: NonEmptyString::try_from(message_id.clone()).unwrap(),
                })
                .is_err(),
            "a missing or already dispatched row cannot be acknowledged as cancelled"
        );
        {
            let connection = service.database.connection();
            assert!(
                crate::persistence::pending_messages::list_pending_messages(&connection)
                    .expect("cleared durable queue")
                    .is_empty()
            );
        }

        // Keep the writer unavailable while cancellation starts. The cancel
        // path must wait for SQLite before taking `queues`; otherwise a stop
        // path holding SQLite and waiting for `queues` can deadlock it.
        let lock_message_id = Uuid::new_v4().to_string();
        let lock_queue = VecDeque::from([PendingMessage {
            id: lock_message_id.clone(),
            session_id: "session-1".to_string(),
            content: "lock ordering".to_string(),
            agent_mode: AgentMode::Auto.as_str().to_string(),
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: false,
            attachments: Vec::new(),
            agent_references: Vec::new(),
            origin: None,
            recovery_status: None,
            queued_at: now_iso(),
        }]);
        {
            let mut connection = service.database.connection();
            replace_session_queue(&mut connection, "session-1", &lock_queue)
                .expect("persist lock-order queue");
        }
        service
            .queues
            .lock_or_recover("queues")
            .insert("session-1".to_string(), lock_queue);
        let database_guard = service.database.connection();
        let cancel_service = Arc::clone(&service);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let cancel_thread = std::thread::spawn(move || {
            started_tx.send(()).expect("signal cancel start");
            cancel_service.cancel_queued_message(ProvidersCancelQueuedMessageInput {
                session_id: SessionId::try_from("session-1".to_string()).expect("session id"),
                message_id: NonEmptyString::try_from(lock_message_id).expect("message id"),
            })
        });
        started_rx.recv().expect("cancel started");
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            service.queues.try_lock().is_ok(),
            "cancel took queues before SQLite"
        );
        drop(database_guard);
        cancel_thread
            .join()
            .expect("cancel thread")
            .expect("cancel queue");
    }

    /// Stop can take the promotion away while "send now" waits for the current
    /// turn to stop. The send is cancelled, but the follow-up has already left
    /// the queue with its row marked `launching` — which the composer hides —
    /// so it has to come back like it does from every other failure here.
    #[tokio::test]
    async fn send_now_restores_the_follow_up_when_stop_cancels_the_promotion() {
        use crate::persistence::{
            projects::{persist_project, PersistProjectInput, ProjectSettings},
            workspaces::{persist_workspace, PersistWorkspaceInput},
        };

        let database = Arc::new(Database::open_in_memory().expect("open db"));
        {
            let connection = database.connection();
            persist_project(
                &connection,
                &PersistProjectInput {
                    id: "project-1".to_string(),
                    name: "argmax-test".to_string(),
                    repo_path: "/tmp/repo".to_string(),
                    current_branch: "main".to_string(),
                    default_branch: Some("main".to_string()),
                    settings: ProjectSettings {
                        archive_on_merge: false,
                        worktree_location: "/tmp/worktrees".to_string(),
                        setup_command: String::new(),
                        check_commands: Vec::new(),
                    },
                },
            )
            .expect("persist project");
            persist_workspace(
                &connection,
                &PersistWorkspaceInput {
                    id: "workspace-1".to_string(),
                    project_id: "project-1".to_string(),
                    task_label: "test workspace".to_string(),
                    branch: "feature/test".to_string(),
                    base_ref: "main".to_string(),
                    path: "/tmp/repo".to_string(),
                    state: "running".to_string(),
                    shared_workspace: false,
                    kind: "git".to_string(),
                    dirty: false,
                    changed_files: 0,
                },
            )
            .expect("persist workspace");
            persist_session(
                &connection,
                &PersistSessionInput {
                    id: "session-1".to_string(),
                    workspace_id: "workspace-1".to_string(),
                    provider: "claude".to_string(),
                    model_label: "Sonnet 5".to_string(),
                    model_id: "claude-sonnet-5".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "hello".to_string(),
                    state: SessionState::Running,
                },
            )
            .expect("persist session");
        }

        let service = ProviderSessionService::new(database);
        let message_id = Uuid::new_v4().to_string();
        let queued = VecDeque::from([PendingMessage {
            id: message_id.clone(),
            session_id: "session-1".to_string(),
            content: "stopped mid-promotion".to_string(),
            agent_mode: AgentMode::Auto.as_str().to_string(),
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: false,
            attachments: Vec::new(),
            agent_references: Vec::new(),
            origin: None,
            recovery_status: None,
            queued_at: now_iso(),
        }]);
        {
            let mut connection = service.database.connection();
            replace_session_queue(&mut connection, "session-1", &queued).expect("persist queue");
        }
        service
            .queues
            .lock_or_recover("queues")
            .insert("session-1".to_string(), queued);

        // Stand in for Stop, in a fixed order. `start_termination` joins a
        // termination job that is already in flight instead of starting one,
        // so the test owns that job: the send parks on it, the promotion is
        // taken away while it waits, and only then does the job finish. Racing
        // a spawned task against a real termination let the send win under
        // CI load and return `ok` instead of the cancellation.
        let (done_tx, done_rx) = watch::channel::<Option<ArgmaxResult<()>>>(None);
        service
            .termination_jobs
            .lock_or_recover("termination jobs")
            .insert("session-1".to_string(), done_rx);
        let promotions = Arc::clone(&service.queue_promotions);
        let jobs = Arc::clone(&service.termination_jobs);
        let stop = tokio::spawn(async move {
            let mut claimed = false;
            for _ in 0..1000 {
                if promotions
                    .lock_or_recover("queue promotions")
                    .remove("session-1")
                {
                    claimed = true;
                    break;
                }
                tokio::task::yield_now().await;
            }
            jobs.lock_or_recover("termination jobs").remove("session-1");
            let _ = done_tx.send(Some(Ok(())));
            claimed
        });

        let cancelled = service
            .send_queued_message_now(ProvidersSendQueuedMessageNowInput {
                session_id: SessionId::try_from("session-1".to_string()).expect("session id"),
                message_id: NonEmptyString::try_from(message_id.clone()).expect("message id"),
            })
            .await
            .expect_err("a promotion dropped by Stop cancels the send");
        assert!(matches!(
            cancelled,
            ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "QUEUED_SEND_CANCELLED"
        ));
        assert!(
            stop.await.expect("stop task"),
            "the promotion must have been claimed and then dropped"
        );

        assert_eq!(
            service.pending_messages_snapshot()["session-1"][0].id,
            message_id
        );
        let connection = service.database.connection();
        let durable = crate::persistence::pending_messages::list_session_pending_messages(
            &connection,
            "session-1",
        )
        .expect("durable queue");
        assert_eq!(durable.len(), 1, "the row is visible to the composer again");
        assert_eq!(durable[0].content, "stopped mid-promotion");
    }

    #[test]
    fn all_provider_permission_modes_have_native_responders() {
        for provider in [
            ProviderId::Claude,
            ProviderId::Codex,
            ProviderId::Cursor,
            ProviderId::Opencode,
            ProviderId::Grok,
        ] {
            ensure_permission_mode_supported(provider, PermissionMode::AskEachTime)
                .expect("native provider approval mode is supported");
            ensure_permission_mode_supported(provider, PermissionMode::ProviderDefaults)
                .expect("provider defaults is supported");
            ensure_permission_mode_supported(provider, PermissionMode::AutoApprove)
                .expect("auto-approve remains supported");
        }
    }
}
