use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
};

use rusqlite::Connection;
use serde::Serialize;
use uuid::Uuid;

use super::{
    normalizer::{
        normalize_provider_event, NormalizedUsage, NormalizerSessionContext, ProviderOutputEvent,
        ProviderOutputStream,
    },
    ProviderId,
};
use crate::{
    error::ArgmaxResult,
    persistence::{
        approvals::{
            find_pending_approval, persist_approval, ApprovalRequest, FindPendingApprovalInput,
            PersistApprovalInput,
        },
        events::{
            persist_raw_output, persist_timeline_event, PersistRawOutputInput,
            PersistTimelineEventInput, RawProviderOutput, TimelineEvent,
        },
        projects::ProjectSummary,
        sessions::{SessionSummary, UsageCounts as PersistedUsageCounts},
        usage::{insert_usage_event, InsertUsageEventInput},
        workspaces::WorkspaceSummary,
    },
    util::delta_coalescer::{DeltaCoalescer, DEFAULT_CADENCE_MS},
};

pub const MICRO_BATCH_MS: u64 = 16;

#[derive(Debug)]
pub struct SessionFlushBuffer {
    sequence: AtomicU64,
    pending_events: Vec<PendingTimelineEvent>,
    pending_raw_outputs: Vec<PersistRawOutputInput>,
    pending_usages: Vec<NormalizedUsage>,
    pending_approvals: Vec<PersistApprovalInput>,
    pending_session_update: Option<SessionSummary>,
}

#[derive(Debug, Clone)]
struct PendingTimelineEvent {
    sequence: u64,
    event: PersistTimelineEventInput,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DashboardDelta {
    pub projects: Vec<ProjectSummary>,
    pub workspaces: Vec<WorkspaceSummary>,
    pub sessions: Vec<SessionSummary>,
    pub events: Vec<TimelineEvent>,
    pub raw_outputs: Vec<RawProviderOutput>,
    pub approvals: Vec<ApprovalRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_messages: Option<std::collections::BTreeMap<String, Vec<PendingMessage>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMessage {
    pub id: String,
    pub session_id: String,
    pub content: String,
    pub agent_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub queued_at: String,
}

#[derive(Debug)]
pub struct ProviderEventFlushQueue {
    sessions: HashMap<String, ProviderFlushSession>,
    gate: DashboardDeltaGate,
}

#[derive(Debug)]
struct ProviderFlushSession {
    provider: ProviderId,
    normalizer_context: NormalizerSessionContext,
    stream_buffers: HashMap<ProviderOutputStream, String>,
    buffer: SessionFlushBuffer,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueueOutputResult {
    pub delta: Option<DashboardDelta>,
    pub provider_conversation_id: Option<String>,
    pub has_trailing_fragment: bool,
}

impl ProviderEventFlushQueue {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            gate: DashboardDeltaGate::new(),
        }
    }

    pub fn initialize_session(
        &mut self,
        session_id: impl Into<String>,
        provider: ProviderId,
        normalizer_context: NormalizerSessionContext,
    ) {
        self.sessions.insert(
            session_id.into(),
            ProviderFlushSession {
                provider,
                normalizer_context,
                stream_buffers: HashMap::new(),
                buffer: SessionFlushBuffer::new(),
            },
        );
    }

    pub fn delete_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    pub fn session_provider(&self, session_id: &str) -> Option<ProviderId> {
        self.sessions
            .get(session_id)
            .map(|session| session.provider)
    }

    pub fn queue_output_event(
        &mut self,
        connection: &mut Connection,
        event: ProviderOutputEvent,
    ) -> ArgmaxResult<QueueOutputResult> {
        let Some(session) = self.sessions.get_mut(&event.session_id) else {
            return Ok(QueueOutputResult {
                delta: None,
                provider_conversation_id: None,
                has_trailing_fragment: false,
            });
        };

        session.buffer.queue_raw_output(PersistRawOutputInput {
            id: Uuid::new_v4().to_string(),
            session_id: event.session_id.clone(),
            stream: event.stream.as_str().to_string(),
            content: event.message.clone(),
            created_at: Some(event.created_at.clone()),
        });

        let pending = session
            .stream_buffers
            .entry(event.stream.clone())
            .or_default();
        pending.push_str(&event.message);

        let mut provider_conversation_id = None;
        let Some(complete_up_to) = pending.rfind(['\n', '\r']).map(|index| index + 1) else {
            return Ok(QueueOutputResult {
                delta: None,
                provider_conversation_id,
                has_trailing_fragment: !pending.trim().is_empty(),
            });
        };
        let trailing = pending.split_off(complete_up_to);
        let has_trailing_fragment = !trailing.trim().is_empty();
        let completed = std::mem::replace(pending, trailing);
        let normalized_event = ProviderOutputEvent {
            message: completed,
            ..event
        };
        let normalized = normalize_provider_event(
            session.provider,
            &normalized_event,
            &mut session.normalizer_context,
        );
        provider_conversation_id = normalized.provider_conversation_id.clone();
        for event in normalized.events {
            session.buffer.queue_timeline_event(event);
        }
        for usage in normalized.usages {
            session.buffer.queue_usage(usage);
        }

        let delta = flush_session_buffer(
            connection,
            &normalized_event.session_id,
            &mut session.buffer,
        )?;
        // The events in `delta` are already persisted to SQLite. Dropping
        // the delta because the 16ms throttle gate said "no" used to lose
        // streaming chunks in flight — they sat in the DB invisible to
        // the renderer until end-of-turn flushed a single bulk delta,
        // which is what made Claude/Codex feel "super mega slow". Always
        // publish non-empty deltas; the gate is retained but only used by
        // flush_trailing_fragments() as a force-next signal.
        let _ = &self.gate;
        Ok(QueueOutputResult {
            delta: (!delta.is_empty()).then_some(delta),
            provider_conversation_id,
            has_trailing_fragment,
        })
    }

    pub fn flush_trailing_fragments(
        &mut self,
        connection: &mut Connection,
        session_id: &str,
        created_at: &str,
    ) -> ArgmaxResult<Option<DashboardDelta>> {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return Ok(None);
        };
        let fragments = std::mem::take(&mut session.stream_buffers);
        for (stream, fragment) in fragments {
            if fragment.trim().is_empty() {
                continue;
            }
            let event = ProviderOutputEvent {
                session_id: session_id.to_string(),
                stream,
                message: format!("{fragment}\n"),
                created_at: created_at.to_string(),
            };
            let normalized =
                normalize_provider_event(session.provider, &event, &mut session.normalizer_context);
            for event in normalized.events {
                session.buffer.queue_timeline_event(event);
            }
            for usage in normalized.usages {
                session.buffer.queue_usage(usage);
            }
        }
        self.gate.force_next_dashboard_delta();
        let delta = flush_session_buffer(connection, session_id, &mut session.buffer)?;
        Ok((!delta.is_empty()).then_some(delta))
    }
}

