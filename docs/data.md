# Data

Rust manages SQLite storage under [src-tauri/src/persistence](../src-tauri/src/persistence). The database file is `argmax.sqlite` in the Tauri app data folder, operating with WAL and SHM sidecars.

## Migrations

[migrations.rs](../src-tauri/src/persistence/migrations.rs) runs append-only schema migrations with SHA-256 checksum verification on startup. Applied migrations must never be edited.

- FTS5 sidecar tables index timeline events and learnings.
- `synced_sessions` (v18, with paired byte and line cursors added in v40) tracks sessions imported from external provider transcripts. See [session-sync.md](session-sync.md).
- `routines` (v19) stores scheduled task prompts and cadences. See [scheduled-tasks.md](scheduled-tasks.md).
- `routines` was normalized by v20. A pre-release v19 created it with `permission_mode` and `agent_mode` columns no code read, so every database that ran the draft failed the checksum and the app could not open its own store. `ACCEPTED_LEGACY_CHECKSUMS` names that one historical body — the check stays strict for unknown drift — and v20 rebuilds the table through an explicit column list, a no-op copy for databases that only saw the merged body. Editing an applied migration is still forbidden; this is the repair once it has already happened.
- `sessions.launched_by_session_id` and `sessions.launch_depth` (v23) record which session's agent launched this one and how deep the chain runs, which is what the launch caps are counted over. The parent reference is `ON DELETE SET NULL`: a pruned session must not take its children's transcripts with it. See [agent-tools.md](agent-tools.md).
- `projects` lost `default_provider`, `default_model_label` and `default_model_id` in v24. The default agent is app-wide, not per project: Settings → Agents holds one default model and one default effort, mirrored to `default-agent.json` in the app data dir for the launches Rust starts on its own. See [providers.md](providers.md).
- `session_messages` (v25) is the session inbox: one row per message an agent addressed to another session, plus the automatic `completion` notice a launched session leaves for whoever launched it. `delivered_at` records that the message also reached the recipient as a turn; `NULL` means it is still collectable by `inbox_read`. Indexed on `(to_session_id, delivered_at)`, which is the only query shape — the caller's undelivered mail. Both session references are `ON DELETE SET NULL`, so pruning one session never deletes another session's inbox history. See [agent-tools.md](agent-tools.md).
- `sessions.launch_kind` (v26) separates a chat an agent launched (`agent`, the default) from one a person dispatched from inside another chat (`multitask`). The launch caps count `agent` rows only, and a multitask records its parent for the link back while starting its own lineage at depth 0. It also reaches the renderer on `SessionSummary`, which is how the sidebar knows to leave a multitask out. See [multitask.md](multitask.md).
- `usage_scan_files`, `usage_hourly`, `usage_dedupe_keys`, and `usage_scan_meta` (v27) back the Usage page: a per-file scan cursor, an hourly token ledger keyed by provider, model, session, and source file, the billed-call keys that keep a resumed or forked session from counting twice, and the parser version. See [usage.md](usage.md).
- `usage_scan_files.parser_state` and `usage_contributions` (v39) make incremental usage scans equivalent to cold parsing. Provider state is committed with each file cursor, while normalized per-source billed calls retain enough information to replace partial Claude records and elect another transcript copy after deletion. See [usage.md](usage.md).
- `session_changes` and `session_change_watermarks` (v28) make transcript delivery recoverable. SQLite triggers record event and raw-output inserts, in-place updates, reparenting, and deletes in the same transaction as the source mutation. The feed keeps the newest 50,000 mutations globally and records a per-session prune watermark before removal.
- The v29 cleanup removes change-feed rows and watermarks when a session is hard-deleted. Session metadata is authoritative for removal, so retaining its child-row revisions would only leak disk space.
- `projects.archive_on_merge` (v31) is the per-project opt-in that lets the gh poller archive a workspace once the PR on its branch merges. `0`/`1`, defaulting to off. Isolated checkouts and their branches now move into the archive location. See [gh.md](gh.md).
- `pending_messages` (v32) journals pending follow-ups and their launch state before the composer acknowledges them. Restart recovery pauses unsent messages and identifies interrupted launches as delivery-unknown. See [runtime.md](runtime.md).
- `remote_operations` (v33) records admission and outcomes for remote mutations by client and operation UUID. Replays return the recorded result. A host restart with no recorded outcome never reruns the action. Request bodies are represented by a digest, while unresolved requests remain on the client until a confirmed outcome. See [remote.md](remote.md).
- `session_after_turn` (v34) is the disposal an agent scheduled for the end of its own turn: one row per session, `move` or `archive`, with the request in `payload_json`. The tool answers `{scheduled: true}` while the turn is still running, so the promise has to outlive the process that made it — without the row, a quit before the turn settled left the workspace live and the timeline saying "scheduled" forever. The registry writes and clears it alongside its in-memory guard, and boot recovery runs whatever is left. `ON DELETE CASCADE`: a pruned session takes its promise with it. See [agent-tools.md](agent-tools.md).
- `sessions.wait_reported_at` (v35) is the high-water mark the argument-less `session_wait` keeps per launched session: when its launcher was last handed that session's finish, NULL until it is. A child is reportable again only once a new turn moves `last_activity_at` past the mark, which every state write does. Without it, a parent that launched two children and collected the first was answered with that same child every time it asked about the second, forever. Named `sessions` waits read the rows without stamping them. See [agent-tools.md](agent-tools.md).
- `sessions.pr_branch_at_start`, `sessions.pr_branch_last_active`, and `gh_pr.attribution` (v37) separate shared-checkout session history from the checkout's live branch. Existing PR associations remain `legacy`, while new observations distinguish `inferred` and `explicit` evidence. These fields stay private to persistence. GitHub-owned PR state synchronizes within each project. See [gh.md](gh.md).
- `checkpoints` (v41) adds pinned worktree and index trees, HEAD, session boundaries, and recovery links to legacy checkpoint rows. `turn_boundary` holds the user-message event id a before-turn checkpoint was taken for, which is what maps a turn to its revert. `checkpoint_rewinds` journals each restore and its recovery checkpoint. Legacy rows remain readable but cannot restore files without tree snapshots.
- `goals` (v42) persists one row per Goal: its condition, state, evaluated turn count, turn budget, and the evaluator's last reason. A partial unique index on `session_id WHERE state = 'active'` is what enforces one active Goal per chat. Restart recovery stops Goals whose driver did not survive.
- `activity_commits`, `activity_scan_meta`, `activity_github_prs`, `activity_github_reviews`, and `activity_github_meta` (v44) back the Activity page: one row per commit SHA the user authored across every registered project, the sweep's parser version and matched author emails, and the cached `gh` half — authored pull requests, one row per review submission, and the login the cache belongs to. `activity_commits.project_id` deliberately carries no foreign key: the sweep reconciles it against the `projects` table, so a project removed while the app was closed is forgotten by the next sweep rather than by a cascade nobody ran. Timestamps are stored as RFC 3339 UTC because the ledger is range-scanned as text. See [activity.md](activity.md).
- `synced_session_tombstones` (v45) retains provider conversation ids for chats deliberately deleted in Settings, whether Argmax launched or imported them. Provider transcripts stay untouched on disk, and session sync consults these tombstones so those chats do not reappear.

