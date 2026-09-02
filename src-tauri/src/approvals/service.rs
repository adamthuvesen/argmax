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
//     Native provider continuation is deliberately not claimed until a
//     responder is wired for that provider capability.
//     The transaction wrapper keeps the renderer's `loadDashboard` reads
//     from seeing inconsistent state.

use std::sync::Arc;

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
use crate::sessions::attention::{
    compute_session_attention, AttentionState, SessionAttentionInput,
};

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
        })
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
            &SessionStateInput {
                state: "waiting".to_string(),
                attention: AttentionState::ApprovalNeeded.as_str().to_string(),
                completed_at: None,
                last_activity_at: None,
            },
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
        let conn = self.database.connection();
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| ArgmaxError::service("SQLITE", error.to_string()))?;
        let approval = resolve_approval(&tx, approval_id, status.as_str())?;
        let session = find_session_by_id(&tx, &approval.session_id)?;
        // Provider-emitted permission gates can be persisted after the
        // provider has already exited. Resolving that stale row should
        // update the audit trail but must not revive a completed /
        // failed / cancelled session.
        let updated_session = if session.state == "waiting" {
            let next_state = match status {
                ResolveStatus::Approved => "running",
                ResolveStatus::Rejected => "blocked",
            };
            let attention = compute_session_attention(SessionAttentionInput {
                state: next_state,
                has_pending_approval: false,
            });
            Some(update_session_state(
                &tx,
                &approval.session_id,
                &SessionStateInput {
                    state: next_state.to_string(),
                    attention: attention.as_str().to_string(),
                    completed_at: None,
                    last_activity_at: None,
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
                        default_provider: "claude".to_string(),
                        default_model_label: "Haiku 4.5".to_string(),
                        default_model_id: String::new(),
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
                    state: "running".to_string(),
                    attention: "normal".to_string(),
                },
            )
            .unwrap();
        }
        (database, "s1".to_string(), dir)
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
        assert_eq!(session.state, "waiting");
        assert_eq!(session.attention, "approval-needed");
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
        assert_eq!(session.state, "running");
        assert_eq!(session.attention, "normal");
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
        assert_eq!(session.state, "blocked");
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
