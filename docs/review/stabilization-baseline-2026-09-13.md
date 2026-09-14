# Stabilization baseline: 2026-09-13

## Result

Argmax's first stabilization baseline is **not green**. The renderer unit and
performance suites pass. The Rust unit suite has one reproducible, date-sensitive
test failure outside the sandbox. The production renderer builds but exceeds
the desktop eager JavaScript budget. Six of eight browser-backed fixture
journeys pass. Two Claude fixture journeys fail after producing output and
need diagnosis. iOS passes 355 unit tests and eight of nine UI tests, with one
activity-row accessibility assertion failing. These results do not yet establish
a user-facing product defect.

This is a working-tree assessment, not release acceptance. Other work changed
the checkout during the run. The fixture journeys used a separate frozen
source copy. No product fixes are part of this baseline.

## Scope and source identity

- [Machine-readable evidence summary](stabilization-baseline-2026-09-13.json)
  retains check counts, log hashes and scenario assertions/fingerprints.
- Repository: `argmax`, package version `0.5.0`.
- Initial HEAD: `63a36d460175ce017299e8b508cee7b34201a529`.
- HEAD observed after renderer checks: `cb188f320a65ed858b9f7e1f0776d20f52339418`.
- Initial checkout already contained 20 modified tracked files. Product changes
  from other work were preserved.
- Initial tracked patch SHA-256:
  `6b6fdbea2dfd1f55488d980eb5fa69ec8f74f0c15952f43cfba6ff33a9f6095f`.
- Patch after renderer checks SHA-256:
  `ef37486e4595789c9310e2dcb86571c82cae97a86d54c0f7c8b4a146bf1fc967`.
- Parent check logs, patches, status snapshots and screenshots:
  `/private/tmp/argmax-baseline-20260913/`. These are local evidence, not permanent
  repository artifacts. The facts and acceptance register are retained here.
- Host/toolchain reported macOS arm64, Node `26.7.0`, npm `11.19.0`, Git `2.50.1`,
  Cargo `1.95.0` and rustc `1.95.0`. Initial free disk was about 520 MB. Space
  later became available during other work. No caches or user files were
  deleted by this task.
- Luna mapped the feature inventory and quantified the bundle failure. Terra
  mapped coverage and diagnosed the failing scanner test. Sol assessed and ran
  isolated native verification. The parent ran checks, browser inspection and
  integrated this register.

Shared-checkout results must not be combined into a claim that one immutable
release candidate passed. Re-run the required gates against a frozen candidate
after fixes land.

## Executed checks

| Check | Observed result | Evidence file in parent log directory |
|---|---|---|
| `npm run precheck -- --all` | Failed at Rust unit tests. Later lanes were run separately. | `precheck.log` |
| IPC channel parity | Passed, 138 request and 9 push channels. | `precheck.log` |
| Main-thread handler allowlist | Passed, 97 off-thread handlers and 40 allowlisted. | `precheck.log` |
| ESLint | Passed with 10 warnings, zero errors. | `precheck.log` |
| TypeScript | Passed. | `precheck.log` |
| Vitest unit suite | 252 files and 2,981 tests passed. | `precheck.log` |
| Vitest performance suite | All 9 tests passed. | `precheck.log` |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Passed. | `precheck.log` |
| Sandboxed Cargo unit tests | 1,201 passed, 6 failed, 3 ignored. Superseded for environment diagnosis by the unsandboxed run. | `precheck.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml`, outside sandbox | 1,206 passed, 1 failed, 3 ignored. Cargo stopped before integration/doc tests. | `cargo-test-unsandboxed.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --test integration`, outside sandbox | 163 passed, 5 ignored. | `cargo-integration.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --doc`, outside sandbox | Command passed, zero documentation tests exist. | `cargo-doc.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --bins`, outside sandbox | All binary test targets completed, zero tests. | `cargo-bins.log` |
| Clippy, all targets, warnings denied | Passed. | `clippy.log` |
| `node scripts/check-ios-fonts.mjs` | Passed. This is a source check, not an iOS build or runtime test. | `ios-fonts.log` |
| `npm run build:renderer` | Passed. | `renderer-build.log` |
| `node scripts/check-bundle.mjs` | Failed, desktop eager JavaScript exceeds budget. | `bundle.log` |
| `node scripts/check-chat-scroll.mjs`, outside sandbox | 52 assertions passed, zero failures and no window error events. | `chat-scroll-unsandboxed.log` |
| Chromium demo walkthrough | Launcher, settings navigation, Light/Dark switching and narrow desktop layout inspected. No browser errors reported. | `desktop-dark.png`, `desktop-light.png`, `settings-light.png`, `narrow-light.png`, `browser-errors.txt` |

