# Stabilization Phase 4: release confidence

Phase 4 completed the practical release-confidence scope chosen by the user.
No known blocker remains in that scope. Live provider compatibility, a short
runtime soak, simulator recovery, physical iPhone network recovery, native chat
and archive journeys, and an unsigned package smoke pass. Automatic self-update
and exhaustive release infrastructure are outside the chosen scope.

The runtime candidate is `fb716634`. `0459f7b4` adds types and assertions to the
verification harness without changing application runtime code. The packaged
application was built from `fb716634`. The final full source gate ran from
`0459f7b4`.

## Final blocker review

The user narrowed the release bar after the original Phase 4 pass. Automatic
updates, APNs, hours-long soak testing, sleep and wake testing, and exhaustive
native and external journey coverage are deferred coverage. They are not
release blockers for this local manual app and DMG release.

The remaining practical blockers were closed as follows:

- B11 was a verification launch collision. The runner launched a raw macOS
  executable without a bundle identifier, while the installed `com.argmax.rs`
  app was running. The candidate reached `ready-to-show` and owned an on-screen
  window, but macOS kept the installed app frontmost. Two controlled launches
  of the same binary under `com.argmax.verification` became active and visible.
  `4665a3c4` applies that identity to native verification runs. The normal
  `chat-resume` journey then passed with no visibility recovery. Report:
  `/private/tmp/argmax-b11-chat-resume-bundled-e5ffec98/report.json`.
- Dirty archive Cancel and OK were exercised through the native AppKit dialog
  in a disposable isolated worktree. Cancel preserved the original path, exact
  dirty bytes, Git status, workspace and sidebar row. OK removed the original
  path, marked the workspace archived, and retained the exact 9-byte file at
  the same relative path in a registered recovery checkout. Direct proof:
  `/private/tmp/argmax-dirty-archive-e5ffec98-v4/manual-proof.json`.
- A physical iPhone kept cached navigation and the latest chat readable during
  Airplane Mode, then resumed live messages after connectivity returned. The
  first run exposed a stale `Can't reach your Mac.` banner until the chat was
  reopened. `d44be954` resets a failed active transcript before its
  authoritative reconnect read. Twenty-two focused recovery and transcript
  tests passed. The user installed the updated build and repeated the same
  in-place recovery. The banner cleared without navigation and messages were
  neither duplicated nor lost.

## Executed checks

### Full source gate

`npm run precheck -- --all` passed on the frozen `0459f7b4` source. It covered
138 request channels and 9 push channels, 97 off-main-thread handlers and 40
allowlisted handlers, ESLint, TypeScript, 3,007 renderer tests, 9 performance
tests, Rust formatting, 1,218 Rust unit tests with 3 ignored, 163 integration
tests with 5 ignored, Clippy with warnings denied, iOS typography, the renderer
build and both bundle budgets. The 10 ESLint findings are existing warnings,
not errors. Log: `/private/tmp/argmax-phase4-0459f7b4-precheck.log`.

### Live providers

All five installed provider CLIs responded through Argmax's production
adapters:

| Provider | Installed version | Evidence |
|---|---:|---|
| Claude | 2.1.269 | Live steering test passed in 17.22 seconds |
| Codex | 0.154.0 | Live steering test passed in 13.78 seconds |
| Cursor | 2026.09.10-fd3934a | Live edit integration passed in 27.75 seconds |
| OpenCode | 1.18.30 | Scratch runtime returned the exact sentinel, completed in 7.6 seconds and recorded usage |
| Grok | 1.0.30 | Scratch ACP runtime preserved the thinking tag and returned the exact final sentinel in 5.3 seconds |

These checks prove current local CLI protocol compatibility. They do not prove
every provider permission, approval or account-state branch.

### Native desktop

The frozen `a08b36f5` candidate passed the native chat-resume journey on its
first unlocked attempt. It streamed a tool, accepted a composer follow-up,
resumed the same conversation, preserved SQLite state and kept the checkout
stable. Report:
`/private/tmp/argmax-phase4-a08b-chat-resume/report.json`.

