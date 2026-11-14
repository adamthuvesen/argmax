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
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::Duration,
};

use argmax_store::sync::LockOrRecover;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use specta::Type;
use tokio::sync::{broadcast, watch};
use uuid::Uuid;

use super::model_catalogue::ModelId;
use super::{
    adapters::get_provider_definition,
    completion_notices::{CompletionNotice, CompletionNoticePolicy, COMPLETION_BATCH_WINDOW},
    continuity,
    flush_queue::{DashboardDelta, ProviderEventFlushQueue},
    follow_up::{
        agent_reference_prompt, compose_follow_up_prompt, compose_follow_up_prompt_since,
        ensure_agent_references_supported,
    },
    measured_diffs::{
        capture_opening_mark, merge_measured_diffs, paths_awaiting_diff, MeasuredDiff,
        MeasuredDiffs,
    },
    normalizer::{CodexCumulativeUsage, NormalizerSessionContext, ProviderOutputEvent},
    orphan_cleanup::{terminate_orphaned_provider_processes, RecoveredProviderSession},
    runtime::{
        composer_payload, parse_agent_mode, parse_permission_mode, parse_reasoning_effort,
        sqlite_error, DeltaPublisher, ProviderProcessLauncher, ProviderRuntimeEvent,
        ProviderRuntimeEventType, ProviderRuntimeHandle, RealProviderProcessLauncher,
    },
    subagent_trace::reconcile_session_subagent_traces,
    ApprovalSupport, LaunchContinuity, ProviderLaunchInput,
};
use crate::{
    approvals::service::ApprovalService,
    checkpoints::service::{CheckpointService, CreateCheckpointInput},
    gh::service::{pr_numbers_from_command_event, GhService},
    git::ops::checkout_write_lock,
    goals::service::GoalService,
    providers::inputs::{
        ProvidersCancelQueuedMessageInput, ProvidersLaunchInput, ProvidersResizeInput,
        ProvidersSendInput, ProvidersSendQueuedMessageNowInput, ProvidersTerminateInput,
        QueuedMessageDelivery, SessionClearInput,
    },
    session_control::{AfterTurn, SessionLaunchRegistry},
    workspaces::lifecycle::{WorkspaceAdmission, WorkspaceLifecycle},
};
use argmax_contracts::error::{ArgmaxError, ArgmaxResult};
use argmax_contracts::messages::ComposerAttachmentInput;
use argmax_contracts::sessions::state::SessionState;
use argmax_contracts::validation::parse_provider;
use argmax_contracts::validation::{AgentMode, PermissionMode, ProviderId};
use argmax_contracts::validation::{NonEmptyString, Prompt, SessionId};
use argmax_store::authorship::PersonAttestation;
use argmax_store::pending_messages::PendingMessage;
use argmax_store::{
    arc_events::{record_arc_event, ArcEventKind, NewArcEvent},
    arcs,
    authorship::PromptAuthor,
    database::Database,
    events::{
        find_event_by_id, latest_agent_message, list_session_events_since, persist_raw_output,
        persist_timeline_event, persist_user_prompt, update_event_payload, PersistRawOutputInput,
        PersistTimelineEventInput, TimelineEvent,
    },
    pending_messages::{
        clear_session_queue, delete_message as delete_pending_message,
        delete_messages_for_collected_origins, list_session_pending_messages,
        mark_message_launching, recover_pending_messages, replace_session_queue,
        restore_launching_message,
    },
    projects::list_projects,
    session_messages::{
        delete_undelivered_session_message, insert_session_message, is_message_delivered,
        mark_message_delivered, NewSessionMessage, MESSAGE_KIND,
    },
    sessions::{
        clear_session_conversation, find_session_by_id, persist_session, record_session_arc,
        session_launch_kind, update_session_agent_mode, update_session_model,
        update_session_provider, update_session_provider_conversation_id, update_session_state,
        PersistSessionInput, SessionAgentModeInput, SessionModelInput, SessionProviderInput,
        SessionStateInput, SessionSummary, LAUNCH_KIND_MULTITASK,
    },
    time::now_iso,
    workspaces::{find_workspace_by_id, update_workspace_state, WorkspaceSummary},
};

const MAX_PENDING_QUEUE: usize = 64;
/// Codex may auto-compact between the first response to a steer and the tool
/// continuation that follows it. Its replacement history keeps the user steer
/// but can omit that first response, causing the model to answer it again.
/// Queue near-full contexts for the next turn instead, with room for the first
/// post-steer tool result.
const CODEX_STEER_MAX_CONTEXT_PERCENT: i64 = 85;
/// How many state changes a `session_wait` subscriber may fall behind before
/// it is told to re-read the rows instead. A blocked waiter wakes on every
/// message, so this only ever fills during a burst.
const SESSION_STATE_BROADCAST_CAPACITY: usize = 256;
const STRUCTURED_LAUNCH_COLS: u16 = 120;
const STRUCTURED_LAUNCH_ROWS: u16 = 32;
/// Persist ordinary provider output at most once per short window. This keeps
/// several busy chats from opening a SQLite transaction for every JSONL line
/// while staying below a perceptible streaming delay. Approval, permission,
/// error, and completion events bypass the window in `flush_queue`.
const STREAM_BATCH_FLUSH_MS: u64 = 25;
/// A newline-less fragment may be human-readable stdout rather than JSONL.
/// Flush it only after output pauses so arbitrary PTY chunk boundaries cannot
/// split or trim its text. Process exit and cancellation force the same flush.
const STREAM_IDLE_FLUSH_MS: u64 = 16;
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

/// Time since an ISO timestamp this app wrote; zero for one it cannot parse,
/// which makes the caller treat the cache as warm (the conservative reading).
fn elapsed_since(at: &str) -> std::time::Duration {
    chrono::DateTime::parse_from_rfc3339(at)
        .ok()
        .and_then(|at| {
            (chrono::Utc::now() - at.with_timezone(&chrono::Utc))
                .to_std()
                .ok()
        })
        .unwrap_or_default()
}

fn has_steering_context_headroom(session: &SessionSummary) -> bool {
    if session.provider != ProviderId::Codex.as_str() {
        return true;
    }
    let Some(context_window) = session.context_window.filter(|window| *window > 0) else {
        return true;
    };
    session.context_tokens.saturating_mul(100)
        < context_window.saturating_mul(CODEX_STEER_MAX_CONTEXT_PERCENT)
}

/// Whether a send may fall into the chat's follow-up queue.
///
/// The person's composer may: a message typed during a turn is meant to wait.
/// An automatic turn may not. A goal continuation or a scheduled wake sitting
/// in the queue reads as something the user typed, holds up move and archive,
/// and — because its driver judges the turn that overtook it and then sends
/// again — puts a second copy behind the first. Refused sends fail with
/// [`TURN_IN_FLIGHT`] instead, and their driver retries once the chat settles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Queueing {
    Allowed,
    Refused,
}

/// A send was refused because the chat is mid-turn. Not a failure: the caller
/// is a driver that will come back when the turn settles.
pub const TURN_IN_FLIGHT: &str = "SESSION_TURN_IN_FLIGHT";

/// What a send that lands behind a running turn does with its queued row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MidTurnDelivery {
    /// Wait for the turn to end.
    Queue,
    /// The composer's Steer: deliver into the running turn, and leave a
    /// failure queued as unsent for the person to retry or discard.
    Steer,
    /// A message from another session or Argmax itself: steer when the
    /// provider can take it, otherwise wait for the turn to end exactly as
    /// `Queue` does. Nobody is watching to retry a failure, so a definite
    /// rejection goes back to the ordinary queue instead of parking unsent.
    SteerOrQueue,
}

fn turn_in_flight_error() -> ArgmaxError {
    ArgmaxError::service(
        TURN_IN_FLIGHT,
        "A turn is already running in this chat; this one was not queued behind it.",
    )
}

/// A goal turn is only allowed while its goal is still active on that chat.
/// The driver checks the same thing before it sends, but it can lose the race
/// with a user clearing the goal; this closes that window in the database,
/// where the settle and the send are ordered against each other.
///
/// Goals reserve nothing else: the user can keep typing into a chat that has
/// one, and other chats sharing the checkout are unaffected.
fn ensure_goal_turn_admitted(
    connection: &rusqlite::Connection,
    session_id: &str,
    identity: &GoalTurnIdentity,
) -> ArgmaxResult<()> {
    let admitted = connection
        .prepare_cached("SELECT 1 FROM goals WHERE id=? AND session_id=? AND state='active'")
        .map_err(sqlite_error)?
        .query_row((identity.goal_id.as_str(), session_id), |_| Ok(()))
        .optional()
        .map_err(sqlite_error)?
        .is_some();
    if admitted {
        Ok(())
    } else {
        Err(ArgmaxError::service(
            "GOAL_NOT_ACTIVE",
            "The goal stopped before its next turn could start.",
        ))
    }
}

use argmax_contracts::messages::MessageOrigin;