The browser walkthrough used the demo renderer at `127.0.0.1:5199` in a separate
browser session. Screenshots were opened and visually inspected. It did not
send a provider prompt. The 390 by 844 capture is the narrow desktop renderer,
not the remote web entry or native iPhone app. Desktop screenshots were 1280 by
633. No claim of complete accessibility, mobile keyboard, native dialog, live
transcript or end-to-end session verification follows from these screenshots.

The first scroll run failed to launch Chrome inside the sandbox. The successful
outside-sandbox run distinguishes that limitation from a scrolling failure.
The process/PTY and file-limit Rust tests likewise passed outside the sandbox.

## Isolated scenario baseline

Sol created a frozen source copy at
`/private/tmp/argmax-baseline-20260913-native/source-snapshot` from HEAD
`63a36d460175ce017299e8b508cee7b34201a529`, with tracked patch SHA-256
`09f0463fc9a2425f727a1f55963b649ac36403d91711b9de158c0c4a3ada3a4c`.
This snapshot differs from the parent's initial working-tree capture and is
identified separately. Dependencies were reused from the existing installation.

Outside-sandbox `npm run doctor` exited 0. Chrome and native driver tooling were
available, while Screen Recording and Accessibility permissions were missing.
Doctor readiness did not establish that native interaction would work.

`npm run verify -- --scenario chat-resume` built and started the isolated app,
then failed before scenario assertions because the app process did not become
visible. Native desktop UX is therefore unverified. Missing OS permissions are
an observed capability limit, not a proven root cause of this foreground failure.

All eight scenarios were then attempted with `--native off` against the same
frozen source. Each used the real backend, a fixture through the production
provider adapter, and the remote browser UI. No paid provider was called.

| Scenario | Result | What the result establishes |
|---|---|---|
| `chat-resume` | Failed | First Claude fixture turn ended in `failed`, preventing follow-up acceptance. |
| `persistent-subagent` | Failed | First Claude child fixture turn ended in `failed`, preventing restart/continuation acceptance. |
| `persistent-codex-subagent` | Passed | Stable child identity, continuation, persisted lifecycle and queryability after backend restart. |
| `codex-user-input` | Passed | Structured question answer reaches the original request and session/event state persists. |
| `persistent-opencode-subagent` | Passed | Stable child identity, continuation, persisted lifecycle and queryability after backend restart. |
| `persistent-cursor-subagent` | Passed | Stable child identity, continuation, persisted lifecycle and queryability after backend restart. |
| `cancellation` | Passed | Cancelled session and expected timeline event persist. |
| `provider-error` | Passed | Expected failed session and error output persist. The intentionally failed provider is a passing scenario. |

Command form: `npm run verify -- --scenario <name> --native off --out <new-dir>`.
Native evidence is in
`/private/tmp/argmax-baseline-20260913-native/chat-resume-native/report.json`.
Browser reports are under the same parent in `<scenario>-browser/report.json`.
They record assertions, source fingerprints, build identity, coverage and
cleanup evidence. All six passing reports include `checkout-stable` assertions.
The two failed Claude runs produced normalized/persisted activity before the
provider process exited with code 1. That is an integration failure to
investigate, not sufficient evidence of live Claude CLI incompatibility.

Narrow diagnostic checks passed below the full runner: direct Claude fixtures
emitted success for both failing payloads, and
`fixture_runs_through_real_provider_launcher_and_resume` passed with the
`verification` Cargo feature. The retained failures reach the control
transport's EOF-before-result path. A runner/barrier interaction is a hypothesis,
not an established cause. B10 remains open until the full scenarios pass.

The parent also opened the captured Codex question and persistent-child light
theme screenshots. The question choices/action and two separate child responses
were visible. This is a limited browser UI inspection, not native desktop
acceptance.

All recorded verification ports and fixture processes were checked after the
runs and had stopped. The parent's browser session and Vite server were also
closed. Source snapshots, reports and build evidence remain in the named local
temporary directories for investigation.

## Native iOS baseline

The final test run used the same frozen source copy, Xcode 26.6 (17F113), and
the available iPhone 17 Pro simulator running iOS 26.5. Existing declared
packages resolved to SwaTex 0.5.0 and MermaidKit 2.2.0 using the local package
cache. No dependency versions or shared product sources were changed.