The next blocking-question attempt reached an on-screen, fully launched app,
but Slack remained frontmost for longer than the five-second acceptance limit.
The console was unlocked and the AppKit activation request returned true.
Report: `/private/tmp/argmax-phase4-a08b-codex-user-input/report.json`.

`0c6e6b10` records the console lock state, activation result, candidate window
state and frontmost process whenever that limit expires. It does not retry and
does not turn an on-screen window into a pass. After that diagnostic change,
the native Codex blocking-question journey passed all 23 assertions on
`fb716634`. The question stayed in the same turn, the answer continued the
conversation and the composer returned to idle. Report:
`/private/tmp/argmax-phase4-fb716634-codex-user-input/report.json`.

B11 is closed for the observed failures. The new process evidence and the
same-binary bundle experiment explain the unlocked foreground timeout without
attributing the separate locked-console occurrence to the same cause.

### iPhone and remote recovery

Sixty-eight focused BridgeRecovery, TranscriptStore, ChannelEncoding, Review,
ReviewFileTabs and Push tests passed. Eight transcript UI tests also passed in
the simulator. The user installed the latest iOS build on a physical iPhone.
Airplane Mode launch and in-place recovery passed on that device. The stale
offline banner found during the first run was fixed, tested, installed and
confirmed on the repeated device run. APNs, backgrounding and host restart are
deferred coverage.

### Runtime soak

A scratch OpenCode runtime ran for 6 minutes 31 seconds. It collected 31 memory
samples while executing 1,550 dashboard reads with no failed calls. RSS was
297,248 KiB initially, peaked at 348,912 KiB during startup, then ranged from
115,984 to 158,304 KiB after sample 9 and ended at 118,256 KiB. No monotonic
growth was observed. Evidence:
`/private/tmp/argmax-phase4-soak-a08b.ndjson`.

This is the bounded soak selected for this release. Hours-long prolonged use,
sleep and wake, and concurrent-agent soak coverage are deferred.

### Package

The `fb716634` application and DMG built successfully. The app is 46 MB and the
DMG is 21 MB. The packaged executable SHA-256 is
`81a4de4b25b3d10c4ee198e97b28661aeff59021e3b4c21e21d00c9f8c1e8d0f`. The
DMG SHA-256 is
`4eb4ecb0176b10e2453cecad111bb23ff939eeeac75f0e97c26004964015e304`.
Strict code-signature verification and DMG verification passed.

The signature is ad hoc, has no TeamIdentifier and is not notarized, so
Gatekeeper rejection is expected. A disposable packaged app launched against
a scratch profile, created its database and reached `ready-to-show` in 551 ms.
The host lacks Screen Recording permission, so that smoke has state evidence
but no screenshot. The installed `/Applications/Argmax.app` was not quit,
replaced or upgraded.

### Distribution scope

The user chose manual app and DMG releases. Automatic self-update is deferred
and is not required for release acceptance. The existing updater configuration
has no public key and does not create updater artifacts, so it must not be
treated as an active release channel. No updater key, signed update archive or
`latest.json` feed is needed for the chosen scope. macOS signing and notarization
remain optional distribution hardening if the app is later shared beyond this
machine.

### Build cleanup

After the final gate, `cargo clean` removed 7,767 files and 5.9 GiB from the
shared Rust dev and release target. The renderer `dist`, any repo `release`
directory, temporary Argmax verification `dist` directories, two deeper
temporary Rust targets of 14 GiB and 1.1 GiB, temporary Xcode products, indexes
and module, SDK and package caches, Argmax-only Xcode DerivedData and the
disposable frozen checkout were also removed. The cleanup left 92 GB free. It
preserved source, local profiles, native reports, screenshots and logs.
Long-lived `argmax mcp` processes were not terminated, and the installed
application was not touched.

## Release assessment

The practical release blockers are closed for the user's local manual release
scope. The deferred checks above remain useful future coverage, but none is a
prerequisite for this release. This does not claim the application is bug-free.
A distributed artifact should still be built from the intended committed
source.
