//! The durable half of an "after this turn settles" disposal.
//!
//! `session_move` and `workspace_archive` answer `{scheduled: true}` while the
//! calling turn is still running, and the agent reports to the user on that
//! basis. Held only in memory, the promise died with the process: a quit or a
//! crash before the turn settled left the workspace live and the timeline
//! saying "scheduled" forever. One row per session records what was promised,
//! so the next launch can keep it.

use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};

use super::{json_error, sqlite_error, time::now_iso};
use crate::error::{ArgmaxError, ArgmaxResult};

/// The `action` column. Kept in step with the table's `CHECK` constraint.
const ACTION_ARCHIVE: &str = "archive";
const ACTION_MOVE: &str = "move";

/// What the session asked for, with everything the runner needs to carry it
/// out in a later process. The in-memory registry holds only the discriminant;
/// this is the part that has to survive a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AfterTurnAction {
    Archive(ArchiveRequest),
    Move(MoveRequest),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveRequest {
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveRequest {
    pub destination: MoveDestinationRecord,
    pub keep_source: bool,
    /// The turn the destination chat opens with. A move that arrived without
    /// it would strand the chat in the destination, so it is persisted with
    /// the rest of the request rather than rebuilt.
    pub prompt: String,
}

/// `workspaces::orchestration::MoveDestination` as a row. Deliberately its own
/// type: this shape is written to disk and read back by a later version of the
/// app, so it must not follow a refactor of the runtime enum silently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MoveDestinationRecord {
    Project { project_id: String, worktree: bool },
    Checkout { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AfterTurnRequest {
    pub session_id: String,
    pub action: AfterTurnAction,
    pub requested_at: String,
}

impl AfterTurnAction {
    fn column(&self) -> &'static str {
        match self {
            AfterTurnAction::Archive(_) => ACTION_ARCHIVE,
            AfterTurnAction::Move(_) => ACTION_MOVE,
        }
    }

    fn payload_json(&self) -> ArgmaxResult<String> {
        match self {
            AfterTurnAction::Archive(request) => serde_json::to_string(request),
            AfterTurnAction::Move(request) => serde_json::to_string(request),
        }
        .map_err(json_error)
    }

    fn from_row(action: &str, payload_json: &str) -> ArgmaxResult<Self> {
        match action {
            ACTION_ARCHIVE => serde_json::from_str(payload_json)
                .map(AfterTurnAction::Archive)
                .map_err(json_error),
            ACTION_MOVE => serde_json::from_str(payload_json)
                .map(AfterTurnAction::Move)
                .map_err(json_error),
            other => Err(ArgmaxError::service(
                "AFTER_TURN_ACTION_UNKNOWN",
                format!("Scheduled after-turn action '{other}' is not a known action."),
            )),
        }
    }
}

/// Record the promise. Fails when one is already recorded for the session:
/// both disposals end the chat, so a session holds at most one.
pub fn insert_after_turn(
    connection: &Connection,
    session_id: &str,
    action: &AfterTurnAction,
) -> ArgmaxResult<()> {
    connection
        .execute(
            r#"
            INSERT INTO session_after_turn (session_id, action, payload_json, requested_at)
            VALUES (?, ?, ?, ?)
            "#,
            (
                session_id,
                action.column(),
                action.payload_json()?,
                now_iso(),
            ),
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn delete_after_turn(connection: &Connection, session_id: &str) -> ArgmaxResult<()> {
    connection
        .execute(
            "DELETE FROM session_after_turn WHERE session_id = ?",
            [session_id],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn find_after_turn(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<AfterTurnRequest>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT session_id, action, payload_json, requested_at FROM session_after_turn WHERE session_id = ?",
        )
        .map_err(sqlite_error)?;
    let row = statement
        .query_row([session_id], read_row)
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(sqlite_error(other)),
        })?;
    row.map(build_request).transpose()
}

/// Every outstanding promise, oldest first — what boot recovery walks.
pub fn list_after_turn(connection: &Connection) -> ArgmaxResult<Vec<AfterTurnRequest>> {
    let mut statement = connection
        .prepare(
            "SELECT session_id, action, payload_json, requested_at FROM session_after_turn ORDER BY requested_at, session_id",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], read_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    rows.into_iter().map(build_request).collect()
}

/// Whether the source side of a move has already been recorded for this
/// session. A move that reached its seam is done, whatever the row still says.
/// It reads `events` rather than `session_after_turn`, but it is only ever
/// asked as part of deciding what to do with a row, so it lives with the row.
pub fn source_move_recorded(connection: &Connection, session_id: &str) -> ArgmaxResult<bool> {
    connection
        .query_row(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM events
                WHERE session_id = ?
                  AND type = 'session.moved'
                  AND json_extract(payload_json, '$.direction') = 'source'
            )
            "#,
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists != 0)
        .map_err(sqlite_error)
}

/// The raw row, before its payload is parsed — `query_map` cannot fail with an
/// `ArgmaxError`, so decoding happens once the rows are collected.
struct AfterTurnRow {
    session_id: String,
    action: String,
    payload_json: String,
    requested_at: String,
}

fn read_row(row: &Row<'_>) -> rusqlite::Result<AfterTurnRow> {
    Ok(AfterTurnRow {
        session_id: row.get("session_id")?,
        action: row.get("action")?,
        payload_json: row.get("payload_json")?,
        requested_at: row.get("requested_at")?,
    })
}

fn build_request(row: AfterTurnRow) -> ArgmaxResult<AfterTurnRequest> {
    Ok(AfterTurnRequest {
        action: AfterTurnAction::from_row(&row.action, &row.payload_json)?,
        session_id: row.session_id,
        requested_at: row.requested_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        persistence::{
            database::Database,
            projects::{persist_project, PersistProjectInput, ProjectSettings},
            sessions::{delete_session, persist_session, PersistSessionInput},
            workspaces::{persist_workspace, PersistWorkspaceInput},
        },
        sessions::state::SessionState,
    };

    fn database_with_session() -> Database {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        persist_project(
            &connection,
            &PersistProjectInput {
                id: "project-1".to_string(),
                name: "Project".to_string(),
                repo_path: "/tmp/project".to_string(),
                current_branch: "main".to_string(),
                default_branch: Some("main".to_string()),
                settings: ProjectSettings {
                    worktree_location: "/tmp/worktrees".to_string(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                    archive_on_merge: false,
                },
            },
        )
        .expect("project");
        persist_workspace(
            &connection,
            &PersistWorkspaceInput {
                id: "workspace-1".to_string(),
                project_id: "project-1".to_string(),
                task_label: "Task".to_string(),
                branch: "main".to_string(),
                base_ref: "main".to_string(),
                path: "/tmp/project".to_string(),
                state: "running".to_string(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("workspace");
        persist_session(
            &connection,
            &PersistSessionInput {
                id: "session-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                provider: "codex".to_string(),
                model_label: "GPT".to_string(),
                model_id: "gpt-5".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "Start".to_string(),
                state: SessionState::Running,
            },
        )
        .expect("session");
        drop(connection);
        database
    }

    fn move_action() -> AfterTurnAction {
        AfterTurnAction::Move(MoveRequest {
            destination: MoveDestinationRecord::Project {
                project_id: "project-2".to_string(),
                worktree: true,
            },
            keep_source: true,
            prompt: "Port the fix".to_string(),
        })
    }

    #[test]
    fn a_scheduled_action_survives_as_a_row_until_it_is_deleted() {
        let database = database_with_session();
        let connection = database.connection();
        insert_after_turn(&connection, "session-1", &move_action()).expect("insert");

        let listed = list_after_turn(&connection).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "session-1");
        assert_eq!(listed[0].action, move_action());
        assert!(!listed[0].requested_at.is_empty());
        assert_eq!(
            find_after_turn(&connection, "session-1").expect("find"),
            Some(listed[0].clone())
        );

        delete_after_turn(&connection, "session-1").expect("delete");
        assert!(list_after_turn(&connection).expect("list").is_empty());
        assert_eq!(
            find_after_turn(&connection, "session-1").expect("find"),
            None
        );
    }

    /// Both disposals end the chat, so the row is the durable half of the
    /// one-slot rule: a second insert is refused by the primary key.
    #[test]
    fn one_session_holds_one_scheduled_action() {
        let database = database_with_session();
        let connection = database.connection();
        insert_after_turn(&connection, "session-1", &move_action()).expect("insert");
        insert_after_turn(
            &connection,
            "session-1",
            &AfterTurnAction::Archive(ArchiveRequest {
                workspace_id: "workspace-1".to_string(),
            }),
        )
        .expect_err("the move already owns the slot");
    }

    /// A pruned session must not leave a promise behind for boot recovery to
    /// act on: the cascade is what keeps the two in step.
    #[test]
    fn deleting_the_session_takes_its_scheduled_action_with_it() {
        let database = database_with_session();
        let connection = database.connection();
        insert_after_turn(&connection, "session-1", &move_action()).expect("insert");
        delete_session(&connection, "session-1").expect("delete session");
        assert!(list_after_turn(&connection).expect("list").is_empty());
    }

    /// The two disposals are the whole vocabulary, and the table says so: a
    /// third spelling can never reach boot recovery as an unreadable row.
    #[test]
    fn the_table_refuses_an_action_it_does_not_know() {
        let database = database_with_session();
        let connection = database.connection();
        connection
            .execute(
                "INSERT INTO session_after_turn (session_id, action, payload_json, requested_at) VALUES ('session-1', 'delete', '{}', '2026-09-07T10:00:00.000Z')",
                [],
            )
            .expect_err("only move and archive are actions");
    }

    #[test]
    fn a_row_naming_an_unknown_action_is_reported_rather_than_skipped() {
        let database = database_with_session();
        let connection = database.connection();
        connection
            .execute(
                "INSERT INTO session_after_turn (session_id, action, payload_json, requested_at) VALUES ('session-1', 'archive', '{\"unexpected\":true}', '2026-09-07T10:00:00.000Z')",
                [],
            )
            .expect("insert raw row");
        list_after_turn(&connection).expect_err("an unreadable payload is loud");
    }
}
