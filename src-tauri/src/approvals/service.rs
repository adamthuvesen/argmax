// ApprovalService — owns the request/resolve flow for command approvals.
//
//   - request_command_approval persists an approval, flips the session to
//     `waiting`/`approval-needed`, and writes the `approval.requested`
//     timeline event — all in a single transaction so a concurrent reader
//     never sees a half-applied state.
//   - Same-tuple races collapse into a single pending row via the
//     SELECT-then-INSERT inside the transaction.
//   - resolve_approval flips the approval to approved/rejected and, when
//     the session is still `waiting`, transitions it to running/blocked.
//     Native requests resume only their live, correlated provider responder.
//     A stopped or disconnected request cannot be approved.
//     The transaction wrapper keeps the renderer's `loadDashboard` reads
//     from seeing inconsistent state.

use crate::util::sync::LockOrRecover;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

use serde_json::json;
use uuid::Uuid;

use crate::approvals::dangerous_action_policy::{classify_command_risk, CommandRiskLevel};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::approvals::{
    find_approval_by_id, find_pending_approval, list_approvals_for_session,
    list_approvals_for_workspace, list_pending_approvals, persist_approval, resolve_approval,
    ApprovalRequest, FindPendingApprovalInput, PersistApprovalInput,
};
use crate::persistence::database::Database;
use crate::persistence::events::{persist_timeline_event, PersistTimelineEventInput};
use crate::persistence::sessions::{find_session_by_id, update_session_state, SessionStateInput};
use crate::persistence::time::now_iso;
use crate::providers::flush_queue::DashboardDelta;
use crate::providers::runtime::DeltaPublisher;
use crate::sessions::state::SessionState;

/// Soft cap on how many pending approvals we return in one IPC roundtrip.
/// Matches the dashboard's `DASHBOARD_ROW_LIMIT` so a single user can't
/// accidentally drown the renderer with a runaway approval stream.
const PENDING_LIMIT: usize = 500;

#[derive(Debug, Clone)]
pub struct RequestCommandApprovalInput {
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub provider: String,
}

#[derive(Debug, Clone)]
pub struct CommandApprovalDecision {
    pub allowed: bool,
    pub approval: Option<ApprovalRequest>,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveStatus {
    Approved,
    Rejected,
}

impl ResolveStatus {
    fn as_str(&self) -> &'static str {
        match self {
            ResolveStatus::Approved => "approved",
            ResolveStatus::Rejected => "rejected",
        }
    }
}

pub struct ApprovalService {
    database: Arc<Database>,
    publish_delta: DeltaPublisher,
    native_requests: Mutex<HashMap<String, (String, oneshot::Sender<bool>)>>,
}

