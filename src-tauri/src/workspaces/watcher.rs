// Per-workspace fs watcher.
//
// Uses `notify::RecommendedWatcher` (recursive on macOS/Windows; falls
// back to non-recursive on Linux when the kernel can't service inotify
// recursively). Events feed into a tokio mpsc channel; an async task
// drains the channel and runs `refresh_status` with a 200 ms trailing-
// edge debounce — so a burst like `npm install` collapses into one
// refresh per quiet window rather than one per fs event.
//
// The async task is single-threaded around `refresh_status` by
// construction (each loop iteration awaits the refresh before the next
// debounce window opens), so we don't need an explicit in-flight /
// pending state machine like the TS version.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::orchestration::{WorkspaceService, WATCH_DEBOUNCE_MS};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::workspaces::find_workspace_by_id;
use crate::util::sync::LockOrRecover;

pub(super) struct WatcherEntry {
    /// Held to keep the OS-level watch alive. Dropped on `close_watcher`.
    _watcher: RecommendedWatcher,
    /// Cancels the async refresh loop. Dropped on `close_watcher`.
    task: JoinHandle<()>,
}

impl Drop for WatcherEntry {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(super) fn watch(service: &Arc<WorkspaceService>, workspace_id: &str) -> ArgmaxResult<()> {
    // Replace any prior watcher for this id so a stale RecommendedWatcher
    // can't outlive its replacement and keep kernel watches alive until
    // process exit.
    close_watcher(service, workspace_id);

    let workspace = {
        let connection = service.database().connection();
        find_workspace_by_id(&connection, workspace_id)?
    };

    let (tx, rx) = mpsc::unbounded_channel::<()>();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            // Coalesce: we don't care about event details — any change is
            // a signal to recompute status. Drop the event if the receiver
            // is gone (close_watcher races).
            if result.is_ok() {
                let _ = tx.send(());
            }
        })
        .map_err(|e| ArgmaxError::service("WATCHER_INIT_FAILED", e.to_string()))?;

    if let Err(error) = watcher.watch(Path::new(&workspace.path), RecursiveMode::Recursive) {
        // Some platforms (older Linux kernels) reject recursive watches.
        // Fall back to non-recursive — root-only edits will still fire,
        // nested ones get missed.
        tracing::warn!(
            workspace_id,
            ?error,
            "recursive fs.watch unavailable; falling back to non-recursive"
        );
        watcher
            .watch(Path::new(&workspace.path), RecursiveMode::NonRecursive)
            .map_err(|e| ArgmaxError::service("WATCHER_WATCH_FAILED", e.to_string()))?;
    }

    let task = spawn_refresh_loop(Arc::clone(service), workspace_id.to_string(), rx);

    let mut watchers = service.watchers.lock_or_recover("watchers");
    watchers.insert(
        workspace_id.to_string(),
        WatcherEntry {
            _watcher: watcher,
            task,
        },
    );
    Ok(())
}

pub(super) fn close_watcher(service: &WorkspaceService, workspace_id: &str) {
    // Dropping the WatcherEntry aborts the task and drops the
    // RecommendedWatcher, which unregisters the OS-level watch.
    let _ = service
        .watchers
        .lock_or_recover("watchers")
        .remove(workspace_id);
}

fn spawn_refresh_loop(
    service: Arc<WorkspaceService>,
    workspace_id: String,
    mut rx: mpsc::UnboundedReceiver<()>,
) -> JoinHandle<()> {
    // If the workspace row is gone, this watcher has no subject left; bail out
    // after a few consecutive not-found refreshes so an orphaned worktree can't
    // keep the loop alive forever.
    const MAX_NOT_FOUND_BEFORE_EXIT: u32 = 3;
    tokio::spawn(async move {
        let mut not_found_streak: u32 = 0;
        loop {
            // Wait for the first event. `None` means the sender was
            // dropped (watcher closed) — exit the loop.
            if rx.recv().await.is_none() {
                return;
            }
            // Trailing-edge debounce: keep extending the window as long
            // as new events arrive within `WATCH_DEBOUNCE_MS`. Once the
            // quiet window completes, fire one refresh.
            let mut deadline = Instant::now() + Duration::from_millis(WATCH_DEBOUNCE_MS);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match tokio::time::timeout(remaining, rx.recv()).await {
                    Ok(Some(())) => {
                        // Another event during the window — reset deadline.
                        deadline = Instant::now() + Duration::from_millis(WATCH_DEBOUNCE_MS);
                    }
                    Ok(None) => return, // sender dropped
                    Err(_) => break,    // quiet window completed
                }
            }
            // refresh_status is best-effort — ENOENT during teardown,
            // transient git lock contention, or removed-worktree races are
            // expected. Distinguish "workspace row gone" (terminal) from
            // transient failures (keep going) instead of swallowing everything.
            match service.refresh_status(&workspace_id).await {
                Ok(_) => not_found_streak = 0,
                Err(ArgmaxError::RecordNotFound { .. }) => {
                    not_found_streak += 1;
                    if not_found_streak >= MAX_NOT_FOUND_BEFORE_EXIT {
                        tracing::debug!(
                            %workspace_id,
                            "watcher: workspace row gone; stopping refresh loop"
                        );
                        return;
                    }
                }
                Err(error) => {
                    not_found_streak = 0;
                    tracing::debug!(%workspace_id, ?error, "watcher: refresh_status failed");
                }
            }
        }
    })
}
