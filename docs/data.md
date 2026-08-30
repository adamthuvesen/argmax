# Data

Rust manages SQLite storage under [src-tauri/src/persistence](../src-tauri/src/persistence). The database file is `argmax.sqlite` in the Tauri app data folder, operating with WAL and SHM sidecars.

## Migrations

[migrations.rs](../src-tauri/src/persistence/migrations.rs) runs append-only schema migrations with SHA-256 checksum verification on startup. Applied migrations must never be edited.

- FTS5 sidecar tables index timeline events and learnings.
- `synced_sessions` (v18) tracks sessions imported from external provider transcripts. See [session-sync.md](session-sync.md).
- `routines` (v19) stores scheduled task prompts and cadences. See [scheduled-tasks.md](scheduled-tasks.md).
- Legacy checkpoint tables are preserved for backward compatibility without creating new entries.

## Repositories

Typed modules (`projects.rs`, `workspaces.rs`, `sessions.rs`, `events.rs`, `approvals.rs`, `checks.rs`, `usage.rs`, `learnings.rs`, `gh.rs`, `routines.rs`) expose queries to services and IPC.

Focused reads in `dashboard.rs`:
- `dashboard:list`: Returns projects, workspaces, sessions, and checks.
- `session:events-since`: Pages timeline events and raw output by SQLite `rowid`.
- `approvals:pending`: Returns outstanding approval requests.

A background sweeper deletes raw provider output older than 7 days. `system:vacuum-database` runs `VACUUM` in a background task.

## Subagent Trace Persistence

Child traces from Codex and Cursor are stored directly in `events` rows using `payload_json`. Rows use deterministic IDs:
`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`

The repository uses insert-if-absent to avoid duplicate events across repeated pane loads. A temporary Cursor `traceNoOutput` placeholder is updated in place once the real tool output is parsed.

Payloads include `parent_tool_use_id`, `traceImported: true`, `providerChildSessionId`, `traceSource`, and `traceSequence`. Parent conversation views filter out child events, while `session:agent-events` fetches them for subagent panes.
