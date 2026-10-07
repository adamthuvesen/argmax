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

Settings, schedules, arcs, browser (beyond `browser-focus` and `browser-frames`), terminal, mobile,
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
| Renderer look | [ui.md](ui.md) | scripts/ui-screenshot.mjs | 2026-10-04 captured at 6ad82aa, cold read |
| Follow-up turn | [chat-resume.md](chat-resume.md) | scenario:chat-resume | 2026-10-04 pass at cb42e859 |
| Queued follow-up across restart | [queued-restart.md](queued-restart.md) | scenario:queued-restart | 2026-10-04 pass at cb42e859 |
| Move chat to another checkout | [session-move.md](session-move.md) | scenario:session-move | 2026-10-04 pass at cb42e859 |
| Chat reference chip and background send | [composer-reference.md](composer-reference.md) | scenario:composer-reference | 2026-10-04 pass at cb42e859 |
| CodeMirror composer behavior | [composer-editor.md](composer-editor.md) | scenario:composer-editor | 2026-10-04 pass at cb42e859 |
| Hidden browser tab keeps off the keyboard | [browser-focus.md](browser-focus.md) | scenario:browser-focus | 2026-10-04 pass at 90d0c4a1 |
| Agent browser tools reach into iframes | [browser-frames.md](browser-frames.md) | scenario:browser-frames | 2026-10-05 pass at 7603999 |
| Fork at a finished turn and merge back | [fork-merge.md](fork-merge.md) | scenario:fork-merge | 2026-10-04 pass at cb42e859 |
| Branch names, linked repositories, snooze shelf | [workspace-settings.md](workspace-settings.md) | scenario:workspace-settings | 2026-10-04 pass at cb42e859 |
| Stop chat | [cancellation.md](cancellation.md) | scenario:cancellation | 2026-10-04 pass at cb42e859 |
| Provider failure | [provider-error.md](provider-error.md) | scenario:provider-error | 2026-10-04 pass at cb42e859 |
| Durable interactive visualizations | [visualizations.md](visualizations.md) | scenario:visualizations | 2026-10-07 pass at a1538eb with visualization changes |

Native evidence: `.verify/runs/2026-10-04T09-16-13-773Z-073201eb-cb42e85/manifest.txt` (local artifact).
All nine scenarios passed without retries. The negative control returned `fail-observed`, and the command tripwire was empty.
These runs use scripted providers and synthetic key events. Screen Recording and Accessibility were missing, so OS capture and physical shortcut delivery remain unverified.

Visualization evidence: `.verify/runs/2026-10-07T16-07-16-713Z-ba896fcb-a1538eb-dirty/drive-visualizations-1791389297835/verdict.json` (local artifact).
The visualization drive passed. Its negative control returned `fail-observed`, cleanup passed, and the command tripwire was empty.
