use std::sync::Arc;

use super::super::{
    argmax_protocol_error, invalid_input_error,
    protocol::{
        RenameAction, SessionControlError, SessionControlResponse, SessionControlResult,
        SessionRenamed,
    },
    protocol_error,
    registry::ParentLaunchSettings,
};
use super::task_label;
use crate::{
    ipc::{
        inputs::WorkspacesSetLabelInput,
        validation::{TaskLabel, WorkspaceId},
    },
    persistence::{
        database::Database, sessions::find_session_by_id, workspaces::find_workspace_by_id,
    },
    workspaces::WorkspaceService,
};

pub(super) fn rename_session(
    action: RenameAction,
    parent: ParentLaunchSettings,
    database: Arc<Database>,
    workspaces: Arc<WorkspaceService>,
) -> Result<SessionControlResponse, SessionControlError> {
    let (workspace_id, previous_task_label) = {
        let connection = database.read_connection();
        let session =
            find_session_by_id(&connection, &parent.session_id).map_err(argmax_protocol_error)?;
        let workspace = find_workspace_by_id(&connection, &session.workspace_id)
            .map_err(argmax_protocol_error)?;
        (
            WorkspaceId::try_from(session.workspace_id.clone()).map_err(invalid_input_error)?,
            workspace.task_label.clone(),
        )
    };
    let label = task_label(&action.task_label);
    let task_label = TaskLabel::try_from(label).map_err(invalid_input_error)?;
    let workspace = workspaces
        .set_label(WorkspacesSetLabelInput {
            workspace_id,
            task_label,
        })
        .map_err(|error| protocol_error("RENAME_FAILED", error.to_string()))?;
    Ok(SessionControlResponse::new(SessionControlResult::Renamed(
        SessionRenamed {
            session_id: parent.session_id,
            workspace_id: workspace.id,
            task_label: workspace.task_label,
            previous_task_label,
        },
    )))
}