Initial sandbox probes could not reach CoreSimulator. Outside-sandbox probes
found the runtime and device, so this is not an unavailable-simulator finding.
Earlier copied-project attempts lacked generated resources, including
`Sources/Info.plist`. Those setup failures were superseded by the final
`DerivedData-frozen2` run after supplying generated build inputs in the copy.

```bash
xcodebuild \
  -project /private/tmp/argmax-baseline-20260913-native/source-snapshot/ios/Argmax/Argmax.xcodeproj \
  -scheme Argmax \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /private/tmp/argmax-baseline-20260913-ios/DerivedData-frozen2 \
  -clonedSourcePackagesDirPath /Users/adamthuvesen/Library/Caches/org.swift.swiftpm \
  -skipPackageUpdates test
```

- Unit tests: **355 passed, zero failed**.
- UI tests: **8 passed, 1 failed**. Both performance UI tests passed.
- Failed test:
  `TranscriptUITests.testActivityUsesSemanticColoursAndKeepsIntegrationArtwork`.
  At `ios/Argmax/UITests/TranscriptUITests.swift:148`, its expected collapsed
  activity-summary button label was not found. The assertion does not establish
  whether the cause is a stale test locator, accessibility regression or absent
  visual content.
- Log: `/private/tmp/argmax-baseline-20260913-ios/xcodebuild-test-frozen2.log`.
- Result bundle:
  `/private/tmp/argmax-baseline-20260913-ios/DerivedData-frozen2/Logs/Test/Test-Argmax-2026.09.13_11-50-12-+0200.xcresult`.

Simulator tests do not establish physical-device pairing, host reconnect,
notifications or packaged-device performance. B05 retains those boundaries.

## Ranked quality register

Priority orders the next work. It does not assign product severity to missing
evidence. A gate failure, a verification gap and a demonstrated product defect
are different types of entry.

| ID | Priority and type | Evidence and impact | Next action and exit condition |
|---|---|---|---|
| B01 | First, test defect | `usage::scanner::tests::codex_tail_keeps_model_and_duplicate_state_from_its_prefix` expects two rows but gets zero in both Cargo runs. Fixture records dated June 15 are outside the scanner's rolling 90-day retention at this run's clock. No incorrect user ledger behavior is established. | Make the scanner test's clock/fixture relationship deterministic while retaining its tail/deduplication assertions. The focused test and Rust suite must pass without changing production retention. |
| B02 | First, build gate failure | Desktop loads 1,848,662 eager JS bytes across 8 chunks against a 1.76 MiB budget, about 3,168 bytes or 0.172% over. No measured user latency regression. | Inspect the emitted module graph and recent weight changes. Restore budget compliance and check both desktop and mobile entries without an unexplained threshold increase. |
| B10 | First, scenario failures | Frozen-source `chat-resume` and `persistent-subagent` produce Claude activity then fail with provider exit 1. Six other browser-backed scenarios pass. | Locate the fixture/adapter exit cause, fix the demonstrated failure and rerun the two affected scenarios. Do not infer live provider support from fixtures. |
| B11 | High, native verification blocker | Scratch app builds and starts, but the native driver cannot make its window visible. | Establish a host/session where the isolated window can be foregrounded and rerun native `chat-resume`. Browser-backed results do not close this entry. |
| B12 | First, iOS UI acceptance failure | The frozen simulator suite cannot find the exact activity-summary button expected by `TranscriptUITests.swift:148`. Eight other UI tests and all 355 unit tests pass. | Compare retained UI/accessibility evidence with the expected summary. Fix the demonstrated test or product issue, then rerun the affected test. Root cause and user impact remain unproven. |
| B03 | High, verification gap | Recovery and mutation logic have substantial Rust coverage, but the existing scenario list does not exercise archive, move and revert through the native desktop UI and filesystem together. | Add or execute scratch journeys that interrupt these operations and verify files, branch/index state, persisted operation state and visible recovery. |
| B04 | High, verification gap | Fixture success cannot establish current installed-provider compatibility. Live provider tests are ignored by default. | Run a bounded launch/tool/follow-up/stop matrix for each supported provider/version before release. Record credentials/unavailable-provider blocks explicitly. |
| B05 | High, verification gap | Remote protocol and iOS recovery tests exist, but no full physical-device pairing, lost-reply/reconnect and notification result is established by the parent browser pass. | Complete native iOS tests and a device-to-scratch-host walkthrough. Verify an interrupted mutation does not execute twice and uncertain delivery stays visible. |
| B06 | Medium, verification gap | Short tests and demo inspection cannot establish behavior after hours of concurrent sessions, sleep/wake, large histories or repeated navigation. | Run an agreed prolonged-use scenario with process/memory/latency measurements and compare against existing budgets. |
| B07 | Medium, verification gap | Scheduler/evaluator logic and usage parsers have tests. Real scheduler timing, live goal evaluation and independent usage-ledger reconciliation have not been run here. | Exercise controlled scratch schedules and goals. Run the existing usage oracle against the same source histories before claiming totals are independently verified. |
| B08 | Low, lint debt | ESLint emits 10 warnings. No affected user behavior was reproduced. | Inspect warnings in context and fix only demonstrated dependency/correctness issues or intentional rule violations. Do not classify every warning as a user bug. |
| B09 | Release prerequisite, evidence integrity | Shared HEAD and tracked patch changed while baseline checks ran. | Use one frozen source fingerprint for the next release-candidate gate. Keep this report as an initial working-tree baseline. |

