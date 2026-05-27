use super::inputs::*;

#[tauri::command(rename = "skills:list")]
#[specta::specta]
pub fn skills_list(_input: SkillsListInput) {
    super::unported("skills:list")
}
