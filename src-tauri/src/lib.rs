// Argmax library crate. The Rust/Tauri runtime is being filled in section by
// section under openspec/changes/port-to-rust-tauri.

use std::sync::Arc;

use tauri::Manager;

pub mod approvals;
pub mod attachments;
pub mod checks;
pub mod dock;
pub mod error;
pub mod files;
pub mod gh;
pub mod git;
pub mod ide;
pub mod ipc;
pub mod mcp;
pub mod memory;
pub mod menu;
pub mod notifications;
pub mod persistence;
pub mod providers;
pub mod review;
pub mod sessions;
pub mod skills;
pub mod state;
pub mod terminal;
pub mod updater;
pub mod util;
pub mod workspaces;

#[cfg(any(debug_assertions, test))]
use specta_typescript::{BigIntExportBehavior, Typescript};
use util::startup_timer::StartupTimer;

/// Construct and run the Tauri app.
pub fn run() {
    let timer = Arc::new(StartupTimer::new());
    timer.mark("boot");

    let specta_builder = ipc::specta_builder();

    // Codegen: emit `src/shared/bindings.d.ts` on every debug startup so
    // the renderer's TS surface stays in lockstep with the Rust command
    // surface. `build.rs` cannot do this (build scripts run before the
    // rest of the crate is even type-checked, so they can't import
    // command functions), so the export lives here instead.
    #[cfg(debug_assertions)]
    if let Err(e) = specta_builder.export(specta_typescript(), "../src/shared/bindings.d.ts") {
        eprintln!("argmax: tauri-specta export failed: {e}");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state::AppState::with_startup_timer(timer.clone()))
        .invoke_handler(specta_builder.invoke_handler())
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .on_window_event(dock::clear_badge_on_focus)
        .setup(move |app| {
            // Tracing init is deferred to setup() because `app.path()` is
            // only valid here — that's how we resolve the user_data_dir
            // the release-mode rolling-file appender writes into.
            let user_data = tauri::Manager::path(app).app_data_dir().ok();
            if let Err(e) = util::tracing_init::init(user_data.as_deref()) {
                eprintln!("argmax: tracing init failed: {e}");
            }
            if let Some(user_data) = user_data.as_ref() {
                let data_dir = user_data.join("local-state");
                if let Err(e) = std::fs::create_dir_all(&data_dir) {
                    tracing::warn!(error = ?e, path = %data_dir.display(), "failed to create data directory");
                } else {
                    match persistence::Database::open(data_dir.join("argmax.sqlite")) {
                        Ok(database) => {
                            let state = tauri::Manager::state::<state::AppState>(app);
                            if state.db.set(Arc::new(database)).is_err() {
                                tracing::warn!("database state was already initialized");
                            }
                            state.startup_timer.mark("db.open");
                        }
                        Err(e) => tracing::warn!(error = ?e, "failed to open database"),
                    }
                }
            }
            timer.mark("services.construct");
            if let Err(e) = menu::install_app_menu(app.handle(), cfg!(debug_assertions)) {
                tracing::warn!(error = ?e, "failed to install app menu");
            }
            timer.mark("ipc.register");
            if app.get_webview_window("main").is_some() {
                timer.mark("window.create");
            }
            tracing::info!(boot_ms = timer.boot_to_now_ms() as u64, "tracing online");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(any(debug_assertions, test))]
fn specta_typescript() -> Typescript {
    Typescript::default().bigint(BigIntExportBehavior::Number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// Exercises the tauri-specta export pipeline end-to-end without
    /// launching the app. This is the CI guard for "the codegen wiring
    /// actually emits TypeScript", paired with `npm run check:bindings`
    /// which guards "the committed bindings.d.ts is at least as new as
    /// every backend input".
    #[test]
    fn specta_export_emits_command_surface() {
        let dir = tempdir().expect("tempdir");
        let out = dir.path().join("bindings.d.ts");

        let builder = ipc::specta_builder();
        builder
            .export(specta_typescript(), &out)
            .expect("specta export ok");

        let contents = fs::read_to_string(&out).expect("read generated bindings");
        assert!(
            contents.contains("health_ping") || contents.contains("healthPing"),
            "expected command surface in bindings:\n{contents}",
        );
    }
}
