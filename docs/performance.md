# Performance Budgets

Budgets define targets for cold start, IPC, and renderer transformations. Measure a release build before you quote a number, because a debug build is about 5.5x slower. Dated measurements here explain a decision, and they are not current readings.

## Whole-app captures

Settings → Advanced → Performance has an opt-in recorder for comparing release workloads. It samples the whole Argmax process tree, split into the Rust host, WebKit, and provider processes. It owns no worker while stopped and never writes to SQLite, so normal use does not pay for it. On macOS it uses `libproc`, so it does not spawn `ps` on every tick.

Label the workload first, and compare at least idle, one busy chat, and five busy chats with the same providers and prompts.

```bash
node scripts/bridge.mjs perf --seconds 300 --output ./argmax-performance.json
```

## Budgets and their owners

| Budget | Owner |
|---|---|
| `boot → window.ready-to-show` ≤ 800 ms on macOS | [startup_timer.rs](../src-tauri/src/util/startup_timer.rs), `system:diagnostics` |
| Eager bundle size | `npm run check:bundle` ([check-bundle.mjs](../scripts/check-bundle.mjs)) |
| Renderer transforms | `npm run test:perf` ([perf.test.ts](../src/test/perf.test.ts)) |
| Synchronous IPC handlers | `npm run check:main-thread` ([check-main-thread-handlers.mjs](../scripts/check-main-thread-handlers.mjs)) |
| IPC p99 < 100 ms, per channel | [ipcLatency.ts](../src/renderer/lib/ipcLatency.ts), Settings → Diagnostics, `window.__argmaxPerf.ipc()` |

`sessions.recover` uses a partial index, so startup orphan detection stays O(sessions). Process orphan scans run in background tasks, so they do not block the setup hook.

## Eager bundle

KaTeX is the largest single dependency, so it stays out of the cold-start graph. The chat renders without math plugins and delegates to the lazy [MathMarkdown](../src/renderer/components/MathMarkdown.tsx) chunk only when `needsMath` says the text may contain math. Shiki loads the same way, after a fence or diff mounts ([highlighter.ts](../src/renderer/lib/highlighter.ts)).

**Do not add a `vendor-katex` or unified-ecosystem `manualChunks` rule** to [vite.config.ts](../vite.config.ts) without re-measuring. A named chunk acts as a magnet. Rolldown hoists the utilities shared by eager remark-gfm and lazy remark-math into it, the eager graph imports it, and cold start preloads all of KaTeX again (measured 1.56 MiB eager with the rule, 1.05 MiB without).

A shared manual icon chunk has the same problem, so Lucide uses automatic chunking.

## Usage scan

The transcript sweep is incremental, so only the first is expensive: 25 s cold, in the background, and 0.2 s warm (2026-09-03, about 2 GB of JSONL). A warm sweep runs inline on every `usage:summary`, so it must stay well under a second.

## Main thread

Tauri resolves a synchronous `#[tauri::command]` body inline on the macOS main thread, so anything it blocks on freezes the window. The `async` flag is not the fix, because it parks a worker shared with provider IO, the remote bridge, and the `dashboard:delta` loop. Blocking work goes through [`read_off_main`](../src-tauri/src/ipc/mod.rs).

Every synchronous handler must be named in `MAIN_THREAD_ALLOWLIST` with a reason, and the check fails if the list goes stale.

## Database reads

Reads take a pooled read-only connection ([`read_connection`](../src-tauri/crates/argmax-store/src/database.rs)), not the single writer. WAL exists so readers and a writer can run at once, and one shared mutex threw that away. A read during a 400 ms write took 349 ms through the writer and 0.63 ms through the pool.

- Readers open `SQLITE_OPEN_READ_ONLY`, so a write through the read path fails loudly.
- In-memory databases have no pool, because a second handle would open a different database.
- The pool caps simultaneous readers, so extra reads wait for a lease instead of opening unbounded page caches.

## Push payloads

`Emitter::emit` renders the payload into a JS source string and evals it, so it has no large-payload path. Transcript writes therefore push session ids, and subscribed clients pull the durable revision feed. Metadata writes push one invalidation.

`dashboard:delta` delivery is bounded by item count and serialized size. Overflow discards the queued window and emits one `resyncRequired` marker. The worker awaits an acknowledgement from each main-thread closure, leaving at most one scheduled emit outside those bounds.

