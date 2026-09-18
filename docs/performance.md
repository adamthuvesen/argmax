# Performance Budgets

Performance budgets define targets for cold start, IPC response times, and frontend data transformations.

## Whole-app captures

Settings → Advanced → Performance has an opt-in recorder for comparing real
release-build workloads. It samples once per second and retains the latest 30
minutes in memory. Starting a new capture clears the old samples. Stopping does
not write anything, and Download JSON is the only persistence path.

Each sample includes the whole Argmax descendant process tree, split into the
Rust host, WebKit processes, and provider or tool processes. CPU is calculated
from native cumulative process time and memory is resident bytes. The same
sample records active chats by provider, provider output and IPC rates, pending
provider items, SQLite reader activity and wait deltas, and renderer long tasks.
The export includes build and platform context, sampler overhead, and median,
p95, peak, and per-running-chat summaries.

On macOS the process sampler uses `libproc` directly. It does not spawn `ps` on
every tick. The recorder owns no worker while stopped and never writes samples
to SQLite, so normal app use does not pay the sampling or storage cost. Measure
release builds, label the workload before starting, and compare at least idle,
one busy chat, and five busy chats with the same providers and prompts.

For a repeatable timed capture against a running release app with the remote
bridge enabled:

```bash
node scripts/bridge.mjs perf --seconds 300 --output ./argmax-performance.json
```

The command starts the same recorder, waits for the requested interval, stops
it, and writes the complete capture. `--data-dir`, `--port`, and `--token` use
the standard bridge connection resolution documented at the top of the script.

## Startup Budget

Tracked by [src-tauri/src/util/startup_timer.rs](../src-tauri/src/util/startup_timer.rs) and exposed via `system:diagnostics`. Target `boot → window.ready-to-show` is ≤ 800 ms on macOS.

- `sessions.recover`: Uses the `idx_events_restart_recovery` partial index (migration v13) to keep startup orphan detection bounded to O(sessions).
- Process orphan scans run in background tasks to avoid blocking the setup hook.

## Eager Bundle

`npm run check:bundle` (scripts/check-bundle.mjs) caps the cold-start module
graph — the entry chunk plus every `<link rel="modulepreload">` Vite emits —
at 1.76 MiB desktop / 1.61 MiB mobile. The desktop allowance includes a small
startup tradeoff for navigation readiness. Measured 2026-09-09 from the existing
build: 1.70 MiB desktop and 1.57 MiB mobile. Desktop rose 0.05 MiB to cover
todo cards, goals, and the rest of this stack.

KaTeX (~0.5 MB JS plus fonts/CSS) is the largest single dependency and stays
out of that graph: the chat surface renders without math plugins and only
delegates to the lazy [MathMarkdown](../src/renderer/components/MathMarkdown.tsx)
chunk when the text may contain math ([needsMath](../src/renderer/lib/needsMath.ts)
mirrors `normalizeMathDelimiters`' early return, so `$`- and `\`-free text
never pays for it). Markdown with math first paints the plain render as the
Suspense fallback, then swaps in the formatted equations once the chunk lands.

Shiki syntax highlighting follows the same rule. Its core and JavaScript regex
engine load only after a code fence or diff mounts through
[highlighter.ts](../src/renderer/lib/highlighter.ts); those surfaces already
paint plain text until the shared highlighter signals readiness, then repaint
with token colors.

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

The pool admits at most four simultaneous readers. Extra reads wait for a
lease instead of opening an unbounded set of SQLite page caches and competing
scans. Settings → Advanced → Performance reports current and peak readers,
opened connections, failures, and cumulative and longest waits. The cap covers
the webview, remote bridge, and a background read without serializing normal
interactive work.

The performance recorder reports wait counts and wait time as per-sample
deltas. This makes a burst line up with CPU, output, and active-chat pressure
without repeatedly querying the database.

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

