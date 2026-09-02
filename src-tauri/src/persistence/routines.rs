use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;

use super::bool_to_i64;
use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq)]
pub struct UpsertRoutineInput {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub prompt: String,
    pub provider: String,
    pub model_label: String,
    pub model_id: String,
    pub worktree: bool,
    pub cron_expr: Option<String>,
    pub run_once_at: Option<String>,
    pub enabled: bool,
}

/// The launch- and schedule-facing fields the scheduler copies out of a due
/// row. Kept as a separate struct so `mark_routine_run` cannot drift into
/// launching.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutineLaunchFields {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub prompt: String,
    pub provider: String,
    pub model_label: String,
    pub model_id: String,
    pub worktree: bool,
    pub cron_expr: Option<String>,
    pub run_once_at: Option<String>,
    /// The row's enabled state before the attempt. `routines:run-now` fires
    /// paused routines too, and recording that run must not resume them.
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub prompt: String,
    pub provider: String,
    pub model_label: String,
    pub model_id: String,
    pub worktree: bool,
    pub cron_expr: Option<String>,
    pub run_once_at: Option<String>,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn list_routines(connection: &Connection) -> ArgmaxResult<Vec<Routine>> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT * FROM routines
        ORDER BY enabled DESC, next_run_at IS NULL, next_run_at ASC, name COLLATE NOCASE
        "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], row_to_routine)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn upsert_routine(
    connection: &Connection,
    input: &UpsertRoutineInput,
    next_run_at: Option<String>,
) -> ArgmaxResult<Routine> {
    let now = now_iso();
    let mut statement = connection
        .prepare_cached(
            r#"
        INSERT INTO routines (
            id, name, project_id, prompt, provider, model_label, model_id,
            worktree, cron_expr, run_once_at,
            enabled, next_run_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            project_id = excluded.project_id,
            prompt = excluded.prompt,
            provider = excluded.provider,
            model_label = excluded.model_label,
            model_id = excluded.model_id,
            worktree = excluded.worktree,
            cron_expr = excluded.cron_expr,
            run_once_at = excluded.run_once_at,
            enabled = excluded.enabled,
            next_run_at = excluded.next_run_at,
            last_error = NULL,
            updated_at = excluded.updated_at
        "#,
        )
        .map_err(sqlite_error)?;
    statement
        .execute((
            input.id.as_str(),
            input.name.as_str(),
            input.project_id.as_str(),
            input.prompt.as_str(),
            input.provider.as_str(),
            input.model_label.as_str(),
            input.model_id.as_str(),
            bool_to_i64(input.worktree),
            input.cron_expr.as_deref(),
            input.run_once_at.as_deref(),
            bool_to_i64(input.enabled),
            next_run_at.as_deref(),
            now.as_str(),
            now.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_routine_by_id(connection, &input.id)
}

pub fn delete_routine(connection: &Connection, id: &str) -> ArgmaxResult<()> {
    let mut statement = connection
        .prepare_cached("DELETE FROM routines WHERE id = ?")
        .map_err(sqlite_error)?;
    let changes = statement.execute([id]).map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("routine", id));
    }
    Ok(())
}

pub fn set_routine_enabled(
    connection: &Connection,
    id: &str,
    enabled: bool,
    next_run_at: Option<String>,
) -> ArgmaxResult<Routine> {
    let mut statement = connection
        .prepare_cached(
            "UPDATE routines SET enabled = ?, next_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
        )
        .map_err(sqlite_error)?;
    let changes = statement
        .execute((
            bool_to_i64(enabled),
            next_run_at.as_deref(),
            now_iso().as_str(),
            id,
        ))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("routine", id));
    }
    find_routine_by_id(connection, id)
}

/// Enabled routines whose stored `next_run_at` has passed. Ordered by due
/// time so several routines landing in the same tick launch oldest-first.
pub fn due_routines(connection: &Connection, now: &str) -> ArgmaxResult<Vec<RoutineLaunchFields>> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT * FROM routines
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC, id ASC
        "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([now], row_to_launch_fields)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn find_routine_by_id(connection: &Connection, id: &str) -> ArgmaxResult<Routine> {
    let mut statement = connection
        .prepare_cached("SELECT * FROM routines WHERE id = ?")
        .map_err(sqlite_error)?;
    match statement.query_row([id], row_to_routine) {
        Ok(routine) => Ok(routine),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("routine", id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

/// Records the outcome of a launch attempt. `next_run_at` is always provided
/// by the caller (the next occurrence, or a retry backoff) so a failure can
/// never leave a row due on every future tick.
pub fn mark_routine_run(
    connection: &Connection,
    id: &str,
    last_run_at: &str,
    next_run_at: Option<&str>,
    last_error: Option<&str>,
    enabled: bool,
) -> ArgmaxResult<()> {
    let mut statement = connection
        .prepare_cached(
            "UPDATE routines SET last_run_at = ?, next_run_at = ?, last_error = ?, enabled = ?, updated_at = ? WHERE id = ?",
        )
        .map_err(sqlite_error)?;
    let changes = statement
        .execute((
            last_run_at,
            next_run_at,
            last_error,
            bool_to_i64(enabled),
            now_iso().as_str(),
            id,
        ))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("routine", id));
    }
    Ok(())
}

