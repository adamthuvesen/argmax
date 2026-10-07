use std::sync::Arc;

use tauri_specta::{collect_commands, Builder as SpectaBuilder};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::Database;
use crate::state::AppState;

pub mod events;
pub mod inputs;
pub mod validation;

pub mod activity;
pub mod approvals;
pub mod arcs;
pub mod attachments;
pub mod browser;
pub mod browser_import;
pub mod checkpoints;
pub mod checks;
pub mod cloud;
pub mod connections;
pub mod dashboard;
pub mod git_ops;
pub mod goals;
pub mod health;
pub mod learnings;
pub mod linked_repos;
pub mod projects;
pub mod providers;
pub mod prs;
pub mod questions;
pub mod remote;
pub mod review;
pub mod routines;
pub mod session;
pub mod settings;
pub mod skills;
pub mod sources;
pub mod sync;
pub mod system;
pub mod terminal;
pub mod usage;
pub mod visualizations;
pub mod window_snapshot;
pub mod windows;
pub mod workspace_files;
pub mod workspaces;

/// Proof that the text came from the person's own composer over IPC (the
/// desktop webview or the paired remote device). Only `crate::ipc` can build
/// one, and only the handlers that take fresh person input do.
pub struct PersonAttestation(());

pub(in crate::ipc) fn attest_person() -> PersonAttestation {
    PersonAttestation(())
}

/// For tests that stand in for a person IPC call. Production code must not
/// call this: `ipc::tests::person_attestation_is_minted_only_by_the_person_handlers`
/// scans the source for every call site.
#[doc(hidden)]
pub fn attest_person_for_tests() -> PersonAttestation {
    PersonAttestation(())
}

pub mod catalogue;
pub use catalogue::{specta_builder, REGISTERED_CHANNELS};

/// Run a blocking database read off the macOS main thread.
///
/// Tauri resolves a sync `#[tauri::command]` body inline on the main thread, so
/// a 24 ms dashboard read is 24 ms the window cannot draw or handle input. The
/// `async` flag is not the fix — it is `tokio::spawn`, which parks a shared
/// worker that provider IO and the `dashboard:delta` emit loop also need.
/// `spawn_blocking` uses the pool sized for exactly this.
pub(crate) async fn read_off_main<T, F>(read: F) -> ArgmaxResult<T>
where
    F: FnOnce() -> ArgmaxResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(read)
        .await
        .map_err(|error| ArgmaxError::service("DATABASE_READ_JOIN", error.to_string()))?
}

pub(crate) fn live_database(state: &AppState) -> ArgmaxResult<Arc<Database>> {
    state.db.get().cloned().ok_or_else(|| {
        // A recorded open failure is the whole story; without one, boot is
        // simply still in flight.
        match state.db_open_error.get() {
            Some(reason) => ArgmaxError::service("DATABASE_NOT_READY", reason),
            None => ArgmaxError::service(
                "DATABASE_NOT_READY",
                "database is not initialized (startup may still be in progress)",
            ),
        }
    })
}

/// Tell subscribers to reload the dashboard snapshot after an Arc changes.
/// Missing provider service is a no-op: boot has not finished installing
/// publishers yet, and the next `dashboard:list` will see the change anyway.
pub(crate) fn publish_dashboard_changed(state: &AppState) {
    if let Some(providers) = state.providers.get() {
        providers.publish_dashboard_changed();
    }
}

/// Push affected PR workspace summaries as soon as `gh_pr` changes. Missing workspace service
/// is a no-op: boot has not finished installing publishers yet.
pub(crate) fn publish_pr_workspaces_for_session(
    state: &AppState,
    session_id: &str,
) -> ArgmaxResult<()> {
    let Some(workspaces) = state.workspaces.get().cloned() else {
        return Ok(());
    };
    let affected = {
        let database = live_database(state)?;
        let conn = database.connection();
        crate::gh::workspaces_for_pr_refresh(&conn, session_id)?
    };
    workspaces.publish_workspaces(affected);
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The person mark is the only thing that makes a chat reference a read
    /// grant, so who can mint it is an invariant, not a convention. Only the
    /// handlers that take fresh text from the person's own composer do.
    #[test]
    fn person_attestation_is_minted_only_by_the_person_handlers() {
        fn rust_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    rust_files(&path, out);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    out.push(path);
                }
            }
        }
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        let mut mints: Vec<(String, usize)> = Vec::new();
        let mut test_minters: Vec<String> = Vec::new();
        for file in files {
            let relative = file
                .strip_prefix(&src)
                .unwrap()
                .to_string_lossy()
                .to_string();
            let text = std::fs::read_to_string(&file).unwrap();
            if relative == "ipc/mod.rs" {
                continue;
            }
            // The test minter appears only inside unit-test code.
            if text.contains("attest_person_for_tests") {
                test_minters.push(relative.clone());
            }
            let count = text.matches("attest_person()").count();
            if count > 0 {
                mints.push((relative, count));
            }
        }
        mints.sort();
        test_minters.sort();
        assert_eq!(
            test_minters,
            vec![
                "providers/session_service.rs".to_string(),
                "providers/session_service_steering_tests.rs".to_string(),
            ],
            "the test minter may be used only by the unit tests of the provider service"
        );
        assert_eq!(
            mints,
            vec![
                ("ipc/providers.rs".to_string(), 3),
                ("ipc/session.rs".to_string(), 1),
            ],
            "launch, send-input, steer-input and a typed multitask prompt are the only person calls"
        );
    }
}
