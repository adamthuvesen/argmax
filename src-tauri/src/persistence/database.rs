use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use tokio::task::JoinSet;

use crate::error::{ArgmaxError, ArgmaxResult};

use super::migrations::run_migrations;
use crate::util::sync::LockOrRecover;

const PRUNE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const RAW_OUTPUT_RETENTION_DAYS: i64 = 7;

/// Idle reader connections kept alive between reads. Reads are short and the
/// pool only has to cover the handlers that can overlap — the webview, the
/// remote bridge, and a background sweep — so a small cap beats a large one:
/// every extra connection is its own page cache.
const MAX_IDLE_READERS: usize = 4;

/// Read-only connections onto the same WAL database.
///
/// One `Mutex<Connection>` for the whole app serialized readers behind writers
/// even though WAL exists precisely so they don't have to. Readers are opened
/// `SQLITE_OPEN_READ_ONLY`, which makes the split enforceable rather than
/// conventional: routing a write through the read path fails loudly instead of
/// silently taking the wrong lock.
struct ReaderPool {
    path: PathBuf,
    idle: Mutex<Vec<Connection>>,
}

/// A borrowed read connection. Derefs to `Connection`, so read call sites take
/// `&connection` exactly as they did behind the writer guard.
pub enum ReadGuard<'a> {
    /// A pooled reader, returned to the pool on drop.
    Pooled {
        pool: &'a ReaderPool,
        connection: Option<Connection>,
    },
    /// The writer connection — used for in-memory databases (a second handle
    /// would open a different database) and whenever opening a reader fails.
    Writer(MutexGuard<'a, Connection>),
}

impl Deref for ReadGuard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        match self {
            // `None` is only reachable after `Drop` has taken the connection,
            // and the guard is gone by then.
            ReadGuard::Pooled { connection, .. } => connection
                .as_ref()
                .expect("reader taken while still borrowed"),
            ReadGuard::Writer(guard) => guard,
        }
    }
}

impl Drop for ReadGuard<'_> {
    fn drop(&mut self) {
        let ReadGuard::Pooled { pool, connection } = self else {
            return;
        };
        let Some(connection) = connection.take() else {
            return;
        };
        let mut idle = pool.idle.lock_or_recover("reader pool");
        if idle.len() < MAX_IDLE_READERS {
            idle.push(connection);
        }
    }
}

pub struct Database {
    connection: Arc<Mutex<Connection>>,
    /// `None` for in-memory databases, which cannot be reopened by path.
    readers: Option<ReaderPool>,
    prune_tasks: Mutex<JoinSet<()>>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> ArgmaxResult<Self> {
        let path = path.as_ref().to_path_buf();
        let connection = Connection::open(&path).map_err(sqlite_error)?;
        Self::from_connection(connection, Some(path))
    }

    pub fn open_in_memory() -> ArgmaxResult<Self> {
        let connection = Connection::open_in_memory().map_err(sqlite_error)?;
        Self::from_connection(connection, None)
    }

    fn from_connection(mut connection: Connection, path: Option<PathBuf>) -> ArgmaxResult<Self> {
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
                    // Recover from a poisoned lock the same way `connection()`
                    // does instead of breaking the loop — otherwise a single
                    // panic elsewhere would permanently stop pruning and let
                    // raw_outputs grow without bound.
                    let connection = prune_connection.lock_or_recover("raw output prune");
                    if let Err(error) = prune_old_raw_outputs(&connection) {
                        tracing::warn!(error = ?error, "raw output prune failed");
                    }
                }
            });
        }

        // Migrations have run by now, so a reader opened here sees the head
        // schema. Readers are opened lazily; this only records where from.
        let readers = path.map(|path| ReaderPool {
            path,
            idle: Mutex::new(Vec::new()),
        });

        Ok(Self {
            connection,
            readers,
            prune_tasks: Mutex::new(prune_tasks),
        })
    }

    pub fn connection(&self) -> MutexGuard<'_, Connection> {
        // SQLite holds no in-memory invariants that survive panic, so a
        // poisoned guard is recoverable. Panicking here would turn one
        // bad row anywhere in the app into a permanent IPC outage that
        // only restart can clear.
        self.connection.lock_or_recover("database connection")
    }

    /// A connection for a read-only query.
    ///
    /// WAL lets readers run concurrently with the writer, so read handlers that
    /// take this never queue behind an in-flight write — and a long write (or a
    /// `VACUUM`) no longer stalls every reader in the app.
    pub fn read_connection(&self) -> ReadGuard<'_> {
        let Some(pool) = self.readers.as_ref() else {
            return ReadGuard::Writer(self.connection());
        };
        let pooled = pool.idle.lock_or_recover("reader pool").pop();
        let connection = match pooled {
            Some(connection) => connection,
            None => match open_reader(&pool.path) {
                Ok(connection) => connection,
                // Degrade to the writer rather than fail the read: a reader
                // that cannot open is a resource problem, not a data problem.
                Err(error) => {
                    tracing::warn!(?error, "could not open a read connection; using the writer");
                    return ReadGuard::Writer(self.connection());
                }
            },
        };
        ReadGuard::Pooled {
            pool,
            connection: Some(connection),
        }
    }

    /// Readers currently parked in the pool. Test-only visibility into reuse.
    pub fn idle_reader_count(&self) -> usize {
        self.readers
            .as_ref()
            .map(|pool| pool.idle.lock_or_recover("reader pool").len())
            .unwrap_or(0)
    }

    pub fn dispose(&self) {
        let mut tasks = self.prune_tasks.lock_or_recover("prune tasks");
        tasks.abort_all();
        tasks.detach_all();
    }

    pub fn prune_task_count(&self) -> usize {
        self.prune_tasks.lock_or_recover("prune tasks").len()
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        let mut tasks = self.prune_tasks.lock_or_recover("prune tasks");
        tasks.abort_all();
        tasks.detach_all();
    }
}

