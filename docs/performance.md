# Performance Budgets

Performance budgets define targets for cold start, IPC response times, and frontend data transformations.

## Startup Budget

Tracked by [src-tauri/src/util/startup_timer.rs](../src-tauri/src/util/startup_timer.rs) and exposed via `system:diagnostics`. Target `boot → window.ready-to-show` is ≤ 800 ms on macOS.

- `sessions.recover`: Uses the `idx_events_restart_recovery` partial index (migration v13) to keep startup orphan detection bounded to O(sessions).
- Process orphan scans run in background tasks to avoid blocking the setup hook.

## Eager Bundle

`npm run check:bundle` (scripts/check-bundle.mjs) caps the cold-start module
graph — the entry chunk plus every `<link rel="modulepreload">` Vite emits —
at 1.70 MiB desktop / 1.60 MiB mobile. Measured 2026-09-08 from the existing
build: 1.67 MiB desktop and 1.55 MiB mobile. The limits increased by 0.10 MiB
each to accommodate the current graph, including the shared file icons.

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
- `mergeDashboardDelta` with a 1-event delta onto 5,000 events: p95 < 4 ms.
- `mergeDashboardDelta` with an empty poll onto 5,000 events: p95 < 0.1 ms.
- Updating one of eight subscribed, 500-event session histories: p95 < 2 ms, with zero notifications to the seven unrelated sessions.
- `buildSessionToolCalls` across the capped 2,000 tool rows and 4,000 progress rows: p95 < 50 ms.
- `buildFileTree` across 10,000 files: < 75 ms.
- `searchFilePaths` across 10,000 paths: p95 < 25 ms.
- `parseUnifiedDiff` across a 500-hunk diff: p95 < 20 ms.

Measured 2026-09-05 on those fixtures: removing the per-tool progress scan cut
`buildSessionToolCalls` p95 from 41.39 ms to 5.18 ms. Skipping empty event merges
cut the 5,000-event poll from 0.153 ms to 0.0024 ms. These isolate renderer
transformations, not whole-app CPU usage.

On the same date, eight 500-event sessions receiving one session's stream took
0.604 ms p95 for the shared merge plus eight pane filters, versus 0.073 ms for
the session store, about 8.3 times faster. The seven unrelated subscriptions
received no notifications.

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
`ipc::Channel` it has no large-payload `fetch` path. Transcript writes therefore
push session ids and let subscribed clients pull the durable revision feed;
metadata writes push one invalidation for a coherent dashboard snapshot.
`dashboard:delta` delivery is bounded to 512 queued items and 4 MiB measured by
actual JSON serialization, while each conflated main-thread payload targets
256 KiB. Overflow discards the incomplete queued window and emits one
`resyncRequired` marker. The worker awaits an acknowledgement from each
main-thread closure, leaving at most one scheduled emit outside those bounds.

Metadata invalidations coalesce for 100 ms, with one read in flight. Transcript
reads remain immediate and use change revisions, including in-place updates and
deletions. On a private copy of a 179,092-event database, a debug build read the
initial 500-event tail with its revision in 9 ms. The change feed adds work to
writes: the synthetic 20,000-update debug fixture measured about 7.3 microseconds
per update above the old path, while atomic 500-event reads added 3.5%.

Terminal output uses a separate 64-item bounded channel. Dedicated PTY reader
threads apply lossless backpressure when it fills, then the worker concatenates
chunks per terminal up to `MAX_CONFLATED_TERMINAL_BYTES` (256 KiB) before a
single acknowledged main-thread emit. The exit watcher joins the reader after
the child closes, draining every kernel-ready byte until a 100 ms quiet period,
so `terminal:exit` cannot overtake final output or wait indefinitely for a
descendant that inherited the PTY slave.

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