/// Who started a turn that carries no [`MessageOrigin`]: the person at the
/// composer, a Goal's evaluator, the scheduler, or a session move. The
/// automatic ones are written onto the `user.message` payload as `starter`, so
/// the completion notice path can tell a wake apart from the person typing
/// into a launched chat — the payloads are otherwise identical — and so a
/// chat reference in them is never read as the person's own (see
/// `human_prompt_references_session`). A move's prompt is written by the agent
/// that asked for the move.
#[derive(Debug, Clone, Copy, PartialEq)]
enum TurnStarter {
    Person,
    Goal,
    Schedule,
    Move,
}

/// Where a turn's prompt came from, for the `user.message` payload: another
/// session (an `origin`) and, failing that, which starter wrote it.
#[derive(Debug, Clone, Copy)]
struct TurnAuthorship<'a> {
    origin: Option<&'a MessageOrigin>,
    starter: TurnStarter,
    /// Whether a person wrote the text (see `persistence/authorship.rs`). The
    /// only thing that makes a chat reference in it a read grant.
    author: PromptAuthor,
}

impl TurnStarter {
    fn payload_marker(self) -> Option<&'static str> {
        match self {
            TurnStarter::Person => None,
            TurnStarter::Goal => Some("goal"),
            TurnStarter::Schedule => Some("schedule"),
            TurnStarter::Move => Some("move"),
        }
    }
}

/// A session's state as it was just written. Broadcast in-process so a blocked
/// `session_wait` wakes on the change instead of polling the database.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionStateChange {
    pub session_id: String,
    pub state: SessionState,
}

#[derive(Debug, Default)]
pub struct ProviderPerformanceStats {
    pub running_chats: u64,
    pub running_chats_by_provider: BTreeMap<String, u64>,
    pub pending_items: u64,
    pub output_events: u64,
}

/// Says which goal a turn is being sent for. Never exposed through IPC; the
/// database re-checks that the goal is still active on that chat before the
/// input is delivered.
#[derive(Debug, Clone)]
pub struct GoalTurnIdentity {
    pub goal_id: String,
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
    output_events: Arc<AtomicU64>,
    /// One bounded output flush per session. A fixed window, rather than an
    /// idle debounce, guarantees sustained streams still reach SQLite.
    batch_flush_generation: Arc<Mutex<HashMap<String, u64>>>,
    batch_flush_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    /// Debounced force-flush for newline-less stream fragments.
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
    /// Monotonic Stop generation per session. A send captures this before any
    /// send-side persistence and must still own the same generation when it
    /// queues, writes a user turn, or claims a launch handle. Unlike the
    /// transient termination markers, this survives a fast completed Stop.
    send_generations: Arc<Mutex<HashMap<String, u64>>>,
    /// Owned termination jobs. A caller may stop waiting when an archive
    /// bound expires, but the job itself continues until the provider handle
    /// is disposed and the cancelled state is persisted.
    termination_jobs: Arc<Mutex<HashMap<String, TerminationJob>>>,
    lifecycle: Arc<WorkspaceLifecycle>,
    approvals: Option<Arc<ApprovalService>>,
    questions: Option<Arc<crate::questions::service::QuestionService>>,
    /// The boot-warmed discovery cache, so a follow-up route never lands on a
    /// CLI that is not installed. Unset in tests, which means "unknown".
    provider_discovery: Option<Arc<super::discovery::ProviderDiscovery>>,
    session_control: Option<Arc<SessionLaunchRegistry>>,
    /// Installed after database startup. A provider turn must capture code
    /// state before the first possible write, while scratch chats skip it.
    checkpoints: OnceLock<Arc<CheckpointService>>,
    /// Installed by `GoalService::new`. Kept weak because the Goal service
    /// owns this provider service while its driver is alive.
    goals: OnceLock<Weak<GoalService>>,
    completion_notices: Arc<CompletionNoticePolicy>,
    /// Per-turn git marks, for providers that report a file write without
    /// saying what changed. See `measured_diffs`.
    measured_diffs: Arc<MeasuredDiffs>,
    /// Every session state this service writes, for `session_wait`.
    session_states: broadcast::Sender<SessionStateChange>,
    #[cfg(test)]
    send_input_test_gate: Arc<Mutex<Option<Arc<SendInputTestGate>>>>,
    #[cfg(test)]
    after_lifecycle_marker_check: Arc<Mutex<Option<LifecycleMarkerHook>>>,
}

#[cfg(test)]
type LifecycleMarkerHook = Arc<dyn Fn() + Send + Sync>;

#[cfg(test)]
#[derive(Default)]
struct SendInputTestGate {
    reached: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

/// The result slot a termination job publishes to; `None` while the job runs.
type TerminationJob = watch::Receiver<Option<ArgmaxResult<()>>>;

mod events;
mod flush;
mod input;
mod launch;
mod post_turn;
mod queue;
mod termination;
#[path = "session_service_turn_end.rs"]
mod turn_end;
mod turn_observations;
use turn_end::{TurnEnd, TurnFollowUp, TurnRows};

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

/// What a [`ProviderSessionService`] is built from. The checkpoint and Goal
/// services are installed later: checkpoints after boot recovery settles
/// rewinds, and Goals because the Goal service owns this one.
pub struct ProviderSessionDeps {
    pub database: Arc<Database>,
    pub launcher: Arc<dyn ProviderProcessLauncher>,
    pub publish_delta: DeltaPublisher,
    pub lifecycle: Arc<WorkspaceLifecycle>,
    pub approvals: Option<Arc<ApprovalService>>,
    pub questions: Option<Arc<crate::questions::service::QuestionService>>,
    pub provider_discovery: Option<Arc<super::discovery::ProviderDiscovery>>,
    pub session_control: Option<Arc<SessionLaunchRegistry>>,
}

impl ProviderSessionDeps {
    pub fn launcher(mut self, launcher: Arc<dyn ProviderProcessLauncher>) -> Self {
        self.launcher = launcher;
        self
    }

    pub fn publish_delta(
        mut self,
        publish_delta: impl Fn(DashboardDelta) + Send + Sync + 'static,
    ) -> Self {
        self.publish_delta = Arc::new(publish_delta);
        self
    }

    pub fn lifecycle(mut self, lifecycle: Arc<WorkspaceLifecycle>) -> Self {
        self.lifecycle = lifecycle;
        self
    }

    pub fn approvals(mut self, approvals: Arc<ApprovalService>) -> Self {
        self.approvals = Some(approvals);
        self
    }

    pub fn session_control(mut self, registry: Arc<SessionLaunchRegistry>) -> Self {
        self.session_control = Some(registry);
        self
    }

    pub fn build(self) -> Arc<ProviderSessionService> {
        ProviderSessionService::new(self)
    }
}

impl ProviderSessionService {
    pub fn performance_stats(&self) -> ProviderPerformanceStats {
        let (running_chats_by_provider, pending_items) = self
            .flush_queue
            .lock_or_recover("flush queue")
            .performance_stats();
        ProviderPerformanceStats {
            running_chats: running_chats_by_provider.values().sum(),
            running_chats_by_provider,
            pending_items,
            output_events: self.output_events.load(Ordering::Relaxed),
        }
    }

    /// Defaults for everything but the database: the real launcher, no
    /// publisher, a fresh lifecycle, and no optional services. Tests chain the
    /// setters they need; the app passes a full [`ProviderSessionDeps`].
    pub fn builder(database: Arc<Database>) -> ProviderSessionDeps {
        ProviderSessionDeps {
            database,
            launcher: Arc::new(RealProviderProcessLauncher::new()),
            publish_delta: Arc::new(|_| {}),
            lifecycle: WorkspaceLifecycle::new(),
            approvals: None,
            questions: None,
            provider_discovery: None,
            session_control: None,
        }
    }

    pub fn new(deps: ProviderSessionDeps) -> Arc<Self> {
        let ProviderSessionDeps {
            database,
            launcher,
            publish_delta,
            lifecycle,
            approvals,
            questions,
            provider_discovery,
            session_control,
        } = deps;
        let recovered_queues = {
            let mut connection = database.connection();
            recover_pending_messages(&mut connection)
                .expect("durable pending-message journal must be readable")
        };
        Arc::new_cyclic(|weak: &Weak<Self>| {
            let weak_service = weak.clone();
            let completion_notices = CompletionNoticePolicy::new(
                Arc::clone(&database),
                COMPLETION_BATCH_WINDOW,
                {
                    let weak_service = weak_service.clone();
                    move |launcher_id| {
                        if let Some(service) = weak_service.upgrade() {
                            if let Some(registry) = service.session_control.as_ref() {
                                registry.notify_inbox(launcher_id);
                            }
                        }
                    }
                },
                move |notice| {
                    let weak_service = weak_service.clone();
                    Box::pin(async move {
                        if let Some(service) = weak_service.upgrade() {
                            service.deliver_notice(notice).await;
                        }
                    })
                },
            );
            Self {
                completion_notices,
                database,
                launcher,
                publish_delta,
                handles: Arc::new(Mutex::new(HashMap::new())),
                queues: Arc::new(Mutex::new(recovered_queues)),
                queue_promotions: Arc::new(Mutex::new(HashSet::new())),
                flush_queue: Arc::new(Mutex::new(ProviderEventFlushQueue::new())),
                output_events: Arc::new(AtomicU64::new(0)),
                batch_flush_generation: Arc::new(Mutex::new(HashMap::new())),
                batch_flush_tasks: Arc::new(Mutex::new(HashMap::new())),
                idle_flush_generation: Arc::new(Mutex::new(HashMap::new())),
                idle_flush_tasks: Arc::new(Mutex::new(HashMap::new())),
                subagent_reconciliations: Arc::new(Mutex::new(HashMap::new())),
                terminating: Arc::new(Mutex::new(HashSet::new())),
                send_generations: Arc::new(Mutex::new(HashMap::new())),
                termination_jobs: Arc::new(Mutex::new(HashMap::new())),
                lifecycle,
                approvals,
                questions,
                provider_discovery,
                session_control,
                checkpoints: OnceLock::new(),
                goals: OnceLock::new(),
                measured_diffs: Arc::new(MeasuredDiffs::default()),
                session_states: broadcast::channel(SESSION_STATE_BROADCAST_CAPACITY).0,
                #[cfg(test)]
                send_input_test_gate: Arc::new(Mutex::new(None)),
                #[cfg(test)]
                after_lifecycle_marker_check: Arc::new(Mutex::new(None)),
            }
        })
    }

