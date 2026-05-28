// Argmax library crate. Scaffolding only at this point — services are
// wired in later sections of the port (see openspec/changes/port-to-rust-tauri).

pub mod approvals;
pub mod attachments;
pub mod checks;
pub mod error;
pub mod files;
pub mod gh;
pub mod git;
pub mod ide;
pub mod ipc;
pub mod mcp;
pub mod memory;
pub mod persistence;
pub mod providers;
pub mod review;
pub mod sessions;
pub mod skills;
pub mod state;
pub mod terminal;
pub mod util;
pub mod workspaces;

use specta_typescript::{BigIntExportBehavior, Typescript};
use util::startup_timer::StartupTimer;

/// Construct and run the Tauri app. Real service wiring lands in sections
/// 3+ of the port. For now this is a window-only shell that proves the
/// scaffolding compiles, links, and launches.
pub fn run() {
    let timer = StartupTimer::new();
    timer.mark("boot");

    let specta_builder = ipc::specta_builder::<tauri::Wry>();

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
        .plugin(tauri_plugin_shell::init())
        .manage(state::AppState::new())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            // Tracing init is deferred to setup() because `app.path()` is
            // only valid here — that's how we resolve the user_data_dir
            // the release-mode rolling-file appender writes into.
            let user_data = tauri::Manager::path(app).app_data_dir().ok();
            if let Err(e) = util::tracing_init::init(user_data.as_deref()) {
                eprintln!("argmax: tracing init failed: {e}");
            }
            tracing::info!(boot_ms = timer.boot_to_now_ms() as u64, "tracing online");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

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

        let builder = ipc::specta_builder::<tauri::Wry>();
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
