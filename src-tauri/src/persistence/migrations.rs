use chrono::{SecondsFormat, Utc};
use phf::phf_map;
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::{ArgmaxError, ArgmaxResult};

pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub up: &'static str,
    pub affected_tables: &'static [&'static str],
    pub expected_columns: &'static phf::Map<&'static str, &'static [&'static str]>,
    pub requires_foreign_keys_off: bool,
}

const ALL_TABLES: &[&str] = &[
    "projects",
    "workspaces",
    "sessions",
    "raw_outputs",
    "events",
    "approvals",
    "checks",
    "checkpoints",
    "ui_state",
    "usage_events",
    "learnings",
    "gh_pr",
    "schema_migrations",
];

pub static EMPTY_EXPECTED_COLUMNS: phf::Map<&'static str, &'static [&'static str]> = phf_map! {};

// Post-v4 `workspaces` shape: the v1 column set plus `task_label_auto`. Kept
// separate from `EXPECTED_COLUMNS` (which still describes the v1 schema) so the
// v1 migration's own column check keeps passing — each migration validates the
// affected tables against its own expected set at its own point in history.
pub static WORKSPACES_AUTO_LABEL_COLUMNS: phf::Map<&'static str, &'static [&'static str]> = phf_map! {
    "workspaces" => &[
        "base_ref", "branch", "changed_files", "created_at", "dirty", "id",
        "last_activity_at", "path", "pinned", "project_id", "shared_workspace",
        "state", "task_label", "task_label_auto", "updated_at",
    ] as &'static [&'static str],
};

pub static EXPECTED_COLUMNS: phf::Map<&'static str, &'static [&'static str]> = phf_map! {
    "projects" => &[
        "check_commands_json", "created_at", "current_branch", "default_branch",
        "default_model_label", "default_provider", "id", "name", "repo_path",
        "repo_remote_name", "repo_remote_owner", "setup_command", "ui_preferences_json",
        "updated_at", "worktree_location",
    ] as &'static [&'static str],
    "workspaces" => &[
        "base_ref", "branch", "changed_files", "created_at", "dirty", "id",
        "last_activity_at", "path", "pinned", "project_id", "shared_workspace",
        "state", "task_label", "updated_at",
    ] as &'static [&'static str],
    "sessions" => &[
        "agent_mode", "attention", "cache_read_tokens", "cache_write_tokens",
        "completed_at", "cost_usd", "id", "input_tokens",
        "last_activity_at", "last_model_id", "model_id", "model_label",
        "output_tokens", "permission_mode", "prompt", "provider",
        "provider_conversation_id", "reasoning_effort", "started_at", "state",
        "workspace_id",
    ] as &'static [&'static str],
    "raw_outputs" => &["content", "created_at", "id", "session_id", "stream"] as &'static [&'static str],
    "events" => &["created_at", "id", "message", "payload_json", "session_id", "type"] as &'static [&'static str],
    "approvals" => &[
        "command", "created_at", "cwd", "id", "provider", "resolved_at",
        "risk_level", "session_id", "status",
    ] as &'static [&'static str],
    "checks" => &[
        "command", "completed_at", "exit_code", "id", "started_at", "status",
        "summary", "workspace_id",
    ] as &'static [&'static str],
    "checkpoints" => &[
        "branch", "created_at", "git_ref", "id", "label", "patch_path",
        "workspace_id",
    ] as &'static [&'static str],
    "ui_state" => &["key", "updated_at", "value_json"] as &'static [&'static str],
    "usage_events" => &[
        "cache_read_tokens", "cache_write_tokens", "cost_usd", "created_at",
        "event_id", "id", "input_tokens", "model_id", "output_tokens", "session_id",
    ] as &'static [&'static str],
    "learnings" => &[
        "created_at", "evidence_event_id", "evidence_session_id", "hits", "id",
        "kind", "last_seen_at", "project_id", "summary", "verified",
    ] as &'static [&'static str],
    "gh_pr" => &[
        "head_sha", "last_seen_check_state", "notified_at", "pr_number",
        "pr_state", "session_id", "updated_at",
    ] as &'static [&'static str],
    "schema_migrations" => &["applied_at", "checksum", "name", "version"] as &'static [&'static str],
};