B01 source evidence: [scanner retention and test](../../src-tauri/src/usage/scanner.rs),
[dated fixture](../../src-tauri/tests/fixtures/usage/codex-duplicate-token-count.jsonl),
and [parser tests](../../src-tauri/src/usage/codex.rs). The parser test still
accepts the fixture. Scanner pruning explains the empty ledger assertion.

B02 source evidence: [bundle gate](../../scripts/check-bundle.mjs). Its rounded
error prints both actual and budget as `1.76 MiB`, obscuring the small overage.
The largest eager chunk was `styles-NAPwLnwB.js`, 1,345,462 bytes. The name alone
does not identify the responsible dependency. Inspection of the same build
found mobile at 1,686,900 bytes, about 1,307 bytes below its 1.61 MiB budget.
The gate exits on desktop failure, so this mobile figure is an artifact
measurement, not a completed gate result.

Lint warnings are in `App.tsx` (six), `AgentActivity.tsx`, `ToolCallDetail.tsx`,
`activity/ActivityPanel.tsx` and `usage/UsagePanel.tsx`. Nine concern Hook
dependencies and one concerns Fast Refresh exports.

## Journey acceptance register

These are acceptance contracts for stabilization, not assertions that all
behaviors currently pass. Existing coverage means tests were found. A journey
is accepted only with successful evidence at the appropriate boundary.