    /// Installed providers, or empty when discovery is not wired in.
    pub(crate) async fn available_providers(&self) -> Vec<super::discovery::AvailableProvider> {
        match self.provider_discovery.as_ref() {
            Some(discovery) => discovery.available_providers().await,
            None => Vec::new(),
        }
    }

    pub fn set_checkpoint_service(&self, checkpoints: Arc<CheckpointService>) {
        if self.checkpoints.set(checkpoints).is_err() {
            tracing::warn!("checkpoint service was already installed");
        }
    }

    pub(crate) fn set_goal_service(&self, goals: Weak<GoalService>) {
        if self.goals.set(goals).is_err() {
            tracing::warn!("goal service was already installed");
        }
    }

    async fn capture_before_provider_turn(&self, session_id: &str) -> ArgmaxResult<()> {
        let Some(checkpoints) = self.checkpoints.get() else {
            return Ok(());
        };
        let (workspace_id, turn_boundary) = {
            let connection = self.database.read_connection();
            let session = find_session_by_id(&connection, session_id)?;
            let workspace = find_workspace_by_id(&connection, &session.workspace_id)?;
            if workspace.kind != "git" {
                return Ok(());
            }
            // The user message this turn answers. It is already persisted by
            // the time a launch reaches here, and it is what lets the turn in
            // the transcript find its own checkpoint to revert to.
            let turn_boundary =
                argmax_store::events::latest_user_message_id(&connection, session_id)?;
            (workspace.id, turn_boundary)
        };
        // A checkpoint is a safety net, never a gate: a turn that cannot be
        // captured still runs, and says so on the turn instead of refusing it.
        if let Err(error) = checkpoints
            .create_checkpoint(CreateCheckpointInput {
                workspace_id,
                session_id: Some(session_id.to_string()),
                label: "Before turn".to_string(),
                turn_boundary: turn_boundary.clone(),
                // Argmax's invocation UUID is not a native conversation
                // boundary, and no provider can resume from an earlier message
                // anyway — a revert restores files, not the conversation.
                provider_conversation_id: None,
                recovery_of: None,
            })
            .await
        {
            if let Some(turn_boundary) = turn_boundary {
                if let Some(event) = Self::mark_turn_checkpoint_unavailable(
                    &self.database,
                    &turn_boundary,
                    &error.to_string(),
                )? {
                    self.publish(DashboardDelta {
                        events: vec![event],
                        ..DashboardDelta::default()
                    });
                }
            }
        }
        Ok(())
    }

    fn mark_turn_checkpoint_unavailable(
        database: &Database,
        turn_boundary: &str,
        reason: &str,
    ) -> ArgmaxResult<Option<TimelineEvent>> {
        let connection = database.connection();
        let Some(mut event) = find_event_by_id(&connection, turn_boundary)? else {
            return Ok(None);
        };
        if event.r#type != "user.message" {
            return Ok(None);
        }
        let mut payload = match event.payload {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        payload.insert("checkpointUnavailable".into(), Value::Bool(true));
        payload.insert(
            "checkpointUnavailableReason".into(),
            Value::String(reason.to_string()),
        );
        event.payload = Value::Object(payload);
        event.semantic =
            argmax_store::timeline_semantics::derive(&event.r#type, &event.id, &event.payload);
        update_event_payload(&connection, turn_boundary, &event.payload)?;
        Ok(Some(event))
    }

    pub fn open_handle_count(&self) -> usize {
        self.handles.lock_or_recover("handles").len()
    }

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

    /// Boot: wake launchers whose completion wake was waiting out its
    /// coalescing window when the app stopped. Runs after orphan recovery, so
    /// a notice that recovery just wrote is already held and is not duplicated.
    pub fn recover_completion_wakes(self: &Arc<Self>) -> ArgmaxResult<usize> {
        self.completion_notices.recover_pending_wakes()
    }

    pub fn recover_orphaned_sessions(&self) -> ArgmaxResult<usize> {
        // A launch that was in flight when the app stopped started nothing if
        // its session was never written, and may have started its provider if
        // it was. Its receipt says which; the second kind is never repeated.
        match argmax_store::launch_receipts::recover_orphaned_receipts(
            &mut self.database.connection(),
        ) {
            Ok(recovered) if recovered == Default::default() => {}
            Ok(recovered) => tracing::info!(?recovered, "in-flight launches recovered"),
            Err(error) => tracing::warn!(?error, "could not recover launch receipts"),
        }
        let (recovered, cleanup_sessions) = {
            let connection = self.database.connection();
            let read_sessions = |sql: &str| -> ArgmaxResult<Vec<RecoveredProviderSession>> {
                let mut statement = connection.prepare(sql).map_err(sqlite_error)?;
                let rows = statement
                    .query_map([], |row| {
                        Ok(RecoveredProviderSession {
                            id: row.get(0)?,
                            provider: row.get(1)?,
                            provider_conversation_id: row.get(2)?,
                        })
                    })
                    .map_err(sqlite_error)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(sqlite_error)?;
                Ok(rows)
            };
            (
                read_sessions(
                    "SELECT id, provider, provider_conversation_id FROM sessions WHERE state IN ('running', 'waiting', 'blocked')",
                )?,
                read_sessions(
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
                )?,
            )
        };
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
            let finished_at = now_iso();
            let mut is_multitask = false;
            self.commit_turn_end(
                TurnEnd {
                    session_id,
                    state: SessionState::Failed,
                    finished_at: &finished_at,
                    may_end: |_| true,
                    yields_to_stop: false,
                    remove_handle: false,
                    pause_queue: false,
                    reconcile_subagents: false,
                },
                |transaction| {
                    let event = persist_timeline_event(
                        transaction,
                        &PersistTimelineEventInput {
                            id: Uuid::new_v4().to_string(),
                            session_id: session_id.clone(),
                            r#type: "process_did_not_survive_restart".to_string(),
                            message: "Provider process did not survive restart.".to_string(),
                            payload: json!({}),
                            created_at: None,
                        },
                    )?;
                    is_multitask = session_launch_kind(transaction, session_id)
                        .is_ok_and(|kind| kind == LAUNCH_KIND_MULTITASK);
                    Ok(TurnRows {
                        events: vec![event],
                        ..TurnRows::default()
                    })
                },
            )?;
            // A multitask that was mid-turn when the app went down never wrote
            // its finish row, so the chat that dispatched it would keep saying
            // "running alongside" for a process that died with the app. Boot is
            // where that becomes knowable, and the row says `failed` because
            // that is what happened to it.
            if is_multitask {
                self.record_multitask_finish(session_id, SessionState::Failed, &finished_at);
            }
            self.cancel_pending_interactions(session_id)?;
        }
        Ok(recovered.len())
    }

    fn record_launch_failure(
        self: &Arc<Self>,
        session_id: &str,
        provider: ProviderId,
        error: ArgmaxError,
    ) -> ArgmaxResult<()> {
        let completed_at = now_iso();
        let ended = self.commit_turn_end(
            TurnEnd {
                session_id,
                state: SessionState::Failed,
                finished_at: &completed_at,
                may_end: |_| true,
                yields_to_stop: false,
                remove_handle: false,
                pause_queue: true,
                reconcile_subagents: false,
            },
            |transaction| {
                let event = persist_timeline_event(
                    transaction,
                    &PersistTimelineEventInput {
                        id: Uuid::new_v4().to_string(),
                        session_id: session_id.to_string(),
                        r#type: "error".to_string(),
                        message: error.to_string(),
                        payload: json!({ "provider": provider.as_str() }),
                        created_at: None,
                    },
                )?;
                Ok(TurnRows {
                    events: vec![event],
                    ..TurnRows::default()
                })
            },
        )?;
        // A launch that never started is still this session's turn ending, and
        // whoever launched it is owed that news: without it a multitask whose
        // CLI could not start leaves a row that says "Running" for as long as
        // the transcript lives, since the finish row it falls back to was never
        // written.
        self.announce_turn_end(
            session_id,
            SessionState::Failed,
            &completed_at,
            TurnFollowUp {
                settle: false,
                drain_queue: false,
            },
        );
        ended.map_or(Ok(()), |ended| ended.queue_paused)
    }