Remote clients read through `dashboard:changes` ([dashboard_changes.rs](../src-tauri/src/remote/dashboard_changes.rs)). The host keeps recent snapshots by digest and answers with what changed. A one-chat change on a 206-chat profile is about 1 KB instead of 684 KB, which matters to a phone on cellular. Large frames are raw DEFLATE ([ws.rs](../src-tauri/src/remote/ws.rs)).

Terminal output has its own bounded channel. PTY reader threads apply lossless backpressure when it fills. The exit watcher drains the reader until a quiet period, so `terminal:exit` cannot overtake final output or wait forever for a descendant holding the PTY slave.

## Animated properties

Idle renderer CPU depends on which property an animation drives, not on how many animations run. `transform` and `opacity` are composited, and everything else re-rasters its layer every frame. One 7px dot animating `box-shadow` cost about 5% of a core.

**Anything new that loops forever must animate `transform` or `opacity` on an HTML element or its pseudo-elements.** WebKit's legacy SVG renderer has no accelerated compositing (checked 2026-07), so an SVG `<circle>` animating `transform` still re-rasters. The working nest is `<span>`s for this reason ([WorkingNest.tsx](../src/renderer/components/WorkingNest.tsx)).

Two deliberate exceptions exist:

- `skeleton-shimmer` (`background-position`) runs only while a review loads.
- The reading wave paints a gradient through text, so it runs only on a line whose work is running. Promoting the text to its own layer would composite it, but puts it on a different pixel phase on a resampled display.

Motion stops while the document is hidden: `windowChrome` mirrors visibility onto the root, and [motion.css](../src/renderer/styles/motion.css) pauses on it.

## Background battery

JS loops that CSS pausing cannot reach check `document.hidden` themselves.

- [EffortPixelField](../src/renderer/components/EffortPixelField.tsx) parks its rAF loop while hidden.
- [TurnExhale](../src/renderer/components/TurnExhale.tsx) is mounted only during its sweep, and a hidden document skips the sweep.
- The chat typewriter runs on the animation frame and catches up silently on return. Pausing made every finished bubble type out together. All revealing blocks share one frame loop, so React batches them into one render per frame.
- The open-agent poll in [AgentActivity](../src/renderer/components/AgentActivity.tsx) runs only for the shown tab. A tab shown again reloads, because Codex and Cursor child traces are imported by that read.

