pub mod approvals;
pub mod checks;
pub mod dashboard;
pub mod database;
pub mod events;
pub mod gh;
pub mod learnings;
pub mod migrations;
pub mod projects;
pub mod routines;
pub mod session_messages;
pub mod sessions;
pub mod synced;
pub mod time;
pub mod usage;
pub mod usage_scan;
pub mod workspaces;

pub use database::Database;

pub(crate) fn sqlite_error(error: rusqlite::Error) -> crate::error::ArgmaxError {
    crate::error::ArgmaxError::service("SQLITE", error.to_string())
}

pub(crate) fn json_error(error: serde_json::Error) -> crate::error::ArgmaxError {
    crate::error::ArgmaxError::service("JSON", error.to_string())
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
