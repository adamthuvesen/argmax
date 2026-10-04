# Chat reference chip and background send

A New chat draft holds a chip that names another chat, the draft survives a trip
to another chat, and the background-send chord starts the chat without leaving
the launcher.

Source: scripts/verify.mjs, scripts/verification/workflows.mjs, scripts/verification/provider-fixture.mjs, src/renderer/components/LaunchSurface.tsx, src/renderer/components/ComposerEditor.tsx, src/renderer/lib/backgroundSend.ts
Inventory-id: scenario:composer-reference

## Sub-features

- `composer-reference` attaches a chat from the `@` menu, restores the draft, sends it with Alt+Enter, and opens the source from the chip in the new chat.

## How to get to it (user POV)

Press New chat, type `@` and a chat title, pick the chat so it becomes a chip,
and press ⌥↵. The chat starts in the sidebar, the launcher empties, and a toast
offers Open. The sent chat shows the same chip; clicking it opens the source.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. No source edits during the run.

- **Reference and background send.** Run `node .agents/skills/verify-argmax/verify.mjs drive composer-reference`.
  The fixture seeds one finished chat titled `Reference source alpha` through
  production IPC. Everything after that uses native keys and clicks.
- **Proof.** The drive's `native/composer-reference.json` lists the assertions:
  the Claude usage chip within five seconds (`63% left in the 5-hour window`, popover lists
  5-hour and Weekly, Escape closes it), one resolved chip, a draft that stores the plain `argmax://chat/<id>` link, the
  chip restored after opening another chat and coming back, a launcher that stays
  open and empty after Alt+Enter, a "in the background" toast, one new chat in
  the same project whose first user message holds the link once, an untouched
  source chat, and the transcript chip that opens the source. The PNGs
  `reference-chip-in-composer`, `reference-chip-restored`,
  `reference-background-launched`, and `reference-chip-opened-source` sit next to it.
  `database.json` is the SQLite snapshot of the background chat.

## Gotchas

The fixture reaches the launcher's default model by pinning `argmax.launch.model`
to the Claude fixture model and reloading the window. This WebDriver sends every key
as an untrusted KeyboardEvent and drops modifiers from named keys, so the chord is a
keydown for Enter with `altKey` set, delivered to the focused editor
(`pressChord`). The launcher's own handler must act on it, and the drive fails at
"alt-enter-chord-is-handled" or "Alt+Enter did not start a new chat" if it does not.
Text goes in through element send keys, not `browser.keys`, which cannot edit a
contenteditable. The driver never clicks the editor: a click can land on a chip.
It does not prove that an agent in the new chat can read the referenced chat
(the fixture agent calls no tools); the Rust tests cover that grant.
