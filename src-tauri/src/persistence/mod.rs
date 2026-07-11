pub mod approvals;
pub mod checks;
pub mod dashboard;
pub mod database;
pub mod events;
pub mod gh;
pub mod learnings;
pub mod migrations;
pub mod projects;
pub mod sessions;
pub mod time;
pub mod usage;
pub mod workspaces;

pub use database::Database;

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
