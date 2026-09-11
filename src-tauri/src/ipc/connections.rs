use std::path::PathBuf;

use tauri::State;

use super::{inputs::ConnectionsListInput, live_database};
use crate::{
    connections::{list_connections, ConnectionSummary},
    error::ArgmaxResult,
    persistence::workspaces::find_workspace_by_id,
    state::AppState,
};

#[tauri::command(rename = "connections:list")]
#[specta::specta]
pub async fn connections_list(
    state: State<'_, AppState>,
    input: ConnectionsListInput,
) -> ArgmaxResult<Vec<ConnectionSummary>> {
    connections_list_impl(&state, input).await
}

pub(crate) async fn connections_list_impl(
    state: &AppState,
    input: ConnectionsListInput,
) -> ArgmaxResult<Vec<ConnectionSummary>> {
    let workspace_path: Option<PathBuf> = match input.workspace_id {
        Some(workspace_id) => {
            let database = live_database(state)?;
            let connection = database.read_connection();
            let workspace = find_workspace_by_id(&connection, workspace_id.as_str())?;
            Some(PathBuf::from(workspace.path))
        }
        None => None,
    };
    let provider = state.provider_discovery.discover(input.provider).await;
    Ok(list_connections(
        input.provider,
        provider.binary_path.as_deref(),
        workspace_path.as_deref(),
    )
    .await)
}
