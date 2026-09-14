use std::path::{Component, Path};

use reqwest::Url;
use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

use super::{sqlite_error, time::now_iso};
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};

pub const MAX_PROJECT_SOURCES: i64 = 100;
pub const MAX_SOURCE_TITLE_CHARS: usize = 160;
pub const MAX_SOURCE_LOCATION_CHARS: usize = 2_048;
pub const MAX_SOURCE_GUIDANCE_CHARS: usize = 1_000;

pub const MIGRATION_SQL: &str = r#"
CREATE TABLE project_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (
    length(title) BETWEEN 1 AND 160
    AND length(trim(title)) > 0
    AND title = trim(title)
  ),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'url')),
  location TEXT NOT NULL CHECK (
    length(location) BETWEEN 1 AND 2048
    AND length(trim(location)) > 0
    AND location = trim(location)
  ),
  guidance TEXT NOT NULL CHECK (length(guidance) <= 1000),
  added_by TEXT NOT NULL CHECK (added_by IN ('user', 'agent')),
  added_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, location)
);

CREATE INDEX idx_project_sources_project_created
  ON project_sources(project_id, created_at DESC, id DESC);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProjectSourceKind {
    File,
    Url,
}

impl ProjectSourceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Url => "url",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "file" => Some(Self::File),
            "url" => Some(Self::Url),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProjectSourceAddedBy {
    User,
    Agent,
}

impl ProjectSourceAddedBy {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Self::User),
            "agent" => Some(Self::Agent),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSource {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub kind: ProjectSourceKind,
    pub location: String,
    pub guidance: String,
    pub added_by: ProjectSourceAddedBy,
    pub added_by_session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
    pub title: String,
    pub location: String,
    pub guidance: String,
}

pub fn validate_source_input(input: &SourceInput) -> ArgmaxResult<ProjectSourceKind> {
    validate_required_text("title", &input.title, MAX_SOURCE_TITLE_CHARS)?;
    if input.title.chars().any(char::is_control) {
        return Err(invalid_source(
            "title",
            "SOURCE_TITLE_CONTROL_CHARACTER",
            "source title must not contain control characters",
        ));
    }
    if input.guidance.chars().count() > MAX_SOURCE_GUIDANCE_CHARS {
        return Err(invalid_source(
            "guidance",
            "SOURCE_GUIDANCE_TOO_LONG",
            format!("source guidance must be at most {MAX_SOURCE_GUIDANCE_CHARS} characters"),
        ));
    }
    if input.guidance.contains('\0') {
        return Err(invalid_source(
            "guidance",
            "SOURCE_GUIDANCE_NULL_BYTE",
            "source guidance must not contain null bytes",
        ));
    }
    validate_required_text("location", &input.location, MAX_SOURCE_LOCATION_CHARS)?;
    if input.location.chars().any(char::is_control) {
        return Err(invalid_source(
            "location",
            "SOURCE_LOCATION_CONTROL_CHARACTER",
            "source location must not contain control characters",
        ));
    }

    if has_url_scheme(&input.location) {
        return validate_url(&input.location);
    }

    let path = Path::new(&input.location);
    if path.is_absolute() {
        return Err(invalid_source(
            "location",
            "SOURCE_FILE_ABSOLUTE",
            "file source location must be relative to the project root",
        ));
    }
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(invalid_source(
            "location",
            "SOURCE_FILE_TRAVERSAL",
            "file source location must not contain `..` segments",
        ));
    }
    Ok(ProjectSourceKind::File)
}

pub fn list_sources(connection: &Connection, project_id: &str) -> ArgmaxResult<Vec<ProjectSource>> {
    require_project_exists(connection, project_id)?;
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT id, project_id, title, kind, location, guidance, added_by,
                   added_by_session_id, created_at, updated_at
            FROM project_sources
            WHERE project_id = ?
            ORDER BY created_at DESC, id DESC
            "#,
        )
        .map_err(sqlite_error)?;
    let sources = statement
        .query_map([project_id], row_to_source)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(sources)
}

