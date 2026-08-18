//! Shared admission control for workspace-scoped processes.
//!
//! Archive is a destructive operation.  The gate closes admission before the
//! archive coordinator starts cancelling children, so a late provider/check/
//! terminal request cannot attach itself to a worktree that is being removed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::{sleep, timeout};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::util::sync::LockOrRecover;

#[derive(Default)]
struct Entry {
    state: LifecycleState,
    admissions: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum LifecycleState {
    #[default]
    Open,
    Archiving,
    Failed,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveOutcome {
    Archived,
    Reopened,
    Failed,
}

/// Process admission gate shared by all services that can own a workspace
/// child process.  It deliberately does not hold a lock for the lifetime of a
/// child: archive must be able to acquire the gate and then cancel children.
#[derive(Clone, Default)]
pub struct WorkspaceLifecycle {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
}

impl WorkspaceLifecycle {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn admit(self: &Arc<Self>, workspace_id: &str) -> ArgmaxResult<WorkspaceAdmission> {
        let mut entries = self.entries.lock_or_recover("workspace lifecycle");
        let entry = entries.entry(workspace_id.to_string()).or_default();
        match entry.state {
            LifecycleState::Archiving => {
                return Err(ArgmaxError::service(
                    "WORKSPACE_ARCHIVING",
                    "Workspace archive is in progress; no new process can be started.",
                ));
            }
            LifecycleState::Failed | LifecycleState::Archived => {
                return Err(ArgmaxError::service(
                    "WORKSPACE_ARCHIVE_FAILED",
                    "Workspace archive requires explicit recovery before new processes can start.",
                ));
            }
            LifecycleState::Open => {}
        }
        entry.admissions += 1;
        Ok(WorkspaceAdmission {
            lifecycle: Arc::clone(self),
            workspace_id: workspace_id.to_string(),
        })
    }

    pub fn begin_archive(
        self: &Arc<Self>,
        workspace_id: &str,
    ) -> ArgmaxResult<WorkspaceArchiveLease> {
        let mut entries = self.entries.lock_or_recover("workspace lifecycle");
        let entry = entries.entry(workspace_id.to_string()).or_default();
        if matches!(
            entry.state,
            LifecycleState::Archiving | LifecycleState::Archived
        ) {
            return Err(ArgmaxError::service(
                "WORKSPACE_ARCHIVE_IN_PROGRESS",
                "Workspace archive is already in progress or has completed.",
            ));
        }
        entry.state = LifecycleState::Archiving;
        Ok(WorkspaceArchiveLease {
            lifecycle: Arc::clone(self),
            workspace_id: workspace_id.to_string(),
            finished: false,
        })
    }

    pub async fn wait_for_admissions(&self, workspace_id: &str, bound: Duration) -> bool {
        timeout(bound, async {
            loop {
                let done = self
                    .entries
                    .lock_or_recover("workspace lifecycle")
                    .get(workspace_id)
                    .map(|entry| entry.admissions == 0)
                    .unwrap_or(true);
                if done {
                    return;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok()
    }

    fn release_admission(&self, workspace_id: &str) {
        let mut entries = self.entries.lock_or_recover("workspace lifecycle");
        let remove = if let Some(entry) = entries.get_mut(workspace_id) {
            entry.admissions = entry.admissions.saturating_sub(1);
            entry.admissions == 0 && matches!(entry.state, LifecycleState::Open)
        } else {
            false
        };
        if remove {
            entries.remove(workspace_id);
        }
    }

    fn finish_archive(&self, workspace_id: &str, outcome: ArchiveOutcome) {
        let mut entries = self.entries.lock_or_recover("workspace lifecycle");
        if let Some(entry) = entries.get_mut(workspace_id) {
            entry.state = match outcome {
                ArchiveOutcome::Archived => LifecycleState::Archived,
                ArchiveOutcome::Failed => LifecycleState::Failed,
                ArchiveOutcome::Reopened => LifecycleState::Open,
            };
            if matches!(outcome, ArchiveOutcome::Reopened) && entry.admissions == 0 {
                entries.remove(workspace_id);
            }
        }
    }

    pub fn reopen(&self, workspace_id: &str) {
        let mut entries = self.entries.lock_or_recover("workspace lifecycle");
        if let Some(entry) = entries.get_mut(workspace_id) {
            entry.state = LifecycleState::Open;
            if entry.admissions == 0 {
                entries.remove(workspace_id);
            }
        }
    }
}

pub struct WorkspaceAdmission {
    lifecycle: Arc<WorkspaceLifecycle>,
    workspace_id: String,
}

impl Drop for WorkspaceAdmission {
    fn drop(&mut self) {
        self.lifecycle.release_admission(&self.workspace_id);
    }
}

pub struct WorkspaceArchiveLease {
    lifecycle: Arc<WorkspaceLifecycle>,
    workspace_id: String,
    finished: bool,
}

impl WorkspaceArchiveLease {
    pub fn finish(mut self, outcome: ArchiveOutcome) {
        self.lifecycle.finish_archive(&self.workspace_id, outcome);
        self.finished = true;
    }
}

impl Drop for WorkspaceArchiveLease {
    fn drop(&mut self) {
        if !self.finished {
            self.lifecycle
                .finish_archive(&self.workspace_id, ArchiveOutcome::Reopened);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_closes_new_admission_immediately() {
        let lifecycle = WorkspaceLifecycle::new();
        let lease = lifecycle.begin_archive("w1").expect("archive lease");
        let error = match lifecycle.admit("w1") {
            Ok(_) => panic!("admission must be blocked"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("archive is in progress"));
        lease.finish(ArchiveOutcome::Reopened);
        assert!(lifecycle.admit("w1").is_ok());
    }

    #[tokio::test]
    async fn archive_waits_for_an_in_flight_admission() {
        let lifecycle = WorkspaceLifecycle::new();
        let admission = lifecycle.admit("w1").expect("admission");
        let lease = lifecycle.begin_archive("w1").expect("archive lease");
        let wait = lifecycle.wait_for_admissions("w1", Duration::from_millis(20));
        assert!(!wait.await);
        drop(admission);
        assert!(
            lifecycle
                .wait_for_admissions("w1", Duration::from_millis(100))
                .await
        );
        lease.finish(ArchiveOutcome::Reopened);
    }

    #[test]
    fn failed_archive_keeps_admission_closed_until_reopened() {
        let lifecycle = WorkspaceLifecycle::new();
        let lease = lifecycle.begin_archive("w1").expect("archive lease");
        lease.finish(ArchiveOutcome::Failed);
        assert!(lifecycle.admit("w1").is_err());
        let retry = lifecycle.begin_archive("w1").expect("explicit retry");
        retry.finish(ArchiveOutcome::Reopened);
        assert!(lifecycle.admit("w1").is_ok());
    }
}