A post-commit push hint asks the subscribed timeline to read its durable feed. The selected running session also uses a polling fallback. See [runtime](runtime.md#event-delivery).

## Transcript size

[SessionTimelines](../src/renderer/lib/sessionTimelines.ts) retains transcripts per session, with caps. Late reads cannot restore an evicted history, and live pushes take precedence over stale copies. Dashboard metadata holds no second copy.

[SessionConversation](../src/renderer/components/SessionConversation.tsx) mounts nested tail windows (`CONVERSATION_WINDOW`, then per-turn and per-group limits), each with a Show earlier control. The nesting matters for a provider that keeps one turn open for hours. Without it, one long turn re-reconciled thousands of subtrees on every delta.

Once the reader scrolls away, [useStableTailWindow](../src/renderer/hooks/useStableTailWindow.ts) keeps the mounted ids. Windows read the follow state instead of taking it as a prop, so scrolling renders none of them. The first upward wheel notch on a 98-turn chat went from about 1,500 committed components to one. Wheel easing writes `scrollTop` every frame ([chat-cards.md](chat-cards.md#follow-scroll)), so any main-thread work during a scroll shows as a stutter.

Caches are bounded for panes that stay mounted:

- Settled Markdown parses are kept by text in [StreamingMarkdown](../src/renderer/components/StreamingMarkdown.tsx).
- Highlighted fences are kept in [highlighter.ts](../src/renderer/lib/highlighter.ts). A fence still being written is not kept, because its prefixes are never asked for again.
- A fence not in cache paints plain and queues its highlight, in small time slices. Tokenizing inside the first render made a 312 ms longest task.
- Diff hunks highlight off the render path ([diffHighlight.ts](../src/renderer/lib/diffHighlight.ts)), carrying grammar state, so a string spanning lines colors correctly.
- Diff previews, closed file previews, and composer file trees have per-pane limits. A failed preload retries. Oversized diffs stay viewable without being cached.

The focused desktop pane warms its file list and first diff. Closed background panes defer Git reads.

## IPC

Timeline push hints trigger `session:events-since`, and no dashboard-wide poll exists ([runtime.md](runtime.md)). `session:agent-events` runs only while a subagent tab is open.

The budget measures what the user waits for: the renderer round trip from `invoke` to result, including serialization and async handler time. [tauriBridge.ts](../src/renderer/lib/tauriBridge.ts) times every request/response call at one point and keeps the last 100 durations per channel ([ipcLatency.ts](../src/renderer/lib/ipcLatency.ts)). A rejected call counts. Read the numbers in Settings → Advanced → Performance (p50, p95, p99, max), in the debug panel IPC tab, or in automation with `window.__argmaxPerf?.ipc()`, which returns one row per channel, slowest p99 first. The Rust side keeps no latency registry. Handler time alone hides the cost of a large result.

Browser bounds share one measurement per animation frame, and unchanged bounds skip the native call. Tab persistence runs after the interaction and excludes loading-only updates.

## Turn waterfall

Every turn a person starts records where its time goes between the send and the first painted answer, in the installed app too ([turn_waterfall.rs](../src-tauri/src/providers/turn_waterfall.rs)). A turn starts timing when `providers:launch` or `providers:send-input` reaches its handler (`ipc_received`, offset 0). The handler gets an origin token, and only the admit that carries that token opens the turn. A queued follow-up leaves no row, and queue drains, agent messages, and schedules carry no token, so they open none and cannot take a person's origin. The turn is keyed by session id and the `user.message` event id it answers.

| Step | Taken at |
|---|---|
| `submit` | The composer's click, `Date.now()`, sent as `submittedAtMs`. Desktop window only; the remote bridge drops it. Negative. |
| `ipc_received` | The IPC handler, before routing. |
| `admitted` | Workspace admission and the checkout lock held (`launch.rs`, `input.rs`). |
| `checkpoint_start`, `checkpoint_end` | Around `capture_before_provider_turn`. The capture runs beside the provider's startup, so these overlap `spawn` and `initialize_*` ([the gate](providers.md#the-pre-turn-checkpoint-gate)). |
| `env_ready`, `spawn` | Claude: around `command.spawn()` in `claude_control.rs`. Other providers: `spawn` is the launcher returning a handle, which is after the prompt was sent. |
| `initialize_sent`, `initialize_ack` | Claude's `initialize` control request flushed to stdin, and its `control_response`. |
| `prompt_gate_waited` | The launch was ready for the prompt before the checkpoint ended; stamped when the checkpoint ended. Absent when the checkpoint finished first. Claude, Codex, OpenCode, and the ACP paths. |
| `prompt_written` | Claude's first user message flushed to stdin: about `max(checkpoint_end, initialize_ack)`. |
| `first_stdout` | Claude's first stdout line; for the other providers, the first stdout line the flush queue takes. Not stamped for typed PTY input, whose first output is the echo. |
| `cli_init` | Claude's `system`/`init` message. |
| `first_content` | The first assistant text or tool start parsed (`flush_queue.rs`). |
| `first_persisted` | The writer transaction that holds it committed. |
| `first_hint_emitted` | The first `dashboard:delta` for the session after that commit reached the webviews. |
| `first_painted` | Two animation frames after the chat rendered the turn's first content (`useTurnPaintReport`), reported once through `session:turn-painted`. |

Backend stamps are `Instant`s, in milliseconds from `ipc_received`. The two renderer stamps are epoch milliseconds, converted with the wall clock read at `ipc_received`. Only the first stamp of each step counts, and an ended turn takes no more. The streaming path stays lock-free: atomic counts of open turns gate every stamp, and a per-run gate skips a step once it is stamped, so a token with no open turn locks and allocates nothing. The turn closes on the paint report, on the next admitted send, or 5 s after any turn end, a stopped turn included. Typed PTY input closes at once, with no answer stamps. Closing logs one `turn waterfall` line with every offset and writes one `turn_waterfalls` row off the streaming path ([data.md](data.md#turn-waterfalls)). `session:turn-waterfalls` reads the newest rows, and Settings → Advanced → Performance shows the last 20.

## Native iOS

[iOS performance and recovery](ios-performance.md) covers native caches and benchmarks. The web viewport probe does not measure the native transcript.
