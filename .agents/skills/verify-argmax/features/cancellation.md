# Stop chat

Stopping a running chat retains its partial answer and leaves the session cancelled.

Source: scripts/verify.mjs, scripts/verification/desktop.mjs, scripts/verification/provider-fixture.mjs, src/renderer/components/SessionComposer.tsx
Inventory-id: scenario:cancellation

## Sub-features

- `cancellation` clicks the native Stop chat button during a retained session and checks its persisted cancelled state.

## How to get to it (user POV)

Open a streaming chat and click Stop chat after it has run for at least ten seconds.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. Each drive starts a fresh session.

- **Stop.** Run `node .agents/skills/verify-argmax/verify.mjs drive cancellation`.
  The partial answer appears, Stop becomes available, and the native click ends
  the session as `cancelled`. The partial answer remains visible. The helper exits 0.
- **Proof.** `drive-cancellation-*` contains native screenshots before and after
  Stop, the action diagnostic, `timeline.ndjson`, `database.json`, `report.json`,
  and `verdict.json`. The manifest records the entry and result.

## Gotchas

Stopping in the first ten seconds restores the draft and archives the workspace.
That separate behavior is not covered here. The driver waits past that window
and confirms the session is still running immediately before the click.
