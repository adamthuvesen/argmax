# Data

SQLite is the source of truth. The renderer never persists state — every refresh is a focused read or a pushed delta. See [architecture.md](architecture.md#renderer--srcrenderer) for the read flow.

## Layout on disk

- Database: `${app.getPath("userData")}/local-state/argmax.sqlite` (see [src/main/paths.ts](../../src/main/paths.ts) — `getDatabasePath()`).
- Checkpoint patches: `${dataDirectory}/checkpoints/<id>.patch`.
- WAL + shm sidecars live next to the database; `better-sqlite3` opens with WAL mode.

`system:vacuumDatabase` exposes a one-shot vacuum from the Help → Diagnostics affordance.

## Tables

Schema is owned by [src/main/persistence/migrations.ts](../../src/main/persistence/migrations.ts). Each migration declares an `affectedTables` manifest; the runner verifies `PRAGMA table_info` against an in-source expected-columns map and throws `MigrationDriftError` if drift is detected. **Never edit a previously-applied migration** — every applied migration is stored with a SHA checksum, and the boot path will refuse to run a tampered one.

| Table | Purpose |
|---|---|
| `projects` | Registered repos + settings (default provider/model, worktree location, setup command, check commands, optional `gh` remote owner/name) |
| `workspaces` | Git worktrees per project; carries dirty/changed-files counts, sticky-pinned flag, `last_activity_at` |
| `sessions` | Durable provider conversations: model + reasoning, resume id, totals (tokens, cost), `last_model_id` fallback |
| `events` | Normalized timeline events (what the chat renders) |
| `raw_outputs` | Per-stream raw provider output (stdout/stderr/pty/system) — debug/audit only |
| `approvals` | Pending and resolved command approval requests |
| `checks` | Workspace check runs (status, exit code, summary) |
| `checkpoints` | Snapshot rows; patch payload lives on disk |
| `usage_events` | Per-event token + cost rows (one row per assistant turn that carries usage) |
| `learnings` | Per-project distilled facts; see [memory.md](memory.md) |
| `gh_pr` | Per-(session, PR) check-state cache for the CI feedback loop; see [gh.md](gh.md) |
| `ui_state` | Generic key/value bag (e.g. `preferred-attempt:<sessionId>`) |
| `schema_migrations` | Applied-migration ledger with checksum for drift detection |

Two FTS5 virtual tables and their triggers keep search cheap:

- `events_fts` mirrors `events.message`. Powers `session.search()` (cross-session ranked search from the command palette).
- `learnings_fts` mirrors `learnings.summary`. Used by the project knowledge panel.

## Reads

Hot paths are deliberately narrow:

| Function | Returns | Used by |
|---|---|---|
| `listDashboard()` | `DashboardListSnapshot` (no events/raw/approvals) | `dashboard:list` — initial render |
| `listSessionEventsSince({ sessionId, eventCursor?, rawOutputCursor? })` | `SessionEventsSinceResult` with new `eventCursor` / `rawOutputCursor` | `session:eventsSince` — selected-session tail |
| `listWorkspaceStatus({ workspaceIds? })` | `WorkspaceStatusSnapshot` | `workspace:status` — 1200 ms polling |
| `listPendingApprovals()` | `ApprovalRequest[]` | `approvals:pending` |
| `loadDashboard()` | Full `DashboardSnapshot` | `dashboard:load` (compat wrapper) |
| `countAttention()` | `{ pendingApprovals, waitingSessions, total }` | Dock badge |
| `listRunningSessionIds()` | `string[]` | `GhPoller.tick()` |

**Cursor semantics.** `listSessionEventsSince` uses SQLite `rowid` cursors, not timestamps. Two events can share a `created_at` during a streaming burst; `rowid` is monotonic per-table so the cursor never duplicates or skips. Tests should assert rowid behavior, not timestamp ordering.

**Caps:**

| Constant | Value | Why |
|---|---|---|
| `DASHBOARD_ROW_LIMIT` | 200 | Workspaces/sessions/approvals/checks/checkpoints per snapshot |
| `DASHBOARD_EVENT_LIMIT` | 500 | Timeline tail for the full snapshot |
| `DASHBOARD_RAW_OUTPUT_LIMIT` | 100 | Raw output tail for the full snapshot |
| `SESSION_EVENT_PAGE_LIMIT` | 500 | Per-page tail for `session:eventsSince` |
| `SESSION_RAW_OUTPUT_PAGE_LIMIT` | 100 | Per-page raw tail for `session:eventsSince` |

The renderer is responsible for capping its own live `events` / `rawOutputs` arrays to the same limits when applying deltas; see `pruneSupersededDeltas` / `mergeByCreatedAt` in `src/renderer/lib/snapshot.ts`.

## Retention

`raw_outputs` older than **7 days** are pruned. The prune sweep runs once at boot and then every 24 hours via `setInterval` (`PRUNE_INTERVAL_MS`). The timer is `.unref()`'d so it never keeps the event loop alive on its own, and `database.clearPruneInterval()` is called during `shutdown()`.

`events`, `usage_events`, `approvals`, `checks`, `checkpoints`, and `gh_pr` are retained indefinitely. Use `system:vacuumDatabase` to reclaim space after deleting projects.

## Errors

- `RecordNotFoundError` — single-row lookups (`getProject`, `getWorkspace`, `getSession`, etc.) throw this with `kind` and `id` set. Catch it specifically on paths that race against deletion (async event handlers writing to a session that was just cancelled); everything else is a real fault and should propagate.
- `MigrationDriftError` — the boot path refuses to run if a previously-applied migration's checksum changed or its post-apply table shape doesn't match the manifest. Fix the cause; don't suppress.

## Writing a new column

The destructive 12-step `CREATE TABLE _new` → `INSERT … SELECT` → `DROP` → `RENAME` recipe (migration v3 is the canonical example) is required when adding `CHECK` constraints or other ALTER-incompatible changes. Set `requiresForeignKeysOff: true` on the migration so the runner toggles `PRAGMA foreign_keys` outside the wrapping transaction; mid-transaction toggles are no-ops in SQLite.

For straight `ALTER TABLE ADD COLUMN` additions, no `requiresForeignKeysOff` is needed. Update the `expectedColumns` manifest for the touched table to the **post-migration** column set, and add the migration's `affectedTables` so the runner re-verifies after applying.

When in doubt: write a database test that opens an in-memory connection, asserts the migration applied, and inserts/reads a row through the touched column.
