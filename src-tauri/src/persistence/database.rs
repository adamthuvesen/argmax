use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;
use tokio::task::JoinSet;

use crate::error::{ArgmaxError, ArgmaxResult};

use super::migrations::run_migrations;

const PRUNE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const RAW_OUTPUT_RETENTION_DAYS: i64 = 7;

pub struct Database {
    connection: Arc<Mutex<Connection>>,
    prune_tasks: Mutex<JoinSet<()>>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> ArgmaxResult<Self> {
        let connection = Connection::open(path).map_err(sqlite_error)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> ArgmaxResult<Self> {
        let connection = Connection::open_in_memory().map_err(sqlite_error)?;
        Self::from_connection(connection)
    }

    fn from_connection(mut connection: Connection) -> ArgmaxResult<Self> {
        configure_connection(&connection)?;
        run_migrations(&mut connection)?;
        prune_old_raw_outputs(&connection)?;

        let connection = Arc::new(Mutex::new(connection));
        let mut prune_tasks = JoinSet::new();
        if tokio::runtime::Handle::try_current().is_ok() {
            let prune_connection = Arc::clone(&connection);
            prune_tasks.spawn(async move {
                let mut interval = tokio::time::interval(PRUNE_INTERVAL);
                loop {
                    interval.tick().await;
                    match prune_connection.lock() {
                        Ok(connection) => {
                            if let Err(error) = prune_old_raw_outputs(&connection) {
                                tracing::warn!(error = ?error, "raw output prune failed");
                            }
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "raw output prune lock poisoned");
                            break;
                        }
                    }
                }
            });
        }

        Ok(Self {
            connection,
            prune_tasks: Mutex::new(prune_tasks),
        })
    }

    pub fn connection(&self) -> MutexGuard<'_, Connection> {
        // SQLite holds no in-memory invariants that survive panic, so a
        // poisoned guard is recoverable. Panicking here would turn one
        // bad row anywhere in the app into a permanent IPC outage that
        // only restart can clear.
        self.connection.lock().unwrap_or_else(|poison| {
            tracing::warn!("database connection mutex was poisoned; recovering");
            poison.into_inner()
        })
    }

    pub fn dispose(&self) {
        if let Ok(mut tasks) = self.prune_tasks.lock() {
            tasks.abort_all();
            tasks.detach_all();
        }
    }

    pub fn prune_task_count(&self) -> usize {
        self.prune_tasks
            .lock()
            .map(|tasks| tasks.len())
            .unwrap_or(0)
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        if let Ok(mut tasks) = self.prune_tasks.lock() {
            tasks.abort_all();
            tasks.detach_all();
        }
    }
}

pub fn configure_connection(connection: &Connection) -> ArgmaxResult<()> {
    let _: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|error| sqlite_error_with("SQLITE_PRAGMA_JOURNAL", error))?;
    connection
        .execute("PRAGMA synchronous = NORMAL", [])
        .map_err(|error| sqlite_error_with("SQLITE_PRAGMA_SYNCHRONOUS", error))?;
    connection
        .execute("PRAGMA foreign_keys = ON", [])
        .map_err(|error| sqlite_error_with("SQLITE_PRAGMA_FOREIGN_KEYS", error))?;
    let _: i64 = connection
        .query_row("PRAGMA busy_timeout = 5000", [], |row| row.get(0))
        .map_err(|error| sqlite_error_with("SQLITE_PRAGMA_BUSY_TIMEOUT", error))?;
    let _: i64 = connection
        .query_row("PRAGMA wal_autocheckpoint = 1000", [], |row| row.get(0))
        .map_err(|error| sqlite_error_with("SQLITE_PRAGMA_WAL_AUTOCHECKPOINT", error))?;
    Ok(())
}

pub fn prune_old_raw_outputs(connection: &Connection) -> ArgmaxResult<usize> {
    connection
        .execute(
            "DELETE FROM raw_outputs
             WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)",
            [format!("-{RAW_OUTPUT_RETENTION_DAYS} days")],
        )
        .map_err(sqlite_error)
}

pub async fn vacuum_database(database: Arc<Database>) -> ArgmaxResult<()> {
    tokio::task::spawn_blocking(move || {
        let connection = database.connection();
        connection.execute("VACUUM", []).map_err(sqlite_error)?;
        Ok(())
    })
    .await
    .map_err(|error| ArgmaxError::service("VACUUM_JOIN", error.to_string()))?
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    sqlite_error_with("SQLITE", error)
}

fn sqlite_error_with(code: &str, error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service(code, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::migrations::MIGRATIONS;

    #[test]
    fn open_in_memory_configures_and_migrates() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();

        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign keys pragma");
        let synchronous: i64 = connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .expect("synchronous pragma");
        let migration_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("migration count");

        assert_eq!(foreign_keys, 1);
        assert_eq!(synchronous, 1);
        assert_eq!(migration_count, MIGRATIONS.len() as i64);
    }

    #[test]
    fn prune_removes_raw_outputs_older_than_retention() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        seed_minimal_session(&connection);

        connection
            .execute(
                "INSERT INTO raw_outputs (id, session_id, stream, content, created_at) VALUES ('old', 's1', 'stdout', 'old', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days'))",
                [],
            )
            .expect("insert old");
        connection
            .execute(
                "INSERT INTO raw_outputs (id, session_id, stream, content, created_at) VALUES ('fresh', 's1', 'stdout', 'fresh', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 days'))",
                [],
            )
            .expect("insert fresh");

        let deleted = prune_old_raw_outputs(&connection).expect("prune");
        let remaining: Vec<String> = connection
            .prepare("SELECT id FROM raw_outputs ORDER BY id")
            .expect("prepare remaining")
            .query_map([], |row| row.get(0))
            .expect("query remaining")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect remaining");

        assert_eq!(deleted, 1);
        assert_eq!(remaining, vec!["fresh"]);
    }

    #[tokio::test]
    async fn drop_aborts_prune_joinset() {
        let database = Database::open_in_memory().expect("open db");
        let task_count = database.prune_tasks.lock().expect("tasks").len();
        assert_eq!(task_count, 1);
        database.dispose();
        assert_eq!(database.prune_tasks.lock().expect("tasks").len(), 0);
    }

    #[tokio::test]
    async fn vacuum_database_runs_on_blocking_pool() {
        let database = Arc::new(Database::open_in_memory().expect("open db"));
        vacuum_database(Arc::clone(&database))
            .await
            .expect("vacuum");
    }

    fn seed_minimal_session(connection: &Connection) {
        let timestamp = "2026-05-24T10:00:00.000Z";
        connection
            .execute(
                "INSERT INTO projects (id, name, repo_path, current_branch, default_provider, default_model_label, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', 'claude', 'Sonnet', '~/.argmax', ?, ?)",
                (timestamp, timestamp),
            )
            .expect("insert project");
        connection
            .execute(
                "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES ('w1', 'p1', 'task', 'branch', 'main', '/tmp/w1', 'running', ?, ?, ?)",
                (timestamp, timestamp, timestamp),
            )
            .expect("insert workspace");
        connection
            .execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, prompt, state, attention, started_at, last_activity_at) VALUES ('s1', 'w1', 'claude', 'Sonnet', 'hello', 'running', 'normal', ?, ?)",
                (timestamp, timestamp),
            )
            .expect("insert session");
    }
}
