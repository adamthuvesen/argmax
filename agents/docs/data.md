# Data

SQLite is owned by Rust under [src-tauri/src/persistence](../../src-tauri/src/persistence). The database lives in Tauri app data as `argmax.sqlite`; WAL/SHM sidecars live next to it.

## Migrations

[migrations.rs](../../src-tauri/src/persistence/migrations.rs) contains the consolidated schema and checksum runner. Migrations are append-only. Never edit an applied migration: the boot path recomputes stored SHA-256 checksums and refuses drift.

FTS5 sidecars index timeline events and learnings. The initial Rust migration represents the current head schema from the pre-port schema. The squashed Electron `v1`–`v20` ledger it replaces is preserved for schema forensics in [legacy-migrations.md](../../src-tauri/docs/legacy-migrations.md).

## Repositories

Table-family modules (`projects.rs`, `workspaces.rs`, `sessions.rs`, `events.rs`, `approvals.rs`, `checks.rs`, `checkpoints.rs`, `usage.rs`, `learnings.rs`, `gh.rs`) expose typed reads/writes for services and IPC handlers.

Dashboard reads are intentionally split:

- `dashboard:list` returns projects, workspaces, sessions, checks, checkpoints.
- `dashboard:load` is the compatibility full snapshot.
- `session:events-since` pages selected-session events/raw output by SQLite `rowid`.
- `approvals:pending` is a separate focused read.

Raw provider output older than 7 days is pruned by the retention sweeper. `system:vacuum-database` runs `VACUUM` in a blocking task.
