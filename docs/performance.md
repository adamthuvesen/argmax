# Performance Budgets

Performance budgets define targets for cold start, IPC response times, and frontend data transformations.

## Startup Budget

Tracked by [src-tauri/src/util/startup_timer.rs](../src-tauri/src/util/startup_timer.rs) and exposed via `system:diagnostics`. Target `boot → window.ready-to-show` is ≤ 800 ms on macOS.

- `sessions.recover`: Uses the `idx_events_restart_recovery` partial index (migration v13) to keep startup orphan detection bounded to O(sessions).
- Process orphan scans run in background tasks to avoid blocking the setup hook.

## Eager Bundle

`npm run check:bundle` (scripts/check-bundle.mjs) caps the cold-start module
graph — the entry chunk plus every `<link rel="modulepreload">` Vite emits —
at 1.60 MiB desktop / 1.50 MiB mobile. Measured 2026-09-03: 1.05 MiB desktop
across 8 chunks, 0.93 MiB mobile across 7.

KaTeX (~0.5 MB JS plus fonts/CSS) is the largest single dependency and stays
out of that graph: the chat surface renders without math plugins and only
delegates to the lazy [MathMarkdown](../src/renderer/components/MathMarkdown.tsx)
chunk when the text may contain math ([needsMath](../src/renderer/lib/needsMath.ts)
mirrors `normalizeMathDelimiters`' early return, so `$`- and `\`-free text
never pays for it). Markdown with math first paints the plain render as the
Suspense fallback, then swaps in the formatted equations once the chunk lands.

Do not add a `vendor-katex` (or any unified-ecosystem) `manualChunks` rule to
[vite.config.ts](../vite.config.ts) without re-measuring. A named KaTeX chunk
acts as a magnet: Rolldown hoists the micromark/mdast/unist/hast utils shared
by remark-gfm (eager) and remark-math/rehype-katex (lazy) into it, the eager
graph statically imports it, and cold start preloads all of KaTeX again
(measured 1.56 MiB eager with the rule, 1.05 MiB without). Automatic chunking
already places KaTeX in a lazy chunk reached only via MathMarkdown,
FilePreview, and Mermaid.

## Renderer Benchmarks

Run via:

```bash
npm run test:perf
```

Targets defined in [src/test/perf.test.ts](../src/test/perf.test.ts):

- `mergeDashboardDelta` across 200 sessions: p95 < 5 ms.
- `mergeDashboardDelta` with 500 deltas + tool rows: p95 < 5 ms.
- `mergeDashboardDelta` with a 1-event delta onto 5,000 events: p95 < 2 ms.
- `buildFileTree` across 10,000 files: < 75 ms.
- `searchFilePaths` across 10,000 paths: p95 < 25 ms.
- `parseUnifiedDiff` across a 500-hunk diff: p95 < 20 ms.

## Usage Scan

The Usage page's transcript sweep ([usage/scanner.rs](../src-tauri/src/usage/scanner.rs))
is incremental, so only the first sweep is expensive. Measured 2026-09-03 on
a release build over this machine's 90-day window (5,235 transcripts, about
2 GB of JSONL): cold sweep 25 s, run in the background with progress on the
page; warm sweep 0.2 s, run inline on every `usage:summary`. A warm sweep
must stay well under a second, since the page refreshes every 60 s while open.

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

Terminal output takes the same shape: PTY chunks queue onto one worker that
concatenates them per terminal up to `MAX_CONFLATED_TERMINAL_BYTES` (256 KB)
before a single main-thread emit, so a `cat` of a large file no longer costs one
`run_on_main_thread` hop per 8 KB read. A `terminal:exit` rides the same queue
and never overtakes output still queued for its terminal.

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

## Background Battery

JS loops that CSS pausing cannot reach check `document.hidden` themselves:

- [EffortPixelField](../src/renderer/components/EffortPixelField.tsx) (effort
  slider canvas) and [ComposerPixelField](../src/renderer/components/ComposerPixelField.tsx)
  (the launcher backdrop) paint at ~30 fps instead of 60 — decorative flow is
  indistinguishable there at half the per-cell noise cost, which is the whole
  cost — and park their rAF loops while hidden, restarting on
  `visibilitychange`. The composer field additionally stops itself once the
  prompt empties, so an idle launcher schedules no frames at all. Its eases are
  per *painted* frame, so changing the paint interval means changing them too.
- [TurnExhale](../src/renderer/components/TurnExhale.tsx) (the turn-end breath)
  never runs while hidden: it is mounted only for the ~1s of its own sweep, and
  a hidden document skips the sweep outright rather than queueing one. A settled
  transcript of two hundred turns paints nothing and schedules no frames.
- The chat typewriter ([StreamingMarkdown](../src/renderer/components/StreamingMarkdown.tsx),
  32 ms tick) and the running-session polls (250 ms event tail in
  [useDashboardSession](../src/renderer/hooks/useDashboardSession.ts), 1.5 s
  agent events in [AgentActivity](../src/renderer/components/AgentActivity.tsx))
  skip ticks while hidden. The visibility-change refresh backfills the selected
  session on return, so nothing is stale — a backgrounded long run costs no
  IPC, SQLite, or re-render work.

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
