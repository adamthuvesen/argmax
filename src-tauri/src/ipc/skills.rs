use std::path::PathBuf;

use tauri::State;

use super::{inputs::*, live_database};
use crate::{
    error::ArgmaxResult,
    persistence::workspaces::find_workspace_by_id,
    skills::registry::{SkillRegistry, SkillSummary},
    state::AppState,
};

#[tauri::command(rename = "skills:list")]
#[specta::specta]
pub fn skills_list(
    state: State<'_, AppState>,
    input: SkillsListInput,
) -> ArgmaxResult<Vec<SkillSummary>> {
    let workspace_cwd: Option<PathBuf> = match input.workspace_id {
        Some(workspace_id) => {
            let database = live_database(&state)?;
            let connection = database.connection();
            let workspace = find_workspace_by_id(&connection, workspace_id.as_str())?;
            Some(PathBuf::from(workspace.path))
        }
        None => None,
    };
    let registry = SkillRegistry::from_env();
    Ok(registry.list_skills(input.provider, workspace_cwd.as_deref()))
}
