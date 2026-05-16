import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up: string;
  /**
   * Tables this migration creates or alters. After the migration applies,
   * the runner verifies that each named table's column set matches the
   * `expectedColumns` manifest below for that version. Drift fails fast.
   */
  affectedTables?: string[];
  /**
   * Set when the migration uses the destructive 12-step recipe (DROP TABLE +
   * RENAME) and references would cascade-delete dependent rows. The runner
   * toggles `PRAGMA foreign_keys = OFF` *before* the wrapping transaction
   * begins (the pragma is a no-op mid-transaction) and restores it after.
   */
  requiresForeignKeysOff?: boolean;
}

/**
 * Thrown by the migration runner when it detects schema drift. Two paths:
 *  1. A previously-applied migration's stored checksum no longer matches
 *     the source SQL (someone edited an applied migration).
 *  2. A just-applied migration's resulting `PRAGMA table_info` does not
 *     match the in-source expected column manifest.
 */
export class MigrationDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationDriftError";
  }
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_local_product_state",
    // workspaces is re-verified by v11's affectedTables (post-v11 manifest);
    // projects is re-verified by v12 (after ALTER TABLE adds the gh remote
    // columns). Including either here would compare the v1 column set to the
    // post-vN shape and fail. The table creations themselves still happen.
    affectedTables: [
      "raw_outputs",
      "events",
      "approvals",
      "checks",
      "checkpoints",
      "ui_state"
    ],
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
  },
  {
    version: 2,
    name: "schema_migrations_checksum",
    // No table reshape: the column is added directly by ensureSchemaMigrationsShape
    // before this row even gets to apply. This migration is purely a marker so
    // the v2-and-up checksum verification path activates.
    affectedTables: ["schema_migrations"],
    up: `
      -- Adds a checksum column on schema_migrations for drift detection.
      -- ensureSchemaMigrationsShape() runs the actual ALTER TABLE before any
      -- migration applies, so this body is intentionally a no-op SELECT.
      SELECT 1;
    `
  },
  {
    version: 3,
    name: "workspaces_check_constraints",
    // workspaces is re-verified by v11's affectedTables (post-v11 manifest);
    // setting it here would compare the v3 column set to the post-v11 shape
    // and fail. The check-constraint changes here still apply.
    affectedTables: [],
    // SQLite cannot ALTER TABLE to add a CHECK constraint, so we follow the
    // canonical destructive-migration recipe (https://sqlite.org/lang_altertable.html#otheralter):
    //
    //   1. PRAGMA foreign_keys = OFF       (outside any transaction)
    //   2. BEGIN                           (handled by the outer applyMigration transaction)
    //   3. CREATE TABLE workspaces_new (... with new constraints ...)
    //   4. INSERT INTO workspaces_new SELECT * FROM workspaces
    //   5. DROP TABLE workspaces
    //   6. ALTER TABLE workspaces_new RENAME TO workspaces
    //   7. (recreate indexes, triggers, views referring to the table)
    //   8. PRAGMA foreign_key_check        (validate before commit)
    //   9. COMMIT
    //  10. PRAGMA foreign_keys = ON        (outside the transaction)
    //
    // The runner toggles `foreign_keys` around the transaction (it's a no-op
    // when issued mid-transaction). Future destructive migrations should
    // follow the same shape and mark themselves with `requiresForeignKeysOff`.
    up: `
      CREATE TABLE workspaces_new (
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
        updated_at TEXT NOT NULL
      );

      INSERT INTO workspaces_new (
        id, project_id, task_label, branch, base_ref, path, state,
        shared_workspace, dirty, changed_files, last_activity_at,
        created_at, updated_at
      )
      SELECT
        id, project_id, task_label, branch, base_ref, path, state,
        CASE WHEN shared_workspace IN (0, 1) THEN shared_workspace ELSE 0 END,
        CASE WHEN dirty IN (0, 1) THEN dirty ELSE 0 END,
        changed_files, last_activity_at, created_at, updated_at
      FROM workspaces;

      DROP TABLE workspaces;
      ALTER TABLE workspaces_new RENAME TO workspaces;

      CREATE INDEX IF NOT EXISTS idx_workspaces_project_id ON workspaces(project_id);

      PRAGMA foreign_key_check;
    `,
    requiresForeignKeysOff: true
  },
  {
    version: 4,
    name: "sessions_provider_conversation_id",
    up: `
      ALTER TABLE sessions ADD COLUMN provider_conversation_id TEXT;
    `
  },
  {
    version: 5,
    name: "sessions_model_selection",
    // sessions is re-verified by v6's affectedTables (post-v6 manifest);
    // verifying it after v5 would compare to the post-v6 column set and fail.
    affectedTables: [],
    up: `
      ALTER TABLE sessions ADD COLUMN model_id TEXT;
      ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;

      UPDATE sessions
      SET
        model_id = CASE provider
          WHEN 'claude' THEN 'sonnet'
          WHEN 'codex' THEN 'gpt-5.3-codex'
          ELSE model_label
        END,
        reasoning_effort = CASE provider
          WHEN 'codex' THEN 'medium'
          ELSE NULL
        END
      WHERE model_id IS NULL;
    `
  },
  {
    version: 6,
    name: "sessions_cost_usage",
    // sessions is re-verified by v8's affectedTables (post-v8 manifest);
    // verifying it after v6 would compare to the post-v8 column set and fail.
    affectedTables: ["usage_events"],
    up: `
      ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;

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
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id);
    `
  },
  {
    version: 7,
    name: "dashboard_read_indexes",
    // Index-only migration: column shape is unchanged.
    affectedTables: [],
    up: `
      -- Backs 'SELECT * FROM events ORDER BY created_at DESC LIMIT 500'.
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

      -- Backs 'SELECT * FROM raw_outputs ORDER BY created_at DESC LIMIT 100'
      -- and the daily 'DELETE FROM raw_outputs WHERE created_at < ...' prune.
      CREATE INDEX IF NOT EXISTS idx_raw_outputs_created_at ON raw_outputs(created_at);

      -- Backs 'WHERE status = ? ORDER BY created_at DESC' (pending list)
      -- and the global approvals list.
      CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
    `
  },
  {
    version: 8,
    name: "sessions_last_model_id",
    // sessions is re-verified by v14's affectedTables (post-v14 manifest).
    affectedTables: [],
    up: `
      -- Denormalized fallback for the most recently observed provider model id.
      -- Populated from Codex turn_context events (and any usage event) so the
      -- cost panel can render a model label without joining usage_events for
      -- sessions that died before any token_count arrived.
      ALTER TABLE sessions ADD COLUMN last_model_id TEXT;
    `
  },
  {
    version: 9,
    name: "learnings_table",
    affectedTables: ["learnings"],
    up: `
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

      CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project_id, last_seen_at DESC);

      -- FTS5 sidecar so 'top-K by query against this project' is a single
      -- prepared query, not an O(N) scan in the renderer.
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
    `
  },
  {
    version: 10,
    name: "events_fts_sidecar",
    up: `
      -- FTS5 mirror of events.message + events.id so the renderer can run a
      -- single ranked query for cross-session text search instead of pulling
      -- the entire events table client-side. content_rowid binds the FTS5 row
      -- to the events row by sqlite rowid; we keep events.id as an indexed
      -- column so search results can join back without an extra lookup.
      CREATE VIRTUAL TABLE events_fts USING fts5(
        message,
        content='events',
        content_rowid='rowid'
      );

      -- Backfill any rows that already exist. New installs have an empty
      -- events table so this is a no-op; existing installs get the index
      -- populated in one shot.
      INSERT INTO events_fts (rowid, message)
        SELECT rowid, message FROM events;

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
    `
  },
  {
    version: 11,
    name: "workspaces_pinned",
    affectedTables: ["workspaces"],
    up: `
      -- Sticky-pinned sessions sort to the top of their project group in the
      -- sidebar. Boolean encoded as INTEGER per SQLite convention.
      ALTER TABLE workspaces ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
    `
  },
  {
    version: 12,
    name: "projects_remote_and_gh_pr",
    affectedTables: ["projects", "gh_pr"],
    up: `
      -- GitHub remote info for the CI feedback loop (P8.01). Owner + name come
      -- from 'gh repo view --json owner,name' and are stored once per project
      -- so PR polling for any session can resolve the repo without re-running
      -- gh on every refresh.
      ALTER TABLE projects ADD COLUMN repo_remote_owner TEXT;
      ALTER TABLE projects ADD COLUMN repo_remote_name TEXT;

      -- One row per (session, PR) pair so a session that's opened more than
      -- one PR (rare but possible) doesn't lose history. last_seen_check_state
      -- holds the rolled-up status from 'gh pr checks' so we can notice the
      -- transition to 'failed' without diffing per-check rows.
      CREATE TABLE gh_pr (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        last_seen_check_state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, pr_number)
      );

      CREATE INDEX IF NOT EXISTS idx_gh_pr_session ON gh_pr(session_id);
    `
  },
  {
    version: 13,
    name: "usage_events_created_at_iso",
    // The column set is unchanged after this migration — only the type
    // affinity of created_at flips from INTEGER to TEXT. SQLite is loosely
    // typed at the storage layer, so a manifest column-name check passes
    // regardless. The intent is documented for readers.
    affectedTables: ["usage_events"],
    up: `
      -- Convert usage_events.created_at from epoch-ms INTEGER to ISO-8601 TEXT
      -- to match every other timestamp in the schema. The column is write-only
      -- today (no read path consults it), so the format change is observation-
      -- ally invisible. New writes from insertUsageEvent emit ISO directly.
      --
      -- Backfill via SQLite strftime: legacy column is epoch-ms, divide by
      -- 1000.0 for unixepoch's seconds, format with millisecond precision.
      ALTER TABLE usage_events RENAME COLUMN created_at TO created_at_ms_legacy;
      ALTER TABLE usage_events ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
      UPDATE usage_events
      SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at_ms_legacy / 1000.0, 'unixepoch');
      ALTER TABLE usage_events DROP COLUMN created_at_ms_legacy;
    `
  },
  {
    version: 14,
    name: "sessions_permission_mode",
    affectedTables: ["sessions"],
    up: `
      ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'auto-approve'
        CHECK (permission_mode IN ('auto-approve', 'ask-each-time'));
    `
  },
  {
    version: 15,
    name: "sessions_agent_mode",
    // sessions is re-verified by v16's affectedTables (post-v16 manifest).
    affectedTables: [],
    up: `
      ALTER TABLE sessions ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'edit'
        CHECK (agent_mode IN ('edit', 'plan'));
    `
  },
  {
    version: 16,
    name: "tournaments",
    affectedTables: [
      "sessions",
      "tournaments",
      "tournament_contestants",
      "tournament_scores",
      "scoring_policies"
    ],
    up: `
      -- Sessions gain optional links to a parent tournament. Both columns are
      -- NULL for normal single-session launches; non-null for tournament
      -- contestants. contestant_index is stable per tournament so the UI can
      -- order contestants deterministically.
      ALTER TABLE sessions ADD COLUMN tournament_id TEXT REFERENCES tournaments(id) ON DELETE SET NULL;
      ALTER TABLE sessions ADD COLUMN contestant_index INTEGER;

      -- Scoring policy snapshots. The policy bound to a tournament is copied
      -- onto the tournament row at launch (see tournaments.policy_snapshot_json)
      -- so editing the source policy never retroactively changes a verdict.
      CREATE TABLE scoring_policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('user', 'project')),
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        is_built_in INTEGER NOT NULL DEFAULT 0 CHECK (is_built_in IN (0, 1)),
        criteria_json TEXT NOT NULL,
        auto_keep_rule_json TEXT NOT NULL DEFAULT '{}',
        ties_threshold REAL NOT NULL DEFAULT 0.05,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scoring_policies_scope ON scoring_policies(scope, project_id);

      -- Parent tournament. policy_snapshot_json freezes the policy at launch.
      -- workspace_id is the project-level workspace context the user launched
      -- from (sessions still own their own per-contestant worktree workspace).
      CREATE TABLE tournaments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_label TEXT NOT NULL,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'running', 'judging', 'awaiting-decision', 'decided', 'cancelled'
        )),
        quorum INTEGER NOT NULL,
        policy_id TEXT,
        policy_snapshot_json TEXT NOT NULL,
        verdict_json TEXT,
        decision_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tournaments_project ON tournaments(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tournaments_state ON tournaments(state);

      -- One row per contestant. (tournament_id, contestant_index) is the
      -- stable key; session_id is the live session the contestant is bound to
      -- and is unique per row.
      CREATE TABLE tournament_contestants (
        tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        contestant_index INTEGER NOT NULL,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_label TEXT NOT NULL,
        reasoning_effort TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN (
          'pending', 'in-quorum', 'outside-quorum', 'cancelled'
        )),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tournament_id, contestant_index)
      );

      CREATE INDEX IF NOT EXISTS idx_tournament_contestants_session ON tournament_contestants(session_id);

      -- One row per (contestant, criterion) pair. evidence_json holds runner-
      -- specific detail (failing test names, diff line counts, pricing snapshot
      -- id, etc.) so the leaderboard can render hover-evidence without joining.
      CREATE TABLE tournament_scores (
        tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        contestant_index INTEGER NOT NULL,
        criterion_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ok', 'inconclusive', 'disqualified')),
        raw_value REAL,
        normalized_value REAL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        scored_at TEXT NOT NULL,
        PRIMARY KEY (tournament_id, contestant_index, criterion_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tournament_scores_tournament ON tournament_scores(tournament_id);
    `
  },
  {
    version: 17,
    name: "scoring_policies_seed",
    // No table reshape — pure data seed. INSERT OR IGNORE so re-runs against an
    // already-seeded database (or one a user pre-populated) stay no-op.
    affectedTables: [],
    up: `
      INSERT OR IGNORE INTO scoring_policies (
        id, name, scope, project_id, is_built_in,
        criteria_json, auto_keep_rule_json, ties_threshold,
        created_at, updated_at
      ) VALUES
        (
          'builtin:correctness-first',
          'Correctness first',
          'user',
          NULL,
          1,
          '[{"id":"tests-pass","weight":3,"threshold":{"op":"==","value":1}},{"id":"lint-clean","weight":1,"threshold":{"op":"==","value":1}},{"id":"typecheck-clean","weight":1,"threshold":{"op":"==","value":1}},{"id":"diff-size-lines","weight":1},{"id":"wall-clock-seconds","weight":0.5}]',
          '{"min_total":0.85,"min_margin":0.10}',
          0.05,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ),
        (
          'builtin:smallest-diff',
          'Smallest diff (correctness gated)',
          'user',
          NULL,
          1,
          '[{"id":"tests-pass","weight":1,"threshold":{"op":"==","value":1}},{"id":"lint-clean","weight":0.5,"threshold":{"op":"==","value":1}},{"id":"typecheck-clean","weight":0.5,"threshold":{"op":"==","value":1}},{"id":"diff-size-lines","weight":3},{"id":"files-touched","weight":1}]',
          '{"min_total":0.80,"min_margin":0.10}',
          0.05,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ),
        (
          'builtin:cheapest-green',
          'Cheapest green (correctness gated)',
          'user',
          NULL,
          1,
          '[{"id":"tests-pass","weight":1,"threshold":{"op":"==","value":1}},{"id":"lint-clean","weight":0.5,"threshold":{"op":"==","value":1}},{"id":"typecheck-clean","weight":0.5,"threshold":{"op":"==","value":1}},{"id":"cost-usd","weight":3},{"id":"diff-size-lines","weight":1}]',
          '{"min_total":0.80,"min_margin":0.10}',
          0.05,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          strftime('%Y-%m-%dT%H:%M:%fZ','now')
        );
    `
  }
];