pub static MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial_schema",
        up: INITIAL_SCHEMA,
        affected_tables: ALL_TABLES,
        expected_columns: &EXPECTED_COLUMNS,
        requires_foreign_keys_off: false,
    },
    Migration {
        version: 2,
        name: "dashboard_read_indexes",
        up: DASHBOARD_READ_INDEXES,
        affected_tables: &[],
        expected_columns: &EMPTY_EXPECTED_COLUMNS,
        requires_foreign_keys_off: false,
    },
    Migration {
        version: 3,
        name: "dashboard_extra_read_indexes",
        up: DASHBOARD_EXTRA_READ_INDEXES,
        affected_tables: &[],
        expected_columns: &EMPTY_EXPECTED_COLUMNS,
        requires_foreign_keys_off: false,
    },
    Migration {
        version: 4,
        name: "workspace_auto_label_flag",
        up: WORKSPACE_AUTO_LABEL_FLAG,
        affected_tables: &["workspaces"],
        expected_columns: &WORKSPACES_AUTO_LABEL_COLUMNS,
        requires_foreign_keys_off: false,
    },
];

// Tracks whether `task_label` is still the auto-generated title (1) or has been
// renamed by the user (0). The session-title generator only overwrites while
// this is 1, so a manual rename is never clobbered. Existing rows default to 1.
const WORKSPACE_AUTO_LABEL_FLAG: &str = r#"
ALTER TABLE workspaces ADD COLUMN task_label_auto INTEGER NOT NULL DEFAULT 1;
"#;