One keyframe still drives a non-composited property, deliberately:
`skeleton-shimmer` (`background-position`), which only runs while a review is
loading. The `nest` style's two-tone hand-off used to animate `background`,
repainting every dot of every running row each frame. Its colours are now two
`::before`/`::after` layers over the dot's rest fill that only fade, on the same
keyframe stops and easings as the dot's scale, so the relay adds no DOM
elements and runs on the compositor. The layers' animations are pseudo-element
animations, so `WorkingNest` anchors them with `getAnimations({ subtree: true })`.
Measured 2026-09-16 in a native WKWebView with 80 running 14px nests: the
`background` relay cost 6.3 CPU-s of WebContent plus 1.2 CPU-s of the GPU
process per 8 s; the layered relay cost 0.0 in both, with all three animations
confirmed running.
Anything new that loops forever should animate `transform`/`opacity` on an HTML
element or its pseudo-elements.

The reading wave ([reading-wave.css](../src/renderer/styles/reading-wave.css)) is
the deliberate exception on a live surface: its band is a gradient painted through
the text, so each frame repaints the words it covers. It runs only on a line whose
work is running. Measured 2026-09-17 in a native WKWebView over 8 s: one waving
line cost 0.3 CPU-s of WebContent plus 0.3 of the GPU process, five cost 0.5 +
0.7, eighty cost 1.3 + 5.2; the same text without the wave cost 0.0. Promoting
the text to its own layer would composite it, but puts it on a different pixel
phase from its row on a resampled display.

Renderer CPU does not depend on the Rust build profile; the release build idles
at 3.2% with no session running, matching the debug measurement.

Motion also stops entirely while the document is hidden — `windowChrome` mirrors
visibility onto the root element and [motion.css](../src/renderer/styles/motion.css)
pauses on it, so a backgrounded window draws nothing.

## Background Battery

JS loops that CSS pausing cannot reach check `document.hidden` themselves:

- [EffortPixelField](../src/renderer/components/EffortPixelField.tsx) (effort
  slider canvas) paints at ~30 fps instead of 60. Decorative flow is
  indistinguishable there at half the per-cell noise cost, and its rAF loop
  parks while hidden and restarts on `visibilitychange`.
- [TurnExhale](../src/renderer/components/TurnExhale.tsx) (the optional PR milestone sweep)
  never runs while hidden: it is mounted only for the ~1s of its own sweep, and
  a hidden document skips the sweep outright rather than queueing one. A settled
  transcript of two hundred turns paints nothing and schedules no frames.
- The chat typewriter ([StreamingMarkdown](../src/renderer/components/StreamingMarkdown.tsx),
  64 ms tick, paced per arrival so a whole backlog drains in ~1.3 s) catches up
  silently while hidden instead of pausing the prefix: a backgrounded live turn
  can land several finished bubbles, and holding them at character zero made
  them all type out together on return. Every revealing block shares one
  interval, started by the first and cleared with the last, so React batches
  all of their advances into one render per tick. The 64 ms cadence halves the
  maximum React and Markdown render rate while keeping reveal throughput steady.
- The 1.5 s open-agent poll in
  [AgentActivity](../src/renderer/components/AgentActivity.tsx) runs only for
  the Agents dock tab that is shown, and still skips ticks while the document is
  hidden. Every open tab loads once on mount. A tab that stopped polling a live
  run while another tab was shown reloads the moment it is shown again, since
  Codex and Cursor child traces are imported by that read and a run that
  finished out of sight would otherwise keep its last load. The dock itself
  unmounts when the review panel leaves Agents mode or the phone overlay
  closes, so no poll outlives it. General session tails have no interval. A post-commit push
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
request. That outer limit counts turns, so each turn also mounts only its last
16 body rows. Expanded tool and mixed-activity groups mount 16 rows at a time,
including nested agent activity. Each boundary has an explicit Show earlier
control. Session sizes are heavily skewed, so these nested limits matter for a
provider that keeps one turn open for hours instead of producing many turns.
Without them, one long turn re-reconciled thousands of live subtrees on every
streaming delta.

