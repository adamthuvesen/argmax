# Performance Budgets

Budgets define targets for cold start, IPC, and renderer transformations. Measure a release build before you quote a number, because a debug build is about 5.5x slower. Dated measurements here explain a decision, and they are not current readings.

## Latency bench

`npm run bench:latency` measures how fast Argmax responds, in the real WKWebView of a verification release build. It drives the page over the build's embedded WebDriver. All times come from inside the page, so WebDriver round trips do not count.

The bench never touches live data. It copies your profile with `VACUUM INTO`, rewrites every project and workspace path to a `git clone --shared` fixture under `.verify/bench/repos`, turns routines off, clears PR watches, and points push URLs at a host that does not exist. A guard stops the run before launch if any path in the copy points outside the fixture root.

| Part | What it measures |
|---|---|
| `boot` | Process start → `ready-to-show` and first paint, one app launch per run |
| `navigation` | Pages, pickers, palette, settings, sidebar, tabs, chat switches: `shown`, `painted`, `settled`, the worst frame gap, IPC calls |
| `send` | New chat and follow-up with the fixture provider: acknowledgement, first text, and the turn waterfall |
| `real` | New chat and follow-up with the real Claude CLI (`--real claude`): click → spawn, prompt written, first paint |

- **shown:** the first frame in which the predicate holds.
- **painted:** two animation frames later. The floor is about 33 ms at 60 Hz, and each step of 16–17 ms is one frame.
- **settled:** no DOM mutation for 150 ms and no IPC call in flight.

Metric ids are the printed row names. Navigation rows add `:shown`, `:painted`, `:settled`, or `:gap`, for example `session.switch.first-visit:settled`. Results go to `.verify/bench/*.json`. Every run ends with a scoreboard against [targets.json](../scripts/bench-latency/targets.json).

```bash
npm run bench:latency -- --build --only navigation --n 12             # build, then measure
npm run bench:latency -- --compare before/argmax after/argmax --rounds 2 --only navigation,send --n 12
npm run bench:latency -- --diff a1.json a2.json -- b1.json b2.json   # compare saved runs
npm run bench:latency -- --only real --real claude --n 3              # real Claude turns
npm run bench:latency -- --check                                      # fail on a regression against the record
npm run bench:latency -- --update-record                              # tighten the record after a win
```

`--real claude` runs short turns ("Reply with just: ok") on your real Claude login with the fast Haiku model, one app launch per turn pair. The CLI runs through a generated wrapper, because the verification build gives the provider a temporary HOME.

### Hill-climbing a metric

