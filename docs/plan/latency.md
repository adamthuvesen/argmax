# Latency program

Snapshot of 2026-11-13. Branch `adam/refactor-agent-dx` at `128b8c50`.

The goal is that every interaction in Argmax feels instant: pages, pickers, the sidebar, tabs, switching chats, and starting or continuing a turn. A slower cold start is acceptable when the time buys something else, such as prewarmed processes.

## How the baseline was measured

- **Build.** A release binary with `custom-protocol,verification`, so the real WKWebView embeds the loopback WebDriver (`tauri-plugin-wdio-webdriver`).
- **Profile.** A `VACUUM INTO` copy of the installed app's profile: 8 projects, 46 workspaces, 48 chats, 53k events.
  - Every stored path is rewritten to `git clone --shared` fixtures of the real repos (mentos is 16k files, argmax is 1.9k).
  - Schedules and PR watches are off, push URLs are disabled, HOME is a temp directory, and `gh` is signed out.
- **Probe.** An in-page probe wraps every `window.argmax.*` call. Each interaction records four values, all taken in the page:
  - **shown:** the first frame in which the target DOM exists.
  - **painted:** shown plus a double rAF. The floor is 33 ms at 60 Hz.
  - **settled:** no DOM mutation for 150 ms and no IPC in flight.
  - **Counts:** IPC calls and the largest frame gap.
- **Send path.** The scripted Claude fixture replaces the model. A shim stamps each CLI exec on the wall clock, which splits the time before spawn from the time after it.
- **Field data.** 375 Claude turns from the real database, and three null turns of the real `claude` CLI on Adam's config.
- **Repetitions.** n = 5–16 per scenario. With n = 8, p95 is the maximum, and it is usually the first open. One machine, the screen unlocked, no other busy chats.

The harness scripts are in this session's scratchpad (`wd.mjs`, `install.js`, `frames.js`, `suite.js`, `send.js`, `launch.sh`). Phase 0 moves them into the repo.

## Baseline

### Boot

| Metric | Value |
|---|---|
| Process start → window ready-to-show | 262–342 ms (installed app: 277–667 ms) |
| Process start → renderer first paint, sidebar visible | 339–393 ms |
| First boot on a profile that needs migrations | ready-to-show 1,772 ms (`db.open` → `sessions.recover` 438 ms) |
| Eager renderer graph | 1.80 MiB across 20 chunks: one 1.59 MB `index` chunk plus 467 KB of CSS |

### Navigation (p50 / p95, ms)

| Interaction | Shown | Painted | Settled | IPC |
|---|---|---|---|---|
| Sidebar group expand or collapse | 6 / 7 | 33 / 34 | 6 / 7 | 0 |
| Archived chats expand | 18 / 20 | 33 / 35 | 18 / 20 | 0 |
| Hide/show sidebar | 28 / 35 | 71 / 105 | 67 / 100 | 1 |
| Switch chat, first visit | 27–32 / 47–51 | 67–96 / 140–195 | **363–629 / 624–1,263** | 11–14 |
| Switch chat, revisit | 32–78 / 35–90 | 67–129 / 71–140 | **362–418** / 366–432 | 11–12 |
| Switch to a 12k-event chat | **207** / 215 | **324** / 333 | 395 / 416 | 13 |
| Max frame gap during a first-visit switch, p95 | 148–802 | | | |
| Command palette, repeat / first open | 20–28 / **328** | 50 / 366 | | 0 |
| Palette query results | 8 / 13 | 33 / 35 | 162 / 170 | 1 |
| Palette Files tab | 51 / 69 | 84 / 102 | | 1 |
| Settings, repeat / first open | 5–9 / **330–338** | 33 / 367 | | 3 |
| Settings section switch | 11 / 22 | 51 / 62 | 23 / 824 | 2 |
| Usage page | **108–116** / 350–359 | 141–159 / 399–408 | 118–127 / 389–472 | 3 |
| Activity page | 84 / 110 | 128 / 150 | 123 / 144 | 1 |
| Schedule, repeat / first open | 28 / **319** | 68 / 354 | | 2 |
| New chat launcher | 21–34 / 24–37 | 52–73 / 53–85 | **353–371** | 8 |
| Model picker | 13 / 28 | 50 / 68 | | 0 |
| Effort picker | 9 / 13 | 50 / 51 | | 0 |
| Project picker | 10 / 12 | 33 / 50 | | 0 |
| Branch picker | **66** / 68 | 100 / 101 | | 2 |
| Workspace Changes tab (rough, misses) | 33 / **516** | 67 / 547 | 219 / 855 | 3 |
| Workspace Files tab (rough) | ~100 | ~116 | | |
| Workspace Terminal tab (rough) | ~26 | ~48 | | |
| Composer keystroke (synthetic input) | 4 / 5 | 33 / 37 | 9 / 10 | 0 |

### Send pipeline (scripted Claude fixture, n = 5)

| Interaction | User bubble painted | CLI spawned | First assistant text |
|---|---|---|---|
| New chat | 104–127 ms | +582–616 ms | 995–1,281 ms |
| Follow-up (resume) | 14–23 ms | +457–481 ms | 828–878 ms |