/**
 * Expected column-name set per table after each migration applies. The runner
 * compares this against `PRAGMA table_info(<table>)` and throws
 * `MigrationDriftError` on drift, catching cases where a migration's DDL
 * silently no-ops or produces an unexpected shape.
 *
 * Keys are table names; values are the sorted column-name list as of the
 * latest migration that touches the table. When a future migration alters a
 * table, update this manifest.
 */
const expectedColumns: Record<string, string[]> = {
  projects: [
    "check_commands_json",
    "created_at",
    "current_branch",
    "default_branch",
    "default_model_label",
    "default_provider",
    "id",
    "name",
    "repo_path",
    "repo_remote_name",
    "repo_remote_owner",
    "setup_command",
    "ui_preferences_json",
    "updated_at",
    "worktree_location"
  ],
  gh_pr: ["head_sha", "last_seen_check_state", "pr_number", "session_id", "updated_at"],
  workspaces: [
    "base_ref",
    "branch",
    "changed_files",
    "created_at",
    "dirty",
    "id",
    "last_activity_at",
    "path",
    "pinned",
    "project_id",
    "shared_workspace",
    "state",
    "task_label",
    "updated_at"
  ],
  learnings: [
    "created_at",
    "evidence_event_id",
    "evidence_session_id",
    "hits",
    "id",
    "kind",
    "last_seen_at",
    "project_id",
    "summary",
    "verified"
  ],
  sessions: [
    "agent_mode",
    "attention",
    "cache_read_tokens",
    "cache_write_tokens",
    "completed_at",
    "contestant_index",
    "cost_usd",
    "id",
    "input_tokens",
    "last_activity_at",
    "last_model_id",
    "model_id",
    "model_label",
    "output_tokens",
    "permission_mode",
    "prompt",
    "provider",
    "provider_conversation_id",
    "reasoning_effort",
    "started_at",
    "state",
    "tournament_id",
    "workspace_id"
  ],
  tournaments: [
    "created_at",
    "decided_at",
    "decision_json",
    "id",
    "policy_id",
    "policy_snapshot_json",
    "project_id",
    "prompt",
    "quorum",
    "state",
    "task_label",
    "updated_at",
    "verdict_json"
  ],
  tournament_contestants: [
    "config_json",
    "contestant_index",
    "created_at",
    "model_id",
    "model_label",
    "outcome",
    "provider",
    "reasoning_effort",
    "session_id",
    "tournament_id"
  ],
  tournament_scores: [
    "contestant_index",
    "criterion_id",
    "evidence_json",
    "normalized_value",
    "raw_value",
    "scored_at",
    "status",
    "tournament_id"
  ],
  scoring_policies: [
    "auto_keep_rule_json",
    "created_at",
    "criteria_json",
    "id",
    "is_built_in",
    "name",
    "project_id",
    "scope",
    "ties_threshold",
    "updated_at"
  ],
  usage_events: [
    "cache_read_tokens",
    "cache_write_tokens",
    "cost_usd",
    "created_at",
    "event_id",
    "id",
    "input_tokens",
    "model_id",
    "output_tokens",
    "session_id"
  ],
  raw_outputs: ["content", "created_at", "id", "session_id", "stream"],
  events: ["created_at", "id", "message", "payload_json", "session_id", "type"],
  approvals: [
    "command",
    "created_at",
    "cwd",
    "id",
    "provider",
    "resolved_at",
    "risk_level",
    "session_id",
    "status"
  ],
  checks: [
    "command",
    "completed_at",
    "exit_code",
    "id",
    "started_at",
    "status",
    "summary",
    "workspace_id"
  ],
  checkpoints: [
    "branch",
    "created_at",
    "git_ref",
    "id",
    "label",
    "patch_path",
    "workspace_id"
  ],
  ui_state: ["key", "updated_at", "value_json"],
  schema_migrations: ["applied_at", "checksum", "name", "version"]
};

