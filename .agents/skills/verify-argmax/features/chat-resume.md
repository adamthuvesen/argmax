# Follow-up turn

A chat streams its first response and tool activity, then continues the same
provider conversation when the user submits a follow-up.

Source: scripts/verify.mjs, scripts/verification/desktop.mjs, scripts/verification/provider-fixture.mjs, src/renderer/components/SessionComposer.tsx
Inventory-id: scenario:chat-resume

## Sub-features

- `chat-resume` shows streamed output and submits a native-composer follow-up that resumes the persisted conversation.

## How to get to it (user POV)

Open an existing chat, wait for its first answer, enter a follow-up in Chat prompt,
and send it. Initial chat creation is seeded through production IPC by this recipe.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. No source edits during the run.

- **Follow up.** Run `node .agents/skills/verify-argmax/verify.mjs drive chat-resume`.
  The first response and Read activity appear, the follow-up completes, and the
  conversation keeps its provider conversation ID. The helper exits 0.
- **Proof.** The run's `drive-chat-resume-*` directory contains native PNGs and UI
  state for streaming, tool activity, and completion, `timeline.ndjson`,
  `database.json`, `report.json`, and `verdict.json`. Its manifest block names this entry.

## Gotchas

The provider fixture gates streaming so intermediate states are observable.
An initial launcher failure is outside this recipe's native coverage.
The SQLite snapshot is taken after teardown, so a visible response alone cannot pass.
