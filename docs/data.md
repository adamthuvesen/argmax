# Data

Rust manages SQLite storage under [src-tauri/src/persistence](../src-tauri/src/persistence). The database file is `argmax.sqlite` in the Tauri app data folder, operating with WAL and SHM sidecars.

## Migrations

[migrations.rs](../src-tauri/src/persistence/migrations.rs) runs append-only schema migrations with SHA-256 checksum verification on startup. Applied migrations must never be edited.

- FTS5 sidecar tables index timeline events and learnings.
- `synced_sessions` (v18) tracks sessions imported from external provider transcripts. See [session-sync.md](session-sync.md).
- `routines` (v19) stores scheduled task prompts and cadences. See [scheduled-tasks.md](scheduled-tasks.md).
- `routines` was normalized by v20. A pre-release v19 created it with `permission_mode` and `agent_mode` columns no code read, so every database that ran the draft failed the checksum and the app could not open its own store. `ACCEPTED_LEGACY_CHECKSUMS` names that one historical body — the check stays strict for unknown drift — and v20 rebuilds the table through an explicit column list, a no-op copy for databases that only saw the merged body. Editing an applied migration is still forbidden; this is the repair once it has already happened.
- `sessions.launched_by_session_id` and `sessions.launch_depth` (v23) record which session's agent launched this one and how deep the chain runs, which is what the launch caps are counted over. The parent reference is `ON DELETE SET NULL`: a pruned session must not take its children's transcripts with it. See [agent-tools.md](agent-tools.md).
- `projects` lost `default_provider`, `default_model_label` and `default_model_id` in v24. The default agent is app-wide, not per project: Settings → Agents holds one default model and one default effort, mirrored to `default-agent.json` in the app data dir for the launches Rust starts on its own. See [providers.md](providers.md).
- `session_messages` (v25) is the session inbox: one row per message an agent addressed to another session, plus the automatic `completion` notice a launched session leaves for whoever launched it. `delivered_at` records that the message also reached the recipient as a turn; `NULL` means it is still collectable by `inbox_read`. Indexed on `(to_session_id, delivered_at)`, which is the only query shape — the caller's undelivered mail. Both session references are `ON DELETE SET NULL`, so pruning one session never deletes another session's inbox history. See [agent-tools.md](agent-tools.md).
- `sessions.launch_kind` (v26) separates a chat an agent launched (`agent`, the default) from one a person dispatched from inside another chat (`multitask`). The launch caps count `agent` rows only, and a multitask records its parent for the link back while starting its own lineage at depth 0. It also reaches the renderer on `SessionSummary`, which is how the sidebar knows to leave a multitask out. See [multitask.md](multitask.md).
- `usage_scan_files`, `usage_hourly`, `usage_dedupe_keys`, and `usage_scan_meta` (v27) back the Usage page: a per-file scan cursor, an hourly token ledger keyed by provider, model, session, and source file, the billed-call keys that keep a resumed or forked session from counting twice, and the parser version. See [usage.md](usage.md).
- Legacy checkpoint tables are preserved for backward compatibility without creating new entries.

Reads take pooled `SQLITE_OPEN_READ_ONLY` connections through `Database::read_connection`, not the writer `Mutex<Connection>`, so a read never queues behind a write. A write attempted on the read path fails loudly; that is the point. See [performance.md](performance.md).

`routines` (v19) stores scheduled tasks: a prompt plus schedule that the
in-app scheduler launches as normal top-level sessions. See
[scheduled-tasks.md](scheduled-tasks.md).

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

Payloads include `parent_tool_use_id`, `traceImported: true`, `providerChildSessionId`, `traceSource`, and `traceSequence`. Child rows also carry `agentModelId` (and `agentReasoningEffort` where the provider reports one) — the model the *subagent* ran on, which the parent session's own model does not answer. Parent conversation views filter out child events, while `session:agent-events` fetches them for subagent panes.

Codex child traces also carry authoritative parent-thread lineage. If structured stdout omitted the matching `spawn_agent`, trace reconciliation stores a deterministic synthetic launch before importing the child. A later real launch reparents those child rows and supersedes the synthetic pair. Imported rows keep their `rowid` values. The synthetic rows are replaced by hidden tombstones with fresh `rowid` values so an incremental session read removes stale launch cards from an open renderer.
