# Stabilization Phase 2: work preservation

Three Phase 2 journeys pass provisionally: queued-message restart, session
move and guarded file revert on disposable profiles and repositories. Dirty
archive acceptance remains open because native dialog verification was
explicitly deferred by the user.
The [Phase 1 report](stabilization-phase1-2026-09-13.md) records the accepted
baseline and unresolved native startup intermittency.

| Journey | Status | Acceptance boundary |
|---|---|---|
| Queued-message restart | Passed, provisional | Native queue, restart and explicit Send, with dashboard and SQLite assertions |
| Dirty archive | Deferred by user | Confirmation fix committed. Actual macOS Cancel/OK checks remain unverified |
| Guarded file revert | Passed, provisional | Native Revert preserves the staged diff and index tree and saves a checkpoint. A stale revision leaves files unchanged |
| Session move | Passed, provisional | Supported agent CLI schedules the move, carries history, resumes in the sibling checkout and preserves both paths |

Phase 2 remains open for dirty archive acceptance. B11 remains a separate
release prerequisite throughout. Phase 3 has not begun systematically.

## B13: confirmation does not guard desktop mutations

The frozen baseline's archive handler calls `window.confirm` synchronously.
The registered Tauri dialog plugin replaces that function with an async
function. The resulting Promise is truthy, so the handler requests a forced
archive before obtaining a decision. Scheduled-task deletion has the same
control-flow defect.

The installed Rust dialog plugin is 2.7.1. Its compiled `src/init-iife.js`
invokes `plugin:dialog|confirm`, while its registered commands are `open`,
`save` and `message`. Merely awaiting this injected function would leave the
unsupported command path in place.

An isolated component reproduction against the frozen Phase 1 v2 source
supplied the actual asynchronous confirmation contract with a declined
result. The real archive handler nevertheless called the archive API once
with `{ workspaceId: "workspace-1", force: true }`. Evidence:
`/private/tmp/argmax-phase2-confirmation-before.log` and
`/private/tmp/argmax-phase2-confirmation-repro`.

The prepared fix exposes `window.argmax.system.confirm(message)` as a
Promise of a boolean. The desktop bridge uses the official dialog helper's
message command, with the minimum `dialog:allow-message` capability. The
remote browser asks locally. Archive, stale-status archive retry and
scheduled deletion await the answer. Decline and dialog errors prevent the
mutation. Existing error surfaces report failures.

Regression tests cover pending, declined, accepted and rejected decisions.
The frozen candidate at `/private/tmp/argmax-phase2-confirmation-20260913`
passes all 75 focused tests across App, the bridge and scheduled tasks, plus
typecheck, renderer build and both bundle budgets. A later test-only change
waits for the scheduled delete button to be enabled after Cancel before
checking that deletion did not occur. All 14 scheduled tests pass again.
Focused lint has no errors, with six existing App hook warnings. Bridge
parity covers all 138 request channels and nine push channels. Independent
review found no material defect in the prepared change.

Automated native-dialog acceptance is blocked by the host: the macOS Accessibility
probe returns false, and CUA cannot initialize because no surfaces are
enabled. The plugin uses a real AppKit NSAlert. WebDriver's JavaScript alert
commands cannot accept or cancel that dialog. Automated checks need a working
native automation surface and host Accessibility permission. Component tests
do not count as native-dialog acceptance.
The user chose to leave this verification open rather than operate the
disposable dialogs manually. No further dialog interaction is scheduled.

Automatic approval review rejected installing
`@tauri-apps/plugin-dialog@^2.7.3`, citing the repository's requirement for
dependency-specific consent despite the user's general permission. Explicit
approval was requested and the user explicitly approved the official helper.
Version 2.7.3 is installed. An audit compared the current lockfile with HEAD
and found the same 12 high findings, all in development dependencies. The
dialog dependency introduced none. Raw audit evidence is at
`/private/tmp/argmax-phase2-npm-audit.json`.

