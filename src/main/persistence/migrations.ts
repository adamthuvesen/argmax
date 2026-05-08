import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_local_product_state",
    up: `
      CREATE TABLE IF NOT EXISTS projects (
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
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_label TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        path TEXT NOT NULL,
        state TEXT NOT NULL,
        shared_workspace INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0,
        changed_files INTEGER NOT NULL DEFAULT 0,
        last_activity_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model_label TEXT NOT NULL,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL,
        attention TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        last_activity_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS raw_outputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        stream TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
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

      CREATE TABLE IF NOT EXISTS checks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        summary TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        branch TEXT NOT NULL,
        git_ref TEXT,
        patch_path TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ui_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_project_id ON workspaces(project_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_events_session_created ON events(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_raw_outputs_session_created ON raw_outputs(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_session_status ON approvals(session_id, status);
      CREATE INDEX IF NOT EXISTS idx_checks_workspace_started ON checks(workspace_id, started_at);
    `
  }
];

export function runMigrations(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    database
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version)
  );

  const applyMigration = database.transaction((migration: Migration) => {
    database.exec(migration.up);
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of migrations) {
    if (!applied.has(migration.version)) {
      applyMigration(migration);
    }
  }
}