impl ApprovalService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Self::with_publisher(database, |_| {})
    }

    pub fn with_publisher(
        database: Arc<Database>,
        publisher: impl Fn(DashboardDelta) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            publish_delta: Arc::new(publisher),
            native_requests: Mutex::new(HashMap::new()),
        })
    }

    /// Wait for a decision on an exact live provider request. The native provider
    /// owns policy evaluation. Every request it sends here requires a decision.
    pub async fn request_native(
        &self,
        session_id: &str,
        invocation_id: &str,
        request_id: &str,
        command: &str,
        cwd: &str,
        provider: &str,
    ) -> ArgmaxResult<bool> {
        let receiver = self.register_native(
            session_id,
            invocation_id,
            request_id,
            command,
            cwd,
            provider,
        )?;
        receiver.await.map_err(|_| {
            ArgmaxError::service(
                "APPROVAL_CANCELLED",
                "This approval is no longer connected to a running provider",
            )
        })
    }

    fn register_native(
        &self,
        session_id: &str,
        invocation_id: &str,
        request_id: &str,
        command: &str,
        cwd: &str,
        provider: &str,
    ) -> ArgmaxResult<oneshot::Receiver<bool>> {
        let mut requests = self.native_requests.lock_or_recover("native approvals");
        let conn = self.database.connection();
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let session = find_session_by_id(&tx, session_id)?;
        if !matches!(session.state, SessionState::Running | SessionState::Waiting) {
            return Err(ArgmaxError::service(
                "APPROVAL_CANCELLED",
                "The provider turn has ended",
            ));
        }
        if crate::persistence::approvals::find_approval_by_provider_request(
            &tx,
            session_id,
            provider,
            invocation_id,
            request_id,
        )?
        .is_some()
        {
            return Err(ArgmaxError::service(
                "APPROVAL_DUPLICATE",
                "This provider request was already received",
            ));
        }
        let approval = persist_approval(
            &tx,
            &PersistApprovalInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                command: command.to_string(),
                cwd: cwd.to_string(),
                provider: provider.to_string(),
                provider_invocation_id: Some(invocation_id.to_string()),
                provider_request_id: Some(request_id.to_string()),
                risk_level: risk_level_str(classify_command_risk(command).risk_level).to_string(),
                status: "pending".to_string(),
                created_at: None,
            },
        )?;
        if requests.contains_key(&approval.id) {
            return Err(ArgmaxError::service(
                "APPROVAL_DUPLICATE",
                "This provider request is already waiting for a decision",
            ));
        }
        let session = update_session_state(
            &tx,
            session_id,
            &SessionStateInput::transition(SessionState::Waiting).with_pending_approval(),
        )?;
        let event = persist_timeline_event(
            &tx,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                r#type: "approval.requested".to_string(),
                message: "The provider needs your approval to continue".to_string(),
                payload: json!({"approvalId": approval.id, "command": command, "cwd": cwd, "provider": provider}),
                created_at: None,
            },
        )?;
        tx.commit()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let (sender, receiver) = oneshot::channel();
        requests.insert(approval.id.clone(), (session_id.to_string(), sender));
        drop(conn);
        drop(requests);
        self.publish(DashboardDelta {
            sessions: vec![session],
            events: vec![event],
            approvals: vec![approval],
            ..DashboardDelta::default()
        });
        Ok(receiver)
    }

    pub fn cancel_native_request(
        &self,
        session_id: &str,
        invocation_id: &str,
        request_id: &str,
    ) -> ArgmaxResult<()> {
        let mut native = self.native_requests.lock_or_recover("native approvals");
        let conn = self.database.connection();
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let pending = list_approvals_for_session(&tx, session_id, "pending")?;
        let mut cancelled = Vec::new();
        for approval in pending.into_iter().filter(|approval| {
            approval.provider_invocation_id.as_deref() == Some(invocation_id)
                && approval.provider_request_id.as_deref() == Some(request_id)
        }) {
            native.remove(&approval.id);
            tx.execute("UPDATE approvals SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'pending'", (now_iso(), &approval.id))
                .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
            cancelled.push(find_approval_by_id(&tx, &approval.id)?);
        }
        let session = find_session_by_id(&tx, session_id)?;
        let updated_session = if !cancelled.is_empty()
            && session.state == SessionState::Waiting
            && list_approvals_for_session(&tx, session_id, "pending")?.is_empty()
        {
            Some(update_session_state(
                &tx,
                session_id,
                &SessionStateInput::transition(SessionState::Running),
            )?)
        } else {
            None
        };
        tx.commit()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        drop(conn);
        drop(native);
        self.publish(DashboardDelta {
            approvals: cancelled,
            sessions: updated_session.into_iter().collect(),
            ..DashboardDelta::default()
        });
        Ok(())
    }

    /// All pending approvals, newest first. The IPC channel
    /// `approvals:pending` takes no input today and that shape is
    /// preserved here — callers pass nothing.
    pub fn pending(&self) -> ArgmaxResult<Vec<ApprovalRequest>> {
        let conn = self.database.read_connection();
        list_pending_approvals(&conn, PENDING_LIMIT)
    }

    pub fn request_command_approval(
        &self,
        input: RequestCommandApprovalInput,
    ) -> ArgmaxResult<CommandApprovalDecision> {
        let risk = classify_command_risk(&input.command);
        if !risk.requires_approval {
            return Ok(CommandApprovalDecision {
                allowed: true,
                approval: None,
                reason: risk.reason.to_string(),
            });
        }

        let conn = self.database.connection();
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let existing = find_pending_approval(
            &tx,
            &FindPendingApprovalInput {
                session_id: input.session_id.clone(),
                command: input.command.clone(),
                cwd: input.cwd.clone(),
                provider: input.provider.clone(),
            },
        )?;
        if let Some(approval) = existing {
            tx.commit()
                .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
            return Ok(CommandApprovalDecision {
                allowed: false,
                approval: Some(approval),
                reason: risk.reason.to_string(),
            });
        }

        let approval = persist_approval(
            &tx,
            &PersistApprovalInput {
                id: Uuid::new_v4().to_string(),
                session_id: input.session_id.clone(),
                command: input.command.clone(),
                cwd: input.cwd.clone(),
                provider: input.provider.clone(),
                provider_invocation_id: None,
                provider_request_id: None,
                risk_level: risk_level_str(risk.risk_level).to_string(),
                status: "pending".to_string(),
                created_at: None,
            },
        )?;
        update_session_state(
            &tx,
            &input.session_id,
            &SessionStateInput::transition(SessionState::Waiting).with_pending_approval(),
        )?;
        persist_timeline_event(
            &tx,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: input.session_id.clone(),
                r#type: "approval.requested".to_string(),
                message: risk.reason.to_string(),
                payload: json!({
                    "command": input.command,
                    "cwd": input.cwd,
                    "provider": input.provider,
                    "riskLevel": risk_level_str(risk.risk_level),
                }),
                created_at: None,
            },
        )?;

        tx.commit()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        Ok(CommandApprovalDecision {
            allowed: false,
            approval: Some(approval),
            reason: risk.reason.to_string(),
        })
    }

    pub fn resolve(
        &self,
        approval_id: &str,
        status: ResolveStatus,
    ) -> ArgmaxResult<ApprovalRequest> {
        let mut native = self.native_requests.lock_or_recover("native approvals");
        let conn = self.database.connection();
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let current = find_approval_by_id(&tx, approval_id)?;
        let is_native = current.provider_request_id.is_some();
        if is_native
            && native
                .get(approval_id)
                .is_none_or(|(_, sender)| sender.is_closed())
        {
            return Err(ArgmaxError::service(
                "APPROVAL_CANCELLED",
                "This approval is no longer connected to a running provider",
            ));
        }
        let approval = resolve_approval(&tx, approval_id, status.as_str())?;
        let session = find_session_by_id(&tx, &approval.session_id)?;
        // Provider-emitted permission gates can be persisted after the
        // provider has already exited. Resolving that stale row should
        // update the audit trail but must not revive a completed /
        // failed / cancelled session.
        let updated_session = if session.state == SessionState::Waiting {
            let still_pending =
                !list_approvals_for_session(&tx, &approval.session_id, "pending")?.is_empty();
            let next_state = if still_pending {
                SessionState::Waiting
            } else if is_native {
                // A denied native tool returns control to the provider too.
                SessionState::Running
            } else {
                match status {
                    ResolveStatus::Approved => SessionState::Running,
                    ResolveStatus::Rejected => SessionState::Blocked,
                }
            };
            Some(update_session_state(
                &tx,
                &approval.session_id,
                &if next_state == SessionState::Waiting {
                    SessionStateInput::transition(next_state).with_pending_approval()
                } else {
                    SessionStateInput::transition(next_state)
                },
            )?)
        } else {
            None
        };
        let message = match status {
            ResolveStatus::Approved => "Approval granted",
            ResolveStatus::Rejected => "Approval denied",
        };
        let event = persist_timeline_event(
            &tx,
            &PersistTimelineEventInput {
                id: Uuid::new_v4().to_string(),
                session_id: approval.session_id.clone(),
                r#type: "approval.resolved".to_string(),
                message: message.to_string(),
                payload: json!({
                    "approvalId": approval.id,
                    "status": status.as_str(),
                    "command": approval.command,
                }),
                created_at: None,
            },
        )?;
        tx.commit()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        if let Some((_, sender)) = native.remove(approval_id) {
            let _ = sender.send(status == ResolveStatus::Approved);
        }
        drop(conn);
        drop(native);
        self.publish(DashboardDelta {
            sessions: updated_session.into_iter().collect(),
            events: vec![event],
            approvals: vec![approval.clone()],
            ..DashboardDelta::default()
        });
        Ok(approval)
    }

    /// Mark pending approvals for a workspace as cancelled during archive.
    /// This is intentionally separate from user resolution: archive is a
    /// lifecycle action, not an approval decision, and must never leave rows
    /// that appear actionable after their provider/session is gone.
    pub fn cancel_workspace_pending(&self, workspace_id: &str) -> ArgmaxResult<()> {
        let mut native = self.native_requests.lock_or_recover("native approvals");
        let conn = self.database.connection();
        let pending = list_approvals_for_workspace(&conn, workspace_id, "pending")?;
        if pending.is_empty() {
            return Ok(());
        }
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let mut statement = tx
            .prepare_cached(
                "UPDATE approvals SET status = 'cancelled', resolved_at = ? WHERE status = 'pending' AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)",
            )
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        statement
            .execute((crate::persistence::time::now_iso(), workspace_id))
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        drop(statement);
        tx.commit()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        native.retain(|id, _| !pending.iter().any(|approval| &approval.id == id));
        let cancelled = pending
            .iter()
            .map(|approval| find_approval_by_id(&conn, &approval.id))
            .collect::<ArgmaxResult<Vec<_>>>()?;
        if !cancelled.is_empty() {
            self.publish(DashboardDelta {
                approvals: cancelled,
                ..DashboardDelta::default()
            });
        }
        Ok(())
    }

    /// Cancel pending approvals when their provider session exits or is
    /// terminated. A request that no longer has a live invocation must never
    /// remain actionable after restart.
    pub fn cancel_session_pending(&self, session_id: &str) -> ArgmaxResult<()> {
        let mut native = self.native_requests.lock_or_recover("native approvals");
        native.retain(|_, (id, _)| id != session_id);
        let conn = self.database.connection();
        let pending = list_approvals_for_session(&conn, session_id, "pending")?;
        if pending.is_empty() {
            return Ok(());
        }
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        tx.execute(
            "UPDATE approvals SET status = 'cancelled', resolved_at = ? WHERE session_id = ? AND status = 'pending'",
            (now_iso(), session_id),
        )
        .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        tx.commit()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        native.retain(|id, _| !pending.iter().any(|approval| &approval.id == id));
        let cancelled = pending
            .iter()
            .map(|approval| find_approval_by_id(&conn, &approval.id))
            .collect::<ArgmaxResult<Vec<_>>>()?;
        if !cancelled.is_empty() {
            self.publish(DashboardDelta {
                approvals: cancelled,
                ..DashboardDelta::default()
            });
        }
        Ok(())
    }

    fn publish(&self, delta: DashboardDelta) {
        if !delta.is_empty() {
            (self.publish_delta)(delta);
        }
    }
}

