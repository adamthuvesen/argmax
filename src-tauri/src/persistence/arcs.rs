//! An Arc is a long-lived body of work that can span several registered
//! projects: a name, a brief, a state, a home project, a coordinator session
//! pointer, and a folder of shared files. This module is persistence plus the
//! small domain rules around it (validation, the on-disk `BRIEF.md`/`NOTES.md`
//! pair); it deliberately does not launch sessions — that is a later phase.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

use super::{sqlite_error, time::now_iso};
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};
use crate::sessions::state::SessionState;

/// Registered by migration v51, right after the routine author column.
pub const MIGRATION_SQL: &str = r#"
CREATE TABLE arcs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  brief TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'done')),
  home_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  coordinator_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  dir TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_arcs_home_project ON arcs(home_project_id);
CREATE INDEX idx_arcs_updated_at ON arcs(updated_at DESC, id DESC);
ALTER TABLE sessions ADD COLUMN arc_id TEXT REFERENCES arcs(id) ON DELETE SET NULL;
CREATE INDEX idx_sessions_arc_id ON sessions(arc_id);
"#;

const BRIEF_FILE_NAME: &str = "BRIEF.md";
const NOTES_FILE_NAME: &str = "NOTES.md";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ArcState {
    Active,
    Paused,
    Done,
}

impl ArcState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Done => "done",
        }
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "paused" => Some(Self::Paused),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

/// The Arc row, named `ArcRecord` rather than `Arc` because every file in this
/// codebase already imports `std::sync::Arc`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArcRecord {
    pub id: String,
    pub name: String,
    pub brief: String,
    pub state: ArcState,
    pub home_project_id: String,
    pub coordinator_session_id: Option<String>,
    pub dir: String,
    pub created_at: String,
    pub updated_at: String,
}

/// The dashboard's lightweight view: enough to render a sidebar row without
/// carrying the full brief text on every snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArcSummary {
    pub id: String,
    pub name: String,
    pub state: ArcState,
    pub home_project_id: String,
    pub coordinator_session_id: Option<String>,
    pub dir: String,
    pub member_count: i64,
    pub updated_at: String,
}

/// One session attached to an Arc, for the member listing the `arc_status`
/// tool reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArcMember {
    pub session_id: String,
    pub project_id: String,
    pub project_name: String,
    pub workspace_id: String,
    pub task_label: String,
    pub state: SessionState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcCreateInput {
    pub name: String,
    /// Empty when the caller wants to pick up an existing `BRIEF.md` from a
    /// user-supplied `dir`, or start with a blank one.
    pub brief: String,
    pub home_project_id: String,
    /// Absolute path to an existing directory. `None` uses the default
    /// `<app data dir>/arcs/<id>/`, which is created for the caller.
    pub dir: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArcUpdateInput {
    pub name: Option<String>,
    pub brief: Option<String>,
}

/// Creates an Arc: validates the name and target directory, writes
/// `BRIEF.md`/`NOTES.md`, and persists the row. Never launches a session.
pub fn create_arc(
    connection: &Connection,
    app_data_dir: &Path,
    input: &ArcCreateInput,
) -> ArgmaxResult<ArcRecord> {
    let name = validate_name(&input.name)?;
    require_project_exists(connection, &input.home_project_id)?;

    let id = Uuid::new_v4().to_string();
    let (dir, brief) = resolve_create_dir(app_data_dir, &id, input.dir.as_deref(), &input.brief)?;

    let now = now_iso();
    connection
        .prepare_cached(
            r#"
            INSERT INTO arcs (
                id, name, brief, state, home_project_id, coordinator_session_id,
                dir, created_at, updated_at
            ) VALUES (?, ?, ?, 'active', ?, NULL, ?, ?, ?)
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            id.as_str(),
            name.as_str(),
            brief.as_str(),
            input.home_project_id.as_str(),
            dir.to_string_lossy().as_ref(),
            now.as_str(),
            now.as_str(),
        ))
        .map_err(sqlite_error)?;

    get_arc(connection, &id)
}

