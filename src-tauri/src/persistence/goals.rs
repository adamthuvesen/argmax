use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    goals::{Goal, GoalState},
};

use super::{sqlite_error, time::now_iso};

const GOAL_COLUMNS: &str =
    "id,workspace_id,session_id,condition,state,turns,max_turns,last_reason,created_at,updated_at";

/// Registered by the migration immediately after the checkpoint schema.
///
/// The leading drops make this body idempotent against the pre-reset shape,
/// which carried a step/check/review workflow and an attempt ledger. The
/// partial unique index is what enforces "one active goal per chat" — service
/// code never has to check for a second one.
pub const MIGRATION_SQL: &str = r#"
DROP TABLE IF EXISTS goal_attempts;
DROP TABLE IF EXISTS goals;
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  condition TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','achieved','impossible','stopped')),
  turns INTEGER NOT NULL DEFAULT 0,
  max_turns INTEGER NOT NULL,
  last_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_goals_active_session ON goals(session_id) WHERE state = 'active';
CREATE INDEX idx_goals_workspace ON goals(workspace_id);
"#;

pub fn insert_goal(connection: &Connection, goal: &Goal) -> ArgmaxResult<Goal> {
    connection
        .prepare_cached(
            "INSERT INTO goals (id,workspace_id,session_id,condition,state,turns,max_turns,last_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .map_err(sqlite_error)?
        .execute(params![
            goal.id,
            goal.workspace_id,
            goal.session_id,
            goal.condition,
            goal.state.as_str(),
            goal.turns,
            goal.max_turns,
            goal.last_reason,
            goal.created_at,
            goal.updated_at,
        ])
        .map_err(sqlite_error)?;
    find_goal(connection, &goal.id)
}

pub fn find_goal(connection: &Connection, goal_id: &str) -> ArgmaxResult<Goal> {
    connection
        .prepare(&format!("SELECT {GOAL_COLUMNS} FROM goals WHERE id = ?"))
        .map_err(sqlite_error)?
        .query_row([goal_id], goal_from_row)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => ArgmaxError::record_not_found("goal", goal_id),
            other => sqlite_error(other),
        })
}

pub fn find_active_goal_for_session(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<Goal>> {
    connection
        .prepare(&format!(
            "SELECT {GOAL_COLUMNS} FROM goals WHERE session_id = ? AND state = 'active'"
        ))
        .map_err(sqlite_error)?
        .query_row([session_id], goal_from_row)
        .optional()
        .map_err(sqlite_error)
}

pub fn list_goals(connection: &Connection, workspace_id: Option<&str>) -> ArgmaxResult<Vec<Goal>> {
    let sql = if workspace_id.is_some() {
        format!("SELECT {GOAL_COLUMNS} FROM goals WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC")
    } else {
        format!("SELECT {GOAL_COLUMNS} FROM goals ORDER BY updated_at DESC, id DESC")
    };
    let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
    let rows = if let Some(workspace_id) = workspace_id {
        statement.query_map([workspace_id], goal_from_row)
    } else {
        statement.query_map([], goal_from_row)
    }
    .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Records one judged turn: the running count plus whatever the evaluator said
/// about it. Only touches an active goal, so a driver that raced a `clear`
/// cannot resurrect a settled row.
pub fn update_goal_progress(
    connection: &Connection,
    goal_id: &str,
    turns: u32,
    last_reason: Option<&str>,
) -> ArgmaxResult<Option<Goal>> {
    let changed = connection
        .prepare_cached(
            "UPDATE goals SET turns=?,last_reason=?,updated_at=? WHERE id=? AND state='active'",
        )
        .map_err(sqlite_error)?
        .execute(params![turns, last_reason, now_iso(), goal_id])
        .map_err(sqlite_error)?;
    if changed == 0 {
        return Ok(None);
    }
    find_goal(connection, goal_id).map(Some)
}

/// Moves an active goal to a terminal state. Returns `None` when the goal was
/// already settled, which is how concurrent settles stay idempotent.
pub fn settle_goal(
    connection: &Connection,
    goal_id: &str,
    state: GoalState,
    reason: Option<&str>,
) -> ArgmaxResult<Option<Goal>> {
    let changed = connection
        .prepare_cached(
            "UPDATE goals SET state=?,last_reason=COALESCE(?,last_reason),updated_at=? WHERE id=? AND state='active'",
        )
        .map_err(sqlite_error)?
        .execute(params![state.as_str(), reason, now_iso(), goal_id])
        .map_err(sqlite_error)?;
    if changed == 0 {
        return Ok(None);
    }
    find_goal(connection, goal_id).map(Some)
}

/// Boot recovery: a goal whose driver died with the app is not being worked on
/// by anyone, so it hands control back rather than looking alive.
pub fn stop_orphaned_goals(connection: &Connection) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            "UPDATE goals SET state='stopped',last_reason=?,updated_at=? WHERE state='active'",
        )
        .map_err(sqlite_error)?
        .execute(params![
            "Argmax restarted while this goal was running.",
            now_iso()
        ])
        .map_err(sqlite_error)?;
    Ok(())
}

fn goal_from_row(row: &Row<'_>) -> rusqlite::Result<Goal> {
    let state: String = row.get("state")?;
    Ok(Goal {
        id: row.get("id")?,
        workspace_id: row.get("workspace_id")?,
        session_id: row.get("session_id")?,
        condition: row.get("condition")?,
        state: GoalState::from_wire(&state).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unknown goal state {state}"),
                )),
            )
        })?,
        turns: row.get("turns")?,
        max_turns: row.get("max_turns")?,
        last_reason: row.get("last_reason")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
