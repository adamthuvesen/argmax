# Performance Budgets

Performance budgets define targets for cold start, IPC response times, and frontend data transformations.

## Startup Budget

Tracked by [src-tauri/src/util/startup_timer.rs](../src-tauri/src/util/startup_timer.rs) and exposed via `system:diagnostics`. Target `boot → window.ready-to-show` is ≤ 800 ms on macOS.

- `sessions.recover`: Uses the `idx_events_restart_recovery` partial index (migration v13) to keep startup orphan detection bounded to O(sessions).
- Process orphan scans run in background tasks to avoid blocking the setup hook.

## Renderer Benchmarks

Run via:

```bash
npm run test:perf
```

Targets defined in [src/test/perf.test.ts](../src/test/perf.test.ts):

- `mergeDashboardDelta` across 200 sessions: p95 < 5 ms.
- `mergeDashboardDelta` with 500 deltas + tool rows: p95 < 5 ms.
- `buildFileTree` across 10,000 files: < 75 ms.
- `searchFilePaths` across 10,000 paths: p95 < 25 ms.
- `parseUnifiedDiff` across a 500-hunk diff: p95 < 20 ms.

## Main Thread

Tauri resolves a synchronous `#[tauri::command]` body inline on the macOS main
thread, so anything it blocks on freezes the window rather than just that
channel. The `async` flag is not the fix — it is `tokio::spawn`, which parks a
worker shared with provider IO, the remote bridge, and the `dashboard:delta`
emit loop. Blocking work goes through
[`read_off_main`](../src-tauri/src/ipc/mod.rs) (`spawn_blocking`).

`npm run check:main-thread` enforces this: every synchronous handler must be
named in `MAIN_THREAD_ALLOWLIST` in
[scripts/check-main-thread-handlers.mjs](../scripts/check-main-thread-handlers.mjs)
with a reason, and the list fails if it goes stale.

Measured on the release build against a 272 MB database (30 projects / 200
workspaces / 213 sessions): `dashboard:list` 4.3 ms, `workspace:status` over all
workspaces 4.0 ms, scoped to one workspace 0.2 ms. `refresh()` runs on
`visibilitychange`, so before this the unscoped read cost that on every window
focus. Benchmark through the remote bridge, which reaches the same `*_impl`
functions. A debug build is ~5.5x slower across the board — measure release
before quoting a number.

## Database Reads

Reads take a pooled read-only connection
([`Database::read_connection`](../src-tauri/src/persistence/database.rs)), not
the single writer `Mutex<Connection>`. WAL exists so readers and a writer can
run at once, and one shared mutex threw that away: a read issued during a 400 ms
write transaction took 349 ms through the writer and takes 0.63 ms through the
pool. That gap is why a `VACUUM` or one slow transaction used to freeze every
panel at once.

Readers are opened `SQLITE_OPEN_READ_ONLY`, so routing a write through the read
path fails loudly instead of silently taking the wrong lock. In-memory databases
have no pool — a second handle would open a different database — and fall back
to the writer.

## Push Payloads

`Emitter::emit` renders the payload into a JS source string and evals it; unlike
`ipc::Channel` it has no large-payload `fetch` path. `dashboard:delta`
conflation is therefore capped at `MAX_CONFLATED_DELTA_BYTES` (256 KB) of event
text — single events reach 711 KB in a real database, and an unbounded merge
handed JavaScriptCore a multi-megabyte program to parse on the main thread.
Whatever does not fit stays queued and goes out on the next iteration, in order.

## Animated Properties

Idle renderer CPU is dominated by *which property* an animation drives, not how
many animations there are. `transform` and `opacity` are composited; everything
else re-rasters the layer the element sits in, every frame, for as long as the
animation runs.

Measured with the window visible and no session running: the launcher's 7px
status dot animated `box-shadow` and cost ~5% of a CPU core on its own — more
than every other animation in the app combined (8.8% total → 3.8% with just
`launcher.css` paused → 4.1% after moving the pulse to a composited
pseudo-element ring). Pausing *all* animations reaches 0.0%, so the remainder is
spread thinly across the composited ones.

Two keyframes still drive non-composited properties, both deliberately: 
`skeleton-shimmer` (`background-position`) only runs while a review is loading,
and `working-nest-relay` (`fill`) only under `[data-active="true"]`. Neither runs
at rest. Anything new that loops forever should animate `transform`/`opacity`.

Renderer CPU does not depend on the Rust build profile; the release build idles
at 3.2% with no session running, matching the debug measurement.

Motion also stops entirely while the document is hidden — `windowChrome` mirrors
visibility onto the root element and [motion.css](../src/renderer/styles/motion.css)
pauses on it, so a backgrounded window draws nothing.

## Transcript Size

[SessionConversation](../src/renderer/components/SessionConversation.tsx) mounts
the last `CONVERSATION_WINDOW` (120) render items and reveals the rest on
request. Session sizes are heavily skewed — p50 is ~53 events, p95 is ~743, and
the largest holds 3,040 events and 3.3 MB of text — so without a window a long
session re-reconciled thousands of live subtrees on every streaming delta.

## IPC Latency

[src-tauri/src/util/ipc_latency.rs](../src-tauri/src/util/ipc_latency.rs) tracks latency histograms accessible in Settings → Diagnostics. Target p99 is < 100 ms.

To prevent IPC bottlenecks:
- General timeline polling uses `session:events-since`.
- `session:agent-events` is only invoked when a subagent tab is open in a review panel's Agents view, bounded by `SESSION_AGENT_EVENT_SCAN_LIMIT` (2,000 rows).