pub fn get_arc(connection: &Connection, arc_id: &str) -> ArgmaxResult<ArcRecord> {
    let mut statement = connection
        .prepare_cached(&format!("SELECT {ARC_COLUMNS} FROM arcs WHERE id = ?"))
        .map_err(sqlite_error)?;
    match statement.query_row([arc_id], row_to_arc) {
        Ok(arc) => Ok(arc),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("arc", arc_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn list_arcs(connection: &Connection) -> ArgmaxResult<Vec<ArcRecord>> {
    let mut statement = connection
        .prepare_cached(&format!(
            "SELECT {ARC_COLUMNS} FROM arcs ORDER BY updated_at DESC, id DESC"
        ))
        .map_err(sqlite_error)?;
    let arcs = statement
        .query_map([], row_to_arc)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(arcs)
}

pub fn list_arc_summaries(connection: &Connection) -> ArgmaxResult<Vec<ArcSummary>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT arcs.id, arcs.name, arcs.state, arcs.home_project_id,
                   arcs.coordinator_session_id, arcs.dir, arcs.updated_at,
                   (SELECT COUNT(*) FROM sessions WHERE sessions.arc_id = arcs.id) AS member_count
            FROM arcs
            ORDER BY arcs.updated_at DESC, arcs.id DESC
            "#,
        )
        .map_err(sqlite_error)?;
    let summaries = statement
        .query_map([], row_to_arc_summary)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(summaries)
}

/// Sessions currently attached to this Arc, for `arc_status`.
pub fn list_members(connection: &Connection, arc_id: &str) -> ArgmaxResult<Vec<ArcMember>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT sessions.id, workspaces.project_id, projects.name AS project_name,
                   sessions.workspace_id, workspaces.task_label, sessions.state
            FROM sessions
            JOIN workspaces ON workspaces.id = sessions.workspace_id
            JOIN projects ON projects.id = workspaces.project_id
            WHERE sessions.arc_id = ?
            ORDER BY sessions.last_activity_at DESC, sessions.id DESC
            "#,
        )
        .map_err(sqlite_error)?;
    let members = statement
        .query_map([arc_id], |row| {
            let state: String = row.get("state")?;
            Ok(ArcMember {
                session_id: row.get("id")?,
                project_id: row.get("project_id")?,
                project_name: row.get("project_name")?,
                workspace_id: row.get("workspace_id")?,
                task_label: row.get("task_label")?,
                state: SessionState::from_wire(&state).unwrap_or(SessionState::Waiting),
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(members)
}

/// How many sessions attached to this Arc are still in flight (not
/// `complete`, `failed`, or `cancelled`), excluding the coordinator itself —
/// the coordinator plans and delegates, it is not one of the pieces of work
/// the member cap bounds. What `arc:launch-coordinator` and the launch caps
/// both check.
pub fn count_active_members(
    connection: &Connection,
    arc_id: &str,
    exclude_session_id: Option<&str>,
) -> ArgmaxResult<i64> {
    connection
        .prepare_cached(
            r#"
            SELECT COUNT(*) FROM sessions
            WHERE arc_id = ?1
              AND state NOT IN ('complete', 'failed', 'cancelled')
              AND (?2 IS NULL OR id != ?2)
            "#,
        )
        .map_err(sqlite_error)?
        .query_row((arc_id, exclude_session_id), |row| row.get(0))
        .map_err(sqlite_error)
}

/// How many sessions this Arc has launched since `since` (an RFC 3339
/// instant) — the launch-budget cap's own count. Counts every session
/// attached to the Arc, coordinator included: the budget is the Arc's, not
/// any one launcher's.
pub fn count_launches_since(
    connection: &Connection,
    arc_id: &str,
    since: &str,
) -> ArgmaxResult<i64> {
    connection
        .prepare_cached("SELECT COUNT(*) FROM sessions WHERE arc_id = ?1 AND started_at >= ?2")
        .map_err(sqlite_error)?
        .query_row((arc_id, since), |row| row.get(0))
        .map_err(sqlite_error)
}

/// Updates name and/or brief. A brief update rewrites `BRIEF.md` in place.
pub fn update_arc(
    connection: &Connection,
    arc_id: &str,
    input: &ArcUpdateInput,
) -> ArgmaxResult<ArcRecord> {
    let current = get_arc(connection, arc_id)?;
    let name = match &input.name {
        Some(name) => validate_name(name)?,
        None => current.name.clone(),
    };
    let brief = match &input.brief {
        Some(brief) => {
            write_file(&PathBuf::from(&current.dir).join(BRIEF_FILE_NAME), brief)?;
            brief.clone()
        }
        None => current.brief.clone(),
    };

    connection
        .prepare_cached("UPDATE arcs SET name = ?, brief = ?, updated_at = ? WHERE id = ?")
        .map_err(sqlite_error)?
        .execute((name.as_str(), brief.as_str(), now_iso().as_str(), arc_id))
        .map_err(sqlite_error)?;
    get_arc(connection, arc_id)
}

pub fn set_arc_state(
    connection: &Connection,
    arc_id: &str,
    state: ArcState,
) -> ArgmaxResult<ArcRecord> {
    get_arc(connection, arc_id)?;
    connection
        .prepare_cached("UPDATE arcs SET state = ?, updated_at = ? WHERE id = ?")
        .map_err(sqlite_error)?
        .execute((state.as_str(), now_iso().as_str(), arc_id))
        .map_err(sqlite_error)?;
    get_arc(connection, arc_id)
}

/// Points the Arc at its coordinator chat, or clears the pointer. Left for a
/// later phase to call once it launches the coordinator session; the foreign
/// key clears it back to `NULL` on its own if that session is ever deleted.
pub fn set_arc_coordinator_session(
    connection: &Connection,
    arc_id: &str,
    session_id: Option<&str>,
) -> ArgmaxResult<ArcRecord> {
    get_arc(connection, arc_id)?;
    connection
        .prepare_cached("UPDATE arcs SET coordinator_session_id = ?, updated_at = ? WHERE id = ?")
        .map_err(sqlite_error)?
        .execute((session_id, now_iso().as_str(), arc_id))
        .map_err(sqlite_error)?;
    get_arc(connection, arc_id)
}

fn validate_name(name: &str) -> ArgmaxResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(invalid_arc(
            "name",
            "ARC_NAME_BLANK",
            "Arc name must not be blank.",
        ));
    }
    Ok(trimmed.to_string())
}

/// Resolves the Arc's directory and the brief it should be created with.
///
/// A default dir is created under the app data dir and always starts from the
/// caller's brief. A user-supplied dir must already exist; its own
/// `BRIEF.md`/`NOTES.md` are never overwritten, and an empty caller brief
/// reads back whatever `BRIEF.md` is already there.
fn resolve_create_dir(
    app_data_dir: &Path,
    id: &str,
    user_dir: Option<&str>,
    brief: &str,
) -> ArgmaxResult<(PathBuf, String)> {
    match user_dir {
        Some(raw) => {
            let dir = PathBuf::from(raw);
            if !dir.is_absolute() {
                return Err(invalid_arc(
                    "dir",
                    "ARC_DIR_INVALID",
                    "Arc dir must be an absolute path.",
                ));
            }
            let metadata = fs::metadata(&dir).map_err(|_| {
                invalid_arc(
                    "dir",
                    "ARC_DIR_INVALID",
                    "Arc dir must already exist as a directory.",
                )
            })?;
            if !metadata.is_dir() {
                return Err(invalid_arc(
                    "dir",
                    "ARC_DIR_INVALID",
                    "Arc dir must already exist as a directory.",
                ));
            }

            let brief_path = dir.join(BRIEF_FILE_NAME);
            let effective_brief = if brief.trim().is_empty() {
                fs::read_to_string(&brief_path).unwrap_or_default()
            } else {
                brief.to_string()
            };
            if !brief_path.exists() {
                write_file(&brief_path, &effective_brief)?;
            }
            let notes_path = dir.join(NOTES_FILE_NAME);
            if !notes_path.exists() {
                write_file(&notes_path, "")?;
            }
            Ok((dir, effective_brief))
        }
        None => {
            let dir = app_data_dir.join("arcs").join(id);
            fs::create_dir_all(&dir).map_err(|error| {
                ArgmaxError::service(
                    "ARC_DIR_CREATE_FAILED",
                    format!("could not create {}: {error}", dir.display()),
                )
            })?;
            write_file(&dir.join(BRIEF_FILE_NAME), brief)?;
            write_file(&dir.join(NOTES_FILE_NAME), "")?;
            Ok((dir, brief.to_string()))
        }
    }
}

fn write_file(path: &Path, content: &str) -> ArgmaxResult<()> {
    fs::write(path, content).map_err(|error| {
        ArgmaxError::service(
            "ARC_FILE_WRITE_FAILED",
            format!("could not write {}: {error}", path.display()),
        )
    })
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

const ARC_COLUMNS: &str =
    "id, name, brief, state, home_project_id, coordinator_session_id, dir, created_at, updated_at";

fn row_to_arc(row: &Row<'_>) -> rusqlite::Result<ArcRecord> {
    let state: String = row.get("state")?;
    Ok(ArcRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        brief: row.get("brief")?,
        state: ArcState::from_wire(&state)
            .ok_or_else(|| invalid_database_value("arc state", &state))?,
        home_project_id: row.get("home_project_id")?,
        coordinator_session_id: row.get("coordinator_session_id")?,
        dir: row.get("dir")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_arc_summary(row: &Row<'_>) -> rusqlite::Result<ArcSummary> {
    let state: String = row.get("state")?;
    Ok(ArcSummary {
        id: row.get("id")?,
        name: row.get("name")?,
        state: ArcState::from_wire(&state)
            .ok_or_else(|| invalid_database_value("arc state", &state))?,
        home_project_id: row.get("home_project_id")?,
        coordinator_session_id: row.get("coordinator_session_id")?,
        dir: row.get("dir")?,
        member_count: row.get("member_count")?,
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

fn invalid_arc(field: &'static str, code: &'static str, message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::invalid(InvalidInputIssue::at(vec![field.to_owned()], code, message))
}

/// The Arc a session is attached to, if any. Plain `sessions.arc_id`, not
/// filtered by liveness — callers that care about live vs. not call
/// `arc_is_live` on the result.
pub fn find_session_arc(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<ArcRecord>> {
    let arc_id: Option<String> = connection
        .prepare_cached("SELECT arc_id FROM sessions WHERE id = ?")
        .map_err(sqlite_error)?
        .query_row([session_id], |row| row.get(0))
        .optional()
        .map_err(sqlite_error)?
        .flatten();
    match arc_id {
        Some(id) => get_arc(connection, &id).map(Some),
        None => Ok(None),
    }
}

/// The settled definition of "live": `active`, pointed at a coordinator
/// session, and that coordinator's workspace not mid-archive or gone. The gh
/// poller's Arc PR/CI events and the scheduler's `arc_coordinator` routine
/// target both gate on exactly this, so it lives here once rather than in
/// each caller.
pub fn arc_is_live(connection: &Connection, arc: &ArcRecord) -> ArgmaxResult<bool> {
    if arc.state != ArcState::Active {
        return Ok(false);
    }
    let Some(coordinator_session_id) = arc.coordinator_session_id.as_deref() else {
        return Ok(false);
    };
    let workspace_state: Option<String> = connection
        .prepare_cached(
            "SELECT workspaces.state FROM sessions
             JOIN workspaces ON workspaces.id = sessions.workspace_id
             WHERE sessions.id = ?",
        )
        .map_err(sqlite_error)?
        .query_row([coordinator_session_id], |row| row.get(0))
        .optional()
        .map_err(sqlite_error)?;
    Ok(matches!(
        workspace_state.as_deref(),
        Some(state) if !matches!(state, "archiving" | "archived" | "archive-failed")
    ))
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

    fn database_with_project() -> Database {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "p1".to_owned(),
                name: "p1".to_owned(),
                repo_path: "/tmp/project-one".to_owned(),
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
        drop(connection);
        database
    }

    fn create_input(dir: Option<String>) -> ArcCreateInput {
        ArcCreateInput {
            name: "Ragnar rollout".to_owned(),
            brief: "Ship the thing.".to_owned(),
            home_project_id: "p1".to_owned(),
            dir,
        }
    }

    #[test]
    fn default_dir_writes_brief_and_notes() {
        let database = database_with_project();
        let connection = database.connection();
        let data_dir = tempfile::tempdir().unwrap();

        let arc = create_arc(&connection, data_dir.path(), &create_input(None)).unwrap();

        let dir = PathBuf::from(&arc.dir);
        assert!(dir.starts_with(data_dir.path().join("arcs")));
        assert_eq!(
            fs::read_to_string(dir.join("BRIEF.md")).unwrap(),
            "Ship the thing."
        );
        assert_eq!(fs::read_to_string(dir.join("NOTES.md")).unwrap(), "");
        assert_eq!(arc.brief, "Ship the thing.");
        assert_eq!(arc.state, ArcState::Active);
    }

    #[test]
    fn missing_user_dir_is_rejected() {
        let database = database_with_project();
        let connection = database.connection();
        let data_dir = tempfile::tempdir().unwrap();

        let error = create_arc(
            &connection,
            data_dir.path(),
            &create_input(Some("/nonexistent/argmax-arc-dir".to_owned())),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            ArgmaxError::InvalidInput { ref issues, .. }
                if issues.iter().any(|issue| issue.code == "ARC_DIR_INVALID")
        ));
    }

    #[test]
    fn existing_brief_in_user_dir_is_not_overwritten() {
        let database = database_with_project();
        let connection = database.connection();
        let data_dir = tempfile::tempdir().unwrap();
        let user_dir = tempfile::tempdir().unwrap();
        fs::write(user_dir.path().join("BRIEF.md"), "Pre-existing brief.").unwrap();

        let mut input = create_input(Some(user_dir.path().to_string_lossy().into_owned()));
        input.brief = String::new();
        let arc = create_arc(&connection, data_dir.path(), &input).unwrap();

        assert_eq!(arc.brief, "Pre-existing brief.");
        assert_eq!(
            fs::read_to_string(user_dir.path().join("BRIEF.md")).unwrap(),
            "Pre-existing brief."
        );
    }

    #[test]
    fn blank_name_is_rejected() {
        let database = database_with_project();
        let connection = database.connection();
        let data_dir = tempfile::tempdir().unwrap();
        let mut input = create_input(None);
        input.name = "   ".to_owned();

        let error = create_arc(&connection, data_dir.path(), &input).unwrap_err();
        assert!(matches!(
            error,
            ArgmaxError::InvalidInput { ref issues, .. }
                if issues.iter().any(|issue| issue.code == "ARC_NAME_BLANK")
        ));
    }

    #[test]
    fn set_state_transitions_persist() {
        let database = database_with_project();
        let connection = database.connection();
        let data_dir = tempfile::tempdir().unwrap();
        let arc = create_arc(&connection, data_dir.path(), &create_input(None)).unwrap();

        let paused = set_arc_state(&connection, &arc.id, ArcState::Paused).unwrap();
        assert_eq!(paused.state, ArcState::Paused);
        let done = set_arc_state(&connection, &arc.id, ArcState::Done).unwrap();
        assert_eq!(done.state, ArcState::Done);
        assert_eq!(get_arc(&connection, &arc.id).unwrap().state, ArcState::Done);
    }

    #[test]
    fn deleting_coordinator_session_nulls_the_pointer() {
        let database = database_with_project();
        let connection = database.connection();
        let data_dir = tempfile::tempdir().unwrap();
        let arc = create_arc(&connection, data_dir.path(), &create_input(None)).unwrap();

        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w1".to_owned(),
                project_id: "p1".to_owned(),
                task_label: "Coordinator".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: "/tmp/project-one".to_owned(),
                state: "running".to_owned(),
                shared_workspace: true,
                kind: "git".to_owned(),
                dirty: false,
                changed_files: 0,
            },
        )
        .unwrap();
        persist_session(
            &connection,
            &PersistSessionInput {
                id: "s1".to_owned(),
                workspace_id: "w1".to_owned(),
                provider: "claude".to_owned(),
                model_label: "Sonnet".to_owned(),
                model_id: "sonnet".to_owned(),
                reasoning_effort: None,
                permission_mode: None,
                agent_mode: None,
                prompt: "Coordinate".to_owned(),
                state: crate::sessions::state::SessionState::Running,
            },
        )
        .unwrap();

        let updated = set_arc_coordinator_session(&connection, &arc.id, Some("s1")).unwrap();
        assert_eq!(updated.coordinator_session_id, Some("s1".to_owned()));

        connection
            .execute("DELETE FROM sessions WHERE id = ?", ["s1"])
            .unwrap();
        assert_eq!(
            get_arc(&connection, &arc.id)
                .unwrap()
                .coordinator_session_id,
            None
        );
    }

    #[test]
    fn update_rewrites_brief_file() {
        let database = database_with_project();
        let connection = database.connection();
        let data_dir = tempfile::tempdir().unwrap();
        let arc = create_arc(&connection, data_dir.path(), &create_input(None)).unwrap();

        let updated = update_arc(
            &connection,
            &arc.id,
            &ArcUpdateInput {
                name: Some("Renamed".to_owned()),
                brief: Some("New brief.".to_owned()),
            },
        )
        .unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.brief, "New brief.");
        assert_eq!(
            fs::read_to_string(PathBuf::from(&arc.dir).join("BRIEF.md")).unwrap(),
            "New brief."
        );
    }

    #[test]
    fn list_members_reports_project_and_workspace() {
        let database = database_with_project();
        let connection = database.connection();
        let data_dir = tempfile::tempdir().unwrap();
        let arc = create_arc(&connection, data_dir.path(), &create_input(None)).unwrap();

        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w1".to_owned(),
                project_id: "p1".to_owned(),
                task_label: "Member".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: "/tmp/project-one".to_owned(),
                state: "running".to_owned(),
                shared_workspace: true,
                kind: "git".to_owned(),
                dirty: false,
                changed_files: 0,
            },
        )
        .unwrap();
        persist_session(
            &connection,
            &PersistSessionInput {
                id: "s1".to_owned(),
                workspace_id: "w1".to_owned(),
                provider: "claude".to_owned(),
                model_label: "Sonnet".to_owned(),
                model_id: "sonnet".to_owned(),
                reasoning_effort: None,
                permission_mode: None,
                agent_mode: None,
                prompt: "Work".to_owned(),
                state: crate::sessions::state::SessionState::Running,
            },
        )
        .unwrap();
        connection
            .execute("UPDATE sessions SET arc_id = ? WHERE id = 's1'", [&arc.id])
            .unwrap();

        let members = list_members(&connection, &arc.id).unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].session_id, "s1");
        assert_eq!(members[0].project_id, "p1");
        assert_eq!(members[0].project_name, "p1");
        assert_eq!(members[0].workspace_id, "w1");
        assert_eq!(members[0].task_label, "Member");

        let summaries = list_arc_summaries(&connection).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].member_count, 1);
    }

    #[test]
    fn active_member_count_excludes_the_coordinator_and_terminal_states() {
        let database = database_with_project();
        let connection = database.connection();
        let data_dir = tempfile::tempdir().unwrap();
        let arc = create_arc(&connection, data_dir.path(), &create_input(None)).unwrap();

        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w1".to_owned(),
                project_id: "p1".to_owned(),
                task_label: "Members".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: "/tmp/project-one".to_owned(),
                state: "running".to_owned(),
                shared_workspace: true,
                kind: "git".to_owned(),
                dirty: false,
                changed_files: 0,
            },
        )
        .unwrap();
        for (id, state) in [
            ("coordinator", crate::sessions::state::SessionState::Running),
            (
                "running-member",
                crate::sessions::state::SessionState::Running,
            ),
            (
                "done-member",
                crate::sessions::state::SessionState::Complete,
            ),
        ] {
            persist_session(
                &connection,
                &PersistSessionInput {
                    id: id.to_owned(),
                    workspace_id: "w1".to_owned(),
                    provider: "claude".to_owned(),
                    model_label: "Sonnet".to_owned(),
                    model_id: "sonnet".to_owned(),
                    reasoning_effort: None,
                    permission_mode: None,
                    agent_mode: None,
                    prompt: "Work".to_owned(),
                    state,
                },
            )
            .unwrap();
            connection
                .execute("UPDATE sessions SET arc_id = ? WHERE id = ?", [&arc.id, id])
                .unwrap();
        }
        set_arc_coordinator_session(&connection, &arc.id, Some("coordinator")).unwrap();

        assert_eq!(
            count_active_members(&connection, &arc.id, Some("coordinator")).unwrap(),
            1
        );
        assert_eq!(count_active_members(&connection, &arc.id, None).unwrap(), 2);
    }

    #[test]
    fn launches_since_counts_by_started_at() {
        let database = database_with_project();
        let connection = database.connection();
        let data_dir = tempfile::tempdir().unwrap();
        let arc = create_arc(&connection, data_dir.path(), &create_input(None)).unwrap();

        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "w1".to_owned(),
                project_id: "p1".to_owned(),
                task_label: "Members".to_owned(),
                branch: "main".to_owned(),
                base_ref: "main".to_owned(),
                path: "/tmp/project-one".to_owned(),
                state: "running".to_owned(),
                shared_workspace: true,
                kind: "git".to_owned(),
                dirty: false,
                changed_files: 0,
            },
        )
        .unwrap();
        persist_session(
            &connection,
            &PersistSessionInput {
                id: "s1".to_owned(),
                workspace_id: "w1".to_owned(),
                provider: "claude".to_owned(),
                model_label: "Sonnet".to_owned(),
                model_id: "sonnet".to_owned(),
                reasoning_effort: None,
                permission_mode: None,
                agent_mode: None,
                prompt: "Work".to_owned(),
                state: crate::sessions::state::SessionState::Running,
            },
        )
        .unwrap();
        connection
            .execute("UPDATE sessions SET arc_id = ? WHERE id = 's1'", [&arc.id])
            .unwrap();

        let far_future = "2999-01-01T00:00:00.000Z";
        let far_past = "2000-01-01T00:00:00.000Z";
        assert_eq!(
            count_launches_since(&connection, &arc.id, far_past).unwrap(),
            1
        );
        assert_eq!(
            count_launches_since(&connection, &arc.id, far_future).unwrap(),
            0
        );
    }
}
