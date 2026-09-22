# Data

Rust manages SQLite storage under [src-tauri/src/persistence](../src-tauri/src/persistence). The database file is `local-state/argmax.sqlite` in the Tauri app data folder, operating with WAL and SHM sidecars. `ARGMAX_DATA_DIR` overrides that app data folder for scratch profiles.

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
- `workspaces.last_viewed_at` (v47) is the host-authoritative read watermark shared by desktop and mobile. Existing workspaces initialize it from `last_activity_at`; new workspaces initialize it at creation, and clients advance it only to an activity timestamp they actually displayed.
- `arcs` and `sessions.arc_id` (v51) back Arcs — see [Arcs](#arcs) below.
- `routines.arc_id` and a fourth `run_target`, `arc_coordinator` (v52), point a scheduled task at a live Arc's coordinator instead of a session or a fresh checkout. SQLite cannot widen `run_target`'s existing CHECK (v36's `ROUTINE_RUN_TARGET`) in place, so this rebuilds `routines` through an explicit column list, the same idiom v20 used to converge a draft schema. A second CHECK ties the pair together: `run_target = 'arc_coordinator'` if and only if `arc_id IS NOT NULL`. Existing rows carry no `arc_id` and keep whichever target they already had.
- v54 drops `idx_raw_outputs_session_created`. Transcript tail and page reads walk `idx_raw_outputs_session_id` in rowid order, and the retention sweep uses `idx_raw_outputs_created_at`; the composite index only served the legacy Cursor resume-id fallback, which is as fast on the single-column index. Dropping an index rewrites no rows; the freed pages return to the filesystem on the next Settings → Vacuum.

Reads take pooled `SQLITE_OPEN_READ_ONLY` connections through `Database::read_connection`, not the writer `Mutex<Connection>`, so a read never queues behind a write. A write attempted on the read path fails loudly; that is the point. See [performance.md](performance.md).

`routines` (v19) stores scheduled tasks: a prompt plus schedule that the
in-app scheduler launches as normal top-level sessions. `created_by` (v50)
names who put the task in the list — `user` for anything saved from the panel,
`agent` for a wake a chat set for itself with `schedule_followup` — and decides
what a spent one-shot leaves behind: the user's is disabled and kept, an
agent's is deleted. The migration backfills `agent` for the shape only a wake
had (a one-shot firing into the same chat) and clears the spent ones among
them. `arc_id` (v52) names the Arc an `arc_coordinator` task resolves its
recipient from at fire time — always the Arc's *current* coordinator, never a
cached session id. See [scheduled-tasks.md](scheduled-tasks.md).

## Arcs

`arcs` (v51) is a long-lived body of work that can span several registered
projects: `id`, `name`, `brief`, `state` (`active` / `paused` / `done`,
defaulting to `active`), `home_project_id` (`ON DELETE CASCADE`),
`coordinator_session_id` (`ON DELETE SET NULL`), `dir`, `created_at`, `updated_at`. The same
migration adds `sessions.arc_id` (`ON DELETE SET NULL`) so a chat can be
attached to an Arc, and an index on it.

`persistence/arcs.rs` owns both the table and the small domain rules around
it: a blank name is rejected, and every create/update keeps `dir`'s
`BRIEF.md` in sync with the row's `brief` column. The brief has exactly one
source of truth per create: no `dir` requires a non-blank typed brief
(`ARC_BRIEF_REQUIRED` otherwise) and makes the Arc's dir under
`<app data dir>/arcs/<id>/`, writing fresh `BRIEF.md`/`NOTES.md` into it. A
caller-supplied `dir` must already exist as an absolute path
(`ARC_DIR_INVALID` otherwise); an existing `BRIEF.md` there is read into the
row only when the typed brief is blank, a non-blank typed brief alongside an
existing `BRIEF.md` is rejected (`ARC_BRIEF_EXISTS`) rather than silently
diverging from the file, and no `BRIEF.md` with a blank typed brief is
`ARC_BRIEF_REQUIRED` too — validated before any directory is created or file
written. `list_members` returns the sessions attached to an Arc — project,
project name, workspace, task label, and state — for the `arc_status` tool.
`count_active_members` and `count_launches_since` back that tool's `limits`
and the launch caps in [agent-tools.md](agent-tools.md#arcs).
`check_launch_caps` is the one place those caps are enforced — `ARC_DONE`,
`ARC_CAPACITY_REACHED`, `ARC_LAUNCH_BUDGET_REACHED` — and every launch path
runs it twice: once as an early, non-transactional fast rejection, and once
for real inside `ProviderSessionService::launch`'s write transaction,
alongside the session insert and its `record_session_arc`, so two concurrent
launches racing the cap can't both pass the early check and then both
insert — SQLite's single writer serialises them at the transactional check.
See [ipc.md](ipc.md#arcs).

`arcs::launch_coordinator` ([src-tauri/src/arcs/mod.rs](../src-tauri/src/arcs/mod.rs))
launches an Arc's coordinator through the ordinary session-launch path,
carrying its own `arc_id` so it clears `check_launch_caps` with
`skip_member_caps` set (its `ARC_DONE` check still applies, but it does not
occupy a slot in the member caps it is not a member of), and calls
`set_arc_coordinator_session`. A session attached to an Arc — coordinator or
member — carries `sessions.arc_id`, attached inside that same launch
transaction rather than by a follow-up call. `sessions.launch_depth` and
`launched_by_session_id` stay at their defaults for a coordinator (no
launcher, depth 0), the same as any top-level chat.

`arc_events` (v53, [persistence/arc_events.rs](../src-tauri/src/persistence/arc_events.rs))
is the Arc timeline: an append-only row per thing that happened — `id`
(deterministic, so a repeated write is `INSERT OR IGNORE`d), `arc_id`
(`ON DELETE CASCADE`), `kind`, `occurred_at`, `session_id` and `project_id`
(no foreign keys: a row outlives the chat), `title`, `detail`, `status`,
`pr_number`, `pr_url`. The timeline reads newest first, keyset-paged on
`(occurred_at, rowid)` so rows recorded in the same millisecond keep their
insertion order. The same migration adds `arcs.notes_snapshot`, the
`NOTES.md` content the next `notes_updated` row is diffed against at a
coordinator's turn end. `ArcSummary.lastEventAt` is `MAX(occurred_at)`.

`find_session_arc` and `arc_is_live` are the settled definition of "live":
`active`, pointed at a coordinator session, and that coordinator's workspace
not mid-archive or gone. The gh poller's Arc PR/CI events and the scheduler's
`arc_coordinator` routine target both gate on exactly this. See
[gh.md](gh.md) and [scheduled-tasks.md](scheduled-tasks.md).

## Session PR state

Migration v49 adds `gh_pull_requests` for canonical GitHub state and
`session_pr_links` for session relationships, pins, and durable dismissals.
`session_pr_evidence` deduplicates original source events, while
`session_pr_evidence_scans` tracks historical repair. Existing cached state is
preserved and legacy associations begin unverified. See [gh.md](gh.md) for
selection, repair, and automation rules.

## Repositories

`data_migrations` (v46) records one-time upgrades that depend on local paths.
The external worktree location upgrade updates only legacy-default project
settings and records completion in the same transaction. Existing workspace
paths and subsequent user changes to project settings are preserved.

Typed modules (`projects.rs`, `workspaces.rs`, `sessions.rs`, `events.rs`, `approvals.rs`, `checks.rs`, `usage.rs`, `learnings.rs`, `gh.rs`, `routines.rs`) expose queries to services and IPC.

Message search accepts Unicode word prefixes and prioritizes user messages and completed assistant messages over activity labels. Within each group, it ranks FTS matches by relevance, then newest event timestamp and row ID for ties. It excludes streaming `message.delta` fragments so a completed answer does not compete with its own partial text for result slots. File-content search uses case-insensitive literal matching through `git grep`.

Focused reads in `dashboard.rs`:
- `dashboard:list`: Returns projects, workspaces, sessions, checks, and Arc summaries.
- `session:events-since`: A cursorless request returns an authoritative bounded
  tail and its change-sequence high-water mark from the same read transaction.
  The tail is the newest 500 rows plus the newest 2000 durable rows (every
  type but `message.delta`), so a long thinking turn cannot push the user
  message and earlier turns out of the initial read; those turns come back
  without their thinking blocks, since `message.completed` carries the answer.
  The 500-row page never begins inside a delta run: it reaches back to the
  durable row before it, up to 5000 rows in total, so a chat opened while a
  long answer is still streaming shows the answer from its first word rather
  than from wherever the page happened to cut.
  Later requests page at most 500 durable changes, including updates and
  deletions. Remote reads may stop earlier at their serialized response budget.
  The returned cursor advances only through the mutation sequence actually
  consumed, and repeated changes to one entity count once. If a cursor predates
  its session's retained history or is ahead of the database, the response
  requests replacement with a fresh bounded tail. The older SQLite `rowid`
  cursors remain accepted for compatibility.

Native Cursor task runs persist the same lifecycle correlation fields as the
other native providers. The child id comes from
`tool_call.taskToolCall.result.success.agentId`, not the initial `args.agentId`.
Each invocation keeps its own `agentRunId` and `providerInvocationId`, while a
resume keeps the child id and parent conversation id.
- `approvals:pending`: Returns outstanding approval requests.

A background sweeper deletes raw provider output older than 3 days, once a day starting 30 seconds after the database opens. Chat history reads `events`, not `raw_outputs`; raw output only backs the raw transcript fallback, the debug tail, and the legacy Cursor resume-id lookup for sessions with no stored conversation id. `system:vacuum-database` runs `VACUUM` in a background task.

File-backed databases admit at most four simultaneous read-only connections.
Additional readers wait for a returned lease, keeping SQLite page caches and
concurrent scans bounded. Reader counts and wait timings are available in the
Advanced performance diagnostics.

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

`project_sources` (v48) stores project-owned source metadata, with a unique
location per project, title, consultation guidance, creator type and optional
creator session, and creation/edit timestamps. Removing a project cascades its
references. Removing a session clears the creator session link while preserving
whether an agent added the reference. Source bodies are not cached. Retrieval
metadata is recorded in `session.note` events. See [memory.md](memory.md).
