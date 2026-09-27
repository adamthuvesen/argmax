# Queued follow-up across restart

A follow-up queued while a turn is running survives a backend restart as a
paused message, is not replayed on its own, and is delivered exactly once when
the user sends it.

Source: scripts/verify.mjs, scripts/verification/desktop.mjs, scripts/verification/provider-fixture.mjs, src/renderer/components/SessionComposer.tsx
Inventory-id: scenario:queued-restart

## Sub-features

- `queued-restart` queues a native-composer follow-up during a held turn, restarts the backend, and sends the recovered message.

## How to get to it (user POV)

Send a follow-up while the agent is still answering so it queues. Quit and reopen
Argmax. The queued message shows as paused or delivery-uncertain until you send it.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. No source edits during the run.

- **Queue, restart, send.** Run `node .agents/skills/verify-argmax/verify.mjs drive queued-restart`.
  The queued message persists before restart, recovers as `Paused` or
  `Delivery uncertain`, is not sent automatically, and completes once after Send.
- **Proof.** The run's `drive-queued-restart-*` directory has native PNGs for the
  running, recovered, and complete states, `queued-before-restart.json`,
  `queued-after-restart.json`, `database.json`, `report.json`, and `verdict.json`.

## Gotchas

The restart replaces the backend only. The native window and WebDriver session stay.
Streamed fragments from the held first turn must match before and after restart.
