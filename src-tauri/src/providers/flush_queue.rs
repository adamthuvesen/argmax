use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;
use serde::Serialize;

use super::normalizer::NormalizedUsage;
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
        sessions::{SessionSummary, UsageCounts as PersistedUsageCounts},
        usage::{insert_usage_event, InsertUsageEventInput},
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
    pub sessions: Vec<SessionSummary>,
    pub events: Vec<TimelineEvent>,
    pub raw_outputs: Vec<RawProviderOutput>,
    pub approvals: Vec<ApprovalRequest>,
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

pub fn flush_session_buffer(
    connection: &mut Connection,
    session_id: &str,
    buffer: &mut SessionFlushBuffer,
) -> ArgmaxResult<DashboardDelta> {
    if buffer.is_empty() {
        return Ok(DashboardDelta::default());
    }

    let mut pending_events = buffer.pending_events.clone();
    pending_events.sort_by_key(|pending| pending.sequence);
    let pending_raw_outputs = buffer.pending_raw_outputs.clone();
    let pending_usages = buffer.pending_usages.clone();
    let pending_approvals = buffer.pending_approvals.clone();
    let pending_session_update = buffer.pending_session_update.clone();

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
        delta
            .approvals
            .push(existing.unwrap_or(persist_approval(&transaction, approval)?));
    }
    if let Some(session) = pending_session_update {
        delta.sessions.push(session);
    }

    transaction.commit().map_err(sqlite_error)?;

    buffer.pending_events.clear();
    buffer.pending_raw_outputs.clear();
    buffer.pending_usages.clear();
    buffer.pending_approvals.clear();
    buffer.pending_session_update = None;

    Ok(delta)
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
