# Argmax verification features

## Baseline preconditions

Use macOS with the repository's installed Node dependencies, Rust toolchain,
SQLite CLI, and a Chromium browser. See [verification](../../../../docs/verification.md).
`launch` builds the checkout and records its fingerprint. Each drive uses a
new scripted-provider project and profile beneath `.verify/state/tmp/`.
No provider account is needed. Doctor must pass before each drive.

## Driving conventions

Run the helper from the repository root. Each scenario creates and tears down
its own app. Production IPC seeds the initial session, then native controls
and the conversation are exercised. SQLite provides the second read of results.
Finish edits before launching. Shared-checkout edits invalidate the fingerprint.

## Inventory

`node .agents/skills/verify-argmax/verify.mjs inventory` derives `scenario:<name>`
IDs from `scenarioDefinitionKeys` in `scripts/verify.mjs`. This is the existing
executable scenario surface. It is not a complete inventory of the desktop UI.

Unmapped:

- `scenario:codex-user-input`: Codex question-dock protocol, beyond the initial map.
- `scenario:persistent-subagent`, `scenario:persistent-codex-subagent`,
  `scenario:persistent-opencode-subagent`, `scenario:persistent-cursor-subagent`:
  require the remote-browser path and separate live-provider support proof.
- `scenario:staged-revert`: native Review and index recovery, beyond the initial map.

The New chat launcher, settings, schedules, arcs, browser, terminal, mobile,
and account integrations have no native entry point here. `ui` can show how
their renderer looks against demo data, not that they work. Their unit tests or
other scenarios do not make them verified by this skill.

## Proof, skip, and flake reporting

Report each feature with its manifest and artifact path. Missing host permission,
tooling, or a locked screen is `unreachable` with the attempted command and prerequisite. A failed
assertion is FAIL. One retry after doctor and reset can produce `flaky`, never pass.
Fixture evidence proves Argmax's adapter and UI behavior, not provider availability.

## Control

`control` runs the provider-error scenario again and expects terminal state
`complete`. The actual `failed` state must reject the assertion. The normal
scenario and persistence checks must still pass.

## Features

| Feature | File | Inventory ids | Last verified |
|---|---|---|---|
| Renderer look | [ui.md](ui.md) | scripts/ui-screenshot.mjs | 2026-09-26 captured at 5fd5ecc, cold read |
| Follow-up turn | [chat-resume.md](chat-resume.md) | scenario:chat-resume | 2026-09-26 pass at 5fd5ecc |
| Queued follow-up across restart | [queued-restart.md](queued-restart.md) | scenario:queued-restart | 2026-09-26 pass at 5fd5ecc |
| Move chat to another checkout | [session-move.md](session-move.md) | scenario:session-move | 2026-09-26 pass at 5fd5ecc, cold read |
| Stop chat | [cancellation.md](cancellation.md) | scenario:cancellation | 2026-09-26 pass at 5fd5ecc |
| Provider failure | [provider-error.md](provider-error.md) | scenario:provider-error | 2026-09-26 pass at 5fd5ecc |
