use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{
    json_error, project_folders::list_project_folders, projects::require_project, sqlite_error,
};
use crate::error::{ArgmaxError, ArgmaxResult};

pub const MAX_OVERVIEW_CHARS: usize = 6_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverviewSource {
    pub folder_id: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverviewDocument {
    pub text: String,
    pub sources: Vec<OverviewSource>,
    pub generated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum OverviewStatus {
    Idle,
    Generating,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverview {
    pub revision: u32,
    pub saved: Option<OverviewDocument>,
    pub draft: Option<OverviewDocument>,
    pub status: OverviewStatus,
    pub error: Option<String>,
}

impl Default for ProjectOverview {
    fn default() -> Self {
        Self {
            revision: 0,
            saved: None,
            draft: None,
            status: OverviewStatus::Idle,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverviewGeneration {
    pub token: String,
    pub signature: String,
    pub base_revision: u32,
    pub auto_apply: bool,
}

pub fn configuration_signature(connection: &Connection, project_id: &str) -> ArgmaxResult<String> {
    let project = require_project(connection, project_id)?;
    let folders = list_project_folders(connection, project_id)?;
    serde_json::to_string(&(
        project.name,
        folders
            .iter()
            .map(|folder| {
                (
                    &folder.id,
                    &folder.name,
                    &folder.root_path,
                    folder.is_primary,
                    folder.enabled,
                )
            })
            .collect::<Vec<_>>(),
    ))
    .map_err(json_error)
}

fn store(
    connection: &Connection,
    project_id: &str,
    overview: &ProjectOverview,
    generation: Option<&OverviewGeneration>,
) -> ArgmaxResult<()> {
    connection
        .execute(
            "UPDATE projects SET overview_json = ?1, overview_generation_json = ?2 WHERE id = ?3",
            rusqlite::params![
                serde_json::to_string(overview).map_err(json_error)?,
                generation
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(json_error)?,
                project_id
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn begin_generation(
    connection: &Connection,
    project_id: &str,
    auto_apply: bool,
) -> ArgmaxResult<Option<OverviewGeneration>> {
    let mut overview = require_project(connection, project_id)?
        .overview
        .unwrap_or_default();
    if overview.status == OverviewStatus::Generating {
        return Ok(None);
    }
    overview.revision += 1;
    overview.status = OverviewStatus::Generating;
    overview.error = None;
    let generation = OverviewGeneration {
        token: uuid::Uuid::new_v4().to_string(),
        signature: configuration_signature(connection, project_id)?,
        base_revision: overview.revision,
        auto_apply,
    };
    store(connection, project_id, &overview, Some(&generation))?;
    Ok(Some(generation))
}

pub fn complete_generation(
    connection: &Connection,
    project_id: &str,
    generation: &OverviewGeneration,
    result: Result<OverviewDocument, String>,
) -> ArgmaxResult<bool> {
    let stored: Option<Option<String>> = connection
        .query_row(
            "SELECT overview_generation_json FROM projects WHERE id = ?",
            [project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;
    let Some(Some(stored)) = stored else {
        return Ok(false);
    };
    let stored: OverviewGeneration = serde_json::from_str(&stored).map_err(json_error)?;
    if stored.token != generation.token {
        return Ok(false);
    }
    let mut overview = require_project(connection, project_id)?
        .overview
        .unwrap_or_default();
    let result = if configuration_signature(connection, project_id)? != generation.signature {
        Err("Project folders changed during generation. Refresh the overview to use the current folders.".to_owned())
    } else {
        result
    };
    match result {
        Ok(document) => {
            if generation.auto_apply
                && overview.revision == generation.base_revision
                && overview.saved.is_none()
            {
                overview.saved = Some(document);
            } else {
                overview.draft = Some(document);
            }
            overview.status = OverviewStatus::Idle;
            overview.error = None;
        }
        Err(error) => {
            overview.status = OverviewStatus::Failed;
            overview.error = Some(error);
        }
    }
    overview.revision += 1;
    store(connection, project_id, &overview, None)?;
    Ok(true)
}

pub enum OverviewEdit<'a> {
    Save(&'a str),
    ApplyDraft,
    DiscardDraft,
}

pub fn edit_overview(
    connection: &Connection,
    project_id: &str,
    expected_revision: u32,
    edit: OverviewEdit<'_>,
) -> ArgmaxResult<()> {
    let mut overview = require_project(connection, project_id)?
        .overview
        .unwrap_or_default();
    if overview.revision != expected_revision {
        return Err(ArgmaxError::service(
            "PROJECT_OVERVIEW_CONFLICT",
            "The project overview changed. Reload it before saving.",
        ));
    }
    match edit {
        OverviewEdit::Save(text) => {
            let text = text.trim();
            if text.chars().count() > MAX_OVERVIEW_CHARS {
                return Err(ArgmaxError::service(
                    "PROJECT_OVERVIEW_TOO_LONG",
                    "Keep the project overview under 6000 characters.",
                ));
            }
            overview.saved = if text.is_empty() {
                None
            } else {
                Some(OverviewDocument {
                    text: text.to_owned(),
                    sources: vec![],
                    generated_at: None,
                })
            };
        }
        OverviewEdit::ApplyDraft => {
            overview.saved = Some(overview.draft.take().ok_or_else(|| {
                ArgmaxError::service(
                    "PROJECT_OVERVIEW_NO_DRAFT",
                    "There is no overview draft to apply.",
                )
            })?);
        }
        OverviewEdit::DiscardDraft => overview.draft = None,
    }
    overview.revision += 1;
    let generation: Option<String> = connection
        .query_row(
            "SELECT overview_generation_json FROM projects WHERE id = ?",
            [project_id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    let generation = generation
        .map(|value| serde_json::from_str::<OverviewGeneration>(&value))
        .transpose()
        .map_err(json_error)?;
    store(connection, project_id, &overview, generation.as_ref())
}

pub fn recover_interrupted(connection: &Connection) -> ArgmaxResult<()> {
    let mut statement = connection
        .prepare(
            "SELECT id, overview_json FROM projects WHERE overview_generation_json IS NOT NULL",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    for (id, json) in rows {
        let mut overview: ProjectOverview = serde_json::from_str(&json).map_err(json_error)?;
        overview.revision += 1;
        overview.status = OverviewStatus::Failed;
        overview.error =
            Some("Overview generation was interrupted. Refresh to try again.".to_owned());
        store(connection, &id, &overview, None)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        Database,
    };

    fn database() -> Database {
        let db = Database::open_in_memory().unwrap();
        persist_project(
            &db.connection(),
            &PersistProjectInput {
                id: "p".into(),
                name: "Project".into(),
                repo_path: "/tmp/repo".into(),
                current_branch: "main".into(),
                default_branch: None,
                settings: ProjectSettings {
                    worktree_location: "/tmp/worktrees".into(),
                    setup_command: String::new(),
                    check_commands: vec![],
                    merge_cleanup: Default::default(),
                },
            },
        )
        .unwrap();
        db
    }
    fn document(text: &str) -> OverviewDocument {
        OverviewDocument {
            text: text.into(),
            sources: vec![OverviewSource {
                folder_id: "primary:p".into(),
                path: "README.md".into(),
            }],
            generated_at: Some("2026-10-18T12:00:00Z".into()),
        }
    }
    fn overview(connection: &Connection) -> ProjectOverview {
        require_project(connection, "p").unwrap().overview.unwrap()
    }

    #[test]
    fn initial_generation_saves_once_refresh_preserves_edits_until_apply() {
        let db = database();
        let connection = db.connection();
        let generation = begin_generation(&connection, "p", true).unwrap().unwrap();
        assert!(begin_generation(&connection, "p", true).unwrap().is_none());
        complete_generation(&connection, "p", &generation, Ok(document("Generated"))).unwrap();
        assert_eq!(overview(&connection).saved.unwrap().text, "Generated");
        let generation = begin_generation(&connection, "p", false).unwrap().unwrap();
        let revision = overview(&connection).revision;
        edit_overview(
            &connection,
            "p",
            revision,
            OverviewEdit::Save("Personal edit"),
        )
        .unwrap();
        assert!(
            edit_overview(&connection, "p", revision, OverviewEdit::Save("Stale edit")).is_err()
        );
        complete_generation(&connection, "p", &generation, Ok(document("Refreshed"))).unwrap();
        let current = overview(&connection);
        assert_eq!(current.saved.unwrap().text, "Personal edit");
        assert_eq!(current.draft.unwrap().text, "Refreshed");
        edit_overview(&connection, "p", current.revision, OverviewEdit::ApplyDraft).unwrap();
        assert_eq!(overview(&connection).saved.unwrap().text, "Refreshed");
    }

    #[test]
    fn editing_initial_generation_prevents_auto_overwrite_and_interrupted_work_is_retryable() {
        let db = database();
        let connection = db.connection();
        let generation = begin_generation(&connection, "p", true).unwrap().unwrap();
        edit_overview(&connection, "p", 1, OverviewEdit::Save("User orientation")).unwrap();
        complete_generation(&connection, "p", &generation, Ok(document("Generated"))).unwrap();
        assert_eq!(
            overview(&connection).saved.unwrap().text,
            "User orientation"
        );
        assert!(overview(&connection).draft.is_some());
        begin_generation(&connection, "p", false).unwrap();
        recover_interrupted(&connection).unwrap();
        let current = overview(&connection);
        assert_eq!(current.status, OverviewStatus::Failed);
        assert_eq!(current.saved.unwrap().text, "User orientation");
        assert!(current.error.unwrap().contains("interrupted"));
        assert!(!complete_generation(&connection, "p", &generation, Ok(document("Late"))).unwrap());
        assert!(begin_generation(&connection, "p", false).unwrap().is_some());
    }

    #[test]
    fn stale_folders_and_deleted_projects_cannot_receive_results() {
        let db = database();
        let connection = db.connection();
        let generation = begin_generation(&connection, "p", true).unwrap().unwrap();
        connection
            .execute(
                "UPDATE project_folders SET name = 'changed' WHERE project_id = 'p'",
                [],
            )
            .unwrap();
        complete_generation(&connection, "p", &generation, Ok(document("Outdated"))).unwrap();
        let current = overview(&connection);
        assert_eq!(current.status, OverviewStatus::Failed);
        assert!(current.saved.is_none());
        let generation = begin_generation(&connection, "p", false).unwrap().unwrap();
        connection
            .execute("DELETE FROM projects WHERE id = 'p'", [])
            .unwrap();
        assert!(
            !complete_generation(&connection, "p", &generation, Ok(document("Deleted"))).unwrap()
        );
    }

    #[test]
    fn provider_failure_keeps_saved_content_and_draft_can_be_discarded() {
        let db = database();
        let connection = db.connection();
        edit_overview(&connection, "p", 0, OverviewEdit::Save("Saved")).unwrap();
        let generation = begin_generation(&connection, "p", false).unwrap().unwrap();
        complete_generation(
            &connection,
            "p",
            &generation,
            Err("Provider unavailable".into()),
        )
        .unwrap();
        let current = overview(&connection);
        assert_eq!(current.saved.unwrap().text, "Saved");
        assert_eq!(current.error.as_deref(), Some("Provider unavailable"));
        let generation = begin_generation(&connection, "p", false).unwrap().unwrap();
        complete_generation(&connection, "p", &generation, Ok(document("Draft"))).unwrap();
        edit_overview(
            &connection,
            "p",
            overview(&connection).revision,
            OverviewEdit::DiscardDraft,
        )
        .unwrap();
        assert!(overview(&connection).draft.is_none());
        assert_eq!(overview(&connection).saved.unwrap().text, "Saved");
    }
}