const DASHBOARD_READ_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity_id
  ON sessions(last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_last_activity_id
  ON sessions(workspace_id, last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_state
  ON sessions(state);
CREATE INDEX IF NOT EXISTS idx_workspaces_last_activity_id
  ON workspaces(last_activity_at DESC, id DESC);
"#;

const DASHBOARD_EXTRA_READ_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_raw_outputs_session_id
  ON raw_outputs(session_id);
CREATE INDEX IF NOT EXISTS idx_checks_started_id
  ON checks(started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_created_id
  ON checkpoints(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_created_id
  ON approvals(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_status_created_id
  ON approvals(status, created_at DESC, id DESC);
"#;

const INITIAL_SCHEMA: &str = r#"
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  current_branch TEXT NOT NULL,
  default_branch TEXT,
  default_provider TEXT NOT NULL,
  default_model_label TEXT NOT NULL,
  worktree_location TEXT NOT NULL,
  setup_command TEXT NOT NULL DEFAULT '',
  check_commands_json TEXT NOT NULL DEFAULT '[]',
  ui_preferences_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  repo_remote_owner TEXT,
  repo_remote_name TEXT
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_label TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  path TEXT NOT NULL,
  state TEXT NOT NULL,
  shared_workspace INTEGER NOT NULL DEFAULT 0 CHECK (shared_workspace IN (0, 1)),
  dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
  changed_files INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model_label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL,
  attention TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  last_activity_at TEXT NOT NULL,
  provider_conversation_id TEXT,
  model_id TEXT,
  reasoning_effort TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  last_model_id TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'auto-approve'
    CHECK (permission_mode IN ('auto-approve', 'ask-each-time')),
  agent_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (agent_mode IN ('auto', 'plan'))
);

CREATE TABLE raw_outputs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stream TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  provider TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  summary TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  branch TEXT NOT NULL,
  git_ref TEXT,
  patch_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE ui_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id TEXT,
  model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE learnings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pitfall', 'convention', 'command')),
  summary TEXT NOT NULL,
  evidence_session_id TEXT,
  evidence_event_id TEXT,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE gh_pr (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  last_seen_check_state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pr_state TEXT,
  notified_at TEXT,
  PRIMARY KEY (session_id, pr_number)
);

CREATE INDEX idx_workspaces_project_id ON workspaces(project_id);
CREATE INDEX idx_sessions_workspace_id ON sessions(workspace_id);
CREATE INDEX idx_events_session_created ON events(session_id, created_at);
CREATE INDEX idx_events_session_id ON events(session_id);
CREATE INDEX idx_events_created_at ON events(created_at);
CREATE INDEX idx_raw_outputs_session_created ON raw_outputs(session_id, created_at);
CREATE INDEX idx_raw_outputs_created_at ON raw_outputs(created_at);
CREATE INDEX idx_approvals_session_status ON approvals(session_id, status);
CREATE INDEX idx_approvals_status_created ON approvals(status, created_at);
CREATE INDEX idx_checks_workspace_started ON checks(workspace_id, started_at);
CREATE INDEX idx_usage_events_session ON usage_events(session_id);
CREATE INDEX idx_learnings_project ON learnings(project_id, last_seen_at DESC);
CREATE INDEX idx_gh_pr_session ON gh_pr(session_id);

CREATE VIRTUAL TABLE learnings_fts USING fts5(
  summary,
  content='learnings',
  content_rowid='rowid'
);

CREATE TRIGGER learnings_after_insert AFTER INSERT ON learnings BEGIN
  INSERT INTO learnings_fts (rowid, summary) VALUES (new.rowid, new.summary);
END;

CREATE TRIGGER learnings_after_delete AFTER DELETE ON learnings BEGIN
  INSERT INTO learnings_fts (learnings_fts, rowid, summary)
    VALUES ('delete', old.rowid, old.summary);
END;

CREATE TRIGGER learnings_after_update AFTER UPDATE OF summary ON learnings BEGIN
  INSERT INTO learnings_fts (learnings_fts, rowid, summary)
    VALUES ('delete', old.rowid, old.summary);
  INSERT INTO learnings_fts (rowid, summary) VALUES (new.rowid, new.summary);
END;

CREATE VIRTUAL TABLE events_fts USING fts5(
  message,
  content='events',
  content_rowid='rowid'
);

CREATE TRIGGER events_after_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, message) VALUES (new.rowid, new.message);
END;

CREATE TRIGGER events_after_delete AFTER DELETE ON events BEGIN
  INSERT INTO events_fts (events_fts, rowid, message)
    VALUES ('delete', old.rowid, old.message);
END;

CREATE TRIGGER events_after_update AFTER UPDATE OF message ON events BEGIN
  INSERT INTO events_fts (events_fts, rowid, message)
    VALUES ('delete', old.rowid, old.message);
  INSERT INTO events_fts (rowid, message) VALUES (new.rowid, new.message);
END;

"#;

#[derive(Debug)]
struct SchemaMigrationRow {
    version: u32,
    checksum: Option<String>,
}

pub fn run_migrations(connection: &mut Connection) -> ArgmaxResult<()> {
    run_migrations_with(connection, MIGRATIONS)
}

pub fn run_migrations_with(
    connection: &mut Connection,
    migrations: &[Migration],
) -> ArgmaxResult<()> {
    assert_migrations_contiguous(migrations)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(sqlite_error)?;
    ensure_schema_migrations_shape(connection)?;

    let applied_rows = {
        let mut statement = connection
            .prepare("SELECT version, checksum FROM schema_migrations")
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(SchemaMigrationRow {
                    version: row.get(0)?,
                    checksum: row.get(1)?,
                })
            })
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        rows
    };

    let mut applied_by_version = std::collections::HashMap::new();
    for row in applied_rows {
        applied_by_version.insert(row.version, row);
    }

    let mut ordered: Vec<&Migration> = migrations.iter().collect();
    ordered.sort_by_key(|migration| migration.version);
    for migration in ordered {
        match applied_by_version.get(&migration.version) {
            Some(applied) => verify_applied_checksum(migration, applied)?,
            None => apply_migration(connection, migration)?,
        }
    }

    verify_head_table_columns(connection, migrations)?;

    Ok(())
}

pub fn compute_migration_checksum(up: &str) -> String {
    let digest = Sha256::digest(up.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn ensure_schema_migrations_shape(connection: &Connection) -> ArgmaxResult<()> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              applied_at TEXT NOT NULL,
              checksum TEXT
            );
            "#,
        )
        .map_err(sqlite_error)
}