    fn cancel_session(self: &Arc<Self>, session_id: &str) -> ArgmaxResult<()> {
        self.capture_pr_branch(session_id);
        let completed_at = now_iso();
        let ended = self.commit_turn_end(
            TurnEnd {
                session_id,
                state: SessionState::Cancelled,
                finished_at: &completed_at,
                may_end: SessionState::is_active,
                yields_to_stop: false,
                remove_handle: false,
                pause_queue: false,
                reconcile_subagents: false,
            },
            |transaction| {
                let event = persist_timeline_event(
                    transaction,
                    &PersistTimelineEventInput {
                        id: Uuid::new_v4().to_string(),
                        session_id: session_id.to_string(),
                        r#type: "session.cancelled".to_string(),
                        message: "Provider chat cancelled.".to_string(),
                        payload: json!({}),
                        created_at: Some(completed_at.clone()),
                    },
                )?;
                Ok(TurnRows {
                    events: vec![event],
                    ..TurnRows::default()
                })
            },
        )?;
        if ended.is_some() {
            self.announce_turn_end(
                session_id,
                SessionState::Cancelled,
                &completed_at,
                TurnFollowUp {
                    settle: false,
                    drain_queue: false,
                },
            );
        }
        Ok(())
    }

    fn live_handle(&self, session_id: &str) -> Option<Arc<dyn ProviderRuntimeHandle>> {
        match self.handles.lock_or_recover("handles").get(session_id) {
            Some(HandleEntry::Resolved(handle)) if !handle.disposed() => Some(Arc::clone(handle)),
            _ => None,
        }
    }

    fn lock_send_generation(
        &self,
        session_id: &str,
        expected: u64,
    ) -> ArgmaxResult<std::sync::MutexGuard<'_, HashMap<String, u64>>> {
        let generations = self.send_generations.lock_or_recover("send generations");
        if generations.get(session_id).copied().unwrap_or(0) != expected {
            return Err(ArgmaxError::service(
                "PROVIDER_SEND_CANCELLED",
                "Provider chat was stopped before this message could be sent.",
            ));
        }
        Ok(generations)
    }

    fn persist_user_message(
        &self,
        session_id: &str,
        message: &str,
        agent_mode: AgentMode,
        attachments: Option<&[ComposerAttachmentInput]>,
        origin: Option<&MessageOrigin>,
        author: PromptAuthor,
    ) -> ArgmaxResult<()> {
        let connection = self.database.connection();
        let event = self.persist_user_message_locked(
            &connection,
            session_id,
            message,
            agent_mode,
            attachments,
            TurnAuthorship {
                origin,
                starter: TurnStarter::Person,
                author,
            },
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
        authorship: TurnAuthorship<'_>,
    ) -> ArgmaxResult<argmax_store::events::TimelineEvent> {
        let mut payload = composer_payload(agent_mode, attachments);
        if let Some(origin) = authorship.origin {
            payload["origin"] = serde_json::to_value(origin).unwrap_or(Value::Null);
        }
        if let Some(marker) = authorship.starter.payload_marker() {
            payload["starter"] = json!(marker);
        }
        persist_user_prompt(
            connection,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                r#type: "user.message".to_string(),
                message: message.to_string(),
                payload,
                created_at: None,
            },
            authorship.author,
        )
    }

