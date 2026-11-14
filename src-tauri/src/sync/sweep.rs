use std::sync::Arc;

use argmax_store::sync::LockOrRecover;
use tauri::Manager;

/// How often the provider transcript stores are re-scanned. Slow on purpose:
/// an import is a convenience, and a sweep stats every transcript file.
const SYNC_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Poll for sessions started outside Argmax. The first sweep is also the
/// catch-up for everything that happened while the app was closed.
pub(crate) async fn run(app: tauri::AppHandle) {
    let Ok(app_data_dir) = crate::util::data_dir::app_data_dir(&app) else {
        tracing::warn!("session sync disabled: no app data dir");
        return;
    };
    let mut interval = tokio::time::interval(SYNC_SWEEP_INTERVAL);
    // A sweep that overran its tick must not be followed by a burst of
    // catch-up sweeps: they would all scan the same unchanged files.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let config = crate::sync::load_or_create_config(&app_data_dir);
        // Clone the handles out and drop the `State` borrow before awaiting.
        let (database, workspaces, sweep_lock) = {
            let state = app.state::<crate::state::AppState>();
            let (Some(database), Some(workspaces)) = (state.db.get(), state.workspaces.get())
            else {
                continue;
            };
            (
                Arc::clone(database),
                Arc::clone(workspaces),
                Arc::clone(&state.sync_sweep),
            )
        };
        // The sweep stats every transcript file under the provider store and
        // writes SQLite, so it belongs on the blocking pool, not on a worker.
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let _serialized = sweep_lock.lock_or_recover("sync sweep");
            crate::sync::run_sync(
                &database,
                &workspaces,
                &config,
                &crate::sync::home_dir(),
                crate::sync::now_ms(),
            )
        })
        .await;
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                tracing::warn!(?error, "session sync sweep task failed to join");
                continue;
            }
        };
        let report = match outcome {
            Ok(outcome) => {
                if outcome.imported > 0 || outcome.pruned > 0 || outcome.extended > 0 {
                    tracing::info!(
                        imported = outcome.imported,
                        extended = outcome.extended,
                        pruned = outcome.pruned,
                        "session sync sweep"
                    );
                }
                crate::sync::SyncReport::ok(outcome)
            }
            Err(error) => {
                tracing::warn!(?error, "session sync sweep failed");
                crate::sync::SyncReport::failed(error.to_string())
            }
        };
        *app.state::<crate::state::AppState>()
            .sync_report
            .lock_or_recover("sync report") = Some(report);
    }
}