fn apply_migration(connection: &mut Connection, migration: &Migration) -> ArgmaxResult<()> {
    let restore_foreign_keys = migration.requires_foreign_keys_off;
    if restore_foreign_keys {
        connection
            .pragma_update(None, "foreign_keys", "OFF")
            .map_err(sqlite_error)?;
    }

    let apply_result = (|| {
        let tx = connection.transaction().map_err(sqlite_error)?;
        let checksum = compute_migration_checksum(migration.up);
        tx.execute_batch(migration.up).map_err(sqlite_error)?;

        if migration.requires_foreign_keys_off {
            let violations = foreign_key_violations(&tx)?;
            if !violations.is_empty() {
                return Err(migration_drift(format!(
                    "Migration v{} ({}) produced {} foreign-key violation(s): {}",
                    migration.version,
                    migration.name,
                    violations.len(),
                    violations.join("; ")
                )));
            }
        }

        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
            (
                migration.version,
                migration.name,
                Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                checksum.as_str(),
            ),
        )
        .map_err(sqlite_error)?;

        for table in migration.affected_tables {
            verify_table_columns(&tx, migration.expected_columns, table)?;
        }

        tx.commit().map_err(sqlite_error)
    })();

    if restore_foreign_keys {
        let restore_result = connection.pragma_update(None, "foreign_keys", "ON");
        if let Err(error) = restore_result {
            return Err(sqlite_error(error));
        }
    }

    apply_result
}

fn verify_applied_checksum(
    migration: &Migration,
    applied: &SchemaMigrationRow,
) -> ArgmaxResult<()> {
    let expected = compute_migration_checksum(migration.up);
    match &applied.checksum {
        Some(stored) if stored == &expected => Ok(()),
        Some(stored) => Err(migration_drift(format!(
            "Migration v{} ({}) checksum drift: stored={} expected={}",
            migration.version, migration.name, stored, expected
        ))),
        None => Err(migration_drift(format!(
            "Migration v{} ({}) has no stored checksum",
            migration.version, migration.name
        ))),
    }
}

pub fn assert_migrations_contiguous(migrations: &[Migration]) -> ArgmaxResult<()> {
    if migrations.is_empty() {
        return Ok(());
    }

    let mut versions: Vec<u32> = migrations
        .iter()
        .map(|migration| migration.version)
        .collect();
    versions.sort_unstable();

    if versions[0] != 1 {
        return Err(migration_drift(format!(
            "Migrations must start at v1, got v{}",
            versions[0]
        )));
    }

    for pair in versions.windows(2) {
        let [prev, next] = pair else { continue };
        if prev == next {
            return Err(migration_drift(format!(
                "Duplicate migration version: v{next}"
            )));
        }
        if *next != *prev + 1 {
            return Err(migration_drift(format!(
                "Migration version gap detected: missing v{}",
                prev + 1
            )));
        }
    }

    Ok(())
}