/// Open one read-only connection. `journal_mode` is a property of the database
/// file, not the connection, so a reader inherits WAL without setting it — and
/// could not set it anyway without write access.
fn open_reader(path: &Path) -> ArgmaxResult<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| sqlite_error_with("SQLITE_OPEN_READER", error))?;
    let _: i64 = connection
        .query_row("PRAGMA busy_timeout = 5000", [], |row| row.get(0))
        .map_err(|error| sqlite_error_with("SQLITE_PRAGMA_BUSY_TIMEOUT", error))?;
    Ok(connection)
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
    use std::time::Instant;

    /// The whole point of the reader pool: WAL lets a read run while a write is
    /// open, and a single shared `Mutex<Connection>` threw that away. Without
    /// the pool this read waits out the writer — which is how a `VACUUM` or a
    /// slow transaction froze every panel in the app at once.
    #[test]
    fn a_read_does_not_wait_for_an_open_write_transaction() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("concurrency.sqlite");
        let database = Arc::new(Database::open(&path).expect("open db"));
        // A table of our own keeps the test about locking rather than about
        // whichever columns the real schema currently requires.
        database
            .connection()
            .execute_batch("CREATE TABLE lock_probe (id INTEGER PRIMARY KEY);")
            .expect("probe table");

        let write_held = Duration::from_millis(400);
        let writer = {
            let database = Arc::clone(&database);
            std::thread::spawn(move || {
                let mut connection = database.connection();
                let transaction = connection.transaction().expect("begin");
                transaction
                    .execute("INSERT INTO lock_probe (id) VALUES (1)", [])
                    .expect("insert");
                std::thread::sleep(write_held);
                transaction.commit().expect("commit");
            })
        };

        // Let the writer take the lock before timing the read.
        std::thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        let count: i64 = database
            .read_connection()
            .query_row("SELECT COUNT(*) FROM lock_probe", [], |row| row.get(0))
            .expect("read during write");
        let read_took = started.elapsed();
        writer.join().expect("writer thread");

        // The uncommitted row is invisible to the reader, which is correct:
        // the read saw the last committed snapshot rather than blocking for one.
        assert_eq!(count, 0);
        assert!(
            read_took < write_held / 2,
            "read waited {read_took:?} for a {write_held:?} write; it is queued behind the writer"
        );
    }

    #[test]
    fn readers_are_returned_to_the_pool_and_reused() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("pool.sqlite");
        let database = Database::open(&path).expect("open db");
        assert_eq!(database.idle_reader_count(), 0);

        {
            let _first = database.read_connection();
            assert_eq!(
                database.idle_reader_count(),
                0,
                "in-flight reader is not idle"
            );
        }
        assert_eq!(database.idle_reader_count(), 1, "reader returns on drop");

        {
            let _reused = database.read_connection();
            assert_eq!(
                database.idle_reader_count(),
                0,
                "the parked reader is reused"
            );
        }
        assert_eq!(database.idle_reader_count(), 1);
    }

    /// Read-only opens make the read/write split enforceable instead of a
    /// convention someone can quietly break.
    #[test]
    fn a_write_through_the_read_path_fails_loudly() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("readonly.sqlite");
        let database = Database::open(&path).expect("open db");

        let error = database
            .read_connection()
            .execute("DELETE FROM projects", [])
            .expect_err("a write on the read path must fail");

        assert!(
            error.to_string().contains("readonly"),
            "expected a read-only rejection, got: {error}"
        );
    }

    /// In-memory databases cannot be reopened by path, so the pool is absent
    /// and reads fall back to the writer connection. Tests rely on this.
    #[test]
    fn an_in_memory_database_reads_through_the_writer() {
        let database = Database::open_in_memory().expect("open db");
        assert!(matches!(database.read_connection(), ReadGuard::Writer(_)));
    }

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
