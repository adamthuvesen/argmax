// Project check outcomes: one row per suggestion the user answered or switch
// Argmax made (docs/routing.md#project-check). A check that found nothing to
// say is not stored. A `stayed` or `undone` row is a wrong call: the rows are
// what the classifier and its thresholds get fixed from.

use std::collections::HashMap;

use rusqlite::{params, Connection};

use super::{sqlite_error, time::now_iso};
use crate::error::ArgmaxResult;

/// Registered by migration v58.
pub const MIGRATION_SQL: &str = r#"
CREATE TABLE project_checks (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  current_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suggested_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  current_probability REAL NOT NULL,
  suggested_probability REAL NOT NULL,
  reasons TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('suggested', 'switched')),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'stayed', 'undone', 'cancelled')),
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
);
"#;

/// What the check decided, kept until the user answers it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectCheckRecord {
    pub id: String,
    pub created_at: String,
    pub prompt_hash: String,
    pub current_project_id: String,
    pub suggested_project_id: String,
    pub current_probability: f64,
    pub suggested_probability: f64,
    pub reasons: Vec<String>,
    /// `suggested` or `switched`.
    pub decision: &'static str,
}

/// Stores the check with its outcome, or updates the outcome of one already
/// stored: an automatic switch is `accepted` at launch and `undone` later.
pub fn record_project_check(
    connection: &Connection,
    record: &ProjectCheckRecord,
    outcome: &str,
    session_id: Option<&str>,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            INSERT INTO project_checks (
              id, created_at, resolved_at, prompt_hash, current_project_id,
              suggested_project_id, current_probability, suggested_probability,
              reasons, decision, outcome, session_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              resolved_at = excluded.resolved_at,
              outcome = excluded.outcome,
              session_id = COALESCE(excluded.session_id, project_checks.session_id)
            "#,
        )
        .map_err(sqlite_error)?
        .execute(params![
            record.id,
            record.created_at,
            now_iso(),
            record.prompt_hash,
            record.current_project_id,
            record.suggested_project_id,
            record.current_probability,
            record.suggested_probability,
            record.reasons.join("; "),
            record.decision,
            outcome,
            session_id,
        ])
        .map_err(sqlite_error)?;
    Ok(())
}

/// The opening prompts of the project's newest chats, newest first, with when
/// each started. Chats an agent launched carry the agent's wording, not the
/// user's, so they are left out — except an Arc member's, whose task is the
/// user's work in that project. A chat later moved to another checkout was
/// started in the wrong place, so it is no evidence for this one.
pub fn recent_opening_prompts(
    connection: &Connection,
    project_id: &str,
    limit: u32,
) -> ArgmaxResult<Vec<(String, String)>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT s.started_at, s.prompt FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
             WHERE w.project_id = ?
               AND (s.launched_by_session_id IS NULL OR s.arc_id IS NOT NULL)
               AND NOT EXISTS (
                 SELECT 1 FROM events e
                 WHERE e.session_id = s.id AND e.type = 'session.moved'
                   AND json_extract(e.payload_json, '$.direction') = 'source'
               )
             ORDER BY s.started_at DESC LIMIT ?",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![project_id, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Opening prompts in the project that are not the user's history there: an
/// agent's launch outside an Arc, and a chat moved elsewhere. Claude Code's
/// own transcripts hold these too, and cannot tell them apart.
pub fn prompts_not_history(connection: &Connection, project_id: &str) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT s.prompt FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
             WHERE w.project_id = ?
               AND ((s.launched_by_session_id IS NOT NULL AND s.arc_id IS NULL)
                 OR EXISTS (
                   SELECT 1 FROM events e
                   WHERE e.session_id = s.id AND e.type = 'session.moved'
                     AND json_extract(e.payload_json, '$.direction') = 'source'
                 ))",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Every directory the project's workspaces ran in: its checkout and each
/// worktree, which is where a provider CLI files that chat's transcript.
pub fn checkout_paths(connection: &Connection, project_id: &str) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached("SELECT DISTINCT path FROM workspaces WHERE project_id = ?")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Chats started per project since `since`: how much the user works in each.
pub fn launches_since(connection: &Connection, since: &str) -> ArgmaxResult<HashMap<String, i64>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT w.project_id, COUNT(*) FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
             WHERE s.started_at >= ? GROUP BY w.project_id",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![since], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(sqlite_error)?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(sqlite_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::database::Database;

    fn seed_projects(connection: &Connection) {
        for id in ["p-current", "p-other"] {
            connection
                .execute(
                    "INSERT INTO projects (id, name, repo_path, current_branch, worktree_location,
                       created_at, updated_at)
                     VALUES (?, ?, ?, 'main', 'sibling', '2026-01-01', '2026-01-01')",
                    params![id, id, format!("/tmp/{id}")],
                )
                .expect("project");
        }
    }

    fn record(decision: &'static str) -> ProjectCheckRecord {
        ProjectCheckRecord {
            id: "check-1".into(),
            created_at: now_iso(),
            prompt_hash: "hash".into(),
            current_project_id: "p-current".into(),
            suggested_project_id: "p-other".into(),
            current_probability: 0.01,
            suggested_probability: 0.98,
            reasons: vec!["Mentions p-other".into()],
            decision,
        }
    }

    #[test]
    fn an_undo_updates_the_switch_it_answers() {
        let database = Database::open_in_memory().expect("database");
        let connection = database.connection();
        seed_projects(&connection);

        record_project_check(&connection, &record("switched"), "accepted", None).expect("insert");
        record_project_check(&connection, &record("switched"), "undone", None).expect("update");

        let rows: Vec<(String, String)> = connection
            .prepare("SELECT decision, outcome FROM project_checks")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows, vec![("switched".to_string(), "undone".to_string())]);
    }
}