fn verify_table_columns(
    connection: &Connection,
    expected_columns: &phf::Map<&'static str, &'static [&'static str]>,
    table: &str,
) -> ArgmaxResult<()> {
    let Some(expected) = expected_columns.get(table) else {
        return Ok(());
    };
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(sqlite_error)?;
    let mut actual = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    actual.sort();

    let mut expected_sorted = expected.to_vec();
    expected_sorted.sort_unstable();

    if actual != expected_sorted {
        return Err(migration_drift(format!(
            "Schema drift on table \"{table}\": expected columns [{}], got [{}]",
            expected_sorted.join(", "),
            actual.join(", ")
        )));
    }

    Ok(())
}

fn verify_head_table_columns(
    connection: &Connection,
    migrations: &[Migration],
) -> ArgmaxResult<()> {
    let mut head_expected_columns = std::collections::HashMap::new();
    for migration in migrations {
        for table in migration.affected_tables {
            if migration.expected_columns.contains_key(table) {
                head_expected_columns.insert(*table, migration.expected_columns);
            }
        }
    }

    for (table, expected_columns) in head_expected_columns {
        verify_table_columns(connection, expected_columns, table)?;
    }
    Ok(())
}

fn foreign_key_violations(connection: &Connection) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(sqlite_error)?;
    let violations = statement
        .query_map([], |row| {
            Ok(format!(
                "table={} rowid={} parent={} fkid={}",
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?
            ))
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(violations)
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn migration_drift(detail: impl Into<String>) -> ArgmaxError {
    ArgmaxError::MigrationDrift {
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_schema_migration_creates_head_tables_and_fts_sidecars() {
        let mut connection = Connection::open_in_memory().expect("open db");
        run_migrations(&mut connection).expect("migrate");

        for table in ["projects", "sessions", "events", "learnings"] {
            verify_table_columns(&connection, &EXPECTED_COLUMNS, table).expect(table);
        }

        let fts_tables: Vec<String> = connection
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events_fts', 'learnings_fts') ORDER BY name",
            )
            .expect("prepare fts query")
            .query_map([], |row| row.get(0))
            .expect("query fts")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect fts");
        assert_eq!(fts_tables, vec!["events_fts", "learnings_fts"]);

        let rows = connection
            .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
            .expect("prepare checksum")
            .query_map([], |row| {
                Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query checksums")
            .collect::<Result<Vec<_>, _>>()
            .expect("checksum rows");
        assert_eq!(
            rows,
            vec![
                (1, compute_migration_checksum(INITIAL_SCHEMA)),
                (2, compute_migration_checksum(DASHBOARD_READ_INDEXES)),
                (3, compute_migration_checksum(DASHBOARD_EXTRA_READ_INDEXES)),
                (4, compute_migration_checksum(WORKSPACE_AUTO_LABEL_FLAG)),
            ]
        );

        let indexes: Vec<String> = connection
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
                  'idx_sessions_last_activity_id',
                  'idx_sessions_workspace_last_activity_id',
                  'idx_sessions_state',
                  'idx_workspaces_last_activity_id',
                  'idx_raw_outputs_session_id',
                  'idx_checks_started_id',
                  'idx_checkpoints_created_id',
                  'idx_approvals_created_id',
                  'idx_approvals_status_created_id'
                ) ORDER BY name",
            )
            .expect("prepare index query")
            .query_map([], |row| row.get(0))
            .expect("query indexes")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect indexes");
        assert_eq!(
            indexes,
            vec![
                "idx_approvals_created_id",
                "idx_approvals_status_created_id",
                "idx_checkpoints_created_id",
                "idx_checks_started_id",
                "idx_raw_outputs_session_id",
                "idx_sessions_last_activity_id",
                "idx_sessions_state",
                "idx_sessions_workspace_last_activity_id",
                "idx_workspaces_last_activity_id"
            ]
        );
    }

    #[test]
    fn rerunning_migrations_accepts_head_workspace_shape() {
        let mut connection = Connection::open_in_memory().expect("open db");
        run_migrations(&mut connection).expect("first migrate");
        run_migrations(&mut connection).expect("second migrate");

        verify_table_columns(&connection, &WORKSPACES_AUTO_LABEL_COLUMNS, "workspaces")
            .expect("head workspace shape");
    }

    #[test]
    fn checksum_drift_is_reported_for_applied_migration() {
        static EXPECTED: phf::Map<&'static str, &'static [&'static str]> = phf_map! {};
        let first = [Migration {
            version: 1,
            name: "drift_probe",
            up: "CREATE TABLE drift_probe (id TEXT PRIMARY KEY);",
            affected_tables: &[],
            expected_columns: &EXPECTED,
            requires_foreign_keys_off: false,
        }];
        let changed = [Migration {
            version: 1,
            name: "drift_probe",
            up: "CREATE TABLE drift_probe (id TEXT PRIMARY KEY, changed TEXT);",
            affected_tables: &[],
            expected_columns: &EXPECTED,
            requires_foreign_keys_off: false,
        }];

        let mut connection = Connection::open_in_memory().expect("open db");
        run_migrations_with(&mut connection, &first).expect("first migrate");
        let err = run_migrations_with(&mut connection, &changed).expect_err("drift");
        assert!(matches!(err, ArgmaxError::MigrationDrift { .. }));
    }

    #[test]
    fn events_rowid_is_monotonic_when_timestamps_tie() {
        let mut connection = Connection::open_in_memory().expect("open db");
        run_migrations(&mut connection).expect("migrate");
        seed_minimal_session(&connection);

        let timestamp = "2026-05-24T10:00:00.000Z";
        let mut insert = connection
            .prepare(
                "INSERT INTO events (id, session_id, type, message, payload_json, created_at) VALUES (?, 's1', 'message.delta', ?, '{}', ?)",
            )
            .expect("prepare insert");
        insert
            .execute(("e1", "first", timestamp))
            .expect("insert first");
        insert
            .execute(("e2", "second", timestamp))
            .expect("insert second");
        drop(insert);

        let rows: Vec<(i64, String)> = connection
            .prepare("SELECT rowid, id FROM events WHERE session_id = 's1' ORDER BY rowid ASC")
            .expect("prepare rowid")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query rowid")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect rowid");

        assert_eq!(rows[0].1, "e1");
        assert_eq!(rows[1].1, "e2");
        assert!(rows[0].0 < rows[1].0);
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
