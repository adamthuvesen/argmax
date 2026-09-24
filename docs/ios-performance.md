# iOS performance and recovery

The native app shows saved content while the Mac reconnects, keeps Usage and
Activity preloaded, and prepares expensive transcript and review content away
from the main actor.

## Run the checks

From `ios/Argmax`:

```sh
xcodegen
xcodebuild -project Argmax.xcodeproj -scheme Argmax \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test \
  -skip-testing:ArgmaxTests/NativePerformanceTests \
  -skip-testing:ArgmaxUITests/NativePerformanceUITests

xcodebuild -project Argmax.xcodeproj -scheme ArgmaxPerformance \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test \
  -only-testing:ArgmaxTests/NativePerformanceTests \
  -only-testing:ArgmaxUITests/NativePerformanceUITests
```

`ArgmaxPerformance` uses release optimization with deterministic fixture entry
points and testable symbols. Its Profile action uses the shipping Release
configuration. The tests record projection, Markdown, file-tree and review
preparation time and memory, plus responsive launch and scrolling metrics.
Xcode stores the samples in the test run's `.xcresult`. Establish a baseline
on the same device and configuration before treating a timing difference as
a regression. Simulator measurements do not establish physical-device frame
or radio performance.

On a physical iPhone, replace the destination with its Xcode device ID and
supply the existing development team. UI tests also require a signed
`com.argmax.remote.uitests.xctrunner` profile. A connected phone alone does
not supply that profile.

For CPU and memory tests without a UI-runner profile, use the
`ArgmaxDeviceBenchmarks` scheme with
`-only-testing:ArgmaxTests/NativePerformanceTests`.

In Instruments, use Time Profiler, SwiftUI, Hangs, and Points of Interest.
`NativePerformance` records content-cache decode, transcript projection,
Markdown preparation, image-thumbnail preparation, file-tree preparation, and
review-document preparation in both Debug and Release builds.

The same builds log the user-facing milestones under the `perf` category, so a
run on real data can be timed without Instruments:

```sh
xcrun simctl spawn booted log stream --level debug \
  --predicate 'subsystem == "com.argmax.remote" AND category == "perf"'
```

- `launch→list` is milliseconds from process start (pre-main included) to the
  first chat list, once from the saved snapshot and once from the Mac.
- `chat open→saved` and `chat open→live` are milliseconds from opening a chat
  to its first rows, saved and authoritative.
- `request` lines carry each bridge read's channel, response bytes, round trip,
  and decode time. `frame` lines time the socket actor's frame parse for
  frames over 64 KiB.

Launch a paired simulator build with `-argmax-pair <link>` and optionally
`-argmax-open-session <id>` to open a real chat. Drive taps from a UI test by
coordinate: an element query takes an accessibility snapshot of the whole
transcript, which occupies the main thread for seconds and swamps the
measurement.

## Content and preloading

`DeviceCache` is disposable, pairing-scoped storage with a 32 MiB total and
32-entry budget, a 16 MiB per-entry limit, and a seven-day maximum age. A
schema version is part of its directory name. Coding and disk access run on
its actor. A failed or corrupt cache is a miss, and a live answer wins a race
with restoration.

The dashboard restores its last snapshot. The transcript retains up to eight
recent chats within a 16 MiB estimated memory budget and persists recent
transcript snapshots. Saved transcript content is labeled as saved and is
reconciled using the existing authoritative tail read. Cached cursors never
replace that read. A chat read live in this process instead catches up after a
reconnect through the host's change feed, which answers a pruned cursor with a
full reset; returning from the background to a 1,471-event chat moved 173 bytes
of transcript instead of 1.7 MB. Host removal cancels pending preparation and invalidates
the open chat's cache.

Usage and Activity still preload from `RootView` at launch and on foreground
entry. Both default ledgers restore asynchronously, scoped to the pairing and
time zone. Opening Insights does not start from scratch or cancel the other
ledger's preload. The existing freshness window remains in effect.

Transcript projection coalesces pending changes and runs on a background task.
A streaming chat projects its whole history per chunk, so the projection has to
stay linear: completions are matched to tool starts through a keyed queue,
patterns are compiled once, and each tool's own derived text (formatted input,
output, diff line counts) is reused while its two events are unchanged. The store writes the open chat's saved copy after a
300 ms pause, or every five seconds during a long stream, encoding it once for
both the size budget and the disk; leaving the chat stores what is pending.
Replaying a real 2,200-event chat at 20 chunks a second, these cut the process
CPU from 15.7 s to 3.6 s over 11 s of streaming.
Only a matching session generation and content revision may publish. Completed
Markdown documents have a bounded cache, with at most two active preparations.
Opening a chat prepares the newest 96 prose documents before its first paint,
so rows do not repaint and re-lay out the stack one by one after it.
The transcript's exact-height eager stack mounts at most 32 presentation rows.
Every mounted row is laid out and drawn whether it is visible or not, so the
window is what opening a chat costs. A chat opens with the newest rows that
fill about three screens, estimated from their text, and mounts the rest of
the window half a second later, above the tail, where the bottom size-change
anchor keeps the screen still. When a reader leaves the live tail, that
row window stays fixed as output lands and shifts by 16 rows once the reader
is within two screens of either edge, preserving the visible reading anchor.
The running mark (`WorkingNest`) breathes with a Core Animation group in the
render server, so an idle screen showing live work does no per-frame main
thread work: one running chat on the list cost 11% of the main thread while it
was a per-frame `TimelineView` canvas.
Image requests share a decoded-image cache. Inline images are downsampled for
their display size. Expansion immediately shows the current preview while a
larger representation is prepared.

Review invalidations are scoped to the affected workspace. Reconnect and
resync invalidate all open reviews. File-tree and attributed-document
preparation run outside view updates. View installation and selection stay on
the main actor. These changes preserve the existing preload behavior.