fn risk_level_str(level: CommandRiskLevel) -> &'static str {
    match level {
        CommandRiskLevel::Low => "low",
        CommandRiskLevel::Medium => "medium",
        CommandRiskLevel::High => "high",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use crate::sessions::attention::AttentionState;
    use tempfile::TempDir;

    fn setup() -> (Arc<Database>, String, TempDir) {
        let dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(dir.path().join("argmax.sqlite")).unwrap());

        {
            let conn = database.connection();
            persist_project(
                &conn,
                &PersistProjectInput {
                    id: "p1".to_string(),
                    name: "fixture".to_string(),
                    repo_path: "/tmp/argmax-fixture-repo".to_string(),
                    default_branch: Some("main".to_string()),
                    current_branch: "main".to_string(),
                    settings: ProjectSettings {
                        archive_on_merge: false,
                        worktree_location: "/tmp/argmax-fixture-repo/.worktrees".to_string(),
                        setup_command: String::new(),
                        check_commands: Vec::new(),
                    },
                },
            )
            .unwrap();
            persist_workspace(
                &conn,
                &PersistWorkspaceInput {
                    id: "w1".to_string(),
                    project_id: "p1".to_string(),
                    task_label: "approvals-test".to_string(),
                    branch: "main".to_string(),
                    base_ref: "main".to_string(),
                    path: "/tmp/argmax-fixture-repo".to_string(),
                    state: "created".to_string(),
                    shared_workspace: true,
                    kind: "git".to_string(),
                    dirty: false,
                    changed_files: 0,
                },
            )
            .unwrap();
            persist_session(
                &conn,
                &PersistSessionInput {
                    id: "s1".to_string(),
                    workspace_id: "w1".to_string(),
                    prompt: "test".to_string(),
                    provider: "claude".to_string(),
                    model_label: "Haiku 4.5".to_string(),
                    model_id: "claude-haiku-4-5".to_string(),
                    reasoning_effort: None,
                    permission_mode: None,
                    agent_mode: Some("auto".to_string()),
                    state: SessionState::Running,
                },
            )
            .unwrap();
        }
        (database, "s1".to_string(), dir)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_control_round_trip_waits_for_real_resolution() {
        use crate::providers::{AgentMode, PermissionMode, ProviderId, ProviderLaunchInput};
        use std::os::unix::fs::PermissionsExt;
        let (database, session_id, dir) = setup();
        let svc = ApprovalService::new(database);
        let binary = dir.path().join("fake-claude");
        let response_file = dir.path().join("reply.json");
        std::fs::write(&binary, r#"#!/bin/sh
read -r initialize
printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"argmax-initialize","response":{}}}'
read -r prompt
printf '%s\n' '{"type":"control_request","request_id":"exact-request","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}'
read -r response
printf '%s' "$response" > reply.json
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"done"}'
"#).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let input = ProviderLaunchInput {
            provider: ProviderId::Claude,
            session_id,
            workspace_path: dir.path().to_path_buf(),
            prompt: "test".into(),
            model_label: "test".into(),
            model_id: "test".into(),
            reasoning_effort: None,
            fast_mode: false,
            resume_conversation_id: None,
            resume_fork: false,
            permission_mode: PermissionMode::ProviderDefaults,
            agent_mode: AgentMode::Auto,
            cols: 80,
            rows: 24,
        };
        let handle = crate::providers::claude_control::launch_turn(
            binary.to_str().unwrap(),
            &input,
            None,
            svc.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let approval = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Some(row) = svc.pending().unwrap().first().cloned() {
                    break row;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            !response_file.exists(),
            "provider must remain waiting before the user decides"
        );
        svc.resolve(&approval.id, ResolveStatus::Rejected).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !handle.disposed() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let response: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(response_file).unwrap()).unwrap();
        assert_eq!(response["response"]["request_id"], "exact-request");
        assert_eq!(response["response"]["response"]["behavior"], "deny");
    }

    #[tokio::test]
    async fn native_requests_wait_and_resolve_exact_request_once() {
        let (database, session_id, _dir) = setup();
        let svc = ApprovalService::new(database.clone());
        let first = svc
            .register_native(&session_id, "turn-1", "r1", "ls", "/tmp", "claude")
            .unwrap();
        let second = svc
            .register_native(&session_id, "turn-1", "r2", "pwd", "/tmp", "claude")
            .unwrap();
        let rows = svc.pending().unwrap();
        let first_row = rows
            .iter()
            .find(|row| row.provider_request_id.as_deref() == Some("r1"))
            .unwrap();
        let second_row = rows
            .iter()
            .find(|row| row.provider_request_id.as_deref() == Some("r2"))
            .unwrap();
        assert!(svc
            .register_native(&session_id, "turn-1", "r1", "ls", "/tmp", "claude")
            .is_err());
        svc.resolve(&second_row.id, ResolveStatus::Rejected)
            .unwrap();
        assert!(!second.await.unwrap());
        assert_eq!(
            find_session_by_id(&database.connection(), &session_id)
                .unwrap()
                .state,
            SessionState::Waiting
        );
        svc.resolve(&first_row.id, ResolveStatus::Approved).unwrap();
        assert!(first.await.unwrap());
        assert_eq!(
            find_session_by_id(&database.connection(), &session_id)
                .unwrap()
                .state,
            SessionState::Running
        );
        assert!(svc.resolve(&first_row.id, ResolveStatus::Approved).is_err());
        assert!(svc
            .register_native(&session_id, "turn-1", "r1", "ls", "/tmp", "claude")
            .is_err());
    }

    #[tokio::test]
    async fn native_request_cancellation_invalidates_the_live_response() {
        let (database, session_id, _dir) = setup();
        let svc = ApprovalService::new(Arc::clone(&database));
        let receiver = svc
            .register_native(&session_id, "turn-1", "r1", "ls", "/tmp", "codex")
            .unwrap();
        let row = svc.pending().unwrap().remove(0);
        svc.cancel_native_request(&session_id, "turn-1", "r1")
            .unwrap();
        assert!(receiver.await.is_err());
        assert!(svc.resolve(&row.id, ResolveStatus::Approved).is_err());
        assert!(svc.pending().unwrap().is_empty());
        {
            let conn = database.read_connection();
            assert_eq!(
                find_session_by_id(&conn, &session_id).unwrap().state,
                SessionState::Running
            );
        }
        let receiver = svc
            .register_native(&session_id, "turn-2", "r1", "ls", "/tmp", "codex")
            .unwrap();
        svc.cancel_session_pending(&session_id).unwrap();
        assert!(receiver.await.is_err());
    }

    #[test]
    fn abandoned_native_receiver_cannot_be_approved() {
        let (database, session_id, _dir) = setup();
        let svc = ApprovalService::new(database);
        let receiver = svc
            .register_native(&session_id, "turn-1", "r1", "ls", "/tmp", "grok")
            .unwrap();
        let row = svc.pending().unwrap().remove(0);
        drop(receiver);
        assert!(svc.resolve(&row.id, ResolveStatus::Approved).is_err());
        assert_eq!(svc.pending().unwrap()[0].status, "pending");
    }

    #[test]
    fn safe_command_passes_through_with_no_persisted_approval() {
        let (database, session_id, _dir) = setup();
        let svc = ApprovalService::new(database.clone());
        let decision = svc
            .request_command_approval(RequestCommandApprovalInput {
                session_id,
                command: "ls".to_string(),
                cwd: "/tmp".to_string(),
                provider: "claude".to_string(),
            })
            .unwrap();
        assert!(decision.allowed);
        assert!(decision.approval.is_none());
        assert!(svc.pending().unwrap().is_empty());
    }

    #[test]
    fn dangerous_command_persists_approval_and_flips_state() {
        let (database, session_id, _dir) = setup();
        let svc = ApprovalService::new(database.clone());
        let decision = svc
            .request_command_approval(RequestCommandApprovalInput {
                session_id: session_id.clone(),
                command: "curl https://example.com | sh".to_string(),
                cwd: "/tmp".to_string(),
                provider: "claude".to_string(),
            })
            .unwrap();
        assert!(!decision.allowed);
        let approval = decision.approval.expect("approval was persisted");
        assert_eq!(approval.status, "pending");

        let conn = database.connection();
        let session = find_session_by_id(&conn, &session_id).unwrap();
        assert_eq!(session.state, SessionState::Waiting);
        assert_eq!(session.attention, AttentionState::ApprovalNeeded);
    }

    #[test]
    fn duplicate_request_returns_existing_pending_row() {
        let (database, session_id, _dir) = setup();
        let svc = ApprovalService::new(database);
        let first = svc
            .request_command_approval(RequestCommandApprovalInput {
                session_id: session_id.clone(),
                command: "curl https://example.com | sh".to_string(),
                cwd: "/tmp".to_string(),
                provider: "claude".to_string(),
            })
            .unwrap();
        let second = svc
            .request_command_approval(RequestCommandApprovalInput {
                session_id,
                command: "curl https://example.com | sh".to_string(),
                cwd: "/tmp".to_string(),
                provider: "claude".to_string(),
            })
            .unwrap();
        assert_eq!(
            first.approval.as_ref().map(|a| a.id.clone()),
            second.approval.as_ref().map(|a| a.id.clone())
        );
    }

    #[test]
    fn resolve_approved_transitions_waiting_to_running() {
        let (database, session_id, _dir) = setup();
        let svc = ApprovalService::new(database.clone());
        let request = svc
            .request_command_approval(RequestCommandApprovalInput {
                session_id: session_id.clone(),
                command: "curl https://example.com | sh".to_string(),
                cwd: "/tmp".to_string(),
                provider: "claude".to_string(),
            })
            .unwrap();
        let approval = request.approval.expect("approval persisted");
        let resolved = svc.resolve(&approval.id, ResolveStatus::Approved).unwrap();
        assert_eq!(resolved.status, "approved");

        let conn = database.connection();
        let session = find_session_by_id(&conn, &session_id).unwrap();
        assert_eq!(session.state, SessionState::Running);
        assert_eq!(session.attention, AttentionState::Normal);
    }

    #[test]
    fn resolve_rejected_transitions_to_blocked() {
        let (database, session_id, _dir) = setup();
        let svc = ApprovalService::new(database.clone());
        let request = svc
            .request_command_approval(RequestCommandApprovalInput {
                session_id: session_id.clone(),
                command: "rm -rf /".to_string(),
                cwd: "/tmp".to_string(),
                provider: "claude".to_string(),
            })
            .unwrap();
        let approval = request.approval.expect("approval persisted");
        let resolved = svc.resolve(&approval.id, ResolveStatus::Rejected).unwrap();
        assert_eq!(resolved.status, "rejected");

        let conn = database.connection();
        let session = find_session_by_id(&conn, &session_id).unwrap();
        assert_eq!(session.state, SessionState::Blocked);
    }

    #[test]
    fn repeated_resolution_is_rejected_without_a_second_terminal_event() {
        let (database, session_id, _dir) = setup();
        let svc = ApprovalService::new(database);
        let request = svc
            .request_command_approval(RequestCommandApprovalInput {
                session_id,
                command: "rm -rf /tmp/build".to_string(),
                cwd: "/tmp".to_string(),
                provider: "codex".to_string(),
            })
            .unwrap();
        let approval = request.approval.expect("approval persisted");
        svc.resolve(&approval.id, ResolveStatus::Rejected)
            .expect("first resolution");
        let error = svc
            .resolve(&approval.id, ResolveStatus::Approved)
            .expect_err("second resolution must fail");
        assert!(error.to_string().contains("cannot be resolved again"));
    }
}
