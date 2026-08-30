use tauri::State;

use super::inputs::*;
use super::live_database;
use crate::error::ArgmaxResult;
use crate::persistence::dashboard::{list_dashboard, DashboardListSnapshot};
use crate::state::AppState;

#[tauri::command(rename = "dashboard:list")]
#[specta::specta]
pub fn dashboard_list(
    state: State<'_, AppState>,
    _input: DashboardListInput,
) -> ArgmaxResult<DashboardListSnapshot> {
    dashboard_list_impl(&state)
}

pub(crate) fn dashboard_list_impl(state: &AppState) -> ArgmaxResult<DashboardListSnapshot> {
    let database = live_database(state)?;
    let connection = database.connection();
    list_dashboard(&connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::Database;
    use std::sync::Arc;

    #[test]
    fn dashboard_list_reads_empty_live_database() {
        let state = state_with_database(Database::open_in_memory().expect("open database"));

        let snapshot = dashboard_list_impl(&state).expect("dashboard list");

        assert!(snapshot.projects.is_empty());
        assert!(snapshot.workspaces.is_empty());
        assert!(snapshot.sessions.is_empty());
        assert!(snapshot.checks.is_empty());
    }

    /// A migration abort is the common reason the database never opens, and the
    /// text it carries is the only thing that tells the user what to fix.
    #[test]
    fn dashboard_list_reports_why_the_database_never_opened() {
        let state = AppState::new();
        assert!(state
            .db_open_error
            .set("Migration v18 (synced_sessions) checksum drift: stored=abc expected=def".into())
            .is_ok());

        let error = dashboard_list_impl(&state).expect_err("no database means no snapshot");

        assert!(
            error.to_string().contains("checksum drift"),
            "the abort reason must survive to the renderer, got: {error}"
        );
    }

    #[test]
    fn dashboard_list_says_boot_is_in_flight_when_nothing_failed() {
        let error =
            dashboard_list_impl(&AppState::new()).expect_err("no database means no snapshot");

        assert!(error
            .to_string()
            .contains("startup may still be in progress"));
    }

    fn state_with_database(database: Database) -> AppState {
        let state = AppState::new();
        assert!(state.db.set(Arc::new(database)).is_ok());
        state
    }
}
