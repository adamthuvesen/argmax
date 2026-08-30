// Per-checkout fs watcher.
//
// Uses `notify::RecommendedWatcher` (recursive on macOS/Windows; falls
// back to non-recursive on Linux when the kernel can't service inotify
// recursively). Events feed into a tokio mpsc channel; an async task
// drains the channel and refreshes status with a 200 ms trailing-edge
// debounce — so a burst like `npm install` collapses into one refresh
// per quiet window rather than one per fs event.
//
// Watches are keyed by *canonical checkout path*, not by workspace id.
// Sessions created on the current checkout all share one directory, so a
// repo with 69 open workspaces used to mean 69 recursive watches over the
// same tree — on macOS each `RecommendedWatcher` is its own FSEvents
// stream and CFRunLoop thread, and each one independently shelled out to
// git on every event. Workspaces now subscribe to a shared watch, and one
// debounced refresh serves every subscriber from a single git read.
//
// The async task is single-threaded around the refresh by construction
// (each loop iteration awaits it before the next debounce window opens),
// so we don't need an explicit in-flight / pending state machine.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::async_runtime::JoinHandle;
use tokio::sync::mpsc;

use super::orchestration::{WorkspaceService, WATCH_DEBOUNCE_MS, WATCH_MAX_DEBOUNCE_MS};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::workspaces::find_workspace_by_id;
use crate::util::sync::LockOrRecover;
use crate::util::workspace_paths::normalize;

/// One OS-level watch over a checkout, shared by every workspace pointing at it.
struct CheckoutWatcher {
    /// Held to keep the OS-level watch alive. Dropped with the last subscriber.
    _watcher: RecommendedWatcher,
    /// Cancels the async refresh loop.
    task: JoinHandle<()>,
    subscribers: HashSet<String>,
}

impl Drop for CheckoutWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Workspace subscriptions multiplexed onto one watch per checkout path.
#[derive(Default)]
pub(super) struct WatcherRegistry {
    checkouts: HashMap<PathBuf, CheckoutWatcher>,
    /// Reverse index so unsubscribing is O(1) and survives a workspace's path
    /// changing between installs.
    subscriptions: HashMap<String, PathBuf>,
}

impl WatcherRegistry {
    /// Workspaces currently watched. Several may share one OS watch.
    pub(super) fn subscription_count(&self) -> usize {
        self.subscriptions.len()
    }

    /// Distinct OS-level watches — the number that costs FSEvents streams.
    pub(super) fn checkout_count(&self) -> usize {
        self.checkouts.len()
    }

    /// Drop a checkout whose refresh loop has stopped, along with every
    /// subscription pointing at it. Without this the dead entry keeps the fast
    /// path in `watch_impl` alive: a later workspace attaches to a watch whose
    /// refresh task is gone and silently stops receiving status updates.
    fn retire_checkout(&mut self, path: &Path) {
        let Some(checkout) = self.checkouts.remove(path) else {
            return;
        };
        for workspace_id in &checkout.subscribers {
            self.subscriptions.remove(workspace_id);
        }
    }