Reads take pooled `SQLITE_OPEN_READ_ONLY` connections through `Database::read_connection`, not the writer `Mutex<Connection>`, so a read never queues behind a write. A write attempted on the read path fails loudly; that is the point. See [performance.md](performance.md).

`routines` (v19) stores scheduled tasks: a prompt plus schedule that the
in-app scheduler launches as normal top-level sessions. See
[scheduled-tasks.md](scheduled-tasks.md).

## Repositories

Typed modules (`projects.rs`, `workspaces.rs`, `sessions.rs`, `events.rs`, `approvals.rs`, `checks.rs`, `usage.rs`, `learnings.rs`, `gh.rs`, `routines.rs`) expose queries to services and IPC.

Focused reads in `dashboard.rs`:
- `dashboard:list`: Returns projects, workspaces, sessions, and checks.
- `session:events-since`: A cursorless request returns an authoritative bounded
  tail and its change-sequence high-water mark from the same read transaction.
  The tail is the newest 500 rows plus the newest 2000 durable rows (every
  type but `message.delta`), so a long thinking turn cannot push the user
  message and earlier turns out of the initial read; those turns come back
  without their thinking blocks, since `message.completed` carries the answer.
  Later requests page at most 500 durable changes, including updates and
  deletions. If a cursor predates its session's retained history or is ahead of
  the database, the response requests replacement with a fresh bounded tail.
  The older SQLite `rowid` cursors remain accepted for compatibility.

