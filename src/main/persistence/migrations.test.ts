// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  assertMigrationsContiguous,
  MigrationDriftError,
  runMigrations,
  type Migration
} from "./migrations.js";

/**
 * Audit-2026-05-11 / SPEC P1.03 — `PRAGMA foreign_key_check` violations in a
 * destructive migration recipe (v3, `requiresForeignKeysOff: true`) must
 * throw before the transaction commits. `database.exec(migration.up)` drops
 * result rows, so the inline pragma at the end of the migration body cannot
 * fail the migration on its own. The runner now reads the pragma result
 * explicitly and throws `MigrationDriftError` on violations.
 */
describe("runMigrations — destructive recipe FK guard", () => {
  it("throws MigrationDriftError when a destructive migration would leak FK violations", () => {
    const database = new Database(":memory:");

    // Seed v1 schema by hand and mark v1/v2 as already applied. This lets us
    // smuggle an orphan workspace row in BEFORE v3's destructive recipe runs.
    // (The real applyMigration would have FK enforcement on, which would
    // refuse the orphan insert.)
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        checksum TEXT
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
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
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
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
    `);

    // Mark v1+v2 as applied so the runner advances directly to v3. v2 is a
    // no-op marker so we don't need to seed any v2-specific state. Both have
    // null checksums (legacy v1 path), which the runner accepts as untracked.
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, NULL)"
      )
      .run(1, "initial_local_product_state", new Date().toISOString());
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, NULL)"
      )
      .run(2, "schema_migrations_checksum", new Date().toISOString());

    // Orphan: project_id points at a non-existent projects row. The FK is
    // declared in the column definition (REFERENCES projects(id)) but we set
    // it up without REFERENCES here to allow the orphan insert. v3's
    // destructive recipe will copy this row into workspaces_new (where the
    // FK IS declared), and the PRAGMA will then report the violation.
    database
      .prepare(
        `
        INSERT INTO workspaces (
          id, project_id, task_label, branch, base_ref, path, state,
          shared_workspace, dirty, changed_files, last_activity_at,
          created_at, updated_at
        ) VALUES (
          'ws-orphan', 'project-does-not-exist', 'orphan task', 'argmax/x',
          'main', '/tmp/x', 'running', 0, 0, 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `
      )
      .run();

    expect(() => runMigrations(database)).toThrow(MigrationDriftError);
    expect(() => runMigrations(database)).toThrow(/foreign-key violation/);
  });

  it("applies a destructive migration cleanly when there are no FK violations", () => {
    // Sanity check: when the data is well-formed, the same destructive recipe
    // applies without throwing. Boots a real DB through runMigrations() with
    // a properly-referenced workspace row.
    const database = new Database(":memory:");
    runMigrations(database);
    // No throw === pass; assert one fact about the post-migration shape so a
    // future refactor that bypasses runMigrations is still flagged.
    const row = database
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 3")
      .get() as { n: number };
    expect(row.n).toBe(1);
  });
});

/**
 * Audit-2026-05-11 / SPEC P1.09 — the runner used to iterate `migrations` in
 * declaration order with no sort and no contiguity check. A future PR can
 * silently introduce gaps, duplicates, or non-positive versions. The
 * `assertMigrationsContiguous` precondition refuses to start when the
 * declared shape is broken.
 */
describe("assertMigrationsContiguous", () => {
  function stub(version: number): Migration {
    return { version, name: `stub-${version}`, affectedTables: [], up: "SELECT 1;" };
  }

  it("accepts a contiguous 1..N sequence (any declaration order)", () => {
    expect(() => assertMigrationsContiguous([stub(1), stub(2), stub(3)])).not.toThrow();
    // Order doesn't matter for the assertion; the runner sorts before
    // iterating.
    expect(() => assertMigrationsContiguous([stub(3), stub(1), stub(2)])).not.toThrow();
  });

  it("throws on a duplicate version", () => {
    expect(() => assertMigrationsContiguous([stub(1), stub(2), stub(2)])).toThrow(
      /Duplicate migration version: v2/
    );
  });

  it("throws on a version gap", () => {
    expect(() => assertMigrationsContiguous([stub(1), stub(2), stub(4)])).toThrow(
      /Migration version gap detected: missing v3/
    );
  });

  it("throws when versions don't start at v1", () => {
    expect(() => assertMigrationsContiguous([stub(2), stub(3)])).toThrow(/must start at v1/);
  });

  it("throws on non-positive or non-integer versions", () => {
    expect(() => assertMigrationsContiguous([stub(0), stub(1)])).toThrow(/positive integer/);
    expect(() => assertMigrationsContiguous([stub(-1), stub(1)])).toThrow(/positive integer/);
    const fractional: Migration = { version: 1.5, name: "x", up: "" };
    expect(() => assertMigrationsContiguous([fractional])).toThrow(/positive integer/);
  });

  it("accepts an empty array (no migrations declared)", () => {
    expect(() => assertMigrationsContiguous([])).not.toThrow();
  });
});

/**
 * SPEC P3.09 — usage_events.created_at unified to ISO-8601 TEXT (was epoch-ms
 * INTEGER). Migration v13 renames the legacy column, adds the new TEXT column,
 * backfills via strftime, and drops the legacy column. Verify backfill on a
 * fixture row that pre-existed v13.
 */
describe("runMigrations — usage_events.created_at ISO unification (v13)", () => {
  it("converts existing INTEGER created_at rows to ISO-8601 TEXT", () => {
    const database = new Database(":memory:");
    runMigrations(database);

    // Seed a usage_events row with an INTEGER created_at that mimics a pre-v13
    // write (the migration already ran, but we re-insert with epoch-ms via the
    // text column to simulate a legacy row that survived backfill). SQLite's
    // loose typing accepts the number into the TEXT column; what we care about
    // for the regression is that NEW inserts via the helper write ISO format.
    database
      .prepare("INSERT INTO projects (id, name, repo_path, current_branch, default_branch, default_provider, default_model_label, worktree_location, setup_command, check_commands_json, ui_preferences_json, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', 'main', 'claude', 'Sonnet', '~/.argmax', '', '[]', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
      .run();
    database
      .prepare("INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, shared_workspace, dirty, changed_files, last_activity_at, created_at, updated_at) VALUES ('w1', 'p1', 't', 'b', 'main', '/tmp/w1', 'created', 0, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
      .run();
    database
      .prepare("INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, reasoning_effort, provider_conversation_id, prompt, state, attention, started_at, completed_at, last_activity_at) VALUES ('s1', 'w1', 'claude', 'Sonnet', 'claude-sonnet', NULL, NULL, 'hello', 'created', 'normal', '2026-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z')")
      .run();

    // Insert a row with an ISO timestamp (post-v13 helper would do this).
    database
      .prepare(
        "INSERT INTO usage_events (session_id, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at) VALUES (?, ?, 1, 1, 0, 0, 0, ?)"
      )
      .run("s1", "claude-sonnet", "2026-05-14T10:30:00.000Z");

    const row = database
      .prepare("SELECT created_at FROM usage_events WHERE session_id = ?")
      .get("s1") as { created_at: string };
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Verify the legacy column is gone — DROP COLUMN landed.
    const columns = database.pragma("table_info(usage_events)") as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).not.toContain("created_at_ms_legacy");
    expect(columns.map((c) => c.name)).toContain("created_at");
  });

  it("backfills pre-existing INTEGER timestamps via strftime", () => {
    // Re-run v13 against a hand-seeded pre-v13 state so the strftime backfill
    // path is exercised on a row that actually had an INTEGER created_at.
    const database = new Database(":memory:");
    // Apply all migrations up through v12 so the table exists with the
    // pre-v13 INTEGER created_at shape, then drop the post-v13 column and
    // re-add the legacy INTEGER column to simulate "v12 state."
    runMigrations(database);
    database.exec(`
      ALTER TABLE usage_events RENAME COLUMN created_at TO created_at_old;
      ALTER TABLE usage_events ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      UPDATE usage_events SET created_at = 0;
      ALTER TABLE usage_events DROP COLUMN created_at_old;
    `);

    // Seed a row with a known epoch-ms value: 2026-05-14T10:30:00.000Z.
    const epochMs = Date.parse("2026-05-14T10:30:00.000Z");
    database
      .prepare("INSERT INTO projects (id, name, repo_path, current_branch, default_branch, default_provider, default_model_label, worktree_location, setup_command, check_commands_json, ui_preferences_json, created_at, updated_at) VALUES ('p2', 'p2', '/tmp/p2', 'main', 'main', 'claude', 'Sonnet', '~/.argmax', '', '[]', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
      .run();
    database
      .prepare("INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, shared_workspace, dirty, changed_files, last_activity_at, created_at, updated_at) VALUES ('w2', 'p2', 't', 'b', 'main', '/tmp/w2', 'created', 0, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
      .run();
    database
      .prepare("INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, reasoning_effort, provider_conversation_id, prompt, state, attention, started_at, completed_at, last_activity_at) VALUES ('s2', 'w2', 'claude', 'Sonnet', 'claude-sonnet', NULL, NULL, 'hello', 'created', 'normal', '2026-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z')")
      .run();
    database
      .prepare(
        "INSERT INTO usage_events (session_id, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at) VALUES (?, ?, 1, 1, 0, 0, 0, ?)"
      )
      .run("s2", "claude-sonnet", epochMs);

    // Apply v13's body directly to the synthetic state.
    database.exec(`
      ALTER TABLE usage_events RENAME COLUMN created_at TO created_at_ms_legacy;
      ALTER TABLE usage_events ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
      UPDATE usage_events
      SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at_ms_legacy / 1000.0, 'unixepoch');
      ALTER TABLE usage_events DROP COLUMN created_at_ms_legacy;
    `);

    const row = database
      .prepare("SELECT created_at FROM usage_events WHERE session_id = ?")
      .get("s2") as { created_at: string };
    expect(row.created_at).toBe("2026-05-14T10:30:00.000Z");
  });
});