While the reader follows live output, each window tracks the newest rows. Once
the reader scrolls away from the bottom, [useStableTailWindow](../src/renderer/hooks/useStableTailWindow.ts)
retains the mounted row ids until following resumes. New output therefore does
not evict the reader's logical anchor just because a bounded tail moved. The
windows read the follow state instead of taking it as a prop, so scrolling
away or back renders none of them. Measured 2026-09-16 on a 98-turn chat
(dev React, headless Chrome, live data over the bridge): the first upward
wheel notch committed about 1,500 components before, and one button after. Mouse-wheel easing
([chat-cards.md](chat-cards.md#follow-scroll)) writes `scrollTop` from JS every
frame, so any main-thread work during a scroll now shows as a stutter.

Paced markdown reveals use a numeric Unicode cursor and slice the source
string without retaining a character array or joining each visible prefix.
Reveal timing, Markdown rendering, and tool-call presentation are unchanged.
Completed, unpaced, and reduced-motion blocks render the source text directly.
An isolated local benchmark of 1,000 prefixes over 100,800 code points took
about 400 ms with the previous array slicing and joining, and under 2 ms with
the cursor. This measures prefix preparation, not end-to-end rendering.

Usage and Activity prefetches share in-flight requests with visible panels.
Each summary cache retains at most eight filter combinations, preserving the
default view while evicting older alternatives. Failed requests can retry.

The focused desktop pane warms its changed-file list and first diff. Closed
background panes defer Git reads until focused or opened. Successful preloads
are reused on opening, while failed preloads retry. Hosts with their own review
screen, including mobile, do not warm the desktop diff. Diff previews retain
at most 12 entries and 8 MiB of estimated UTF-16 text per pane, excluding the
currently displayed diff. Oversized diffs remain viewable without being cached.

Workspace file inventories sort and deduplicate borrowed paths before creating
owned entries, avoiding tree-node and duplicate string allocations while
preserving sorted results.

File browsing caches are bounded for panes that stay mounted for a long time.
The Files view retains at most 12 closed previews per pane. Each file read is
capped at 1 MiB of source content. Composer file autocomplete retains four
source trees and re-fetches an older project or workspace after eviction.

## IPC Latency

### Browser panel

ResizeObserver and window-resize notifications share one bounds measurement per
animation frame. Unchanged bounds skip the native call, while tab activation and
overlay hiding remain immediate. The browser component tests exercise a burst
of 100 resize events plus observer notifications: one measurement and native
update, followed by no additional native update for unchanged geometry.

Tab persistence runs after the interaction, coalesces changes, and excludes
loading-only updates. Measured 2026-09-14 by running the previous and updated
tab-store modules against an in-memory storage spy: a single burst of 100
activation/title/loading updates across 1 / 10 / 30 tabs caused 299 / 390 / 370
synchronous writes before, and zero synchronous writes plus one deferred write
after. This isolates redundant serialization and write calls. It does not
measure real disk latency, native tab-switch latency, or WebKit memory usage.

### General bridge

[src-tauri/src/util/ipc_latency.rs](../src-tauri/src/util/ipc_latency.rs) tracks latency histograms accessible in Settings → Diagnostics. Target p99 is < 100 ms.

To prevent IPC bottlenecks:
- General timeline push hints trigger `session:events-since`. There is no renderer polling interval.
- `session:agent-events` is only invoked when a subagent tab is open in a review panel's Agents view, bounded by `SESSION_AGENT_EVENT_SCAN_LIMIT` (2,000 rows).

## Native iOS

[iOS performance and recovery](ios-performance.md) describes native caches,
preloading, background preparation, mutation recovery, and the
`ArgmaxPerformance` benchmark scheme. Use its physical-device checks for phone
latency and scrolling claims. The web viewport probe does not measure the
native transcript.