Committed as `36527166` (`fix(desktop): await native archive and delete
confirmations`). Native compilation with `custom-protocol,verification`
also passes. The preserved binary is
`/private/tmp/argmax-phase2-confirmation-bin/argmax`, SHA-256
`8ab30bb305b8b390de7be4db2c45e801ca4172da07690aa3e816193693f5e16e`.
Build log: `/private/tmp/argmax-phase2-confirmation-cargo.log`. Native-dialog
acceptance remains open.

## Queued-message restart

The scenario holds a first turn at the fixture's explicit streaming barrier,
queues a second prompt through the native composer and restarts the same
isolated profile. Its contract requires the same queued ID and text after
restart, preserved first-turn content, visible paused delivery, no automatic
replay, exactly one message after explicit Send, and an empty final queue.

An initial attempt exposed a harness mistake: running chats queue through
Enter and show Stop, rather than a Send follow-up button. The corrected run
observed the intended recovery and send behaviour, but failed a later generic
persistence assertion that expected the deliberately interrupted first turn
to have completed. It also exposed an orphaned fixture process during native
restart cleanup. That process was stopped and cleanup checked.

The corrected v3 run passes. Two first-turn deltas retained the exact same
IDs and text across restart. The queued follow-up retained its ID and text
while its journal state changed from `pending` to `recovered`. There was no
second user message before explicit Send and exactly one afterward. The
resumed session completed and the pending journal was empty.

All three native screenshots were inspected. The recovered view showed
`Paused • not sent` and the explicit Send control. Native close captured
owned descendant PID/start identities and stopped only still-matching
processes after the app exited. The final process scan found no verification
app, driver or provider fixture. This proves cleanup of the driver's restart
scenario, rather than ordinary user-initiated app shutdown.

Evidence: `/private/tmp/argmax-phase2-queued-restart-v3-native-20260913/report.json`
with SHA-256 `d0d8f37cfd4cb81eadd11b40aec2e0b8bd31cb74dcfa542880dc19e0a9f5b3a0`.
Source: `/private/tmp/argmax-phase2-queued-restart-v3-20260913`, HEAD
`50a5c471d9ff3ccc29e865487793e5530e0f5235`, unchanged fingerprint
`1f3952ad0cf8dcbcd709a9adfb250d65f100a2d58ce7c077caf81bcfff8f93dc`.
The snapshot's typecheck and all 11 verification-script tests passed.

Independent review found two gaps in v3's harness. App identity must include
its start time when first connected, before collecting descendants at exit,
so a reused PID cannot make unrelated processes cleanup targets. Queue
assertions must check the entire session queue, so a duplicate with a new ID
cannot pass unnoticed. Both corrections are complete. A focused independent
re-review found no material defects.

The single v4 native run passes without a retry. The only pending row before
and after restart has ID `62f4b822-063b-4b81-9687-0af94e020c2e`. Its state
changes from `pending` to `recovered`, then it is removed. Second-user-event
counts are zero before restart, zero after recovery, and one after Send.
Both final session queues are empty. The exact two first-turn deltas survive.

Evidence: `/private/tmp/argmax-phase2-queued-restart-v4-native-20260913/report.json`.
The source fingerprint before build, after build and after the run is
`32bbd0b9a58d9cac925ef39bc889610254bd1f8a58852dd2fa0c299fc0b9e263`.
All three native screenshots were visually checked. Both cleanup records
match the app's stored PID and start time. A separate unsandboxed process
check confirmed app PIDs 11103 and 11373 and fixture PID 11320 had exited.
PID reuse is tested at the identity-matching helper, not forced during
native shutdown. All 12 verification-script tests and typecheck pass.

Committed as `85e57a46` (`test(verification): prove queued delivery survives
native restart`). This is provisional journey acceptance while B11 remains
an open release prerequisite.

## B14: diff reads contend for the real Git index

Native Revert verification first exposed two setup assumptions in the harness:
it expected a collapsed file diff and the default comparison mode. Both are
now read from the actual UI state. Those failed runs did not demonstrate a
product defect.

Subsequent v3 and v4 runs completed the native Revert but failed the final
bridge diff read with `GIT_NON_ZERO_EXIT` because `.git/index.lock` already
existed. In v3, the harness ran its direct `git write-tree` alongside the
bridge request. In v4, those operations were sequential, but the renderer's
own post-action diff refresh could still overlap the bridge read.