1. Pick a target that misses on the scoreboard. Find what holds it: the turn waterfall for a turn, the probe's IPC list and frame gaps for navigation.
2. Build the current code and copy `src-tauri/target/verification/release/argmax` out of the target directory. The next build overwrites it.
3. Make the change and build again.
4. Run `--compare <before> <after> --rounds 2`. A delta smaller than the spread between rounds is noise. Add rounds before you believe it.
5. Report the stamp the user sees: first paint or first text, not `cli_init` or `initialize_ack`.
6. Run `--check`, then `--update-record`, and commit the record with the change. The record only tightens. `--loosen <metric>` raises one entry when a change deliberately trades it away. Say so in the commit.
7. Lock the mechanism with a count or structure test, and add it to [Budgets and their owners](#budgets-and-their-owners).

Traps that gave wrong numbers on 2026-11-13:

- **Runs from different times.** A CLI upgrade looked like 1.5 s → 0.53 s. Interleaved, it was about 0.3 s, and the rest was machine load. Always use `--compare`. Do not run builds or other benches at the same time.
- **The wrong stamp.** The MCP server cost looked like 1.9 s when measured to the CLI's `init` event. To the first token it was 0.4–0.6 s.
- **p95 at n = 12 is the slowest run.** For an overlay, that is the cold first open.
- **Revisit settled jumps about 130 ms between identical runs.** `--check` therefore compares p50 and allows max(20 %, 34 ms).
- **WKWebView reports no `longtask` entries.** Frame gaps come from the in-page timer sampler.
- **The record belongs to one machine.** `--check` warns when the host differs. Seed a new record on a new machine.

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
| Latency targets, and no regression against the last accepted run | [targets.json](../scripts/bench-latency/targets.json), [record.json](../scripts/bench-latency/record.json), `npm run bench:latency -- --check` ([Latency bench](#latency-bench)) |
| A repeat checkpoint of an unchanged checkout runs ≤ 2 git processes | `a_second_checkpoint_of_an_unchanged_checkout_runs_two_git_processes` ([checkpoints/service.rs](../src-tauri/src/checkpoints/service.rs)) |
| The CLI starts while the checkpoint runs; the prompt waits for it | `the_prompt_waits_for_the_checkpoint_gate_after_initialize` ([claude_control.rs](../src-tauri/src/providers/claude_control.rs)) |
| Claude turns skip the post-turn summary call | `every_claude_turn_env_pair_is_in_the_process_env_not_the_settings`, `a_claude_pty_launch_puts_every_turn_env_pair_in_the_process_env` |
| A chat revisit makes none of the reads it kept | [SessionPane.revisit.test.tsx](../src/renderer/components/SessionPane.revisit.test.tsx) |
| A long chat mounts its newest 8 items first | [SessionConversation.window.test.tsx](../src/renderer/components/SessionConversation.window.test.tsx) |
| Git runs the real binary, not Apple's `xcrun` shim | `the_xcrun_shim_on_path_resolves_to_the_real_git` ([git_exec.rs](../src-tauri/crates/argmax-process/src/git_exec.rs)) |

The timed budgets need the native app, so CI cannot run them. The test rows lock in each mechanism behind a latency win with an exact count, so a regression fails `npm test` without a timer. When you land a latency win, add a row like these.

`sessions.recover` uses a partial index, so startup orphan detection stays O(sessions). Process orphan scans run in background tasks, so they do not block the setup hook.

## Eager bundle

KaTeX is the largest single dependency, so it stays out of the cold-start graph. The chat renders without math plugins and delegates to the lazy [MathMarkdown](../src/renderer/components/MathMarkdown.tsx) chunk only when `needsMath` says the text may contain math. Shiki loads the same way, after a fence or diff mounts ([highlighter.ts](../src/renderer/lib/highlighter.ts)). It runs in a module worker ([highlight.worker.ts](../src/renderer/lib/highlight.worker.ts)), a lazy chunk that Vite builds with `worker.format: "es"` so that each grammar stays its own chunk.

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

The outer window fills after the first paint. An opened chat mounts its last `FIRST_PAINT_ITEMS` items, and each later frame mounts `MOUNT_GROWTH_STEP` more above them, in a transition, until the window is full. Following places the latest prompt at the top of the viewport, so the first frame shows all that the reader can see. The restore window (`data-restoring`) stays open until the fill ends, so rows that mount late do not play their entrance motion. Rules for the fill:

- It waits until no wheel, key, touch, or scrollbar input has arrived for 150 ms. Each step makes the scroll controller correct `scrollTop`, and in WebKit a write in the middle of a momentum scroll stops the scroll or moves the view back.
- Show earlier counts only the items outside the full window. A click during the fill mounts the rest of the window and nothing more.
- A failed history load ends the fill, as a finished backfill does.

Once the reader scrolls away, [useStableTailWindow](../src/renderer/hooks/useStableTailWindow.ts) keeps the mounted ids. Windows read the follow state instead of taking it as a prop, so scrolling renders none of them. The first upward wheel notch on a 98-turn chat went from about 1,500 committed components to one. Wheel easing writes `scrollTop` every frame ([chat-cards.md](chat-cards.md#follow-scroll)), so any main-thread work during a scroll shows as a stutter.

Caches are bounded for panes that stay mounted:

- Settled Markdown parses are kept by text in [StreamingMarkdown](../src/renderer/components/StreamingMarkdown.tsx).
- Highlighted fences are kept in [highlighter.ts](../src/renderer/lib/highlighter.ts). A fence still being written is not kept, because its prefixes are never asked for again.
- A fence not in cache paints plain and asks for its colors with `requestHighlight`. Tokenizing inside the first render made a 312 ms longest task.
- Diff hunks highlight off the render path ([diffHighlight.ts](../src/renderer/lib/diffHighlight.ts)). Each side of a hunk is one request, so a string spanning lines colors correctly.
- Diff previews, closed file previews, and composer file trees have per-pane limits. A failed preload retries. Oversized diffs stay viewable without being cached.

The focused desktop pane warms its file list and first diff. Closed background panes defer Git reads.

## Chat switch

Selecting a chat remounts its whole pane, so every read the pane makes on mount runs again on every switch. Reads whose reply has a known staleness signal are kept across the remount in [retainedReads.ts](../src/renderer/data/retainedReads.ts), the one renderer home for this. `useBridgeQuery` takes `retain` for it. A kept reply is keyed by what it depends on, and a dashboard resync drops every entry. A read still in flight when its entry would be dropped is not kept, and a failed read is never kept:

| Read | Dropped when |
|---|---|
| `review:list-changed-files` | The workspace's changed-files count, state or last activity moves (the key; a turn's end advances the activity), or a review action refreshes the list. Edits outside a turn that keep the count are not seen until it moves. A visible Changes list still revalidates on mount, and a closed one waits until it opens. Project and project-folder sources have no change signal and are not kept. |
| `checkpoints:list` | The session state or the workspace's last activity moves (the key). |
| `goals:get` | A delta carries `goalChangedIds`. |
| `session:fork-lineage`, `projects:get-folders` | A delta carries `dashboardChanged`. An explicit refresh also re-reads folders. |
| `providers:discover` | Never. Rust caches discovery until a forced refresh, and a forced refresh lands under the same key. |

Other per-switch work:

- `prs:refresh` publishes only the workspace rows it changed. An unchanged publish still set `dashboardChanged`, so every switch re-read the full dashboard (`dashboard:list` and `approvals:pending`).
- The open-time PR refresh waits until the chat has stayed open for `SETTLE_MS` ([chatOpenSettle.ts](../src/renderer/lib/chatOpenSettle.ts)), like the follow-up suggestion, and skips a session and branch refreshed less than one poller tick (60 s) ago.
- Shiki uses precompiled grammars with the raw JavaScript engine. The first TypeScript fence of an app run was a 786 ms task; precompiled, it was about 466 ms (one sample each, same chat). The grammars are `v`-flag regex literals, so WebKit older than Safari 17 keeps the runtime-translated grammars. The worker makes the same check.
- Shiki runs in a module worker. The main thread sends each fence, or each side of a diff hunk, as one whole request and gets token lines back. Because a request is a whole block, no grammar state crosses calls. Requests are cancelled when their block unmounts, and a streaming fence replaces its request on each throttle tick. If the worker cannot start, fails to load, or fails to create Shiki, its open requests move to the main thread. There they run 200 lines per step, in 6 ms slices, and carry the grammar state between steps.

Measured 2026-11-13 with `npm run bench:latency -- --build --only navigation --scenarios session.switch --n 12` (release build, copied profile; another bench ran on the machine during the baseline). Milliseconds, p50 / p95:

| Scenario | n | Painted | Settled | Max frame gap p95 | IPC |
|---|---|---|---|---|---|
| First visit, before | 12 | 66 / 112 | 614 / 1,304 | 858 | 15.3 |
| First visit, after | 12 | 70 / 277 | 418 / 917 | 474 | 10 |
| Revisit, before | 24 | 78 / 92 | 385 / 419 | 56 | 12 |
| Revisit, after | 24 | 65 / 72 | 47 / 51 | 46 | 2 |
| 12k-event chat, before | 12 | 298 / 323 | 379 / 576 | 272 | 13 |
| 12k-event chat, after | 12 | 288 / 306 | 287 / 306 | 243 | 3 |

With n = 12 the p95 is the slowest run. The first-visit painted p95 of 277 ms is one chat in two of three runs with precompiled grammars: the shorter grammar task can now land before that chat's second frame.

The worker, measured 2026-11-13 with the same command and a temporary probe, removed afterwards. Milliseconds:

| First visit | n | Painted p50 / p95 | Settled p50 / p95 | Max frame gap p95 | Longest highlight task on the main thread |
|---|---|---|---|---|---|
| Before, run 1 | 12 | 43 / 262 | 393 / 1,068 | 500 | not probed |
| Before, run 2 | 12 | 61 / 81 | 408 / 1,192 | 472 | 457 (the first fence's job) |
| Worker | 12 | 51 / 81 | 421 / 1,194 | 215 | under 1 (reply handler), 35 from reply to the second frame after it |

The first tokenization now takes 466 ms inside the worker. The one main-thread gap over 50 ms that the probe saw during highlighting (106 ms) had no worker reply in it, so it is not highlighting. Revisit and the 12k-event chat did not move (gap p95 62 → 47 and 249 → 234, inside run-to-run noise). With n = 12 the p95 is the slowest run. The bench profile has few fences, so a chat with many fences was not measured. Highlight colors are unchanged: the tokens and colors of a TypeScript, Rust, Markdown, and diff fixture match exactly in light and dark, and headless Chrome screenshots of it are pixel-identical. Release WKWebView serves the module worker over the custom protocol: the probe saw every request answered by the worker.

Still open, measured with a temporary render probe:

- A first visit still makes about 10 calls: `session:events-since`, `goals:get`, `session:fork-lineage`, `checkpoints:list`, `projects:get-folders`, two `review:list-changed-files`, and `session:turn-painted`.

### The 12k-event chat

A temporary probe in the real WKWebView showed what the switch frame held. The renderer held 1,012 of the chat's events, and its window mounted 111 items: about 8,500 nodes (55 turns, 126 tool groups, 729 SVG icons, 35 tables). Creating them was a 120–130 ms commit. Two more commits followed in the same frame, when the backfill landed and when the restore flag moved, and each spent about 30 ms on a forced relayout of the whole list. Paint itself was about 15 ms. Deriving the model was 2–3 ms.

The fix mounts the last 8 items first and fills the window in steps of 8, one per frame ([Transcript size](#transcript-size)). The first commit is about 436 nodes and 12 ms. Four bench runs, n = 12 each, milliseconds p50 / p95. The last column is a plain revisit in the same app run, which shows how loaded the machine was:

| Run | Painted | Settled | Max frame gap p95 | Revisit gap p95 |
|---|---|---|---|---|
| Before | 285 / 328 | 285 / 593 | 260 | 46 |
| After | 52 / 54 | 386 / 410 | 37 | 33 |
| Before, A/B pair | 292 / 319 | 292 / 319 | 261 | 74 |
| After, A/B pair | 82 / 86 | 396 / 419 | 71 | 61 |

In the A/B pair the long chat's gap is at the level of a plain revisit, so the remaining long frame is the pane switch itself, not the transcript. Settled is later by design: the fill keeps the DOM changing for about 400 ms after the paint. Steps of 16 items measured a frame gap p95 of 59, and steps of 12 measured 45 to 73.

Rejected or not tried:

- A smaller `CONVERSATION_WINDOW` (2026-09-23, about 10 %). The first frame still mounts many items, and Show earlier reveals less.
- `content-visibility: auto` on turns. The first frame still creates every node. Turns above the viewport would get an estimated height, which the scroll controller would then have to correct while a detached reader scrolls up.
- A virtualization library. The fill reaches the target with the existing follow and anchor controller, and a virtual list would replace that controller.

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

### Measured and not built: a warm Claude process

Measured 2026-11-13 with the real Claude CLI (2.1.323, Haiku) in a release
build, n=4 per case, after the checkpoint started overlapping CLI startup. A
follow-up writes its prompt 519 ms after the IPC call (was 868), and the CLI
startup still showing past the checkpoint is 18-43 ms. Keeping the process
alive after a turn could save only that, against about 400 MB per idle process
and stale-config eviction across model, permission, MCP preset, move and fork.
For new chats the checkpoint itself is the gate (about 930 ms while the CLI
boots beside it), so prewarming the CLI would not help either. Revisit only if
a waterfall shows `initialize_ack` well past `checkpoint_end`.

### The checkpoint gate

Measured 2026-11-13 with `npm run bench:latency -- --only send --n 5` in a
release build with the scripted Claude fixture, before and after back to back
on a quiet machine (10 turns per run: 5 new chats and 5 follow-ups, all on the
project checkout). The capture is described in
[providers.md](providers.md#the-pre-turn-checkpoint-gate).

| Repo | `checkpoint_end` p50 / p95, before | After |
|---|---|---|
| argmax (1.9k files) | 252 / 294 ms | 84 / 144 ms |
| mentos (16k files) | 342 / 449 ms | 75 / 101 ms |

The fixture writes no files, so after the first capture every turn reuses the
last capture's trees: 2 git processes (`status`, `update-ref --stdin`), against
13 before. A capture with no record and an edited file, timed alone, went from
134 to 53 ms on argmax and from 322 to 132 ms on mentos, with identical trees.
`status` is now the floor: about 7 ms alone on argmax and 68 ms on mentos, and
60-200 ms in the app, where it shares the machine with the CLI boot, the turn
mark, and the review refresh (about 20 more git processes at turn start).

Reuse cannot see a change that moves the tree `add` writes without moving
status or a stat. Such changes are `.git/info/attributes`, `core.autocrlf`,
and filter configuration changed while the app runs. The next capture that
is not reused picks the change up.

Measured and not taken:

- **Zero git processes on reuse.** It needs the watcher to prove nothing
  changed, and FSEvents gives no delivery barrier for a write made just before
  the capture. `status` is the proof instead.
- **`core.untrackedCache`, `core.fsmonitor`.** Both store their state in the
  real index or a daemon. Argmax reads with `GIT_OPTIONAL_LOCKS=0` and forces
  `core.fsmonitor=false`, so neither can help a read.
- **Sharing the turn mark's snapshot.** The measured-diff mark marks the same
  boundary with 4 git processes, and equals the checkpoint's worktree tree
  whenever no force-staged ignored file was dropped. Sharing it means threading
  the mark through the launch task; not built while the gate is under 100 ms.

## Native iOS

[iOS performance and recovery](ios-performance.md) covers native caches and benchmarks. The web viewport probe does not measure the native transcript.
