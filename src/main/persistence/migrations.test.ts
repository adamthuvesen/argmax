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