    fn subscribers(&self, path: &Path) -> Vec<String> {
        self.checkouts
            .get(path)
            .map(|checkout| checkout.subscribers.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Attach to an existing watch. Returns false when the path isn't watched
    /// yet and the caller must install one.
    fn subscribe(&mut self, workspace_id: &str, path: &Path) -> bool {
        let Some(checkout) = self.checkouts.get_mut(path) else {
            return false;
        };
        checkout.subscribers.insert(workspace_id.to_owned());
        self.subscriptions
            .insert(workspace_id.to_owned(), path.to_path_buf());
        true
    }

    fn install(&mut self, workspace_id: &str, path: PathBuf, watcher: CheckoutWatcher) {
        self.checkouts.insert(path.clone(), watcher);
        self.subscriptions.insert(workspace_id.to_owned(), path);
    }

    /// Drop a workspace's subscription, tearing down the OS watch once the last
    /// subscriber leaves.
    fn unsubscribe(&mut self, workspace_id: &str) {
        let Some(path) = self.subscriptions.remove(workspace_id) else {
            return;
        };
        let Some(checkout) = self.checkouts.get_mut(&path) else {
            return;
        };
        checkout.subscribers.remove(workspace_id);
        if checkout.subscribers.is_empty() {
            // Dropping the CheckoutWatcher aborts the refresh loop and drops the
            // RecommendedWatcher, which unregisters the OS-level watch.
            self.checkouts.remove(&path);
        }
    }
}

pub(super) fn watch(service: &Arc<WorkspaceService>, workspace_id: &str) -> ArgmaxResult<()> {
    // Installing a watcher is itself workspace-scoped admission. Archive can
    // begin while this runs, but it must wait for the install to finish and
    // then close the watcher before teardown continues.
    let _admission = service.lifecycle().admit(workspace_id)?;
    watch_impl(service, workspace_id)
}

/// Archive owns the lifecycle lease while restoring a watcher after a failed
/// or intentionally reopened archive. It has already decided that teardown
/// is not proceeding, so it may install the watcher before releasing that
/// lease; startup watchers are blocked by the public `watch` admission above.
pub(super) fn watch_during_archive(
    service: &Arc<WorkspaceService>,
    workspace_id: &str,
) -> ArgmaxResult<()> {
    watch_impl(service, workspace_id)
}

fn watch_impl(service: &Arc<WorkspaceService>, workspace_id: &str) -> ArgmaxResult<()> {
    // Drop any prior subscription for this id first, so re-watching after the
    // workspace's path changed can't leave it attached to the old checkout.
    close_watcher(service, workspace_id);

    let workspace = {
        let connection = service.database().connection();
        find_workspace_by_id(&connection, workspace_id)?
    };
    if !matches!(
        workspace.state.as_str(),
        "created"
            | "running"
            | "waiting"
            | "blocked"
            | "complete"
            | "failed"
            | "cancelled"
            | "kept"
            | "archiving"
            | "archive-failed"
    ) {
        return Err(ArgmaxError::service(
            "WORKSPACE_WATCH_UNAVAILABLE",
            format!(
                "Workspace {} is not open for filesystem watching.",
                workspace_id
            ),
        ));
    }

    // A gone checkout is not "recursive watches unavailable". Check first so
    // startup restore does not warn twice for a stale SQLite row.
    let workspace_path = Path::new(&workspace.path);
    if !workspace_path.is_dir() {
        return Err(ArgmaxError::service(
            "WATCHER_PATH_MISSING",
            format!("No directory at {}", workspace.path),
        ));
    }
    let watch_path = watch_key(workspace_path);

    // Fast path: another workspace already watches this checkout. Sharing the
    // stream is the whole point — no second FSEvents registration.
    {
        let mut registry = service.watchers.lock_or_recover("watchers");
        if registry.subscribe(workspace_id, &watch_path) {
            return Ok(());
        }
    }

    // A dirty bit is all the refresh loop needs.  A bounded channel keeps a
    // noisy build from turning file churn into unbounded memory growth.
    let (tx, rx) = mpsc::channel::<()>(1);
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            // Coalesce: we don't care about event details — any change is
            // a signal to recompute status. Drop the event if the receiver
            // is gone (close_watcher races).
            if let Ok(event) = result {
                if !is_status_relevant(&event) {
                    return;
                }
                let _ = tx.try_send(());
            }
        })
        .map_err(|e| ArgmaxError::service("WATCHER_INIT_FAILED", e.to_string()))?;

    if let Err(error) = watcher.watch(&watch_path, RecursiveMode::Recursive) {
        // Some platforms (older Linux kernels) reject recursive watches.
        // Fall back to non-recursive — root-only edits will still fire,
        // nested ones get missed.
        tracing::warn!(
            workspace_id,
            ?error,
            "recursive fs.watch unavailable; falling back to non-recursive"
        );
        watcher
            .watch(&watch_path, RecursiveMode::NonRecursive)
            .map_err(|e| ArgmaxError::service("WATCHER_WATCH_FAILED", e.to_string()))?;
    }

    let task = spawn_refresh_loop(Arc::downgrade(service), watch_path.clone(), rx);

    let mut registry = service.watchers.lock_or_recover("watchers");
    // A concurrent install for the same checkout may have won the race while we
    // were registering; prefer the existing stream and retire ours. Dropping a
    // JoinHandle only detaches it, so abort explicitly rather than leaving the
    // loop to notice its channel closed.
    if registry.subscribe(workspace_id, &watch_path) {
        task.abort();
        return Ok(());
    }
    registry.install(
        workspace_id,
        watch_path,
        CheckoutWatcher {
            _watcher: watcher,
            task,
            subscribers: HashSet::from([workspace_id.to_owned()]),
        },
    );
    Ok(())
}

pub(super) fn close_watcher(service: &WorkspaceService, workspace_id: &str) {
    service
        .watchers
        .lock_or_recover("watchers")
        .unsubscribe(workspace_id);
}

/// Key watches by the symlink-resolved path so two workspaces recorded with
/// different spellings of one checkout (`/tmp` vs `/private/tmp`, a trailing
/// slash, a `..` segment) still share a single stream.
fn watch_key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| normalize(path))
}

