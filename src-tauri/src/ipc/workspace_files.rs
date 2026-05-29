use tauri::State;

use super::{inputs::*, live_database};
use crate::{
    error::ArgmaxResult,
    files::git_grep_parser::WorkspaceContentSearchResult,
    files::workspace_files::{
        WorkspaceFileEntry, WorkspaceFilePreview, WorkspaceFileStat, WorkspaceFileWriteResult,
        WorkspaceFilesService,
    },
    persistence::dashboard::{list_workspace_status, WorkspaceStatusSnapshot},
    state::AppState,
};

#[tauri::command(rename = "workspace:status")]
#[specta::specta]
pub fn workspace_status(
    state: State<'_, AppState>,
    input: WorkspaceStatusInput,
) -> ArgmaxResult<WorkspaceStatusSnapshot> {
    let database = live_database(&state)?;
    let connection = database.connection();
    let workspace_ids = input.workspace_ids.map(|ids| {
        ids.into_iter()
            .map(|workspace_id| workspace_id.into_string())
            .collect::<Vec<_>>()
    });
    list_workspace_status(&connection, workspace_ids.as_deref())
}

#[tauri::command(rename = "workspace:list-files")]
#[specta::specta]
pub async fn workspace_list_files(
    state: State<'_, AppState>,
    input: WorkspaceListFilesInput,
) -> ArgmaxResult<Vec<WorkspaceFileEntry>> {
    let database = live_database(&state)?;
    WorkspaceFilesService::new(database)
        .list_files(input.workspace_id.as_str())
        .await
}

#[tauri::command(rename = "workspace:read-file")]
#[specta::specta]
pub async fn workspace_read_file(
    state: State<'_, AppState>,
    input: WorkspaceReadFileInput,
) -> ArgmaxResult<WorkspaceFilePreview> {
    let database = live_database(&state)?;
    WorkspaceFilesService::new(database)
        .read_file(input.workspace_id.as_str(), input.file_path.as_str())
        .await
}

#[tauri::command(rename = "workspace:list-files-for-project")]
#[specta::specta]
pub async fn workspace_list_files_for_project(
    state: State<'_, AppState>,
    input: WorkspaceListFilesForProjectInput,
) -> ArgmaxResult<Vec<WorkspaceFileEntry>> {
    let database = live_database(&state)?;
    WorkspaceFilesService::new(database)
        .list_files_for_project(input.project_id.as_str())
        .await
}

#[tauri::command(rename = "workspace:read-file-for-project")]
#[specta::specta]
pub async fn workspace_read_file_for_project(
    state: State<'_, AppState>,
    input: WorkspaceReadFileForProjectInput,
) -> ArgmaxResult<WorkspaceFilePreview> {
    let database = live_database(&state)?;
    WorkspaceFilesService::new(database)
        .read_file_for_project(input.project_id.as_str(), input.file_path.as_str())
        .await
}

#[tauri::command(rename = "workspace:write-file")]
#[specta::specta]
pub async fn workspace_write_file(
    state: State<'_, AppState>,
    input: WorkspaceWriteFileInput,
) -> ArgmaxResult<WorkspaceFileWriteResult> {
    let database = live_database(&state)?;
    WorkspaceFilesService::new(database)
        .write_file(
            input.workspace_id.as_str(),
            input.file_path.as_str(),
            input.content.as_str(),
            input.expected_mtime_ms.into_inner(),
        )
        .await
}

#[tauri::command(rename = "workspace:stat-file")]
#[specta::specta]
pub async fn workspace_stat_file(
    state: State<'_, AppState>,
    input: WorkspaceStatFileInput,
) -> ArgmaxResult<WorkspaceFileStat> {
    let database = live_database(&state)?;
    WorkspaceFilesService::new(database)
        .stat_file(input.workspace_id.as_str(), input.file_path.as_str())
        .await
}

#[tauri::command(rename = "workspace:write-file-for-project")]
#[specta::specta]
pub async fn workspace_write_file_for_project(
    state: State<'_, AppState>,
    input: WorkspaceWriteFileForProjectInput,
) -> ArgmaxResult<WorkspaceFileWriteResult> {
    let database = live_database(&state)?;
    WorkspaceFilesService::new(database)
        .write_file_for_project(
            input.project_id.as_str(),
            input.file_path.as_str(),
            input.content.as_str(),
            input.expected_mtime_ms.into_inner(),
        )
        .await
}

#[tauri::command(rename = "workspace:stat-file-for-project")]
#[specta::specta]
pub async fn workspace_stat_file_for_project(
    state: State<'_, AppState>,
    input: WorkspaceStatFileForProjectInput,
) -> ArgmaxResult<WorkspaceFileStat> {
    let database = live_database(&state)?;
    WorkspaceFilesService::new(database)
        .stat_file_for_project(input.project_id.as_str(), input.file_path.as_str())
        .await
}

#[tauri::command(rename = "workspace:grep-content")]
#[specta::specta]
pub async fn workspace_grep_content(
    state: State<'_, AppState>,
    input: WorkspaceGrepContentInput,
) -> ArgmaxResult<WorkspaceContentSearchResult> {
    let database = live_database(&state)?;
    let service = WorkspaceFilesService::new(database);
    match input.kind {
        WorkspaceGrepKind::Workspace => {
            service
                .grep_content_for_workspace(input.id.as_str(), input.query.as_str())
                .await
        }
        WorkspaceGrepKind::Project => {
            service
                .grep_content_for_project(input.id.as_str(), input.query.as_str())
                .await
        }
    }
}