impl Default for ProviderEventFlushQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionFlushBuffer {
    pub fn new() -> Self {
        Self {
            sequence: AtomicU64::new(0),
            pending_events: Vec::new(),
            pending_raw_outputs: Vec::new(),
            pending_usages: Vec::new(),
            pending_approvals: Vec::new(),
            pending_session_update: None,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.pending_events.is_empty()
            && self.pending_raw_outputs.is_empty()
            && self.pending_usages.is_empty()
            && self.pending_approvals.is_empty()
            && self.pending_session_update.is_none()
    }

    pub fn queue_timeline_event(&mut self, event: PersistTimelineEventInput) -> u64 {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        self.pending_events
            .push(PendingTimelineEvent { sequence, event });
        sequence
    }

    pub fn queue_raw_output(&mut self, output: PersistRawOutputInput) {
        self.pending_raw_outputs.push(output);
    }

    pub fn queue_usage(&mut self, usage: NormalizedUsage) {
        self.pending_usages.push(usage);
    }

    pub fn queue_approval(&mut self, approval: PersistApprovalInput) {
        self.pending_approvals.push(approval);
    }

    pub fn queue_session_update(&mut self, session: SessionSummary) {
        self.pending_session_update = Some(session);
    }
}

impl Default for SessionFlushBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl DashboardDelta {
    pub fn is_empty(&self) -> bool {
        self.projects.is_empty()
            && self.workspaces.is_empty()
            && self.sessions.is_empty()
            && self.events.is_empty()
            && self.raw_outputs.is_empty()
            && self.approvals.is_empty()
            && self.pending_messages.is_none()
    }
}

pub fn flush_session_buffer(
    connection: &mut Connection,
    session_id: &str,
    buffer: &mut SessionFlushBuffer,
) -> ArgmaxResult<DashboardDelta> {
    if buffer.is_empty() {
        return Ok(DashboardDelta::default());
    }

    let mut pending_events = std::mem::take(&mut buffer.pending_events);
    pending_events.sort_by_key(|pending| pending.sequence);
    let pending_raw_outputs = std::mem::take(&mut buffer.pending_raw_outputs);
    let pending_usages = std::mem::take(&mut buffer.pending_usages);
    let pending_approvals = std::mem::take(&mut buffer.pending_approvals);
    let pending_session_update = buffer.pending_session_update.take();

    let result = (|| {
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let mut delta = DashboardDelta::default();

        for output in &pending_raw_outputs {
            delta
                .raw_outputs
                .push(persist_raw_output(&transaction, output)?);
        }
        for pending in &pending_events {
            delta
                .events
                .push(persist_timeline_event(&transaction, &pending.event)?);
        }
        for usage in &pending_usages {
            insert_usage_event(
                &transaction,
                &InsertUsageEventInput {
                    session_id: session_id.to_string(),
                    event_id: usage.event_id.clone(),
                    model_id: usage.model_id.clone(),
                    tokens: PersistedUsageCounts {
                        input: usage.tokens.input as i64,
                        output: usage.tokens.output as i64,
                        cache_read: usage.tokens.cache_read as i64,
                        cache_write: usage.tokens.cache_write as i64,
                    },
                    cost_usd: usage.cost_usd,
                    created_at: None,
                },
            )?;
        }
        for approval in &pending_approvals {
            let existing = find_pending_approval(
                &transaction,
                &FindPendingApprovalInput {
                    session_id: approval.session_id.clone(),
                    command: approval.command.clone(),
                    cwd: approval.cwd.clone(),
                    provider: approval.provider.clone(),
                },
            )?;
            // unwrap_or eagerly evaluates its argument, so persist_approval
            // would INSERT a duplicate every time the existing row was found.
            // Match keeps the INSERT in the None branch only.
            let row = match existing {
                Some(row) => row,
                None => persist_approval(&transaction, approval)?,
            };
            delta.approvals.push(row);
        }
        if let Some(session) = &pending_session_update {
            delta.sessions.push(session.clone());
        }

        transaction.commit().map_err(sqlite_error)?;
        Ok(delta)
    })();

    match result {
        Ok(delta) => Ok(delta),
        Err(error) => {
            buffer.pending_events = pending_events;
            buffer.pending_raw_outputs = pending_raw_outputs;
            buffer.pending_usages = pending_usages;
            buffer.pending_approvals = pending_approvals;
            buffer.pending_session_update = pending_session_update;
            Err(error)
        }
    }
}

#[derive(Debug)]
pub struct DashboardDeltaGate {
    coalescer: DeltaCoalescer,
}

impl DashboardDeltaGate {
    pub fn new() -> Self {
        Self {
            coalescer: DeltaCoalescer::new(DEFAULT_CADENCE_MS),
        }
    }