/// Filter events that can never change `git status` output.
///
/// Object and LFS writes churn heavily during commits and fetches, and the
/// short-lived `*.lock` files git writes around every ref or index update would
/// otherwise wake the debounce twice per operation. Ref and index changes are
/// deliberately *not* filtered — those move the branch and dirty state.
fn is_status_relevant(event: &notify::Event) -> bool {
    if event.paths.is_empty() {
        return true;
    }
    event.paths.iter().any(|path| !is_git_noise(path))
}

fn is_git_noise(path: &Path) -> bool {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".lock"))
    {
        return true;
    }
    let mut components = path.components().map(|component| component.as_os_str());
    while let Some(component) = components.next() {
        if component != ".git" {
            continue;
        }
        return matches!(
            components.next().and_then(|next| next.to_str()),
            Some("objects" | "lfs" | "fsmonitor--daemon")
        );
    }
    false
}

fn spawn_refresh_loop(
    service: Weak<WorkspaceService>,
    path: PathBuf,
    mut rx: mpsc::Receiver<()>,
) -> JoinHandle<()> {
    // If every subscribed workspace row is gone, this watch has no subject
    // left; bail out after a few consecutive empty refreshes so an orphaned
    // worktree can't keep the loop alive forever.
    const MAX_NOT_FOUND_BEFORE_EXIT: u32 = 3;
    // `watch()` also runs from sync IPC (`workspaces:create-current`) on the
    // macOS main thread, which has no Tokio context. `tokio::spawn` panics
    // there. Tauri's runtime is process-wide and matches boot restoration.
    tauri::async_runtime::spawn(async move {
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
            let first_event = Instant::now();
            let max_deadline = first_event + Duration::from_millis(WATCH_MAX_DEBOUNCE_MS);
            let mut deadline = first_event + Duration::from_millis(WATCH_DEBOUNCE_MS);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match tokio::time::timeout(remaining, rx.recv()).await {
                    Ok(Some(())) => {
                        // Another event during the window — reset the trailing
                        // edge, but never beyond the hard maximum.
                        deadline = (Instant::now() + Duration::from_millis(WATCH_DEBOUNCE_MS))
                            .min(max_deadline);
                    }
                    Ok(None) => return, // sender dropped
                    Err(_) => break,    // quiet window completed
                }
            }
            let Some(service) = service.upgrade() else {
                return;
            };
            // Read the subscriber set fresh each pass: workspaces attach and
            // detach while the watch stays up.
            let subscribers = service
                .watchers
                .lock_or_recover("watchers")
                .subscribers(&path);
            if subscribers.is_empty() {
                return;
            }
            // One git read serves every subscriber. Refreshes are best-effort —
            // ENOENT during teardown, transient git lock contention, and
            // removed-worktree races are all expected.
            if service.refresh_checkout(&path, &subscribers).await > 0 {
                not_found_streak = 0;
                continue;
            }
            not_found_streak += 1;
            if not_found_streak >= MAX_NOT_FOUND_BEFORE_EXIT {
                tracing::debug!(
                    path = %path.display(),
                    "watcher: no workspace rows left for checkout; stopping refresh loop"
                );
                service
                    .watchers
                    .lock_or_recover("watchers")
                    .retire_checkout(&path);
                return;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_object_and_lock_churn_is_filtered() {
        assert!(is_git_noise(Path::new("/repo/.git/objects/ab/cdef")));
        assert!(is_git_noise(Path::new("/repo/.git/lfs/tmp/x")));
        assert!(is_git_noise(Path::new("/repo/.git/index.lock")));
        assert!(is_git_noise(Path::new("/repo/.git/refs/heads/main.lock")));
    }

    #[test]
    fn tracked_and_ref_changes_are_not_filtered() {
        assert!(!is_git_noise(Path::new("/repo/src/main.rs")));
        assert!(!is_git_noise(Path::new("/repo/.git/index")));
        assert!(!is_git_noise(Path::new("/repo/.git/HEAD")));
        assert!(!is_git_noise(Path::new("/repo/.git/refs/heads/main")));
        // A source directory merely named `objects` is not git internals.
        assert!(!is_git_noise(Path::new("/repo/objects/thing.rs")));
    }

    #[test]
    fn an_event_touching_any_real_file_survives_the_filter() {
        let event = notify::Event {
            paths: vec![
                PathBuf::from("/repo/.git/objects/ab/cdef"),
                PathBuf::from("/repo/src/main.rs"),
            ],
            ..notify::Event::new(notify::EventKind::Any)
        };
        assert!(is_status_relevant(&event));
    }

    #[test]
    fn a_pure_git_object_event_is_dropped() {
        let event = notify::Event {
            paths: vec![PathBuf::from("/repo/.git/objects/ab/cdef")],
            ..notify::Event::new(notify::EventKind::Any)
        };
        assert!(!is_status_relevant(&event));
    }
}