Native Cursor task runs persist the same lifecycle correlation fields as the
other native providers. The child id comes from
`tool_call.taskToolCall.result.success.agentId`, not the initial `args.agentId`.
Each invocation keeps its own `agentRunId` and `providerInvocationId`, while a
resume keeps the child id and parent conversation id.
- `approvals:pending`: Returns outstanding approval requests.

A background sweeper deletes raw provider output older than 7 days. `system:vacuum-database` runs `VACUUM` in a background task.

Settings can preview and permanently delete chats whose last activity is older than 7 days. The confirmed cleanup rechecks activity and protects active sessions, queued follow-ups, after-turn actions, active Goals, running checks, and live terminals. It removes chat attachments and empty workspace records so the sidebar has no ghost rows, while leaving every checkout and worktree on disk.

## Subagent Trace Persistence

Child traces from Codex and Cursor are stored directly in `events` rows using `payload_json`. Rows use deterministic IDs:
`trace:<provider>:<sessionId>:<parentToolUseId>:<childId>:<seq>:<kind>`

The repository uses insert-if-absent to avoid duplicate events across repeated pane loads. A temporary Cursor `traceNoOutput` placeholder is updated in place once the real tool output is parsed.

Payloads include `parent_tool_use_id`, `traceImported: true`, `providerChildSessionId`, `traceSource`, and `traceSequence`. Child rows also carry `agentModelId` (and `agentReasoningEffort` where the provider reports one) — the model the *subagent* ran on, which the parent session's own model does not answer. Parent conversation views filter out child events, while `session:agent-events` fetches them for subagent panes.

Claude native subagent lifecycle rows use the existing `events` table and `payload_json`. They carry the parent conversation id, child session id, parent tool id, provider invocation id, `agentRunId`, and a persisted `agentCodename`. Each native launch and `SendMessage` continuation has its own lifecycle pair, so `task_started` and `task_notification` do not stand in for the message delivery event. The renderer can query these rows after a backend restart, but only while the identity still belongs to the current parent conversation. Clearing, switching provider, or forking invalidates the reference without deleting the history. This behavior adds no migration.

Native agent reads return at most 2,000 events, including original launch metadata. The dock reports when earlier activity is omitted. Older events remain stored, but this view does not yet offer pagination.

Codex uses the same native identity and lifecycle fields. `spawn_agent` and
`send_input` to an idle child open assignments, while a terminal child state closes them.
Additional inputs delivered during an active assignment stay within that run.
The enclosing tool's completion alone is a delivery acknowledgement. Each
parent CLI invocation scopes Codex's reusable tool item IDs.
Child trace turns are attached only when their correspondence to native
assignments is unambiguous. Older trace history remains stored when it cannot
be assigned safely, and the native completion summary remains available.

Codex child traces also carry authoritative parent-thread lineage. If structured stdout omitted the matching `spawn_agent`, trace reconciliation stores a deterministic synthetic launch before importing the child. A later real launch reparents those child rows and supersedes the synthetic pair. Imported rows keep their `rowid` values. The synthetic rows are replaced by hidden tombstones with fresh `rowid` values so an incremental session read removes stale launch cards from an open renderer.

OpenCode native `task` launches persist the child session from the tool
metadata (`sessionId`) together with the parent conversation (`parentSessionId`)
and the task call id. A continuation supplies the same child as
`state.input.task_id`, so each parent invocation gets its own lifecycle run
while the renderer keeps one dock tab. OpenCode has no separate child trace
reader, and its parent stream carries the child result rather than child body
events.