/**
 * Computes a sha256 of the migration's `up` SQL. Used to detect drift
 * between an applied migration and the current source. Stored in full hex
 * (64 chars) on `schema_migrations.checksum` from v2 onwards. The v1 row
 * keeps `checksum = NULL` (legacy untracked) and is intentionally not
 * backfilled — backfilling would mask drift.
 */
function computeMigrationChecksum(up: string): string {
  return createHash("sha256").update(up).digest("hex");
}

interface SchemaMigrationRow {
  version: number;
  checksum: string | null;
}

/**
 * Ensures `schema_migrations` exists and has the `checksum` column.
 * Idempotent across launches: the v1 row created before the column existed
 * keeps `checksum = NULL` (treated as "legacy, untracked"); migrations
 * recorded after this column landed always store a non-null checksum.
 */
function ensureSchemaMigrationsShape(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const columns = database
    .prepare("PRAGMA table_info(schema_migrations)")
    .all() as Array<{ name: string }>;
  const hasChecksum = columns.some((column) => column.name === "checksum");
  if (!hasChecksum) {
    database.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
  }
}

/**
 * Refuse to start the runner if the declared migrations contain a gap, a
 * duplicate version, or a non-positive version. The runner currently
 * iterates in declaration order, but a future PR can land a v9.5 by mistake
 * or accidentally renumber a v10 → v8 — both produce silent corruption.
 * Fail fast at boot so the broken migration is the one we ship a fix for,
 * not the schema it left behind.
 */