Composer drafts are protected files in Application Support, separate from the
evictable content cache. Edits save after a short debounce, and leaving the
screen or backgrounding requests an immediate save.

## Connection and action recovery

Every socket attempt has a generation. Authentication, receive, heartbeat,
and reconnect callbacks from retired generations cannot affect a replacement
connection. Foregrounding and network-path changes prompt recovery, with
bounded backoff and heartbeat as fallback. A usable network path does not
prove the Mac is reachable.

Every `dashboard:list` caller shares one read per host change: the list, the
open chat's composer metadata, and delegated-work cards each read the whole
dashboard on the same hint. A delta that hints at a change or carries rows, a
resync, a dropped socket, and any mutation this phone sends retire the shared
answer; otherwise it is reused for at most five seconds. With a chat open on a
busy Mac this halved the dashboard reads sent (24 asked, 13 sent in a minute)
at about 740 KB each. A Mac that advertises `dashboardChanges` at authentication
answers that read as `dashboard:changes` instead: a diff against the last
snapshot this phone merged, named by its digest, which `BridgeClient` merges
below the shared read ([DashboardChanges.swift](../ios/Argmax/Sources/Bridge/DashboardChanges.swift)),
so every caller still receives a whole snapshot. An answer that does not apply
to exactly that base costs one full read instead. The base survives reconnects,
since the host keys it by digest rather than by socket. Against the isolated dev
instance, a chat launch, a turn and six pins produced nine reads of 0.8–4.7 KB
each for a 51.7 KB list, and the store equalled an independent `dashboard:list`
afterwards. On the real 206-chat profile the same change after a hint is one
row, about 1 KB, against 684 KB. The budget: a hint moves only the rows it
changed. On that profile a median chat's rows are 1.1 KB (session) and 0.7 KB
(workspace), the largest 11 KB and 25 KB (a long first prompt, a PR list), and
a new chat also carries the id orders, 16 KB; a hint that costs more than the
rows it names plus those orders is a regression. The perf log line `dashboard:changes wireBytes= snapshotBytes=` shows
both sides. A transcript read queued while the socket reconnects
goes out on the new connection, so reconnecting does not request the chat a
second time.

A new mutation waits for authentication and replay capability before being
journaled or sent. The protected, pairing-scoped journal stores canonical input
and the original operation identity. A dropped response retries that same
identity within a bounded recovery window. Reads are not replayed as actions.
The host's `operationSettled` marker determines when a journal record can be
removed, including settled host errors.

After process termination, repeating the same unresolved action adopts its
saved identity. Nothing from an earlier process automatically executes at
launch. An outcome the host marks unknown is not automatically retried.
Settings → Your Mac → Unconfirmed actions lets the user acknowledge a record
after inspecting the affected chat. Clearing a record never submits an action.
Only host-interrupted records can be cleared. A submitted or pending record
retains its identity across relaunch until repeating the action recovers a
confirmed result.
The journal refuses new submissions at its capacity limit instead of evicting
unresolved actions.

A sleeping Mac or broken Tailscale route cannot be repaired by phone retries.
For long remote sessions, the Mac's existing Keep computer awake setting
prevents idle sleep while chats are active. Diagnose Tailscale Serve and TLS
from the Mac's remote-access settings.

## Acceptance scenarios

Run these against a representative large chat and a real paired Mac:

- Open cached chats in airplane mode, relaunch, then reconnect. Confirm current
  rows replace saved content and removed chats cannot reappear.
- Stream while typing, scrolling upward, opening the keyboard, and switching
  chats. The reading position must remain stable and the newest projection
  must win.
- Switch Wi-Fi and cellular, background the phone, restart the host, and drop
  a response after mutation execution. Verify eventual resync and no duplicate
  effects. A host-interrupted outcome must remain explicitly unconfirmed.
- Open Usage and Activity immediately after launch and after returning from
  the background. Verify cached numbers paint while their preloads refresh.
- Stream in workspace A with review B open. B must issue no refreshes for A's
  transcript events. Reconnect must still refresh B.
- Open screenshot-heavy chats, a 10,000-path tree, and a large diff repeatedly.
  Record peak memory, input latency, and hitches. Memory should settle after
  navigation instead of growing with every visit.

Initial targets are a cached warm chat opening within 100 ms at p95, cached
cold list within one second, and cached disk-backed chat opening within
500 ms. Continuous UI work should generally stay below 5 ms. These are
acceptance targets, not measurements or guarantees for an unavailable host.

## First measurements, 12 September 2026

Optimized hosted unit benchmarks ran on the connected iPhone Air. Each value
is the mean of five recorded iterations in milliseconds:

| Preparation | Before | After |
| --- | ---: | ---: |
| 3,000-event projection | 1.48 | 1.94 |
| Markdown fixture | 8.78 | 11.36 |
| 10,000-path file tree | 10.36 | 13.61 |
| 10,000-line review document | 27.08 | 33.51 |

These samples do not demonstrate a CPU speedup. The change moves preparation
away from the main actor, coalesces transcript work, and reuses cached results.
The runs were sequential with intervening builds, without thermal controls.
Use controlled repeated runs and Instruments to establish frame-time and
end-to-end navigation improvements. The unchanged projection and Markdown
algorithms also measured slower in the later run.

The native functional suite passed 325 tests after the review fixes. Four
transcript interaction tests passed. The keyboard-dismissal interaction failed
both before and after this change. A baseline simulator launch benchmark also
had an intermittent missing-app failure, so its launch samples are not an
accepted launch baseline. Physical UI benchmarks require the missing UI-runner
signing profile. Real Wi-Fi/cellular handoff and paired-Mac acceptance scenarios
above remain manual validation work.