fn row_to_routine(row: &Row<'_>) -> rusqlite::Result<Routine> {
    Ok(Routine {
        id: row.get("id")?,
        name: row.get("name")?,
        project_id: row.get("project_id")?,
        prompt: row.get("prompt")?,
        provider: row.get("provider")?,
        model_label: row.get("model_label")?,
        model_id: row.get("model_id")?,
        worktree: row.get::<_, i64>("worktree")? == 1,
        cron_expr: row.get("cron_expr")?,
        run_once_at: row.get("run_once_at")?,
        enabled: row.get::<_, i64>("enabled")? == 1,
        last_run_at: row.get("last_run_at")?,
        next_run_at: row.get("next_run_at")?,
        last_error: row.get("last_error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_launch_fields(row: &Row<'_>) -> rusqlite::Result<RoutineLaunchFields> {
    Ok(RoutineLaunchFields {
        id: row.get("id")?,
        name: row.get("name")?,
        project_id: row.get("project_id")?,
        prompt: row.get("prompt")?,
        provider: row.get("provider")?,
        model_label: row.get("model_label")?,
        model_id: row.get("model_id")?,
        worktree: row.get::<_, i64>("worktree")? == 1,
        cron_expr: row.get("cron_expr")?,
        run_once_at: row.get("run_once_at")?,
        enabled: row.get::<_, i64>("enabled")? == 1,
    })
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::Database;

    /// The real migrated schema, not a hand-copy: a fixture that drifts from
    /// the migration is how a missing `ON DELETE CASCADE` stays invisible.
    fn database_with_project() -> Database {
        let database = Database::open_in_memory().expect("open db");
        {
            let connection = database.connection();
            connection
                .execute(
                    r#"
                INSERT INTO projects (
                    id, name, repo_path, current_branch,
                    worktree_location, created_at, updated_at
                )
                VALUES ('p1', 'Demo', '/tmp/demo', 'main',
                        '/tmp/worktrees', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
                "#,
                    [],
                )
                .unwrap();
        }
        database
    }

    fn input(id: &str) -> UpsertRoutineInput {
        UpsertRoutineInput {
            id: id.to_string(),
            name: "Morning triage".to_string(),
            project_id: "p1".to_string(),
            prompt: "Triage the board".to_string(),
            provider: "claude".to_string(),
            model_label: "Opus 5".to_string(),
            model_id: "claude-opus-5".to_string(),
            worktree: true,
            cron_expr: Some("0 0 9 * * *".to_string()),
            run_once_at: None,
            enabled: true,
        }
    }

    #[test]
    fn upsert_then_list_returns_row() {
        let database = database_with_project();
        let connection = database.connection();
        upsert_routine(
            &connection,
            &input("r1"),
            Some("2026-01-01T09:00:00.000Z".into()),
        )
        .unwrap();
        let rows = list_routines(&connection).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "r1");
        assert!(rows[0].worktree);
        assert_eq!(rows[0].cron_expr.as_deref(), Some("0 0 9 * * *"));
    }

    #[test]
    fn due_routines_only_returns_enabled_past_rows_in_order() {
        let database = database_with_project();
        let connection = database.connection();
        upsert_routine(
            &connection,
            &input("a"),
            Some("2026-01-01T08:00:00.000Z".into()),
        )
        .unwrap();
        upsert_routine(
            &connection,
            &input("b"),
            Some("2026-01-01T07:00:00.000Z".into()),
        )
        .unwrap();
        set_routine_enabled(&connection, "a", false, None).unwrap();
        let due = due_routines(&connection, "2026-01-01T09:00:00.000Z").unwrap();
        assert_eq!(
            due.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["b"]
        );
        assert!(due[0].enabled);
    }

    #[test]
    fn mark_run_persists_outcome_and_disables_once_rows() {
        let database = database_with_project();
        let connection = database.connection();
        upsert_routine(
            &connection,
            &input("r1"),
            Some("2026-01-01T09:00:00.000Z".into()),
        )
        .unwrap();
        mark_routine_run(
            &connection,
            "r1",
            "2026-01-01T09:00:00.000Z",
            None,
            Some("launch failed"),
            false,
        )
        .unwrap();
        let routine = find_routine_by_id(&connection, "r1").unwrap();
        assert!(!routine.enabled);
        assert_eq!(routine.last_error.as_deref(), Some("launch failed"));
        assert_eq!(
            routine.last_run_at.as_deref(),
            Some("2026-01-01T09:00:00.000Z")
        );
    }

    /// `routines:run-now` reads its launch fields straight off the row, so the
    /// paused state has to travel with them or firing a paused task resumes it.
    #[test]
    fn launch_fields_carry_the_paused_state() {
        let database = database_with_project();
        let connection = database.connection();
        upsert_routine(
            &connection,
            &input("r1"),
            Some("2026-01-01T09:00:00.000Z".into()),
        )
        .unwrap();
        set_routine_enabled(&connection, "r1", false, None).unwrap();
        let paused = find_routine_by_id(&connection, "r1").unwrap();
        assert!(!paused.enabled);
    }

    #[test]
    fn removing_a_project_takes_its_routines_with_it() {
        let database = database_with_project();
        let connection = database.connection();
        upsert_routine(&connection, &input("r1"), None).unwrap();
        connection
            .execute("DELETE FROM projects WHERE id = 'p1'", [])
            .unwrap();
        assert!(list_routines(&connection).unwrap().is_empty());
    }

    #[test]
    fn delete_unknown_id_is_record_not_found() {
        let database = database_with_project();
        let connection = database.connection();
        let error = delete_routine(&connection, "missing").unwrap_err();
        assert_eq!(error.to_string(), "routine not found: missing");
    }
}