    pub fn should_publish_dashboard_delta(&self) -> bool {
        self.coalescer.should_emit("dashboard:delta")
    }

    pub fn force_next_dashboard_delta(&self) {
        self.coalescer.reset("dashboard:delta");
    }
}

impl Default for DashboardDeltaGate {
    fn default() -> Self {
        Self::new()
    }
}

fn sqlite_error(error: rusqlite::Error) -> crate::error::ArgmaxError {
    crate::error::ArgmaxError::service("SQLITE", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{
        database::Database,
        events::{list_session_events_since, PersistTimelineEventInput},
    };
    use serde_json::json;

    #[test]
    fn same_millisecond_events_land_in_queue_order_and_read_by_row_cursor() {
        let database = Database::open_in_memory().expect("open db");
        let mut connection = database.connection();
        seed_session(&connection);

        let mut buffer = SessionFlushBuffer::new();
        buffer.queue_timeline_event(event("first"));
        buffer.queue_timeline_event(event("second"));

        let delta = flush_session_buffer(&mut connection, "s1", &mut buffer).expect("flush");
        assert_eq!(
            delta
                .events
                .iter()
                .map(|event| event.message.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert!(delta.events[0].row_cursor < delta.events[1].row_cursor);

        let fetched =
            list_session_events_since(&connection, "s1", None, None).expect("fetch events");
        assert_eq!(
            fetched
                .events
                .iter()
                .map(|event| event.message.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert_eq!(fetched.event_cursor, delta.events[1].row_cursor.unwrap());
    }

    #[test]
    fn dashboard_delta_gate_throttles_dashboard_only() {
        let gate = DashboardDeltaGate::new();
        assert!(gate.should_publish_dashboard_delta());
        assert!(!gate.should_publish_dashboard_delta());
        gate.force_next_dashboard_delta();
        assert!(gate.should_publish_dashboard_delta());
    }

    #[test]
    fn provider_flush_queue_owns_stream_buffers_until_newline() {
        let database = Database::open_in_memory().expect("open db");
        let mut connection = database.connection();
        seed_session(&connection);

        let mut queue = ProviderEventFlushQueue::new();
        queue.initialize_session(
            "s1",
            ProviderId::Claude,
            NormalizerSessionContext::default(),
        );

        let first = queue
            .queue_output_event(
                &mut connection,
                output_event(
                    ProviderOutputStream::Stdout,
                    "{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hel",
                ),
            )
            .expect("queue first");
        assert!(first.delta.is_none());
        assert!(first.has_trailing_fragment);

        queue.gate.force_next_dashboard_delta();
        let second = queue
            .queue_output_event(
                &mut connection,
                output_event(ProviderOutputStream::Stdout, "lo\"}}\n"),
            )
            .expect("queue second");
        assert!(!second.has_trailing_fragment);
        let second = second.delta.expect("delta");

        assert_eq!(second.raw_outputs.len(), 2);
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.events[0].message, "Hello");
        let fetched =
            list_session_events_since(&connection, "s1", None, None).expect("fetch events");
        assert_eq!(fetched.events[0].message, "Hello");
    }

    #[test]
    fn trailing_fragments_flush_before_session_buffer_is_dropped() {
        let database = Database::open_in_memory().expect("open db");
        let mut connection = database.connection();
        seed_session(&connection);

        let mut queue = ProviderEventFlushQueue::new();
        queue.initialize_session(
            "s1",
            ProviderId::Claude,
            NormalizerSessionContext::default(),
        );
        let queued = queue
            .queue_output_event(
                &mut connection,
                output_event(ProviderOutputStream::Stdout, "plain trailing output"),
            )
            .expect("queue fragment");
        assert!(queued.has_trailing_fragment);

        let delta = queue
            .flush_trailing_fragments(&mut connection, "s1", "2026-05-24T10:00:01.000Z")
            .expect("flush trailing")
            .expect("delta");
        assert_eq!(delta.events.len(), 1);
        assert_eq!(delta.events[0].message, "plain trailing output");
    }

    #[test]
    fn flush_restores_buffer_when_transaction_fails() {
        let database = Database::open_in_memory().expect("open db");
        let mut connection = database.connection();
        seed_session(&connection);
        persist_timeline_event(&connection, &event("duplicate")).expect("seed duplicate");

        let mut buffer = SessionFlushBuffer::new();
        buffer.queue_timeline_event(event("duplicate"));

        flush_session_buffer(&mut connection, "s1", &mut buffer).expect_err("duplicate id fails");

        assert_eq!(buffer.pending_events.len(), 1);
        assert_eq!(buffer.pending_events[0].event.id, "event-duplicate");
    }

    fn event(message: &str) -> PersistTimelineEventInput {
        PersistTimelineEventInput {
            id: format!("event-{message}"),
            session_id: "s1".to_string(),
            r#type: "message.delta".to_string(),
            message: message.to_string(),
            payload: json!({}),
            created_at: Some("2026-05-24T10:00:00.000Z".to_string()),
        }
    }

    fn output_event(stream: ProviderOutputStream, message: &str) -> ProviderOutputEvent {
        ProviderOutputEvent {
            session_id: "s1".to_string(),
            stream,
            message: message.to_string(),
            created_at: "2026-05-24T10:00:00.000Z".to_string(),
        }
    }

    fn seed_session(connection: &Connection) {
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
                "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, reasoning_effort, permission_mode, agent_mode, provider_conversation_id, prompt, state, attention, started_at, completed_at, last_activity_at) VALUES ('s1', 'w1', 'claude', 'Sonnet', 'claude-sonnet-4', NULL, 'auto-approve', 'auto', NULL, 'prompt', 'running', 'none', '2026-05-24T10:00:00.000Z', NULL, '2026-05-24T10:00:00.000Z')",
                [],
            )
            .expect("insert session");
    }
}