- The fixture costs about 120 ms after spawn: 57 ms of node boot and 3 × 20 ms of emits.
- Argmax owns about **600 ms before spawn** on a new chat and about 465 ms on a follow-up.
- Argmax owns about **300 ms after spawn**: parse, the 25 ms batch, persist, the hint, the pull and the render.

### Real CLI and field data

| Metric | Value |
|---|---|
| `claude` spawn → `system:init`, Adam's config with 43 MCP servers | **2,345–2,787 ms** |
| `claude` spawn → first token (Haiku) | 4,310–4,522 ms |
| `claude` result event after the API finished | up to 16 s late (API 9 s, result at 25 s) |
| Field: Claude send → first event, p50 / p90 (n = 375) | **10.2 s / 16.3 s** |
| Field: Claude send → first text, p50 | 17.4 s |

Argmax launches turns without `--strict-mcp-config`, so every turn starts the user's full MCP stack plus `argmax mcp`.

Estimated split of a real Claude turn before the first token:

| Part | Time |
|---|---|
| Argmax before spawn | ~0.6 s |
| CLI boot and MCP connect | ~2.5 s |
| Model time to first token | ~2 s or more |
| Argmax after spawn | ~0.3 s |

### IPC per call (p50 / p95, ms)

| Channel | Latency | Note |
|---|---|---|
| `review.listChangedFiles` | 291 / 396 | Runs on every chat switch. It sets the settled time. |
| `workspaces.autoTitle` | 264 | |
| `session.suggestFollowUp` | 76 / 113 | Spawns a CLI. |
| `projects.refreshBranch` | 60 / 73 | |
| `prs.refresh` | 58 / 188 | 49 calls across the run. |
| `dashboard.list` | 2 / 4 | 99 calls: one full snapshot per chat switch. |
| `session.eventsSince` | 1 / 13 | |

### Instrumentation gaps found

- WKWebView reports no `longtask` entries. The renderer stall observer and the Perf HUD see nothing.
- The Rust IPC latency registry (`util/ipc_latency.rs`) has no producer. Settings → Diagnostics IPC p50/p99 is empty, and the "IPC p99 < 100 ms" budget is not enforced.
- No span covers send → spawn → first byte → first paint, and no log line carries a launch phase.
- The only renderer marks are `argmax:first-paint` and `argmax:first-content`.

## Target rule

Target = min(the perceptual threshold for the interaction class, the measured floor × 1.2). Every target is measured at p95, on the copied profile and on a 3–5× heavy profile, with one scripted chat streaming. Stop climbing a metric when it meets the target.

| Class | Target |
|---|---|
| Direct manipulation (keystroke, hover, toggle) | Painted in 1 frame over the floor: ≤ 50 ms painted |
| Navigation (page, chat, tab, picker, palette) | Shown ≤ 50 ms, real content painted ≤ 100 ms, settled ≤ 300 ms, also on first open |
| Commands that start work (send, new chat) | Acknowledgement painted ≤ 50 ms. Argmax overhead before spawn ≤ 50 ms. After spawn ≤ 50 ms over the fixture. |
| Real turn, excluding model time | Click → CLI ready ≤ 200 ms on a warm hit. Report the hit rate and the full distribution with misses. |
| Boot | A ceiling, not a goal: process → first paint ≤ 500 ms, including any prewarm the main thread pays for |

Concrete first targets from the baseline:

| Metric | Baseline | Target |
|---|---|---|
| Chat switch, settled p95 | 624–1,263 ms | ≤ 300 ms |
| Chat switch, painted p95 | 140–195 ms | ≤ 100 ms |
| Max frame gap during a switch | 148–802 ms | ≤ 50 ms |
| 12k-event chat, painted | 324 ms | ≤ 100 ms |
| First open of palette, settings, schedule, usage | 319–359 ms | ≤ 100 ms |
| New chat launcher, settled | 353–371 ms | ≤ 150 ms |
| New chat, user bubble painted | 104–127 ms | ≤ 50 ms |
| New chat, click → CLI spawn | ~600 ms | ≤ 50 ms |
| Follow-up, click → CLI spawn | ~465 ms | ≤ 50 ms |
| After spawn → first text, excluding the fixture | ~300 ms | ≤ 50 ms |
| Real Claude follow-up, click → CLI ready | ~3 s | ≤ 200 ms on a warm hit, with an 80% hit rate |
| Branch picker | 66 ms | ≤ 30 ms |
| IPC calls per chat switch | 11–14 | ≤ 4 |

## Plan

### Phase 0: instrument (first)

1. **Turn waterfall.** Stamp one turn id at each step and persist the stamps, so that the installed app collects field data during daily use. Show them in the Perf HUD. The steps are:
   - click
   - IPC received
   - checkpoint start and end
   - spawn
   - first stdout byte
   - CLI init
   - first content event
   - persisted
   - hint emitted
   - painted
