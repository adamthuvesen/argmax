# Debugging

Two developer-facing surfaces, split by whether the numbers move.

For a reproducible local failure, start with `npm run doctor`, then
`npm run verify -- --scenario chat-resume`. The runner writes its report and
evidence under `scratch/verification/<run-id>/` by default. The report records
the source fingerprint, build identity, assertions, and cleanup outcome.
See [verification.md](verification.md) for scenarios and coverage boundaries.

| Surface | Opened by | Shows |
|---|---|---|
| Debug panel | `⌘⇧D`, or View → Toggle Debug Log | Live: this session's trace, the backend log tail, IPC latency |
| Settings → Advanced → Diagnostics | `⌘,` | Static, once per visit: row counts, startup phases, the full log dump, and the save/copy/vacuum actions |
| Perf HUD | `localStorage["argmax.perfOverlay"] = "1"` | An always-on corner readout of five hot channels |

## Debug panel

[src/renderer/components/debug](../src/renderer/components/debug). It docks to
the right of the focused session pane and coexists with the review panel.

**Trace** interleaves the session's normalized timeline events and its raw
provider output into one time-ordered list. That pairing is the point: a
normalizer bug reads as "this JSON arrived, and *that* event came out of it",
which two separate lists never show. Raw chunks are split per line, so a
stream-json burst reads as N rows. Each row carries the gap since the previous
one, and a gap past 1.5s is highlighted — that is how a delivery stall
separates itself from a slow model.

Collapsed rows summarise; reasoning content is reduced to a marker so a chain
of thought cannot bury the list. Expanding shows the line verbatim, and Copy
yields the original text, not the summary.

**Logs** tails the Rust `tracing` ring buffer
([util/log_buffer.rs](../src-tauri/src/util/log_buffer.rs), 1000 entries).
Filter by minimum level, by scope, or by text. The backend emits at `info` with
`argmax_lib` at `debug`; raise it with `RUST_LOG`. An unrecognized level is
never filtered out.

Renderer breadcrumbs join the same list, merged by timestamp so the two sides
read as one chronology. They share one ring
([lib/rendererLogRing.ts](../src/renderer/lib/rendererLogRing.ts)) and live in
the renderer rather than crossing IPC: a round trip per transition to record
that nothing happened is not worth its cost. Two scopes write to it.

`renderer::chat` ([lib/chatCueLog.ts](../src/renderer/lib/chatCueLog.ts)): one
line each time the chat's progress cue appears or disappears, carrying which of
the suppression rules is holding it down — `tool-running`, `card-ask`,
`live-thought`, `streaming-text`, `answer-settling`, `compacting`, or
`show-delay`. That cue is the only thing on screen while a relaunched provider
spends ten to thirty seconds before its first word, and it is derived from
state that is gone by the time anyone reads the transcript, so a pane that goes
quiet leaves no other evidence.

`renderer::drag` ([lib/dragLog.ts](../src/renderer/lib/dragLog.ts)): the
lifecycle of every drag that crosses the window — start, entry, a sampled
`dragover` line carrying whether any target accepted it, drop, end. Drag and
drop stops working window-wide after hours of use (a screenshot no longer
attaches, a sidebar row no longer splits a pane) and comes back only on
relaunch. The breadcrumbs separate the three candidates: no lines at all means
the event never reached the page, `accepted=false` throughout means it arrived
and no target took it, and a `warn` line — a drag that dropped without a
`dragend`, or that stopped mid-flight — means the page left a drag session
open, which is what a subsequent window-wide failure would follow.

**IPC** lists every channel called since launch with p50/p99 over the last 100
invocations, sorted by p99. Rows go amber past one frame (16 ms) and red past
100 ms.

The footer copies the session id, the provider's own conversation id, the
workspace id, and the worktree path — the four things you need to leave the app
and go query SQLite or find the provider CLI's transcript
(see [session-sync.md](session-sync.md)).

## Polling

Logs and IPC poll `system:debug-snapshot` once a second, and only while their
tab is open. That channel reads two in-memory ring buffers and nothing else.

Do not reach for `system:diagnostics` on an interval: it runs nine `COUNT(*)`
scans and shells out to `ps`. It is collected once, when the Advanced group
opens — the only group that shows the report. Loading it from every group put
those scans between the click and the Settings page appearing, which on a 1.8 GB
database was 1.7 s. It resolves through `read_off_main` for the same reason: the
scans used to run inline on the macOS main thread and froze the window.

Log lines are fetched by a monotonic `seq` cursor, so each tick transfers only
what is new rather than re-sending the ring.