| ID | Journey and source | Success and UX contract | Failure and recovery contract | Baseline proof boundary |
|---|---|---|---|---|
| J01 | Projects and defaults, [workspaces](../workspaces.md) | Register a project and select the intended checkout, branch, setup/check commands and defaults. Controls name their scope. | Invalid paths and save/setup errors are visible. Retry preserves user input and existing repository files. | Renderer/Rust tests, native registration walkthrough outstanding. |
| J02 | New chat, [providers](../providers.md) | Launch with the selected provider/model/mode and project. Prompt, attachments and task label match the request. | Launch failure retains recoverable input and explains what to correct. Retry does not launch twice. | Launcher demo inspected, live/native launch evidence recorded separately. |
| J03 | Streaming and follow-up, [chat](../chat-cards.md) | Show normalized content, tools and honest session state. Thinking yields to visible content. Follow-up retains the right conversation. | Provider exit or malformed output becomes an intelligible error. Resume never silently targets another session. | Unit/integration coverage and existing fixture scenarios. Live CLI compatibility separate. |
| J04 | Queue, steer and stop, [runtime](../runtime.md) | Pending rows retain text, attachments and settings. Stop and steering affect the intended turn. | Restart restores paused/uncertain messages. No silent resend after ambiguous acceptance. User can recover explicitly. | Backend/renderer coverage. Native interruption matrix outstanding. |
| J05 | Sidebar, attention and archive, [workspaces](../workspaces.md) | Open, pin, rename and archive the intended chat. Priority and unread indicators agree with session state. | Dirty/busy conflicts are explained. Archive preserves recoverable files and interrupted operations reconcile. | Strong backend coverage. Native dirty-archive walkthrough outstanding. |
| J06 | Grid, multitasks and agent traces, [multitask](../multitask.md) | Pane selection and per-pane launcher project are predictable. Multitask progress and results remain discoverable. | Launch caps/errors are clear. Parent and sibling work survive independent failure or restart. | Renderer tests and persistent-child fixture scenarios, real-layout multitask walkthrough outstanding. |
| J07 | Plans, questions and approvals, [approvals](../approvals-checks.md) | Context and requested answer are clear. Responding continues the correct provider request once. | Stale/unsupported gates fail visibly. Cancellation or disconnect cannot create false approval success. | Unit/integration coverage and Codex question fixture. Provider-specific live gates outstanding. |
| J08 | Files, diffs and annotations, [workspaces](../workspaces.md) | Correct comparison/revision, readable files and diff context. Notes retain file/line/scope. | Stale or truncated output is marked and refreshable. Failed reads do not masquerade as empty files. | Renderer/backend tests. Native large-diff and annotation walkthrough outstanding. |
| J09 | Stage, commit, revert and move, [workspaces](../workspaces.md) | Operate on the intended checkout/index. Preview makes affected paths and scope clear. | Concurrent work, changed HEAD and dirty state are guarded. Revert/move interruption preserves recovery data. | Strong Rust coverage, native operation plus filesystem proof outstanding. |
| J10 | Terminal and IDE, [terminal](../terminal.md) | Shell opens in the intended checkout. Input, resize, output and IDE handoff work. | Exits/failures are visible. Closing owned jobs does not kill unrelated detached work. | Unsandboxed PTY/process unit checks pass, interactive native walkthrough outstanding. |
| J11 | Browser and agent browser tools, [browser](../browser.md) | Navigation, tabs and ownership are clear. Agent actions affect their intended page. | Stale refs/timeouts return explicit failures. Ownership and page state recover through refresh/reopen. | Tests exist. Chromium demo is not the embedded native browser, native walkthrough outstanding. |
| J12 | Scheduled tasks, [schedules](../scheduled-tasks.md) | Run once at the intended time/target. Enable, edit and Run now have predictable effects. | Busy targets and launch failures remain visible. Restart/missed ticks avoid duplicate launches. | Scheduler/renderer tests. Real ticking scheduler journey outstanding. |
| J13 | Provider session import, [sync](../session-sync.md) | Eligible external sessions import with correct identity/history and can continue. | I/O failure does not advance the cursor or lose source content. Retry remains idempotent. | Rust sync coverage, native settings plus import/resume journey outstanding. |
| J14 | Goals, [goals](../goals.md) | Goal condition, progress and terminal reason remain clear while turns continue appropriately. | Evaluator failures and overtaken turns cannot falsely complete work or duplicate continuations. | Logic/renderer coverage, live evaluator and interruption journey outstanding. |
| J15 | Learnings, sources, skills and connections, [skills](../skills.md) | User can discover/use the correct project/provider material. Keyboard interaction and scope are clear. | Failed reads/login/refresh have explicit recovery. Unknown health stays unknown. | Component/backend coverage, combined native walkthrough outstanding. |
| J16 | Usage and activity, [usage](../usage.md), [activity](../activity.md) | Totals, filters, attribution and empty states are accurate and understandable. | Partial scans/stale caches show honest status and retry safely. | Parser/UI tests, one scanner test blocked by fixture age. Independent oracle not run. |
| J17 | GitHub PR and CI feedback, [GitHub](../gh.md) | Correct PR/check attribution and bounded automatic follow-up. Status explains attention. | Authentication, busy/dirty work and restart defer safely without duplicate fix sessions or unsafe archive. | Backend/renderer coverage. Scratch repository plus real GitHub journey outstanding. |
| J18 | iPhone and remote web, [remote](../remote.md) | Pair, read, reply and review with usable touch/keyboard layout and consistent read state. | Lost replies, reconnect and offline cache preserve mutation identity and display uncertainty. | Protocol/recovery tests exist. Native results recorded separately, physical-device proof outstanding. |
| J19 | Appearance, diagnostics and release, [styling](../styling.md), [release](../release.md) | Preferences persist and remain readable. Diagnostics are reachable. Packaged startup/update preserves the profile. | Save/update/permission failures offer an actionable next step and preserve recoverable state. | Demo theme/navigation and font check pass. Packaged upgrade, permissions and native accessibility outstanding. |

## Evidence still required for release acceptance

1. Resolve B01, B02, B10 and B12, then run the full gate against one frozen candidate.
2. Run applicable fixture journeys and retain their source fingerprints,
   assertions, screenshots and cleanup outcomes.
3. Exercise native archive/move/revert, terminal/browser, restart and pending
   delivery flows in disposable projects and profiles.
4. Record live-provider versions and smoke outcomes, native iOS results and
   physical-device remote recovery. Unavailable platforms remain unverified.
5. Complete prolonged-use and packaged-upgrade checks, plus independent usage
   reconciliation before treating usage figures as externally verified.

No test-count or code-coverage percentage substitutes for those acceptance
results. Existing verification instructions remain in [verification.md](../verification.md)
and [testing.md](../testing.md).
