use tauri::Manager;

/// Remove archive recovery checkouts older than `ARCHIVE_RECOVERY_EXPIRY`, once
/// a day. Services are read from state per tick, like the sync sweep, so the
/// loop holds no service alive and skips a tick the database never opened for.
pub(crate) async fn run(app: tauri::AppHandle) {
    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + argmax_store::database::PRUNE_STARTUP_DELAY,
        argmax_store::database::PRUNE_INTERVAL,
    );
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let Some(workspaces) = app
            .state::<crate::state::AppState>()
            .workspaces
            .get()
            .cloned()
        else {
            continue;
        };
        let archived_before =
            std::time::SystemTime::now() - super::orchestration::ARCHIVE_RECOVERY_EXPIRY;
        match tauri::async_runtime::spawn_blocking(move || {
            workspaces.expire_archive_recoveries(archived_before)
        })
        .await
        {
            Ok(removed) => tracing::info!(removed, "archive recovery expiry sweep finished"),
            Err(error) => tracing::warn!(?error, "archive recovery expiry task failed to join"),
        }
    }
}
