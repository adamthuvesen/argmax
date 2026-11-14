//! What a turn is watched for: its PR branch, measured diffs, and subagent traces.

use super::*;

impl ProviderSessionService {
    /// Mark the worktree where this turn starts, so a provider that reports a
    /// file write without saying what changed can still get a line stat. Off
    /// the send path: the mark costs a few hundred milliseconds on a large
    /// repo, while the agent's first write is a model round-trip away.
    pub(super) fn mark_turn_start(&self, session_id: &str, workspace_path: PathBuf) {
        self.capture_pr_branch(session_id);
        let mark = self.measured_diffs.open_turn(session_id, workspace_path);
        tauri::async_runtime::spawn(capture_opening_mark(mark));
    }

    // Watcher delivery can lag behind the last checkout command of a turn.
    // Reading symbolic HEAD is small local I/O and also handles linked worktrees.
    pub(super) fn capture_pr_branch(&self, session_id: &str) {
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
            argmax_store::sessions::record_session_pr_branch(&connection, session_id, &branch)
        })();
        if let Err(error) = result {
            tracing::warn!(%session_id, %error, "could not capture session PR branch");
        }
    }

    /// When a tool's stdout contains a GitHub PR URL (typically `gh pr create`),
    /// cache that PR immediately. The poller only views `workspace.branch` in
    /// `workspace.path`, so a PR opened from another worktree would otherwise
    /// never appear on the sidebar.
    pub(super) fn schedule_observed_prs(
        self: &Arc<Self>,
        session_id: &str,
        delta: &DashboardDelta,
    ) {
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
                argmax_store::workspaces::workspaces_for_pr_refresh(&connection, &session_id)
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
    pub(super) fn schedule_measured_diffs(
        self: &Arc<Self>,
        session_id: &str,
        delta: &DashboardDelta,
    ) {
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

    pub(super) fn rewrite_event_with_measured_diffs(
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

    pub(crate) fn reconcile_subagent_traces(&self, session_id: &str) -> ArgmaxResult<usize> {
        let written = reconcile_session_subagent_traces(&self.database, session_id)?;
        if written > 0 {
            self.publish(DashboardDelta {
                changed_session_ids: vec![session_id.to_string()],
                ..DashboardDelta::default()
            });
        }
        Ok(written)
    }

    pub(crate) fn schedule_subagent_trace_reconciliation(&self, session_id: &str) {
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
        let publish_delta = Arc::clone(&self.publish_delta);
        let in_flight = Arc::clone(&self.subagent_reconciliations);
        tauri::async_runtime::spawn_blocking(move || loop {
            match reconcile_session_subagent_traces(&database, &session_id) {
                Ok(written) if written > 0 => publish_delta(DashboardDelta {
                    changed_session_ids: vec![session_id.clone()],
                    ..DashboardDelta::default()
                }),
                Ok(_) => {}
                Err(error) => tracing::warn!(
                    error = %error,
                    session_id,
                    "failed to reconcile live subagent trace events"
                ),
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

    pub(super) fn append_reconciled_subagent_events(
        &self,
        session_id: &str,
        delta: &mut DashboardDelta,
    ) {
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