pub fn get_source(
    connection: &Connection,
    project_id: &str,
    source_id: &str,
) -> ArgmaxResult<ProjectSource> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT id, project_id, title, kind, location, guidance, added_by,
                   added_by_session_id, created_at, updated_at
            FROM project_sources
            WHERE project_id = ? AND id = ?
            "#,
        )
        .map_err(sqlite_error)?;
    match statement.query_row((project_id, source_id), row_to_source) {
        Ok(source) => Ok(source),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("project source", source_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn insert_source(
    connection: &Connection,
    project_id: &str,
    input: &SourceInput,
    added_by: ProjectSourceAddedBy,
    added_by_session_id: Option<&str>,
) -> ArgmaxResult<(ProjectSource, bool)> {
    let kind = validate_source_input(input)?;
    require_project_exists(connection, project_id)?;

    if let Some(existing) = find_source_by_location(connection, project_id, &input.location)? {
        if added_by == ProjectSourceAddedBy::Agent {
            return Ok((existing, false));
        }
        return Err(source_conflict());
    }

    let count = connection
        .query_row(
            "SELECT COUNT(*) FROM project_sources WHERE project_id = ?",
            [project_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sqlite_error)?;
    if count >= MAX_PROJECT_SOURCES {
        return Err(ArgmaxError::service(
            "PROJECT_SOURCE_LIMIT",
            format!("A project can have at most {MAX_PROJECT_SOURCES} sources."),
        ));
    }
    validate_session_project(connection, project_id, added_by_session_id)?;

    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    connection
        .prepare_cached(
            r#"
            INSERT INTO project_sources (
                id, project_id, title, kind, location, guidance, added_by,
                added_by_session_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            id.as_str(),
            project_id,
            input.title.as_str(),
            kind.as_str(),
            input.location.as_str(),
            input.guidance.as_str(),
            added_by.as_str(),
            added_by_session_id,
            now.as_str(),
            now.as_str(),
        ))
        .map_err(map_insert_error)?;

    Ok((get_source(connection, project_id, &id)?, true))
}

pub fn update_source(
    connection: &Connection,
    project_id: &str,
    source_id: &str,
    input: &SourceInput,
) -> ArgmaxResult<ProjectSource> {
    let kind = validate_source_input(input)?;
    get_source(connection, project_id, source_id)?;
    if find_source_by_location(connection, project_id, &input.location)?
        .is_some_and(|source| source.id != source_id)
    {
        return Err(source_conflict());
    }

    let changes = connection
        .prepare_cached(
            r#"
            UPDATE project_sources
            SET title = ?, kind = ?, location = ?, guidance = ?, updated_at = ?
            WHERE project_id = ? AND id = ?
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            input.title.as_str(),
            kind.as_str(),
            input.location.as_str(),
            input.guidance.as_str(),
            now_iso(),
            project_id,
            source_id,
        ))
        .map_err(map_insert_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("project source", source_id));
    }
    get_source(connection, project_id, source_id)
}

pub fn delete_source(
    connection: &Connection,
    project_id: &str,
    source_id: &str,
) -> ArgmaxResult<()> {
    let changes = connection
        .prepare_cached("DELETE FROM project_sources WHERE project_id = ? AND id = ?")
        .map_err(sqlite_error)?
        .execute((project_id, source_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("project source", source_id));
    }
    Ok(())
}

fn validate_required_text(field: &'static str, value: &str, max: usize) -> ArgmaxResult<()> {
    if value.trim().is_empty() {
        return Err(invalid_source(
            field,
            "SOURCE_REQUIRED",
            format!("source {field} must not be blank"),
        ));
    }
    if value != value.trim() {
        return Err(invalid_source(
            field,
            "SOURCE_WHITESPACE",
            format!("source {field} must not have leading or trailing whitespace"),
        ));
    }
    if value.chars().count() > max {
        return Err(invalid_source(
            field,
            "SOURCE_TOO_LONG",
            format!("source {field} must be at most {max} characters"),
        ));
    }
    Ok(())
}

fn validate_url(location: &str) -> ArgmaxResult<ProjectSourceKind> {
    let url = Url::parse(location).map_err(|_| {
        invalid_source(
            "location",
            "SOURCE_URL_INVALID",
            "URL source location must be a valid http or https URL",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid_source(
            "location",
            "SOURCE_URL_SCHEME",
            "URL source location must use http or https",
        ));
    }
    if url.host_str().is_none() {
        return Err(invalid_source(
            "location",
            "SOURCE_URL_INVALID",
            "URL source location must include a host",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid_source(
            "location",
            "SOURCE_URL_CREDENTIALS",
            "URL source location must not contain credentials",
        ));
    }
    Ok(ProjectSourceKind::Url)
}

fn has_url_scheme(location: &str) -> bool {
    let Some(colon) = location.find(':') else {
        return false;
    };
    let scheme = &location[..colon];
    !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

fn require_project_exists(connection: &Connection, project_id: &str) -> ArgmaxResult<()> {
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?)",
            [project_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(sqlite_error)?;
    if !exists {
        return Err(ArgmaxError::record_not_found("project", project_id));
    }
    Ok(())
}

fn validate_session_project(
    connection: &Connection,
    project_id: &str,
    session_id: Option<&str>,
) -> ArgmaxResult<()> {
    let Some(session_id) = session_id else {
        return Ok(());
    };
    let belongs_to_project = connection
        .query_row(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM sessions
                JOIN workspaces ON workspaces.id = sessions.workspace_id
                WHERE sessions.id = ? AND workspaces.project_id = ?
            )
            "#,
            (session_id, project_id),
            |row| row.get::<_, bool>(0),
        )
        .map_err(sqlite_error)?;
    if !belongs_to_project {
        return Err(ArgmaxError::service(
            "PROJECT_SOURCE_SESSION_MISMATCH",
            "The source session does not belong to this project.",
        ));
    }
    Ok(())
}

fn find_source_by_location(
    connection: &Connection,
    project_id: &str,
    location: &str,
) -> ArgmaxResult<Option<ProjectSource>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT id, project_id, title, kind, location, guidance, added_by,
                   added_by_session_id, created_at, updated_at
            FROM project_sources
            WHERE project_id = ? AND location = ?
            "#,
        )
        .map_err(sqlite_error)?;
    match statement.query_row((project_id, location), row_to_source) {
        Ok(source) => Ok(Some(source)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

fn row_to_source(row: &Row<'_>) -> rusqlite::Result<ProjectSource> {
    let kind: String = row.get("kind")?;
    let added_by: String = row.get("added_by")?;
    Ok(ProjectSource {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        kind: ProjectSourceKind::from_str(&kind)
            .ok_or_else(|| invalid_database_value("project source kind", &kind))?,
        location: row.get("location")?,
        guidance: row.get("guidance")?,
        added_by: ProjectSourceAddedBy::from_str(&added_by)
            .ok_or_else(|| invalid_database_value("project source added_by", &added_by))?,
        added_by_session_id: row.get("added_by_session_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn invalid_database_value(label: &str, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("unknown {label} {value}"),
        )),
    )
}

fn invalid_source(
    field: &'static str,
    code: &'static str,
    message: impl Into<String>,
) -> ArgmaxError {
    ArgmaxError::invalid(InvalidInputIssue::at(vec![field.to_owned()], code, message))
}

fn source_conflict() -> ArgmaxError {
    ArgmaxError::service(
        "PROJECT_SOURCE_CONFLICT",
        "A source with this location already exists in the project.",
    )
}

fn map_insert_error(error: rusqlite::Error) -> ArgmaxError {
    if error
        .sqlite_error()
        .is_some_and(|details| details.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
    {
        return source_conflict();
    }
    sqlite_error(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{
        database::Database,
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        sessions::{persist_session, PersistSessionInput},
        workspaces::{persist_workspace, PersistWorkspaceInput},
    };
    use crate::sessions::state::SessionState;

    #[test]
    fn validates_relative_files_and_http_urls() {
        assert_eq!(
            validate_source_input(&input("docs/data.md")).unwrap(),
            ProjectSourceKind::File
        );
        assert_eq!(
            validate_source_input(&input("https://example.com/docs?q=1")).unwrap(),
            ProjectSourceKind::Url
        );

        for location in [
            "/tmp/secret",
            "docs/../secret",
            "file:///tmp/secret",
            "mailto:owner@example.com",
            "https://user:secret@example.com/docs",
            "https://example.com/line\nfeed",
        ] {
            assert!(
                validate_source_input(&input(location)).is_err(),
                "accepted {location:?}"
            );
        }
    }

    #[test]
    fn crud_is_project_scoped_and_agent_adds_are_idempotent() {
        let database = database_with_projects();
        let connection = database.connection();
        let source_input = input("docs/data.md");
        let (source, created) = insert_source(
            &connection,
            "p1",
            &source_input,
            ProjectSourceAddedBy::User,
            None,
        )
        .unwrap();
        assert!(created);
        assert_eq!(source.kind, ProjectSourceKind::File);
        assert_eq!(
            list_sources(&connection, "p1").unwrap(),
            vec![source.clone()]
        );
        assert!(list_sources(&connection, "p2").unwrap().is_empty());
        assert!(get_source(&connection, "p2", &source.id).is_err());
        assert!(delete_source(&connection, "p2", &source.id).is_err());

        let (existing, created) = insert_source(
            &connection,
            "p1",
            &source_input,
            ProjectSourceAddedBy::Agent,
            None,
        )
        .unwrap();
        assert!(!created);
        assert_eq!(existing, source);
        assert!(insert_source(
            &connection,
            "p1",
            &source_input,
            ProjectSourceAddedBy::User,
            None,
        )
        .is_err());

        let (other, _) = insert_source(
            &connection,
            "p1",
            &input("docs/other.md"),
            ProjectSourceAddedBy::User,
            None,
        )
        .unwrap();
        let conflicting_update = SourceInput {
            location: other.location.clone(),
            ..source_input.clone()
        };
        assert!(update_source(&connection, "p1", &source.id, &conflicting_update).is_err());
        delete_source(&connection, "p1", &other.id).unwrap();

        let updated_input = SourceInput {
            title: "Data model".to_owned(),
            location: "https://example.com/data".to_owned(),
            guidance: "Use for persistence questions.".to_owned(),
        };
        let updated = update_source(&connection, "p1", &source.id, &updated_input).unwrap();
        assert_eq!(updated.kind, ProjectSourceKind::Url);
        assert_eq!(updated.added_by, ProjectSourceAddedBy::User);
        delete_source(&connection, "p1", &source.id).unwrap();
        assert!(list_sources(&connection, "p1").unwrap().is_empty());
    }

    #[test]
    fn session_link_is_project_checked_and_cleared_on_delete() {
        let database = database_with_projects();
        let connection = database.connection();
        persist_workspace(&connection, &workspace_input()).unwrap();
        persist_session(&connection, &session_input()).unwrap();

        assert!(insert_source(
            &connection,
            "p2",
            &input("docs/data.md"),
            ProjectSourceAddedBy::Agent,
            Some("s1"),
        )
        .is_err());
        let (source, _) = insert_source(
            &connection,
            "p1",
            &input("docs/data.md"),
            ProjectSourceAddedBy::Agent,
            Some("s1"),
        )
        .unwrap();
        connection
            .execute("DELETE FROM sessions WHERE id = ?", ["s1"])
            .unwrap();
        assert_eq!(
            get_source(&connection, "p1", &source.id)
                .unwrap()
                .added_by_session_id,
            None
        );
    }

    #[test]
    fn project_delete_cascades_and_limit_fails_explicitly() {
        let database = database_with_projects();
        let connection = database.connection();
        for index in 0..MAX_PROJECT_SOURCES {
            insert_source(
                &connection,
                "p1",
                &input(&format!("docs/{index}.md")),
                ProjectSourceAddedBy::User,
                None,
            )
            .unwrap();
        }
        let error = insert_source(
            &connection,
            "p1",
            &input("docs/overflow.md"),
            ProjectSourceAddedBy::User,
            None,
        )
        .unwrap_err();
        assert!(matches!(
            error,
            ArgmaxError::ServiceError { ref sub_code, .. } if sub_code == "PROJECT_SOURCE_LIMIT"
        ));

        connection
            .execute("DELETE FROM projects WHERE id = ?", ["p1"])
            .unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM project_sources", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    fn input(location: &str) -> SourceInput {
        SourceInput {
            title: "Project reference".to_owned(),
            location: location.to_owned(),
            guidance: "Consult when relevant.".to_owned(),
        }
    }

    fn database_with_projects() -> Database {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        for (id, repo_path) in [("p1", "/tmp/project-one"), ("p2", "/tmp/project-two")] {
            persist_project(
                &connection,
                &PersistProjectInput {
                    id: id.to_owned(),
                    name: id.to_owned(),
                    repo_path: repo_path.to_owned(),
                    current_branch: "main".to_owned(),
                    default_branch: Some("main".to_owned()),
                    settings: ProjectSettings {
                        worktree_location: "/tmp/worktrees".to_owned(),
                        setup_command: String::new(),
                        check_commands: Vec::new(),
                        archive_on_merge: false,
                    },
                },
            )
            .unwrap();
        }
        drop(connection);
        database
    }

    fn workspace_input() -> PersistWorkspaceInput {
        PersistWorkspaceInput {
            id: "w1".to_owned(),
            project_id: "p1".to_owned(),
            task_label: "Source context".to_owned(),
            branch: "main".to_owned(),
            base_ref: "main".to_owned(),
            path: "/tmp/project-one".to_owned(),
            state: "running".to_owned(),
            shared_workspace: true,
            kind: "git".to_owned(),
            dirty: false,
            changed_files: 0,
        }
    }

    fn session_input() -> PersistSessionInput {
        PersistSessionInput {
            id: "s1".to_owned(),
            workspace_id: "w1".to_owned(),
            provider: "codex".to_owned(),
            model_label: "GPT".to_owned(),
            model_id: "gpt".to_owned(),
            reasoning_effort: None,
            permission_mode: None,
            agent_mode: None,
            prompt: "Add source".to_owned(),
            state: SessionState::Running,
        }
    }
}