    fn cancel_pending_interactions(&self, session_id: &str) -> ArgmaxResult<()> {
        let mut first_error = None;
        if let Some(approvals) = self.approvals.as_ref() {
            if let Err(error) = approvals.cancel_session_pending(session_id) {
                first_error = Some(error);
            }
        }
        if let Some(questions) = self.questions.as_ref() {
            if let Err(error) = questions.cancel_session_pending(session_id) {
                first_error.get_or_insert(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Every session state this service writes from now on. `session_wait`
    /// subscribes before it reads the current states, so an edge that lands
    /// between the two is queued rather than missed.
    pub fn subscribe_session_states(&self) -> broadcast::Receiver<SessionStateChange> {
        self.session_states.subscribe()
    }

    pub fn publish_goal_changed(&self, goal_id: &str) {
        self.publish(DashboardDelta {
            goal_changed_ids: vec![goal_id.to_string()],
            ..DashboardDelta::default()
        });
    }

    /// Arcs ride the full dashboard snapshot rather than a focused read, so a
    /// create/update/set-state only needs to say "reload it" rather than
    /// duplicate the changed row into every delta.
    pub fn publish_dashboard_changed(&self) {
        self.publish(DashboardDelta {
            dashboard_changed: true,
            ..DashboardDelta::default()
        });
    }
}

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

/// An Auto chat's routing for one follow-up, decided before the checkout lock
/// and applied once the send is admitted.
enum AutoFollowUp {
    /// The user picked another model: routing ends, and a 'pinned' row
    /// closes the last route's window.
    Pinned(argmax_contracts::routing::RouteDecision),
    /// The router's decision, or `None` when there was nothing to classify
    /// with (no key, a classifier failure).
    Routed(
        Option<argmax_contracts::routing::RouteDecision>,
        Box<SessionSummary>,
    ),
}

/// Rewrites a routed follow-up and returns the route to record. Fast mode is
/// off for every follow-up the router still drives, as for an Auto launch
/// (routing::route_launch): the grid's cells never ask for it.
fn apply_auto_follow_up(
    input: &mut ProvidersSendInput,
    auto_follow_up: Option<AutoFollowUp>,
    session: &SessionSummary,
) -> ArgmaxResult<Option<argmax_contracts::routing::RouteDecision>> {
    let route = match auto_follow_up {
        None => return Ok(None),
        Some(AutoFollowUp::Pinned(route)) => return Ok(Some(route)),
        Some(AutoFollowUp::Routed(mut route, observed)) => {
            input.fast_mode = false;
            if observed.provider != session.provider
                || observed.model_id != session.model_id
                || observed.reasoning_effort != session.reasoning_effort
                || observed.auto_tier != session.auto_tier
                || observed.last_activity_at != session.last_activity_at
                || observed.provider_conversation_id != session.provider_conversation_id
            {
                input.provider = None;
                input.model_id = None;
                input.model_label = None;
                input.reasoning_effort = None;
                let Some(tier) = session
                    .auto_tier
                    .as_deref()
                    .and_then(crate::routing::parse_tier)
                else {
                    return Ok(None);
                };
                route = Some(argmax_contracts::routing::RouteDecision {
                    tier,
                    provider: parse_provider(&session.provider)?,
                    model_id: session.model_id.clone(),
                    model_label: session.model_label.clone(),
                    effort: session
                        .reasoning_effort
                        .as_deref()
                        .and_then(parse_reasoning_effort),
                    kind: None,
                    difficulty: None,
                    kind_confidence: None,
                    difficulty_confidence: None,
                    decision: argmax_contracts::routing::RouteDecisionKind::Kept,
                    reason: "Session changed during classification, retaining its admitted route"
                        .to_string(),
                    signals: None,
                });
            }
            route
        }
    };
    let Some(route) = route else {
        return Ok(None);
    };
    if matches!(
        route.decision,
        argmax_contracts::routing::RouteDecisionKind::Reroute
            | argmax_contracts::routing::RouteDecisionKind::Escalate
    ) {
        // An escalation off the top of a cheap ladder changes provider; the
        // provider-switch path then rebuilds context from the visible
        // transcript. The same provider is no switch there.
        input.provider = Some(route.provider);
        input.model_label = Some(
            NonEmptyString::try_from(route.model_label.clone()).map_err(ArgmaxError::invalid)?,
        );
        input.model_id =
            Some(NonEmptyString::try_from(route.model_id.clone()).map_err(ArgmaxError::invalid)?);
        input.reasoning_effort = route.effort;
    }
    Ok(Some(route))
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
        // `None` keeps the chat's provider at drain time; a row that picked
        // another provider switches to it when it drains, after the turn it
        // waited behind has ended.
        provider: message.provider,
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
    let workspace = update_workspace_state_for_session_state_within_transaction(
        &transaction,
        workspace_id,
        state,
    )?;
    transaction.commit().map_err(sqlite_error)?;
    Ok(workspace)
}

fn update_workspace_state_for_session_state_within_transaction(
    connection: &rusqlite::Connection,
    workspace_id: &str,
    state: SessionState,
) -> ArgmaxResult<WorkspaceSummary> {
    let current = find_workspace_by_id(connection, workspace_id)?;
    let workspace = if matches!(
        current.state.as_str(),
        "archiving" | "archive-failed" | "archived"
    ) {
        current
    } else {
        update_workspace_state(connection, workspace_id, state.as_str())?
    };
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

/// Whether a model id a client sent names the model this chat already runs. A
/// client echoes the successor of a retired id, which is not a new pick.
fn runs_stored_model(session: &SessionSummary, model_id: &str) -> bool {
    match ProviderId::parse(&session.provider) {
        Some(provider) => {
            ModelId::resolve(provider, &session.model_id) == ModelId::resolve(provider, model_id)
        }
        None => session.model_id == model_id,
    }
}

/// The id a turn's usage is recorded under. An OpenCode turn on Vercel names
/// the model as Vercel does, matching what OpenCode stores, so its own cost
/// figure (the bill there) is trusted rather than OpenRouter's table.
fn usage_model_id(provider: ProviderId, model_id: &ModelId) -> String {
    if provider == ProviderId::Opencode {
        super::opencode_gateway::selected().route_model_id(model_id)
    } else {
        model_id.to_string()
    }
}

#[cfg(test)]
mod tests {
    mod steering {
        include!("session_service_steering_tests.rs");
    }

    use super::*;
    use crate::providers::runtime::{BoxFuture, EventCallback};
    use argmax_contracts::validation::ReasoningEffort;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct CountingFailureLauncher {
        launches: AtomicUsize,
    }

    impl ProviderProcessLauncher for CountingFailureLauncher {
        fn launch<'a>(
            &'a self,
            _input: ProviderLaunchInput,
            _on_event: EventCallback,
        ) -> BoxFuture<'a, ArgmaxResult<Arc<dyn ProviderRuntimeHandle>>> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Err(ArgmaxError::service(
                    "UNEXPECTED_TEST_LAUNCH",
                    "send raced past Stop",
                ))
            })
        }
    }

    fn database_with_running_session() -> Arc<Database> {
        use argmax_store::{
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
                        merge_cleanup: Default::default(),
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
                    model_label: "Sonnet 5.5".to_string(),
                    model_id: "claude-sonnet-5-5".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "hello".to_string(),
                    state: SessionState::Running,
                },
            )
            .expect("persist session");
        }
        database
    }

    #[test]
    fn lifecycle_completion_rolls_back_if_its_event_cannot_be_written() {
        let database = database_with_running_session();
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(Arc::new(CountingFailureLauncher::default()))
            .build();
        database
            .connection()
            .execute_batch(
                "CREATE TRIGGER reject_completion BEFORE INSERT ON events
                 WHEN NEW.type = 'session.completed'
                 BEGIN SELECT RAISE(ABORT, 'completion event refused'); END;",
            )
            .expect("install fault");
        let event = ProviderRuntimeEvent {
            session_id: "session-1".to_string(),
            r#type: ProviderRuntimeEventType::Exit,
            stream: super::super::normalizer::ProviderOutputStream::System,
            message: "provider exited".to_string(),
            exit_code: Some(0),
            created_at: "2026-10-03T10:00:00.000Z".to_string(),
        };
        assert!(service.handle_lifecycle_event(event.clone()).is_err());
        {
            let connection = database.connection();
            assert_eq!(
                find_session_by_id(&connection, "session-1").unwrap().state,
                SessionState::Running
            );
            assert_eq!(
                find_workspace_by_id(&connection, "workspace-1")
                    .unwrap()
                    .state,
                "running"
            );
            let raw_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM raw_outputs WHERE session_id = 'session-1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(raw_count, 0);
        }
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_completion")
            .unwrap();
        service
            .handle_lifecycle_event(event)
            .expect("retry after fault");
        let connection = database.connection();
        assert_eq!(
            find_session_by_id(&connection, "session-1").unwrap().state,
            SessionState::Complete
        );
        assert_eq!(
            find_workspace_by_id(&connection, "workspace-1")
                .unwrap()
                .state,
            "complete"
        );
    }

    #[test]
    fn every_turn_end_mirrors_the_workspace_and_writes_one_event() {
        type EndTurn = fn(&Arc<ProviderSessionService>) -> ArgmaxResult<()>;
        let paths: [(EndTurn, SessionState, &str); 3] = [
            (
                |service| service.cancel_session("session-1"),
                SessionState::Cancelled,
                "session.cancelled",
            ),
            (
                |service| {
                    service.record_launch_failure(
                        "session-1",
                        ProviderId::Claude,
                        ArgmaxError::service("TEST", "no CLI"),
                    )
                },
                SessionState::Failed,
                "error",
            ),
            (
                |service| {
                    service.handle_lifecycle_event(ProviderRuntimeEvent {
                        session_id: "session-1".to_string(),
                        r#type: ProviderRuntimeEventType::Exit,
                        stream: super::super::normalizer::ProviderOutputStream::System,
                        message: "provider exited".to_string(),
                        exit_code: Some(0),
                        created_at: "2026-10-03T10:00:00.000Z".to_string(),
                    })
                },
                SessionState::Complete,
                "session.completed",
            ),
        ];
        for (end_turn, state, event_type) in paths {
            let database = database_with_running_session();
            let service = ProviderSessionService::builder(Arc::clone(&database))
                .launcher(Arc::new(CountingFailureLauncher::default()))
                .build();
            end_turn(&service).expect("turn ends");
            let connection = database.connection();
            let session = find_session_by_id(&connection, "session-1").unwrap();
            assert_eq!(session.state, state, "{event_type}");
            let workspace_state: String = connection
                .query_row(
                    "SELECT state FROM workspaces WHERE id = ?1",
                    [&session.workspace_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(workspace_state, state.as_str(), "{event_type}");
            let events: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM events WHERE session_id = 'session-1' AND type = ?1",
                    [event_type],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(events, 1, "{event_type}");
        }
    }

    #[test]
    fn cancellation_rolls_back_if_its_event_cannot_be_written() {
        let database = database_with_running_session();
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(Arc::new(CountingFailureLauncher::default()))
            .build();
        database
            .connection()
            .execute_batch(
                "CREATE TRIGGER reject_cancellation BEFORE INSERT ON events
             WHEN NEW.type = 'session.cancelled'
             BEGIN SELECT RAISE(ABORT, 'cancellation event refused'); END;",
            )
            .unwrap();
        assert!(service.cancel_session("session-1").is_err());
        {
            let connection = database.connection();
            assert_eq!(
                find_session_by_id(&connection, "session-1").unwrap().state,
                SessionState::Running
            );
            assert_eq!(
                find_workspace_by_id(&connection, "workspace-1")
                    .unwrap()
                    .state,
                "running"
            );
        }
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_cancellation")
            .unwrap();
        service.cancel_session("session-1").unwrap();
        let connection = database.connection();
        assert_eq!(
            find_session_by_id(&connection, "session-1").unwrap().state,
            SessionState::Cancelled
        );
        assert_eq!(
            find_workspace_by_id(&connection, "workspace-1")
                .unwrap()
                .state,
            "cancelled"
        );
    }

    #[test]
    fn provider_exit_during_stop_keeps_the_cancelled_state() {
        let database = database_with_running_session();
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(Arc::new(CountingFailureLauncher::default()))
            .build();
        {
            let connection = database.connection();
            update_session_state(
                &connection,
                "session-1",
                &SessionStateInput::transition(SessionState::Cancelled),
            )
            .unwrap();
        }
        service
            .terminating
            .lock_or_recover("terminating")
            .insert("session-1".to_string());
        service
            .handle_lifecycle_event(ProviderRuntimeEvent {
                session_id: "session-1".to_string(),
                r#type: ProviderRuntimeEventType::Exit,
                stream: super::super::normalizer::ProviderOutputStream::System,
                message: "provider exited".to_string(),
                exit_code: Some(0),
                created_at: "2026-10-03T10:00:00.000Z".to_string(),
            })
            .unwrap();
        let connection = database.connection();
        assert_eq!(
            find_session_by_id(&connection, "session-1").unwrap().state,
            SessionState::Cancelled
        );
        let completion_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = 'session-1' AND type = 'session.completed'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(completion_count, 0);
    }

    #[test]
    fn stop_marked_during_exit_flush_prevents_completion_commit() {
        let database = database_with_running_session();
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(Arc::new(CountingFailureLauncher::default()))
            .build();
        let reached_flush = Arc::new(std::sync::Barrier::new(2));
        let resume_flush = Arc::new(std::sync::Barrier::new(2));
        let reached = Arc::clone(&reached_flush);
        let resume = Arc::clone(&resume_flush);
        *service
            .after_lifecycle_marker_check
            .lock_or_recover("lifecycle test hook") = Some(Arc::new(move || {
            reached.wait();
            resume.wait();
        }));
        let service_for_exit = Arc::clone(&service);
        let exit = std::thread::spawn(move || {
            service_for_exit.handle_lifecycle_event(ProviderRuntimeEvent {
                session_id: "session-1".to_string(),
                r#type: ProviderRuntimeEventType::Exit,
                stream: super::super::normalizer::ProviderOutputStream::System,
                message: "provider exited".to_string(),
                exit_code: Some(0),
                created_at: "2026-10-03T10:00:00.000Z".to_string(),
            })
        });
        reached_flush.wait();
        service
            .terminating
            .lock_or_recover("terminating")
            .insert("session-1".to_string());
        resume_flush.wait();
        exit.join().unwrap().unwrap();
        let connection = database.connection();
        assert_eq!(
            find_session_by_id(&connection, "session-1").unwrap().state,
            SessionState::Running
        );
        let completion_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = 'session-1' AND type = 'session.completed'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(completion_count, 0);
    }

    /// The app stopped while a completion wake waited out its window. After the
    /// restart the idle launcher is woken from the durable row.
    #[tokio::test]
    async fn boot_wakes_an_idle_launcher_for_a_completion_whose_window_died() {
        let database = database_with_running_session();
        let checkout = tempfile::tempdir().unwrap();
        database
            .connection()
            .execute(
                "UPDATE workspaces SET path = ? WHERE id = 'workspace-1'",
                [checkout.path().display().to_string()],
            )
            .unwrap();
        let launcher = Arc::new(CountingFailureLauncher::default());
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(launcher.clone())
            .build();
        {
            let connection = database.connection();
            argmax_store::sessions::persist_session(
                &connection,
                &PersistSessionInput {
                    id: "launcher-session".to_string(),
                    workspace_id: "workspace-1".to_string(),
                    provider: "claude".to_string(),
                    model_label: "Sonnet 5.5".to_string(),
                    model_id: "claude-sonnet-5-5".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "launch".to_string(),
                    state: SessionState::Waiting,
                },
            )
            .unwrap();
            argmax_store::sessions::record_session_launch(
                &connection,
                "session-1",
                "launcher-session",
                1,
                "agent",
            )
            .unwrap();
            insert_session_message(
                &connection,
                &NewSessionMessage {
                    id: "completion:session-1:t".to_string(),
                    from_session_id: Some("session-1".to_string()),
                    to_session_id: "launcher-session".to_string(),
                    body: "Session session-1 finished.".to_string(),
                    kind: "completion".to_string(),
                },
            )
            .unwrap();
            argmax_store::session_messages::mark_wake_due(&connection, "completion:session-1:t")
                .unwrap();
        }

        assert_eq!(service.recover_completion_wakes().unwrap(), 1);
        // The wake is attempted once its window closes, whatever the send does
        // with it, and the attempt clears the durable mark.
        for _ in 0..80 {
            if argmax_store::session_messages::list_due_wakes(&database.connection())
                .unwrap()
                .is_empty()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            argmax_store::session_messages::list_due_wakes(&database.connection())
                .unwrap()
                .is_empty(),
            "the recovered wake must be attempted"
        );
        assert!(
            launcher.launches.load(Ordering::SeqCst) > 0,
            "the idle launcher is started for the unread completion"
        );
        // The turn it starts carries its origin, so nothing downstream can read
        // an automatic wake as something the person typed.
        let events = argmax_store::events::list_session_events_since(
            &database.connection(),
            "launcher-session",
            None,
            None,
        )
        .unwrap()
        .events;
        let wake = events
            .iter()
            .rev()
            .find(|event| {
                event.r#type == "user.message" && event.message.contains("session-1 finished")
            })
            .expect("the wake is persisted as a user message");
        assert_eq!(wake.payload["origin"]["kind"], "completion");
        assert_eq!(wake.payload["origin"]["sessionId"], "session-1");
    }

    #[tokio::test]
    async fn failed_completion_notice_does_not_strand_a_pending_message() {
        let database = database_with_running_session();
        let published = Arc::new(Mutex::new(Vec::<DashboardDelta>::new()));
        let published_copy = Arc::clone(&published);
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(Arc::new(CountingFailureLauncher::default()))
            .publish_delta(move |delta| {
                published_copy
                    .lock_or_recover("published deltas")
                    .push(delta)
            })
            .build();
        {
            let connection = database.connection();
            argmax_store::sessions::persist_session(
                &connection,
                &PersistSessionInput {
                    id: "launcher-session".to_string(),
                    workspace_id: "workspace-1".to_string(),
                    provider: "claude".to_string(),
                    model_label: "Sonnet 5.5".to_string(),
                    model_id: "claude-sonnet-5-5".to_string(),
                    reasoning_effort: None,
                    permission_mode: Some("auto-approve".to_string()),
                    agent_mode: Some("auto".to_string()),
                    prompt: "launch".to_string(),
                    state: SessionState::Waiting,
                },
            )
            .unwrap();
            argmax_store::sessions::record_session_launch(
                &connection,
                "session-1",
                "launcher-session",
                1,
                "agent",
            )
            .unwrap();
            connection
                .execute_batch(
                    "CREATE TRIGGER reject_notice BEFORE INSERT ON session_messages
                 WHEN NEW.kind = 'completion'
                 BEGIN SELECT RAISE(ABORT, 'notice refused'); END;",
                )
                .unwrap();
        }
        let input = serde_json::from_value(json!({
            "sessionId": "session-1", "input": "next", "fastMode": false
        }))
        .unwrap();
        service
            .enqueue_pending_message(
                "session-1",
                "next",
                AgentMode::Auto,
                &input,
                None,
                PromptAuthor::unattested(),
            )
            .unwrap();
        service
            .handle_lifecycle_event(ProviderRuntimeEvent {
                session_id: "session-1".to_string(),
                r#type: ProviderRuntimeEventType::Exit,
                stream: super::super::normalizer::ProviderOutputStream::System,
                message: "provider exited".to_string(),
                exit_code: Some(0),
                created_at: "2026-10-03T10:00:00.000Z".to_string(),
            })
            .expect("notice failure cannot fail completion");
        let drained = published
            .lock_or_recover("published deltas")
            .iter()
            .any(|delta| {
                delta
                    .pending_messages
                    .as_ref()
                    .is_some_and(|messages| messages.get("session-1").is_some_and(Vec::is_empty))
            });
        assert!(drained, "queue drain published an empty composer queue");
    }

    fn pending_message(id: &str, session_id: &str, content: &str) -> PendingMessage {
        PendingMessage {
            id: id.to_string(),
            session_id: session_id.to_string(),
            content: content.to_string(),
            agent_mode: AgentMode::Auto.as_str().to_string(),
            provider: None,
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: false,
            attachments: Vec::new(),
            agent_references: Vec::new(),
            origin: None,
            recovery_status: None,
            queued_at: now_iso(),
            author: PromptAuthor::unattested(),
        }
    }

    #[tokio::test]
    async fn manual_follow_up_pin_precedes_classification_and_does_not_write_a_route() {
        let database = database_with_running_session();
        database
            .connection()
            .execute(
                "UPDATE sessions SET auto_tier = 'balanced' WHERE id = 'session-1'",
                [],
            )
            .unwrap();
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(Arc::new(CountingFailureLauncher::default()))
            .build();
        let input = serde_json::from_value(json!({
            "sessionId": "session-1", "input": "next", "fastMode": false,
            "modelId": "claude-opus-5-5", "modelLabel": "Opus 5.5", "reasoningEffort": "high"
        }))
        .unwrap();
        let route = service.route_follow_up(&input, "next", true).await.unwrap();
        assert!(matches!(route, Some(AutoFollowUp::Pinned(_))));
        let count: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM turn_routes WHERE session_id = 'session-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 0,
            "route decisions persist only after send admission"
        );
    }

    #[test]
    fn routed_effort_reduction_replaces_echoed_composer_selection_and_disables_fast() {
        let mut input: ProvidersSendInput = serde_json::from_value(json!({
            "sessionId": "session-1", "input": "short question", "fastMode": true,
            "modelId": "gpt-6-astra", "modelLabel": "GPT-6 Astra", "reasoningEffort": "high"
        }))
        .unwrap();
        let route = argmax_contracts::routing::RouteDecision {
            tier: argmax_contracts::routing::AutoTier::Balanced,
            provider: ProviderId::Codex,
            model_id: "gpt-6-astra".to_string(),
            model_label: "GPT-6 Astra".to_string(),
            effort: Some(ReasoningEffort::Low),
            kind: None,
            difficulty: None,
            kind_confidence: None,
            difficulty_confidence: None,
            decision: argmax_contracts::routing::RouteDecisionKind::Reroute,
            reason: "Simpler next task".to_string(),
            signals: None,
        };
        let database = database_with_running_session();
        let session = find_session_by_id(&database.connection(), "session-1").unwrap();
        let recorded = apply_auto_follow_up(
            &mut input,
            Some(AutoFollowUp::Routed(Some(route), Box::new(session.clone()))),
            &session,
        )
        .unwrap()
        .unwrap();
        assert_eq!(input.provider, Some(ProviderId::Codex));
        assert_eq!(input.model_id.as_ref().unwrap().as_str(), "gpt-6-astra");
        assert_eq!(input.reasoning_effort, Some(ReasoningEffort::Low));
        assert!(!input.fast_mode);
        assert_eq!(
            recorded.decision,
            argmax_contracts::routing::RouteDecisionKind::Reroute
        );
    }

    #[test]
    fn stale_classification_retains_the_admitted_route_and_cannot_undo_a_pin() {
        let database = database_with_running_session();
        let mut observed = find_session_by_id(&database.connection(), "session-1").unwrap();
        observed.auto_tier = Some("balanced".to_string());
        let mut admitted = observed.clone();
        admitted.model_id = "claude-fable-5-1".to_string();
        admitted.model_label = "Fable 5.1".to_string();
        admitted.reasoning_effort = Some("xhigh".to_string());
        let mut route = crate::routing::fallback_decision(
            argmax_contracts::routing::AutoTier::Balanced,
            "test classification",
        );
        route.decision = argmax_contracts::routing::RouteDecisionKind::Reroute;
        for still_auto in [true, false] {
            if !still_auto {
                admitted.auto_tier = None;
            }
            let mut input: ProvidersSendInput = serde_json::from_value(json!({
                "sessionId": "session-1", "input": "next", "fastMode": false,
                "modelId": observed.model_id, "modelLabel": observed.model_label,
                "reasoningEffort": "medium"
            }))
            .unwrap();
            let recorded = apply_auto_follow_up(
                &mut input,
                Some(AutoFollowUp::Routed(
                    Some(route.clone()),
                    Box::new(observed.clone()),
                )),
                &admitted,
            )
            .unwrap();
            assert!(input.model_id.is_none());
            assert!(input.reasoning_effort.is_none());
            if still_auto {
                let recorded = recorded.unwrap();
                assert_eq!(
                    recorded.decision,
                    argmax_contracts::routing::RouteDecisionKind::Kept
                );
                assert_eq!(recorded.model_id, "claude-fable-5-1");
                assert_eq!(recorded.effort, Some(ReasoningEffort::Xhigh));
            } else {
                assert!(recorded.is_none(), "a pin must not reactivate Auto");
            }
        }
    }

    #[test]
    fn inbox_collection_before_enqueue_does_not_leave_a_pending_copy() {
        use argmax_store::session_messages::{
            insert_session_message, take_undelivered_messages, NewSessionMessage,
        };

        let database = database_with_running_session();
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(Arc::new(CountingFailureLauncher::default()))
            .build();
        {
            let mut connection = database.connection();
            insert_session_message(
                &connection,
                &NewSessionMessage {
                    id: "inbox-1".to_string(),
                    from_session_id: None,
                    to_session_id: "session-1".to_string(),
                    body: "Peer guidance".to_string(),
                    kind: "message".to_string(),
                },
            )
            .unwrap();
            assert_eq!(
                take_undelivered_messages(&mut connection, "session-1", 10, 1000)
                    .unwrap()
                    .len(),
                1
            );
        }
        service
            .reconcile_collected_messages("session-1", &["inbox-1".to_string()])
            .unwrap();
        let input = serde_json::from_value(json!({
            "sessionId": "session-1", "input": "Peer guidance", "fastMode": false
        }))
        .unwrap();
        service
            .enqueue_pending_message(
                "session-1",
                "Peer guidance",
                AgentMode::Auto,
                &input,
                Some(MessageOrigin {
                    session_id: "peer".to_string(),
                    label: "Peer".to_string(),
                    kind: "message".to_string(),
                    message_id: Some("inbox-1".to_string()),
                }),
                PromptAuthor::unattested(),
            )
            .unwrap();
        assert!(service
            .queues
            .lock_or_recover("queues")
            .get("session-1")
            .is_none_or(VecDeque::is_empty));
        assert!(
            argmax_store::pending_messages::list_session_pending_messages(
                &database.connection(),
                "session-1"
            )
            .unwrap()
            .is_empty()
        );
    }

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

    /// A queued row that only echoes the chat's model must drain without one:
    /// by then the router may have moved the chat, and a stale model would
    /// read as the user pinning the old one.
    #[test]
    fn a_queued_follow_up_keeps_only_a_model_the_user_picked() {
        let database = database_with_running_session();
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(Arc::new(CountingFailureLauncher::default()))
            .build();
        let enqueue = |model_id: &str, effort: Option<&str>| {
            let input = serde_json::from_value(json!({
                "sessionId": "session-1", "input": "next", "fastMode": false,
                "modelLabel": "Some model", "modelId": model_id, "reasoningEffort": effort
            }))
            .unwrap();
            service
                .enqueue_pending_message(
                    "session-1",
                    "next",
                    AgentMode::Auto,
                    &input,
                    None,
                    PromptAuthor::unattested(),
                )
                .unwrap()
                .expect("queued")
        };
        let echo = enqueue("claude-sonnet-5-5", None);
        assert_eq!(
            (echo.model_id, echo.model_label, echo.reasoning_effort),
            (None, None, None)
        );
        let picked = enqueue("claude-opus-5-5", None);
        assert_eq!(picked.model_id.as_deref(), Some("claude-opus-5-5"));
        let effort = enqueue("claude-sonnet-5-5", Some("high"));
        assert_eq!(
            (
                effort.model_id.as_deref(),
                effort.reasoning_effort.as_deref()
            ),
            (Some("claude-sonnet-5-5"), Some("high"))
        );
    }

    fn queued_provider_service() -> (Arc<Database>, Arc<ProviderSessionService>) {
        let database = database_with_running_session();
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(Arc::new(CountingFailureLauncher::default()))
            .build();
        (database, service)
    }

    fn enqueue_with_provider(
        service: &ProviderSessionService,
        provider: Option<&str>,
        model_id: &str,
    ) -> ArgmaxResult<Option<PendingMessage>> {
        let mut value = json!({
            "sessionId": "session-1", "input": "next", "fastMode": false,
            "modelLabel": "Some model", "modelId": model_id,
        });
        if let Some(provider) = provider {
            value["provider"] = json!(provider);
        }
        let input = serde_json::from_value(value).unwrap();
        service.enqueue_pending_message(
            "session-1",
            "next",
            AgentMode::Auto,
            &input,
            None,
            PromptAuthor::unattested(),
        )
    }

    fn durable_providers(database: &Database) -> Vec<Option<ProviderId>> {
        argmax_store::pending_messages::list_session_pending_messages(
            &database.connection(),
            "session-1",
        )
        .unwrap()
        .into_iter()
        .map(|message| message.provider)
        .collect()
    }

    /// The chat is on Claude. A row that names a provider keeps it whether or
    /// not it matches the chat's, so it survives the removal of any row ahead.
    #[test]
    fn a_named_provider_is_kept_on_every_queued_row_even_when_it_matches_the_chat() {
        let (database, service) = queued_provider_service();
        let same = enqueue_with_provider(&service, Some("claude"), "claude-sonnet-5-5")
            .unwrap()
            .unwrap();
        assert_eq!(same.provider, Some(ProviderId::Claude));
        assert_eq!(same.model_id.as_deref(), Some("claude-sonnet-5-5"));
        let omitted = enqueue_with_provider(&service, None, "claude-sonnet-5-5")
            .unwrap()
            .unwrap();
        assert_eq!(
            omitted.provider, None,
            "no provider named means none stored"
        );
        let switched = enqueue_with_provider(&service, Some("codex"), "gpt-5.6-sol")
            .unwrap()
            .unwrap();
        assert_eq!(switched.provider, Some(ProviderId::Codex));
        assert_eq!(switched.model_id.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(
            durable_providers(&database),
            vec![Some(ProviderId::Claude), None, Some(ProviderId::Codex)]
        );
    }

    #[test]
    fn removing_or_reordering_an_earlier_switch_leaves_later_rows_on_their_own_provider() {
        let (database, service) = queued_provider_service();
        let first = enqueue_with_provider(&service, Some("codex"), "gpt-5.6-sol")
            .unwrap()
            .unwrap();
        // The same explicit choice as the row ahead of it: it must not lean on it.
        enqueue_with_provider(&service, Some("codex"), "gpt-5.6-sol").unwrap();
        enqueue_with_provider(&service, Some("claude"), "claude-opus-5-5").unwrap();
        assert_eq!(
            durable_providers(&database),
            vec![
                Some(ProviderId::Codex),
                Some(ProviderId::Codex),
                Some(ProviderId::Claude)
            ]
        );

        service
            .cancel_queued_message(
                serde_json::from_value(json!({ "sessionId": "session-1", "messageId": first.id }))
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            durable_providers(&database),
            vec![Some(ProviderId::Codex), Some(ProviderId::Claude)]
        );
        let in_memory = service.pending_messages_snapshot()["session-1"].clone();
        assert_eq!(in_memory[0].provider, Some(ProviderId::Codex));
        assert_eq!(in_memory[0].model_id.as_deref(), Some("gpt-5.6-sol"));

        // Reorder the way the composer does: replace the whole queue.
        let reversed: VecDeque<_> = in_memory.into_iter().rev().collect();
        replace_session_queue(&mut database.connection(), "session-1", &reversed).unwrap();
        assert_eq!(
            durable_providers(&database),
            vec![Some(ProviderId::Claude), Some(ProviderId::Codex)]
        );
    }

    #[test]
    fn naming_a_provider_without_a_model_is_refused_when_queued() {
        let (database, service) = queued_provider_service();
        let input = serde_json::from_value(json!({
            "sessionId": "session-1", "input": "next", "fastMode": false, "provider": "codex"
        }))
        .unwrap();
        let error = service
            .enqueue_pending_message(
                "session-1",
                "next",
                AgentMode::Auto,
                &input,
                None,
                PromptAuthor::unattested(),
            )
            .unwrap_err();
        assert!(matches!(
            error,
            ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "SWITCH_PROVIDER_REQUIRES_MODEL"
        ));
        assert!(durable_providers(&database).is_empty());
    }

    #[test]
    fn a_provider_that_cannot_answer_approvals_is_refused_in_ask_each_time() {
        let (database, service) = queued_provider_service();
        database
            .connection()
            .execute(
                "UPDATE sessions SET permission_mode = 'ask-each-time' WHERE id = 'session-1'",
                [],
            )
            .unwrap();
        let unsupported = [
            ProviderId::Claude,
            ProviderId::Codex,
            ProviderId::Cursor,
            ProviderId::Opencode,
            ProviderId::Grok,
        ]
        .into_iter()
        .find(|provider| {
            ensure_permission_mode_supported(*provider, PermissionMode::AskEachTime).is_err()
        });
        let Some(provider) = unsupported else {
            return;
        };
        let error =
            enqueue_with_provider(&service, Some(provider.as_str()), "some-model").unwrap_err();
        assert!(matches!(
            error,
            ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "PROVIDER_APPROVAL_UNSUPPORTED"
        ));
        assert!(durable_providers(&database).is_empty());
    }

    #[test]
    fn a_drained_row_carries_its_provider_into_the_send_and_a_legacy_row_carries_none() {
        let mut row = pending_message("m1", "session-1", "next");
        row.provider = Some(ProviderId::Codex);
        row.model_label = Some("GPT".to_string());
        row.model_id = Some("gpt-5.6-sol".to_string());
        let input = pending_message_to_send_input("session-1".to_string(), row).unwrap();
        assert_eq!(input.provider, Some(ProviderId::Codex));
        assert_eq!(input.model_id.as_ref().unwrap().as_str(), "gpt-5.6-sol");

        let legacy = pending_message("m2", "session-1", "next");
        let input = pending_message_to_send_input("session-1".to_string(), legacy).unwrap();
        assert_eq!(input.provider, None);
    }

    #[tokio::test]
    async fn cursor_composer_reference_is_rejected_before_a_queued_model_update() {
        let database = database_with_running_session();
        {
            let connection = database.connection();
            connection
                .execute(
                    "UPDATE sessions SET provider = 'cursor', model_label = 'Safe one-shot', model_id = 'gpt-5' WHERE id = 'session-1'",
                    [],
                )
                .expect("switch the idle session to cursor");
            update_session_state(
                &connection,
                "session-1",
                &SessionStateInput::transition(SessionState::Complete),
            )
            .expect("settle session");
            update_workspace_state(&connection, "workspace-1", "complete")
                .expect("settle workspace");
        }
        let references = serde_json::from_value(json!([{
            "name": "Gauss",
            "providerChildSessionId": "child-1",
            "providerParentConversationId": "parent-1"
        }]))
        .expect("references");
        let mut queued = pending_message("queued-reference", "session-1", "Ask Gauss again");
        queued.model_label = Some("Composer".to_string());
        queued.model_id = Some("composer-2.5".to_string());
        queued.agent_references = references;
        let input =
            pending_message_to_send_input("session-1".to_string(), queued).expect("queued input");
        let service = ProviderSessionService::builder(Arc::clone(&database)).build();
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
            events: vec![argmax_store::events::TimelineEvent {
                id: "wait".to_string(),
                session_id: "session".to_string(),
                r#type: "command.started".to_string(),
                message: "wait".to_string(),
                payload: json!({}),
                semantic: argmax_store::timeline_semantics::derive(
                    "command.started",
                    "wait",
                    &json!({}),
                ),
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
        let database = database_with_running_session();
        update_workspace_state(&database.connection(), "workspace-1", "archiving")
            .expect("archiving workspace");

        let service = ProviderSessionService::builder(database).build();
        let message_id = Uuid::new_v4().to_string();
        let queued = VecDeque::from([pending_message(
            &message_id,
            "session-1",
            "please keep this",
        )]);
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
                delivery: None,
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
                delivery: None,
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
            let durable = argmax_store::pending_messages::list_pending_messages(&connection)
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
                argmax_store::pending_messages::list_pending_messages(&connection).unwrap();
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
                argmax_store::pending_messages::list_pending_messages(&connection)
                    .expect("cleared durable queue")
                    .is_empty()
            );
        }

        // Keep the writer unavailable while cancellation starts. The cancel
        // path must wait for SQLite before taking `queues`; otherwise a stop
        // path holding SQLite and waiting for `queues` can deadlock it.
        let lock_message_id = Uuid::new_v4().to_string();
        let lock_queue = VecDeque::from([pending_message(
            &lock_message_id,
            "session-1",
            "lock ordering",
        )]);
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
        let service = ProviderSessionService::builder(database_with_running_session()).build();
        let message_id = Uuid::new_v4().to_string();
        let queued = VecDeque::from([pending_message(
            &message_id,
            "session-1",
            "stopped mid-promotion",
        )]);
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
                delivery: None,
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
        let durable =
            argmax_store::pending_messages::list_session_pending_messages(&connection, "session-1")
                .expect("durable queue");
        assert_eq!(durable.len(), 1, "the row is visible to the composer again");
        assert_eq!(durable[0].content, "stopped mid-promotion");
    }

    /// A person's prompt never carries another session's origin or a system
    /// starter: a send that claims both is refused, not quietly downgraded.
    #[tokio::test]
    async fn a_person_prompt_with_an_origin_is_refused() {
        let database = database_with_running_session();
        let service = ProviderSessionService::builder(database).build();
        let input: ProvidersSendInput = serde_json::from_value(json!({
            "sessionId": "session-1", "input": "hello", "fastMode": false
        }))
        .unwrap();
        let person = PromptAuthor::person(crate::ipc::attest_person_for_tests());
        let origin = MessageOrigin {
            session_id: "peer".to_string(),
            label: "Peer".to_string(),
            kind: "message".to_string(),
            message_id: None,
        };

        let error = service
            .send_input_authored(input.clone(), Some(origin), person)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "PROMPT_AUTHOR_CONFLICT"
        ));
        let error = service
            .send_input_scoped(
                input,
                None,
                None,
                TurnStarter::Move,
                Queueing::Allowed,
                MidTurnDelivery::Queue,
                person,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "PROMPT_AUTHOR_CONFLICT"
        ));
    }

    #[test]
    fn multitask_claim_blocks_the_turn_end_drain_until_it_is_resolved() {
        let database = database_with_running_session();
        let service = ProviderSessionService::builder(database).build();
        let queue = VecDeque::from([
            pending_message("pending-1", "session-1", "run alongside"),
            pending_message("pending-2", "session-1", "send after the turn"),
        ]);
        {
            let mut connection = service.database.connection();
            replace_session_queue(&mut connection, "session-1", &queue).expect("persist queue");
        }
        service
            .queues
            .lock_or_recover("queues")
            .insert("session-1".to_string(), queue);

        let claimed = service
            .claim_queued_message_for_multitask("session-1", "pending-1")
            .expect("claim multitask");
        assert!(
            service
                .pop_next_undelivered("session-1")
                .expect("attempt drain")
                .is_none(),
            "turn-end drain must stay parked while sibling dispatch is unresolved"
        );
        service
            .restore_queued_message_multitask("session-1", claimed)
            .expect("restore failed dispatch");
        assert_eq!(
            service.pending_messages_snapshot()["session-1"]
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["pending-1", "pending-2"]
        );

        let claimed = service
            .claim_queued_message_for_multitask("session-1", "pending-1")
            .expect("claim successful multitask");
        service
            .finish_queued_message_multitask("session-1", &claimed.id)
            .expect("finish multitask");
        let drained = service
            .pop_next_undelivered("session-1")
            .expect("drain after promotion")
            .expect("second follow-up remains runnable");
        assert_eq!(drained.id, "pending-2");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_permanently_invalidates_a_send_that_passed_the_initial_check() {
        let database = database_with_running_session();
        let launcher = Arc::new(CountingFailureLauncher::default());
        let service = ProviderSessionService::builder(Arc::clone(&database))
            .launcher(launcher.clone())
            .build();
        let gate = Arc::new(SendInputTestGate::default());
        *service
            .send_input_test_gate
            .lock_or_recover("send input test gate") = Some(Arc::clone(&gate));
        let send = {
            let service = Arc::clone(&service);
            tokio::spawn(async move {
                service
                    .send_input(ProvidersSendInput {
                        agent_references: None,
                        session_id: SessionId::try_from("session-1".to_string())
                            .expect("session id"),
                        input: Prompt::try_from("must not launch".to_string()).expect("prompt"),
                        provider: None,
                        model_label: None,
                        model_id: None,
                        reasoning_effort: None,
                        fast_mode: false,
                        agent_mode: None,
                        attachments: None,
                    })
                    .await
            })
        };

        gate.reached.notified().await;
        service
            .terminate(ProvidersTerminateInput {
                session_id: SessionId::try_from("session-1".to_string()).expect("session id"),
            })
            .await
            .expect("Stop completes");
        gate.release.notify_one();

        let error = send
            .await
            .expect("send task")
            .expect_err("pre-Stop send stays cancelled after markers clear");
        assert!(
            matches!(
                error,
                ArgmaxError::ServiceError { ref sub_code, .. }
                    if sub_code == "PROVIDER_SEND_CANCELLED"
            ),
            "unexpected send error: {error:?}"
        );
        tokio::task::yield_now().await;
        assert_eq!(launcher.launches.load(Ordering::SeqCst), 0);
        assert_eq!(service.open_handle_count(), 0);
        let connection = database.connection();
        let session = find_session_by_id(&connection, "session-1").expect("session");
        assert_eq!(session.state, SessionState::Cancelled);
        let events = list_session_events_since(&connection, "session-1", None, None)
            .expect("events")
            .events;
        assert!(!events
            .iter()
            .any(|event| { event.r#type == "user.message" && event.message == "must not launch" }));
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