Code inspection found that `review_revision_at_path` runs `git write-tree`
against the real index before and after every diff load. The existing
`tree_snapshot::index_tree` helper also uses the real index despite its
read-only contract. The correction copies the staged index to a
unique temporary index and computes its tree there. The two revision checks
and the checkout mutation lock remain in place.

The extra bridge assertion is retained. Deterministic held-index-lock tests,
concurrent diff reads, preserved index bytes, linked worktree and split-index
coverage pass. B11 did not recur in the earlier v3 and v4 failed runs.

Independent review caught a split-index generation race in the first fix:
the main index was copied before resolving the live shared-index path, so an
external Git operation could replace the shared companion between those
steps. A direct Git experiment confirmed that resolving the companion through
the copied index selects the matching generation. If that companion expires
during capture, the entire capture must be retried within a fixed bound.
The final correction implements that sequence with at most three capture
attempts. An unstable capture fails loudly. Stable malformed and unmerged
indexes still fail. A deterministic regression expires the old companion
between capture steps and proves a fresh capture succeeds. Independent
review found no material defects.

The fix is committed as `aeae98bc` (`fix(git): isolate index snapshots from
concurrent readers`). Final Rust checks pass: 1,217 unit tests and 163
integration tests, with three and five intentional ignores respectively.
Clippy with warnings denied and formatting also pass. Logs:
`/private/tmp/argmax-b14-cargo-tests.log` and
`/private/tmp/argmax-b14-clippy.log`. These checks ran in the shared checkout,
which also included the separately committed nonblocking Codex question fix.

The frozen native candidate is `/private/tmp/argmax-phase2-final-20260913`,
based on `cb529290` with the final Rust fix and verification scripts overlaid.
Its first final Revert attempt stopped before the initial UI because the
screen was locked. The foreground diagnostic identified PID 418, later
resolved to macOS `loginwindow`, and the console probe returned
`CGSSessionScreenIsLocked: true`. That run supplies no journey acceptance
evidence and does not establish a product startup failure. It does not resolve
the separately open B11 issue.

After the user unlocked the Mac, the v2 native run passed. Revert restored
`edited.txt` to HEAD, preserved the cached diff byte for byte and the index
tree exactly, saved `Before reverting edited.txt`, and removed the edited
file from the native Review and backend diff. The bridge stale-revision
subcase returned `REVIEW_STALE_REVISION` and preserved the newer edited bytes,
cached diff and index tree. The Stage label and 8 px action spacing also pass.
The final screenshot caught the preserved file while its diff was loading,
so a final harness check now waits for that staged content to render.

The locked-host report is
`/private/tmp/argmax-phase2-final-revert-native-20260913/report.json`.
The passing v2 report is
`/private/tmp/argmax-phase2-final-revert-v2-native-20260913/report.json`.
Both used source fingerprint
`7eecab3da0b306ac5649a819f8e5db1d826cc8e3a44f1d867afc0c912cb0e1ba`.
The v2 run retained that fingerprint before build, after build and after run.

The final v3 Revert run also passes, including the added wait for the
preserved staged content to render. Its screenshot was inspected and shows
the staged change with the Unstage action, with the reverted file absent.
The final helper addition received independent review with no findings.
Report: `/private/tmp/argmax-phase2-final-revert-v3-native-20260913/report.json`.
Its unchanged source fingerprint is
`61c2165bb94820955813108340a1b081e886aacee8b02a8ae3b580716ff9e84f`.
Cleanup matched the stored app PID and start time. This accepts guarded
Revert provisionally while B11 remains open.

Evidence directories retain each failed report and screenshot:
`/private/tmp/argmax-phase2-staged-revert-native-20260913`, plus the
`staged-revert-v2-native`, `staged-revert-v3-native` and
`staged-revert-v4-native` variants with the same date suffix.

## Session move

The fixture calls the production `argmax session move --path` CLI while the
source turn is held at an explicit barrier. The scenario verifies one
scheduled move request, the original source session, a new destination
session in the sibling checkout, copied history and correct move markers.
The original provider conversation is retained at source and forked at the
destination. The native window follows the move without a destination click.
Both Git worktrees and their fixture README bytes are preserved.

