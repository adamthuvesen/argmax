use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;
use uuid::Uuid;

use super::{
    normalizer::{
        normalize_provider_event, synthesize_message_completed_from_exit, NormalizedUsage,
        NormalizerSessionContext, ProviderOutputEvent, ProviderOutputStream,
    },
    ProviderId,
};
use crate::{
    error::ArgmaxResult,
    ipc::inputs::ComposerAttachmentInput,
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
};

#[derive(Debug)]
pub struct SessionFlushBuffer {
    sequence: u64,
    pending_events: Vec<PendingTimelineEvent>,
    pending_raw_outputs: Vec<PersistRawOutputInput>,
    pending_usages: Vec<NormalizedUsage>,
    pending_approvals: Vec<PersistApprovalInput>,
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
    pub fast_mode: bool,
    // Carried through the queue so a drained follow-up re-persists its image
    // thumbnails on the user.message event — otherwise queuing a message with
    // an attachment loses the image in the chat UI once the turn sends.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ComposerAttachmentInput>,
    pub queued_at: String,
}

#[derive(Debug)]
pub struct ProviderEventFlushQueue {
    sessions: HashMap<String, ProviderFlushSession>,
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
        // The events in `delta` are already persisted to SQLite. Always publish
        // non-empty deltas immediately; rate bounding lives in the emit worker,
        // which conflates queued deltas per cycle.
        Ok(QueueOutputResult {
            delta: (!delta.is_empty()).then_some(delta),
            provider_conversation_id,
            has_trailing_fragment,
        })
    }

    /// Flush any buffered, newline-less stream fragments to SQLite.
    ///
    /// `synthesize_cursor_exit` must be `true` only on a genuine Cursor process
    /// exit that never sent a `result/success`. The synth `.take()`s the
    /// cumulative-delta baseline and marks the turn completed, so firing it on a
    /// mid-turn idle flush (or a user terminate) would prematurely complete the
    /// turn and duplicate the next delta. Mid-stream callers pass `false`.
    pub fn flush_trailing_fragments(
        &mut self,
        connection: &mut Connection,
        session_id: &str,
        created_at: &str,
        synthesize_cursor_exit: bool,
    ) -> ArgmaxResult<Option<DashboardDelta>> {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return Ok(None);
        };
        if synthesize_cursor_exit && session.provider == ProviderId::Cursor {
            let exit_event = ProviderOutputEvent {
                session_id: session_id.to_string(),
                stream: ProviderOutputStream::Stdout,
                message: String::new(),
                created_at: created_at.to_string(),
            };
            if let Some(event) =
                synthesize_message_completed_from_exit(&exit_event, &mut session.normalizer_context)
            {
                session.buffer.queue_timeline_event(event);
            }
        }
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
            sequence: 0,
            pending_events: Vec::new(),
            pending_raw_outputs: Vec::new(),
            pending_usages: Vec::new(),
            pending_approvals: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.pending_events.is_empty()
            && self.pending_raw_outputs.is_empty()
            && self.pending_usages.is_empty()
            && self.pending_approvals.is_empty()
    }

    pub fn queue_timeline_event(&mut self, event: PersistTimelineEventInput) -> u64 {
        self.sequence += 1;
        let sequence = self.sequence;
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

    /// Conflate `other` into `self`. Entity/event vectors are concatenated in
    /// arrival order (the renderer dedupes by id, keeping the later — i.e. newer
    /// — row), and `pending_messages` is a per-session snapshot, so `other`'s
    /// entries overwrite `self`'s for any session it touches. Used by the delta
    /// emit worker to merge a burst of streamed deltas into a single push.
    pub fn merge_from(&mut self, other: DashboardDelta) {
        self.projects.extend(other.projects);
        self.workspaces.extend(other.workspaces);
        self.sessions.extend(other.sessions);
        self.events.extend(other.events);
        self.raw_outputs.extend(other.raw_outputs);
        self.approvals.extend(other.approvals);
        if let Some(incoming) = other.pending_messages {
            let merged = self.pending_messages.get_or_insert_with(Default::default);
            merged.extend(incoming);
        }
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
                    context_window: usage.context_window.map(|window| window as i64),
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
            Err(error)
        }
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
    fn merge_from_concatenates_events_and_overrides_pending_messages() {
        use crate::persistence::events::TimelineEvent;
        use std::collections::BTreeMap;

        let event = |id: &str| TimelineEvent {
            id: id.to_string(),
            session_id: "s1".to_string(),
            r#type: "message.delta".to_string(),
            message: String::new(),
            payload: serde_json::json!({}),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            row_cursor: None,
        };
        let pending = |id: &str| PendingMessage {
            id: id.to_string(),
            session_id: "s1".to_string(),
            content: "hi".to_string(),
            agent_mode: "auto".to_string(),
            model_label: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: false,
            attachments: Vec::new(),
            queued_at: "2026-01-01T00:00:00Z".to_string(),
        };

        let mut a = DashboardDelta {
            events: vec![event("e1")],
            pending_messages: Some(BTreeMap::from([
                ("s1".to_string(), vec![pending("m1")]),
                ("s2".to_string(), vec![pending("m2")]),
            ])),
            ..DashboardDelta::default()
        };
        a.merge_from(DashboardDelta {
            events: vec![event("e2")],
            // s1's queue is now empty — newer snapshot must override a's.
            pending_messages: Some(BTreeMap::from([("s1".to_string(), vec![])])),
            ..DashboardDelta::default()
        });

        assert_eq!(
            a.events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["e1", "e2"]
        );
        let pending = a.pending_messages.expect("pending merged");
        assert!(pending.get("s1").expect("s1 present").is_empty());
        assert_eq!(pending.get("s2").expect("s2 preserved").len(), 1);
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
            .flush_trailing_fragments(&mut connection, "s1", "2026-05-24T10:00:01.000Z", false)
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

    #[test]
    fn cursor_idle_flush_does_not_prematurely_complete_turn() {
        let database = Database::open_in_memory().expect("open db");
        let mut connection = database.connection();
        seed_session(&connection);

        let mut queue = ProviderEventFlushQueue::new();
        queue.initialize_session(
            "s1",
            ProviderId::Cursor,
            NormalizerSessionContext::default(),
        );

        // A complete cumulative assistant line establishes the delta baseline.
        queue
            .queue_output_event(
                &mut connection,
                output_event(
                    ProviderOutputStream::Stdout,
                    "{\"type\":\"assistant\",\"message\":\"Hello\",\"timestamp_ms\":1}\n",
                ),
            )
            .expect("queue first assistant line");

        // A mid-turn idle flush must NOT synthesize a turn completion...
        let idle = queue
            .flush_trailing_fragments(&mut connection, "s1", "2026-05-24T10:00:01.000Z", false)
            .expect("idle flush");
        let synthesized_completions = idle
            .as_ref()
            .map(|delta| {
                delta
                    .events
                    .iter()
                    .filter(|event| event.r#type == "message.completed")
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(
            synthesized_completions, 0,
            "idle flush must not complete the turn"
        );

        // ...and must leave the cumulative baseline intact, so the next delta is
        // the suffix only — not the whole message re-emitted.
        let next = queue
            .queue_output_event(
                &mut connection,
                output_event(
                    ProviderOutputStream::Stdout,
                    "{\"type\":\"assistant\",\"message\":\"Hello world\",\"timestamp_ms\":2}\n",
                ),
            )
            .expect("queue second assistant line")
            .delta
            .expect("delta");
        assert_eq!(next.events.len(), 1);
        assert_eq!(next.events[0].message, " world");

        // A genuine process exit (no prior result/success) does synthesize.
        let exit = queue
            .flush_trailing_fragments(&mut connection, "s1", "2026-05-24T10:00:02.000Z", true)
            .expect("exit flush")
            .expect("delta");
        assert_eq!(exit.events.len(), 1);
        assert_eq!(exit.events[0].r#type, "message.completed");
        assert_eq!(exit.events[0].message, "Hello world");
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
                "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, reasoning_effort, permission_mode, agent_mode, provider_conversation_id, prompt, state, attention, started_at, completed_at, last_activity_at) VALUES ('s1', 'w1', 'claude', 'Sonnet', 'claude-sonnet-5', NULL, 'auto-approve', 'auto', NULL, 'prompt', 'running', 'none', '2026-05-24T10:00:00.000Z', NULL, '2026-05-24T10:00:00.000Z')",
                [],
            )
            .expect("insert session");
    }
}
