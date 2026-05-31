use tauri::State;

use super::inputs::*;
use super::live_database;
use crate::error::ArgmaxResult;
use crate::persistence::dashboard::{
    list_dashboard, load_dashboard, DashboardListSnapshot, DashboardSnapshot,
};
use crate::state::AppState;

#[tauri::command(rename = "dashboard:list")]
#[specta::specta]
pub fn dashboard_list(
    state: State<'_, AppState>,
    _input: DashboardListInput,
) -> ArgmaxResult<DashboardListSnapshot> {
    read_dashboard_list(&state)
}

#[tauri::command(rename = "dashboard:load")]
#[specta::specta]
pub fn dashboard_load(
    state: State<'_, AppState>,
    _input: DashboardLoadInput,
) -> ArgmaxResult<DashboardSnapshot> {
    read_dashboard(&state)
}

fn read_dashboard_list(state: &AppState) -> ArgmaxResult<DashboardListSnapshot> {
    let database = live_database(state)?;
    let connection = database.connection();
    list_dashboard(&connection)
}

fn read_dashboard(state: &AppState) -> ArgmaxResult<DashboardSnapshot> {
    let database = live_database(state)?;
    let connection = database.connection();
    load_dashboard(&connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ArgmaxError;
    use crate::persistence::Database;
    use std::sync::Arc;

    #[test]
    fn dashboard_list_reads_empty_live_database() {
        let state = state_with_database(Database::open_in_memory().expect("open database"));

        let snapshot = read_dashboard_list(&state).expect("dashboard list");

        assert!(snapshot.projects.is_empty());
        assert!(snapshot.workspaces.is_empty());
        assert!(snapshot.sessions.is_empty());
        assert!(snapshot.checks.is_empty());
        assert!(snapshot.checkpoints.is_empty());
    }

    #[test]
    fn dashboard_load_requires_initialized_database() {
        let error = read_dashboard(&AppState::new()).expect_err("missing database");

        assert!(
            matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "DATABASE_NOT_READY")
        );
    }

    fn state_with_database(database: Database) -> AppState {
        let state = AppState::new();
        assert!(state.db.set(Arc::new(database)).is_ok());
        state
    }
}
