use super::inputs::*;

#[tauri::command(rename = "scoring:list-policies")]
#[specta::specta]
pub fn scoring_list_policies(_input: ScoringListPoliciesInput) {
    super::unported("scoring:list-policies")
}
