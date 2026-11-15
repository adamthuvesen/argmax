//! The SQLite store: migrations and every query. It depends only on contracts
//! and on the process crate for read-only git probes, so the compiler rejects an
//! import from a service above it. See docs/architecture.md#layers.

pub mod activity;
pub mod after_turn;
pub mod app_settings;
pub mod approvals;
pub mod arc_events;
pub mod arcs;
pub mod authorship;
pub mod chat_cleanup;
pub mod checkpoints;
pub mod checks;
pub mod continuity;
pub mod dashboard;
pub mod database;
pub mod diagnostics;
pub mod events;
pub mod follow_up_suggestions;
pub mod gh;
pub mod goals;
mod heredoc_activity;
pub mod launch_receipts;
pub mod learnings;
pub mod linked_repos;
pub mod migrations;
pub mod pending_messages;
pub mod pr_watches;
pub mod project_checks;
pub mod project_folders;
pub mod project_overviews;
pub mod project_sources;
pub mod projects;
pub mod remote_operations;
pub mod routines;
pub mod session_messages;
pub mod sessions;
pub mod sync;
pub mod synced;
pub mod time;
pub mod timeline_semantics;
pub mod tool_activity;
pub mod turn_routes;
pub mod turn_waterfalls;
pub mod usage;
pub mod usage_scan;
pub mod workspaces;

use std::path::PathBuf;

pub use database::Database;

/// Worktrees live outside source checkouts. Scratch profiles keep their own
/// root so verification does not leave checkouts in the user's worktree store.
pub fn worktree_root() -> argmax_contracts::error::ArgmaxResult<PathBuf> {
    if let Ok(raw) = std::env::var("ARGMAX_DATA_DIR") {
        if !raw.trim().is_empty() {
            let dir = PathBuf::from(raw);
            let dir = if dir.is_absolute() {
                dir
            } else {
                std::env::current_dir()
                    .map_err(|error| {
                        argmax_contracts::error::ArgmaxError::service(
                            "WORKTREE_LOCATION",
                            error.to_string(),
                        )
                    })?
                    .join(dir)
            };
            return Ok(dir.join("local-state").join("worktrees"));
        }
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            argmax_contracts::error::ArgmaxError::service(
                "WORKTREE_LOCATION",
                "An absolute HOME directory is required for worktree storage",
            )
        })?;
    Ok(home.join(".argmax").join("worktrees"))
}

pub fn sqlite_error(error: rusqlite::Error) -> argmax_contracts::error::ArgmaxError {
    argmax_contracts::error::ArgmaxError::service("SQLITE", error.to_string())
}

pub fn json_error(error: serde_json::Error) -> argmax_contracts::error::ArgmaxError {
    argmax_contracts::error::ArgmaxError::service("JSON", error.to_string())
}

/// Map a bool to SQLite's 0/1 integer representation.
pub(crate) fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod repository_tests;
