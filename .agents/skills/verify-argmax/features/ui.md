# Renderer look

The renderer draws correctly against the demo snapshot in dark and light themes,
at any viewport, after optional clicks.

Source: scripts/ui-screenshot.mjs, src/renderer/lib/loadDashboardSnapshot.ts
Inventory-id: scripts/ui-screenshot.mjs

## Sub-features

- `ui` captures the demo renderer in both themes, optionally after `--eval` navigation.

## How to get to it (user POV)

Any screen reachable by clicking in the demo data: sidebar, chats, settings, composer.

## Driving it

No `launch` needed. Run `node .agents/skills/verify-argmax/verify.mjs ui`, adding
`-- --eval '<js>'` to click into the state under test and `--mobile` or `--width`
for layout. Open both PNGs and compare them with the intended change.

- **Proof.** `.verify/runs/<...>-ui/` holds `ui-dark.png`, `ui-light.png`,
  `ui.log`, and a manifest block with the replay command.

## Gotchas

Demo data is static, so live states (streaming, errors from Rust) need a native drive.
A capture that exits 0 can still be blank or show the wrong state. Look at it.
