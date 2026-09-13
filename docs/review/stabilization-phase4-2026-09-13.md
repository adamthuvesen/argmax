# Stabilization Phase 4: release confidence

Phase 4 executed every release-confidence check that this host and the
available credentials could support. The candidate is not accepted for
release. Live provider compatibility, a short runtime soak, simulator recovery,
native chat journeys and an unsigned package smoke pass. Foreground activation,
the real updater path, physical-device recovery, prolonged use and several
native interaction boundaries remain open.

The runtime candidate is `fb716634`. `0459f7b4` adds types and assertions to the
verification harness without changing application runtime code. The packaged
application was built from `fb716634`. The final full source gate ran from
`0459f7b4`.

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

B11 remains open. The mixed results show foreground contention in the
verification environment, but they do not explain every earlier startup or
foreground failure. A passing rerun is not closure.

### iPhone and remote recovery

Sixty-eight focused BridgeRecovery, TranscriptStore, ChannelEncoding, Review,
ReviewFileTabs and Push tests passed. Eight transcript UI tests also passed in
the simulator. A physical iPhone was visible to Xcode, but this phase did not
install or mutate it. Pairing, APNs, radio loss, backgrounding and restart
recovery therefore remain open.

### Runtime soak

A scratch OpenCode runtime ran for 6 minutes 31 seconds. It collected 31 memory
samples while executing 1,550 dashboard reads with no failed calls. RSS was
297,248 KiB initially, peaked at 348,912 KiB during startup, then ranged from
115,984 to 158,304 KiB after sample 9 and ended at 118,256 KiB. No monotonic
growth was observed. Evidence:
`/private/tmp/argmax-phase4-soak-a08b.ndjson`.

This is a bounded smoke test, not the hours-long prolonged-use, sleep/wake and
concurrent-agent acceptance required for release confidence.

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

### Updater

Updater acceptance could not run. `plugins.updater.pubkey` is empty and
`bundle.createUpdaterArtifacts` is not enabled. The current build therefore
creates only the app and DMG, without a signed update archive, signature or
usable `latest.json`. `docs/release.md` now describes the actual configuration
and the required release inputs. A fake key or unsigned local feed would not
exercise the production trust path.

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

Release acceptance is withheld until these prerequisites are complete:

1. Resolve B11 with repeatable native foreground and startup behavior, including
   attribution of the older unexplained failures.
2. Complete the explicitly deferred native dirty-archive Cancel and OK checks.
3. Exercise physical-device pairing, APNs, network loss, backgrounding and
   restart recovery.
4. Supply the real updater public key and private signing credential, enable
   updater artifacts, publish a signed `latest.json`, sign and notarize the app,
   then perform an actual upgrade from the installed predecessor.
5. Run an hours-long prolonged-use check covering sleep/wake and concurrent
   provider work.
6. Complete the remaining native and external boundaries recorded in the
   [Phase 3 journey register](stabilization-phase3-2026-09-13.md), especially
   large diff and annotation interaction, Stage and Commit, terminal, embedded
   browser, clock-driven scheduling, import, goals, connections and GitHub.

This assessment is deliberately narrower than “bug-free” or “release-ready.”
It records demonstrated behavior and preserves every untested boundary.
