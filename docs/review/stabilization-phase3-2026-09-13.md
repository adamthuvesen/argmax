# Stabilization Phase 3: everyday workflows

Phase 3 is complete as a systematic workflow and UX pass. The executed scopes
found one product defect: the `argmax usage` CLI opened the wrong database.
That fix is committed and verified against the live ledger. No other product
defect was reproduced in the 19 journey contracts.

This result does not accept every journey at a native or external-service
boundary. The table keeps those limits visible. Phase 2's dirty archive dialog
remains deferred by the user.

## Journey register

| ID | Result | Evidence and remaining boundary |
|---|---|---|
| J01 Projects and defaults | Automated pass | Project, settings, launcher draft, focus and navigation tests pass. Dark, light and narrow launcher/settings renders were inspected. A native registration walkthrough remains open. |
| J02 New chat | Provisional | Launcher selection, draft recovery, shortcuts and fixture launch pass. Current live-provider evidence is recorded in Phase 4. |
| J03 Streaming and follow-up | Passed, provisional | Chat rendering, scroll and provider-error tests pass. Frozen native chat-resume streams a tool, sends a follow-up through the composer and preserves the conversation. B11 still limits native acceptance. |
| J04 Queue, steer and stop | Passed, provisional | Phase 1 native cancellation and Phase 2 native queued-restart pass. Live Claude and Codex steering tests pass. |
| J05 Sidebar, attention and archive | Provisional | Sidebar, priority, rename, attention and archive conflict tests pass. Native dirty archive Cancel and OK remain deferred by the user. |
| J06 Grid, multitasks and agent traces | Automated pass | Grid, multitask, Agents view and persistent-child fixture coverage pass. A native real-layout multitask walkthrough remains open. |
| J07 Plans, questions and approvals | Passed, provisional | Plan, approval and question-card tests pass. Native Codex blocking-question acceptance passes on the final frozen candidate. Provider-specific live approval gates remain open. |
| J08 Files, diffs and annotations | Automated pass | Review, file, diff, stale revision and annotation tests pass. Native large-diff and annotation interaction remain open. |
| J09 Stage, commit, revert and move | Passed, provisional | Phase 2 native Revert preserves the staged index and checkpoint. Native session move preserves both checkouts and the provider conversation. Native Stage and Commit remain open. |
| J10 Terminal and IDE | Automated pass | Terminal, resize, output, exit and process ownership tests pass. Interactive native terminal and IDE handoff remain open. |
| J11 Browser and agent browser tools | Automated pass | Browser state, ownership, stale-reference and recovery tests pass. Browser-page renders were inspected. Embedded WKWebView interaction remains open. |
| J12 Scheduled tasks | Automated pass | Scheduler, editor, Run now, restart and duplicate-launch guards pass. A real clock-driven tick remains open. |
| J13 Provider session import | Automated pass | Import, cursor, retry and idempotence tests pass. Native settings plus import-and-resume remain open. |
| J14 Goals | Automated pass | Evaluator, continuation, overtaken-turn and failure tests pass. A live evaluator interruption journey remains open. |
| J15 Learnings, sources, skills and connections | Automated pass | Scope, keyboard, failed-read and provider-health tests pass. A combined native walkthrough remains open. |
| J16 Usage and activity | Passed, provisional | The CLI path defect is fixed. Parser, scanner and UI tests pass. Live ledger totals were reconciled to Argmax's fork-copy and duplicate policy. External readers use incompatible policies, so cross-tool equality remains open. |
| J17 GitHub PR and CI feedback | Automated pass | Attribution, retry, deduplication and bounded follow-up tests pass. A real GitHub journey remains open. |
| J18 iPhone and remote web | Simulator pass | 68 focused recovery, transcript and review tests plus 8 transcript UI tests pass. Physical-device pairing, radio loss, APNs and restart recovery remain open. |
| J19 Appearance, diagnostics and release | Provisional | Dark, light, narrow, settings, schedule, activity and search renders were inspected. Packaging and release limits are recorded in Phase 4. |

## Executed checks

- Three focused renderer groups passed 707 tests across 45 files: 276 for
  J01 to J07, 264 for J08 to J11, and 167 for J12 to J19.
- `node scripts/check-chat-scroll.mjs` passed all 52 checks.
- Full Rust coverage passed 1,217 unit tests and 163 integration tests before
  the usage CLI fix. The new CLI path test and CLI build passed separately.
  The final frozen-candidate gate is recorded in Phase 4.
- Browser renders were inspected in dark, light and 620 px layouts, plus
  settings, schedule, activity and search states. Evidence is under
  `/private/tmp/argmax-phase3-*.png`.
- `scripts/doctor.mjs` reported READY. Native tooling was available. Screen
  Recording and Accessibility were optional missing host permissions.

## Usage database defect

The runtime stores its database at `<app-data>/local-state/argmax.sqlite`.
The `argmax usage` CLI opened `<app-data>/argmax.sqlite`, which was a different
empty file on the live profile. `a08b36f5` routes the CLI through the runtime
layout and adds a focused path test. `cargo build --bin argmax` passes, and
`argmax usage --days 1 --json` reads the live 4.1 GB ledger.

The seven-day comparison then exposed counting-policy differences. Argmax
suppresses copied fork history and consecutive duplicate usage events.
`ccusage` counts both on observed Codex days. CodexBar counts copied fork
history, usually drops consecutive duplicates, and produced one lower total
that none of those rules explained. The live `usage_contributions` sums match
Argmax exactly. No scanner or parser change is warranted from this comparison.
`fb716634` keeps the oracle exit strict while correcting the claim that a
mismatch alone establishes which reader is wrong.

## Phase boundary

Phase 3 closes the systematic everyday-workflow pass. Native surfaces and
external systems that were not exercised here remain release prerequisites or
explicit evidence gaps in the [Phase 4 report](stabilization-phase4-2026-09-13.md).
