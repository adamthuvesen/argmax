# Provider failure

When a provider fails, the conversation shows its diagnostic and the session
persists as failed.

Source: scripts/verify.mjs, scripts/verification/provider-fixture.mjs, scripts/verification/desktop.mjs, src/renderer/components/SessionConversation.tsx
Inventory-id: scenario:provider-error

## Sub-features

- `provider-error` surfaces the fixture's failure in the native conversation and persists its failed state.

## How to get to it (user POV)

Open a chat whose provider has failed and read its diagnostic in the conversation.
The fixture produces the failure after the harness launches through production IPC.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. No provider account is needed.

- **Read failure.** Run `node .agents/skills/verify-argmax/verify.mjs drive provider-error`.
  The native conversation shows `Verification provider failed as requested.`
  and the session ends `failed`. The helper exits 0.
- **Reject a wrong result.** Run `node .agents/skills/verify-argmax/verify.mjs control`.
  A fresh run must reject expected state `complete` with `fail-observed`.
- **Proof.** `drive-provider-error-*` or `control-provider-error-*` contains the
  native screenshot and UI diagnostics, `timeline.ndjson`, `database.json`,
  `report.json`, and `verdict.json`. The manifest includes the assertion process exit.

## Gotchas

The expected provider failure is a passing feature check. A missing diagnostic,
app crash, or teardown failure is a failed drive and cannot satisfy the control.
An action-error toast is a different behavior from this provider diagnostic.