export function assertMigrationsContiguous(list: Migration[]): void {
  if (list.length === 0) return;
  const versions = list.map((m) => m.version);
  const seen = new Set<number>();
  for (const v of versions) {
    if (!Number.isInteger(v) || v < 1) {
      throw new MigrationDriftError(`Migration version must be a positive integer, got ${v}`);
    }
    if (seen.has(v)) {
      throw new MigrationDriftError(`Duplicate migration version: v${v}`);
    }
    seen.add(v);
  }
  const sorted = [...versions].sort((a, b) => a - b);
  const min = sorted[0] ?? 1;
  const max = sorted[sorted.length - 1] ?? 1;
  if (min !== 1) {
    throw new MigrationDriftError(`Migrations must start at v1, got first version v${min}`);
  }
  if (max - min + 1 !== sorted.length) {
    const missing: number[] = [];
    for (let v = min; v <= max; v++) {
      if (!seen.has(v)) missing.push(v);
    }
    throw new MigrationDriftError(`Migration version gap detected: missing v${missing.join(", v")}`);
  }
}

function verifyTableColumns(database: Database.Database, table: string): void {
  const expected = expectedColumns[table];
  if (!expected) {
    return;
  }
  const rows = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  const actual = rows.map((row) => row.name).sort();
  const expectedSorted = [...expected].sort();
  if (actual.length !== expectedSorted.length || actual.some((name, i) => name !== expectedSorted[i])) {
    throw new MigrationDriftError(
      `Schema drift on table "${table}": expected columns [${expectedSorted.join(", ")}], ` +
        `got [${actual.join(", ")}]`
    );
  }
}