The first native run found a harness setup mistake: it waited for the source
session row inside a collapsed project. The corrected setup expands the chat
group with a native click, then opens the exact source row. The second run
completed the move but failed its final invocation check because it searched
argv for prompt text delivered over stdin. The corrected assertion counts
all chat invocations in the isolated log, requires exactly two with one per
canonical checkout, checks the source session identity, and verifies the
destination resume/fork arguments. Advisor review confirmed this correction
preserves the intended contract.

The v3 and v4 runs pass all 44 assertions. The v4 helper also scopes selected
workspace queries to session rows, avoiding ambiguity with the active project
header. Independent review found no remaining material defects. The final
screenshot check additionally waits for the destination's idle composer,
after automatic following has already been verified. The move marker is
asserted in the DOM. Despite the harness's scroll request, the final screenshot
shows the destination response and idle composer, with the marker above the
viewport. It does not provide screenshot evidence of the marker itself.

The final v5 run passes all 45 assertions. Both native screenshots were
inspected. The source is visibly running at the held barrier, and the
destination shows its response and idle composer. Report:
`/private/tmp/argmax-phase2-final-move-v5-native-20260913/report.json`.
Its source fingerprint is unchanged before build, after build and after run:
`0797cb7116f0bf5f778987567400a70881a1462f06844158afa5730af6268525`.
The proof records canonical paths, session identities, provider arguments,
history and move markers. This is fixture-provider acceptance, not live
provider compatibility. The final 13 verification-script tests pass.

The final native Revert and move helpers share the same Rust correction.
They are committed as `4a97aafd` (`test(verification): prove guarded revert
and session move`).
Their fingerprints differ because only the session-move harness was corrected
after the Revert run. Cleanup matched the app's stored PID/start identity.
A separate process check confirmed the final Revert app PID 81818, move app
PIDs 84586 and 86111, and descendant PID 86380 had exited.

The retained failed reports are under
`/private/tmp/argmax-phase2-final-move-native-20260913` and
`/private/tmp/argmax-phase2-final-move-v2-native-20260913`.
These were harness failures, not demonstrated session-move product defects.

## Combined local changes

The user explicitly authorized committing all local changes during Phase 2.
The combined repository precheck passed, with 3,000 renderer tests, nine
performance tests, 1,209 Rust unit tests and 163 Rust integration tests.
Three Rust unit and five integration tests remain intentionally ignored.
Lint has ten existing warnings and no errors. Typecheck, bridge parity,
main-thread checks, iOS typography, Clippy and both bundle budgets pass.
Log: `/private/tmp/argmax-combined-precheck-20260913.log`.

The drag test initially failed because jsdom did not construct the pointer
coordinates and ID. Its correction exercises pointerdown, pointermove and
pointerup, then asserts the chat pane opens. The focused before/after logs
are `/private/tmp/argmax-shared-drag-before.log` and
`/private/tmp/argmax-shared-drag-after.log`. Independent review found no
material defects in the workspace drag and agent roster changes.

Those changes are committed as `4fdc1e6c` (`fix(ui): stabilize workspace
dragging and agent navigation`). Activity presentation is committed as
`cb529290` (`fix(activity): align semantic tool colors across desktop and
iOS`). All seven iOS icon tests pass in
`/private/tmp/argmax-combined-ios-icons-20260913.xcresult`.

The requested Stage label and 8 px header gap are committed as `d148a90f`
(`fix(review): space hunk actions and shorten Stage label`). The real diff
component was visually checked in dark and light themes, including a 320 px
viewport with no header overflow. Native v3 and v4 screenshots also show the
short label and separate actions. Browser evidence is under
`/private/tmp/argmax-hunk-spacing-preview`.

The combined precheck predates the B14 Rust fix and final session-move
integration. Those changes require their own checks before acceptance.

## Remaining work

- Verify the confirmation fix and dirty archive through native UI and exact
  tracked, untracked and ignored file preservation.
- Keep B11 open for release repeatability. A startup failure that prevents
  reaching the test's initial state supplies no journey acceptance evidence.