`transform`/`opacity` is necessary but not sufficient — the element also has to
be an HTML box. WebKit's legacy SVG renderer has no accelerated compositing at
all (the layer tree does not know SVG exists; the Layer-Based SVG Engine that
fixes it is still not default-on as of 2026-07), so an SVG `<circle>` animating
`transform` re-rasters every frame exactly like animating `fill` does. The
working nest was SVG for that reason and is now absolutely-positioned `<span>`s
([WorkingNest.tsx](../src/renderer/components/WorkingNest.tsx)), which is what
makes it affordable to run one per visible row.

Two keyframes still drive non-composited properties, both deliberately:
`skeleton-shimmer` (`background-position`) only runs while a review is loading,
and `working-nest-relay` (`background`) only under `[data-active="true"]`, for
the two-tone hand-off that is the whole idea of the `nest` style — the
alternative, two stacked dots cross-fading, doubles the element count of the
default mark to save a repaint on four 4px boxes. Neither runs at rest. Anything
new that loops forever should animate `transform`/`opacity` on an HTML element.

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
- [TurnExhale](../src/renderer/components/TurnExhale.tsx) (the optional PR milestone sweep)
  never runs while hidden: it is mounted only for the ~1s of its own sweep, and
  a hidden document skips the sweep outright rather than queueing one. A settled
  transcript of two hundred turns paints nothing and schedules no frames.
- The chat typewriter ([StreamingMarkdown](../src/renderer/components/StreamingMarkdown.tsx),
  32 ms tick, paced per arrival so a whole backlog drains in ~1.3 s) catches up
  silently while hidden instead of pausing the prefix: a backgrounded live turn
  can land several finished bubbles, and holding them at character zero made
  them all type out together on return. The 1.5 s open-agent poll in
  [AgentActivity](../src/renderer/components/AgentActivity.tsx) still skips
  ticks while hidden. General session tails have no interval. A post-commit push
  hint asks the subscribed timeline to read its durable revision feed. The
  visibility-change refresh backfills the selected session on return. Hidden
  windows stop interval work, while push hints can still trigger bounded
  durable-feed reads.

## Transcript Size

[SessionTimelines](../src/renderer/lib/sessionTimelines.ts) retains transcripts and
cursors per session. Each subscribed session has independent event caps and 100
raw-output rows. At most 12 inactive histories remain cached. Late reads cannot
restore an evicted or removed history, and live pushes received during a read
take precedence over stale copies in its response. Dashboard metadata contains
no second copy of these arrays.

[canonicalTimeline.ts](../src/renderer/lib/canonicalTimeline.ts) caches each
persisted row's typed classification in a `WeakMap`. Conversation projections
reuse that classification without retaining rows after timeline eviction or
serializing large message and tool bodies into the cache.

[SessionConversation](../src/renderer/components/SessionConversation.tsx) mounts
the last `CONVERSATION_WINDOW` (120) render items and reveals the rest on
request. Session sizes are heavily skewed — p50 is ~53 events, p95 is ~743, and
the largest holds 3,040 events and 3.3 MB of text — so without a window a long
session re-reconciled thousands of live subtrees on every streaming delta.

Only paced, actively streaming markdown blocks allocate character arrays for
the reveal. Completed, unpaced, and reduced-motion blocks render the source
text directly.

File browsing caches are bounded for panes that stay mounted for a long time.
The Files view retains at most 12 closed previews per pane. Each file read is
capped at 1 MiB of source content. Composer file autocomplete retains four
source trees and re-fetches an older project or workspace after eviction.

## IPC Latency

[src-tauri/src/util/ipc_latency.rs](../src-tauri/src/util/ipc_latency.rs) tracks latency histograms accessible in Settings → Diagnostics. Target p99 is < 100 ms.

To prevent IPC bottlenecks:
- General timeline push hints trigger `session:events-since`. There is no renderer polling interval.
- `session:agent-events` is only invoked when a subagent tab is open in a review panel's Agents view, bounded by `SESSION_AGENT_EVENT_SCAN_LIMIT` (2,000 rows).
