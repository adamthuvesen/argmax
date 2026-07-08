# Data

SQLite is owned by Rust under [src-tauri/src/persistence](../src-tauri/src/persistence). The database lives in Tauri app data as `argmax.sqlite`; WAL/SHM sidecars live next to it.

## Migrations

[migrations.rs](../src-tauri/src/persistence/migrations.rs) contains the consolidated schema and checksum runner. Migrations are append-only. Never edit an applied migration: the boot path recomputes stored SHA-256 checksums and refuses drift.

FTS5 sidecars index timeline events and learnings. The initial Rust migration is the schema baseline for the Tauri app data directory.

## Repositories

Table-family modules (`projects.rs`, `workspaces.rs`, `sessions.rs`, `events.rs`, `approvals.rs`, `checks.rs`, `checkpoints.rs`, `usage.rs`, `learnings.rs`, `gh.rs`) expose typed reads/writes for services and IPC handlers.

Dashboard reads are intentionally split:

- `dashboard:list` returns projects, workspaces, sessions, checks, checkpoints.
- `dashboard:load` returns the full snapshot used at boot and by browser-preview fixtures.
- `session:events-since` pages selected-session events/raw output by SQLite `rowid`.
- `approvals:pending` is a separate focused read.

Raw provider output older than 7 days is pruned by the retention sweeper. `system:vacuum-database` runs `VACUUM` in a blocking task.

## Subagent Trace Imports

Codex and Cursor child-agent traces are stored as normal timeline events. There
is no migration for this: `events.payload_json` already holds provider-specific
JSON. Imported rows use deterministic IDs in the form
`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`, and the
events repository inserts them only when absent so repeated pane opens are safe.
The one exception is a synthetic Cursor `traceNoOutput` completion: it holds
the sequence slot of a tool result that has not been written yet, and when a
later poll finds the real result under the same ID the row is upgraded in
place (same rowid) instead of being ignored.

Imported payloads carry the spawning `parent_tool_use_id`, `traceImported: true`,
`providerChildSessionId`, `traceSource`, and `traceSequence`. The parent chat
projection hides those child rows. `session:agent-events` reads them back for
the agent pane together with the parent launch/completion rows and any linked
Codex child-thread messages.