2. **Interaction marks.** Add `performance.mark`/`measure` for chat switch, page open, picker open, palette open and first-open chunk load. Replace the dead long-task observer with a rAF frame-gap sampler.
3. **IPC latency producer.** Emit `channel` and `latency_ms` from the IPC layer, so the existing registry fills. Fix `docs/performance.md` in the same change.
4. **`npm run bench:latency`.** Move the scratch harness into `scripts/`. It builds the verification release binary, clones a pristine APFS copy of the profile before each run, rewrites paths to fixture repos, and writes JSON. The JSON records the commit sha, the binary hash and the machine state (power source, thermal state, other Argmax processes).
5. **Scenarios.** Add the null variants that set each floor: an empty-pane switch, a no-op IPC call, and a bare CLI spawn to init. Add a heavy profile (3–5× the real one, plus one multi-hour single-turn chat), and a "five scripted chats streaming" background mode.
6. **Ratchet counts, not times.** Gate in `precheck` on IPC calls per interaction, process spawns and git spawns per turn, and eager bytes. Track times in the JSON and compare them ABAB, interleaved, never across days.

### Phase 1: the send pipeline (the largest absolute win)

1. **Find the 600 ms before spawn.** Use the waterfall. The candidates are:
   - the checkpoint chain (about 10–12 serial git spawns)
   - provider discovery
   - the login-shell env
   - the workspace admission and checkout locks
2. **Split "start process" from "deliver prompt".** Spawn the CLI and run `initialize` while the checkpoint runs. Write the prompt when both finish. The checkpoint stays a hard gate before any provider write.
3. **Keep the Claude process alive after a turn.** Use an idle TTL and a cap of 1–2 processes, with eviction on a config fingerprint: model, effort, permission mode, cwd, MCP config and linked folders. This removes the ~2.5 s CLI and MCP boot from follow-ups. Measure the RAM cost: about 400 MB per process plus its MCP children.
4. **Prewarm on intent.** On composer focus or the first keystroke, spawn and initialize a process for the selected provider and model. Check the Auto router first: it picks the model after it reads the prompt, so a prewarmed process needs an in-flight model switch or it misses.
5. **Shorten the path after spawn.**
   - Flush the first content event immediately.
   - Inline small transcript batches into the push for focused chats instead of sending a hint and then pulling.
   - Move FTS indexing from each `message.delta` row to turn settle.
   - Add writer-lock wait as a metric.
6. **Paint the user bubble and the new-chat pane before the IPC returns.** This is optimistic acknowledgement.
7. **Persist the login-shell env.** Key it on rc file mtimes and refresh it in the background.
8. **Measure `claude` result lag.** Up to 16 s between the API finishing and the `result` event delays the "turn complete" state. Find out whether it is MCP teardown.

### Phase 2: navigation

1. **First open of lazy surfaces (~330 ms).** Palette, Settings, Schedule and Usage pay a chunk load on first open. Preload their chunks right after first paint, or make them eager. Check why the existing idle prefetch does not hide this.
2. **Chat switch.**
   - Serve `listChangedFiles` (291 ms of git) from a cache keyed on the watcher generation, and refresh it after paint.
   - Stop calling `dashboard.list` and `prs.refresh` on every switch.
   - Defer `suggestFollowUp`.
   - Find the 150–800 ms frame gaps with the frame sampler.
3. **Long chats.** Make the conversation derivation incremental and cache the derived model per chat. The 12k-event chat shows content at 207 ms today.
4. **Metadata pushes.** Replace the full `dashboard.list` reload on every `dashboardChanged` with row deltas. Phone clients already get deltas through `dashboard_changes.rs`.
5. **Smaller items.**
   - Cache the branch list (66 ms).
   - Cache the new-chat context reads (8 IPC calls, settled at 353 ms).
   - Precompute the Usage page summary (108 ms to shown).

### Phase 3: under load and the experiments

- Run the navigation suite with five scripted chats streaming in the background. Look at the shared writer mutex and the flush queue.
- These need a metric that asks for them first: React Compiler (judged by commit counts), SQLite `mmap_size`/`cache_size` on readers, and a slim `argmax mcp` helper binary (one `hyperfine` run decides it).
- Boot stays a ceiling. Spend its headroom on prewarm.

### Do not retry without new evidence

These were measured and reverted on 2026-09-23:

- `<Activity>` keep-alive of chat panes
- Shiki idle warm-up
- adaptive reveal lag
- a smaller conversation window

## Risks

- **Synthetic input.** WebDriver input skips the native input path. Keystroke numbers are a proxy only.
- **Frame rate.** Painted times are quantised to frames. Occlusion, App Nap and Low Power Mode throttle rAF. Keep the window visible.
- **Scripted providers hide CLI cost.** They do not show CLI boot. The real-CLI null turn and the field stamps cover it, with small n and no gate.
- **Warm processes.**
  - They cost memory.
  - They can serve a stale config.
  - They conflict with the "process exit ends the turn" logic in `claude_control.rs`.
  - They conflict with the Auto router's choice of model after it reads the prompt.
- **The profile copy holds real paths.** Without the path rewrite, a second instance could write checkpoints into live repos or run PR cleanup on them.