export function runMigrations(database: Database.Database): void {
  // Sort by version + assert contiguity. The declaration order of `migrations`
  // matches the version order today, but a future PR can silently introduce
  // a gap or a duplicate; assert here so the runner refuses to start instead
  // of producing an inconsistent schema state.
  assertMigrationsContiguous(migrations);
  const latestAffectedVersion = new Map<string, number>();
  for (const migration of migrations) {
    for (const table of migration.affectedTables ?? []) {
      const previous = latestAffectedVersion.get(table) ?? 0;
      if (migration.version > previous) {
        latestAffectedVersion.set(table, migration.version);
      }
    }
  }

  database.pragma("foreign_keys = ON");
  ensureSchemaMigrationsShape(database);

  const appliedRows = database
    .prepare("SELECT version, checksum FROM schema_migrations")
    .all() as SchemaMigrationRow[];
  const appliedByVersion = new Map<number, SchemaMigrationRow>();
  for (const row of appliedRows) {
    appliedByVersion.set(row.version, row);
  }

  const applyMigration = database.transaction((migration: Migration) => {
    const checksum = computeMigrationChecksum(migration.up);
    database.exec(migration.up);

    // Destructive recipes drop + recreate tables. A bug in the SELECT/INSERT
    // copy step can leave orphaned FK references. `PRAGMA foreign_key_check`
    // returns one row per violation; `exec()` discards rows so the inline
    // pragma at the end of a v3-style migration can't actually fail the
    // migration on its own — we have to read the result here.
    if (migration.requiresForeignKeysOff) {
      const violations = database
        .prepare("PRAGMA foreign_key_check")
        .all() as Array<Record<string, unknown>>;
      if (violations.length > 0) {
        throw new MigrationDriftError(
          `Migration v${migration.version} (${migration.name}) produced ${violations.length} foreign-key violation(s): ` +
            JSON.stringify(violations.slice(0, 5))
        );
      }
    }

    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)"
      )
      .run(migration.version, migration.name, new Date().toISOString(), checksum);

    // Post-migration verification: re-query schema_migrations to confirm the
    // row was actually persisted with the expected checksum. A discrepancy
    // here means something raced or the DDL silently failed; fail fast.
    const recorded = database
      .prepare("SELECT version, checksum FROM schema_migrations WHERE version = ?")
      .get(migration.version) as SchemaMigrationRow | undefined;
    if (!recorded || recorded.checksum !== checksum) {
      throw new MigrationDriftError(
        `Migration v${migration.version} (${migration.name}) failed post-apply verification`
      );
    }

    // Verify the resulting column manifest for each table this migration
    // touched. Drift fails the migration before the surrounding transaction
    // commits.
    for (const table of migration.affectedTables ?? []) {
      if (latestAffectedVersion.get(table) !== migration.version) continue;
      verifyTableColumns(database, table);
    }
  });

  const orderedMigrations = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of orderedMigrations) {
    const applied = appliedByVersion.get(migration.version);
    if (!applied) {
      // PRAGMA foreign_keys is a no-op while a transaction is open, so it
      // must be toggled around the wrapping transaction for the destructive
      // recipe to work. A `PRAGMA foreign_key_check` inside the migration
      // verifies referential integrity before the transaction commits.
      const restoreForeignKeys = migration.requiresForeignKeysOff
        ? (() => {
            database.pragma("foreign_keys = OFF");
            return () => database.pragma("foreign_keys = ON");
          })()
        : () => {};
      try {
        applyMigration(migration);
      } finally {
        restoreForeignKeys();
      }
      continue;
    }

    // Already applied: verify the stored checksum still matches the source.
    // A null stored checksum means the row was inserted before this column
    // existed (legacy v1) — accept it as untracked.
    if (applied.checksum === null) continue;

    const expected = computeMigrationChecksum(migration.up);
    if (applied.checksum !== expected) {
      throw new MigrationDriftError(
        `Migration v${migration.version} (${migration.name}) checksum drift: ` +
          `stored=${applied.checksum} expected=${expected}. ` +
          `The migration source has changed since it was applied; restore the original SQL ` +
          `or write a new migration instead of editing an applied one.`
      );
    }
  }
}
