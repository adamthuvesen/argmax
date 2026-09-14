# Stabilization Phase 1: 2026-09-13

Phase 1 functional acceptance passes. The full precheck, repaired iOS activity
test and required native journeys pass. B11, intermittent native startup
visibility, remains unresolved and blocks release acceptance. Phase 2 can
proceed with recovery investigation on the monitored scratch host.

The [initial baseline](stabilization-baseline-2026-09-13.md) remains the record
of the starting state. Its journey register defines the remaining acceptance
work. Passing Phase 1 does not establish release readiness.

## Changes

| Baseline entry | Cause and change | Evidence |
|---|---|---|
| B01, scanner fixture | Fixed June timestamps aged out of the rolling retention window. The scanner test now dates its input to the run day and preserves the deduplication and tail assertions. | Focused test and full Rust suite pass. Production retention is unchanged. |
| B02, eager bundle | The syntax highlighter loaded Shiki core and its regex engine through both code and diff rendering. Both modules now load when highlighting is requested, using the existing shared initialization promise and plain-text fallback. | Desktop and mobile bundle gates pass without increasing either budget. |
| B10, Claude scenarios | The fixture consumed user input without replaying it. The production adapter requests replay and waits for that acknowledgement before accepting the result. The fixture now emits the consumed user message. | The fixture subprocess test asserts the replayed prompt. Chat-resume passes with native UI verification. Persistent-subagent passes with browser UI verification. |
| B12, iOS activity | The scenario includes a skill call missing from the expected summary. The test also queried the long summary as an identifier. Its expected text now includes the skill and it selects the accessibility label. | The previously failing activity UI test passes. Its subsequent semantic colour, integration artwork and theme assertions remain. |
| Native cancellation harness | The scenario stopped within the intentional early-stop window, which restores the draft and archives the session. It now waits past that window and verifies the session is running before clicking Stop. | Native cancellation passes, retaining the cancelled row. A test checks the harness threshold against the renderer contract. |
| Fingerprint fixture cleanup | The disposable Git repository inherited a globally enabled filesystem monitor. Git tracing confirmed it launched a detached daemon. The fixture disables that setting locally to avoid writes racing cleanup. | The full verification test file passes all 11 tests. The subsequent trace contains no daemon launch. |

## Frozen candidate

- Directory: `/private/tmp/argmax-phase1-final-20260913`
- HEAD: `50a5c471d9ff3ccc29e865487793e5530e0f5235`
- Captured tracked diff SHA-256: `ab0070dbc184a31adfecbf41eebcca2868f079cdf9992dee0939e862cb53ca10`
- Checkout fingerprint before and after precheck: `0ace09cbfc09a69b2c41a619a4cf04d39a87a2248b96d373a2b5d344d13f8145`

The snapshot includes the shared working tree at freeze time, including
pre-existing changes owned by other work. Those changes are excluded from
the stabilization commits. Installed dependencies and build caches are reused.

`npm run precheck -- --all` exited 0. Its log is
`/private/tmp/argmax-phase1-final-20260913-precheck.log`.

| Check | Result |
|---|---|
| Renderer | 252 files, 2,981 tests passed |
| Performance | 9 tests passed |
| Rust unit | 1,209 passed, 3 ignored |
| Rust integration | 163 passed, 5 ignored |
| Rust doctests | None defined |
| ESLint | Passed with the 10 existing warnings |
| TypeScript, Cargo format and Clippy | Passed |
| IPC parity, main-thread and iOS typography gates | Passed |
| Renderer build and both bundle budgets | Passed. Desktop 1,705,308 bytes, mobile 1,543,532 bytes |

The iOS activity check ran separately in `/private/tmp/argmax-phase1-b12`
with DerivedData at `/private/tmp/argmax-phase1-b12-dd`. The baseline contains
the broader iOS run of 355 passing unit tests and eight other passing UI tests.
The focused rerun closes the failed assertion, rather than claiming a second
complete simulator run.

## Native gate

| Journey | Candidate | Result |
|---|---|---|
| Chat resume | Original frozen candidate | Passed with native streaming, tool and completed-turn inspection |
| Persistent Claude subagent | Original frozen candidate | Passed with browser inspection and backend restart |
| Cancellation | v2 | Passed. Stop clicked after 10,023 ms, session still running before the click, cancelled row retained |
| Codex user input | v2 | Passed. Native question and answered states inspected, answer delivered through the bridge |
| Provider error | v2 | Passed. Native error card and idle composer inspected |

Candidate v2 is `/private/tmp/argmax-phase1-final-v2-20260913`. It has the
same HEAD as the original candidate and checkout fingerprint
`1b6c4b789c3fe3a200ed3fca9858d8b183ac8dd45108c5f846b10e61b55bb61a`.
Only the desktop driver, scenario runner and verification test file differ.
Its three native runs retained the same source fingerprint before and after
each run. Screenshots were inspected and owned app/driver processes stopped.

The final shared source also guards a failed diagnostic probe so it cannot
replace the original WebDriver error, and isolates the fingerprint test from
global fsmonitor settings. These two changes received focused checks and
independent review. They were not included in the v2 native runs. The full
precheck result belongs to the original frozen candidate.

The [evidence manifest](stabilization-phase1-2026-09-13.json) records every
run, source identity and report hash, including the failed first attempts.

B11 recurred before the frozen provider-error scenario could launch. The
backend started, but the native driver could not make the document visible.
The frozen chat-resume run passed. These mixed results establish an
intermittent native visibility failure.
An AppKit diagnostic launch was already visible, active and frontmost with
one on-screen window. It did not reproduce the failure. The harness now
retains activation and window state if foregrounding fails, preserving the
driver error even when the diagnostic probe fails too. Missing host
permissions are not established as the cause. Passing reruns do not close B11.

## Local commits

- `55188f28`: `perf(renderer): load syntax highlighter on demand`
- `fd9f7bbb`: `test(usage): keep scanner tail fixture within retention`
- `9c669b8c`: `test(ios): match the complete activity summary label`
- `3036b1d6`: `docs(quality): record the stabilization baseline and journey gaps`
- `38dca684`: `fix(verification): honor provider replay and native stop contracts`

No push was performed. Pre-existing user changes remain separate.

## Remaining phases and delegation

Phases advance sequentially after their acceptance checks. Independent work
inside a phase can run concurrently with disjoint ownership.

| Phase | Work and acceptance | Delegation |
|---|---|---|
| 2, preserve work and delivery | Scratch native journeys for queued-message restart, dirty archive, supported session move and guarded revert. Assert persisted state, visible recovery and exact file/index preservation. | Terra maps contracts and owns bounded scenario work. Sol owns restart/mutation orchestration and independent review. Luna executes settled checks and inventories evidence. |
| 3, everyday workflows and UX | Exercise the remaining baseline journeys, including empty/error/loading states, keyboard interaction and theme/layout consistency. Fix reproduced defects in small batches with affected checks. | Luna handles mechanical work, Terra handles bounded workflows, Sol handles cross-component defects and review. |
| 4, release acceptance | Live-provider compatibility, device recovery, prolonged use and packaged upgrade. Record versions, measurements and unavailable environments explicitly. | Luna runs settled matrices, Terra analyses evidence, Sol investigates failures. Astra resolves consequential ambiguity. |

Model escalation follows demonstrated complexity. Each handoff names files,
expected behaviour and evidence, and returns a compact result. The parent owns
integration and phase acceptance. B11 stays on the release watch list and
returns to active investigation if native verification becomes unreliable.
