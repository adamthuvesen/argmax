# CodeMirror composer behavior

The prompt field is the real CodeMirror editor in the native window, and typing, an
`@` chat chip, undo, chip delete, copy, cut and Enter-after-pick behave as a
person expects.

Source: scripts/verify.mjs, scripts/verification/workflows.mjs, scripts/verification/desktop.mjs, src/renderer/components/ComposerEditorView.tsx, src/renderer/components/composerEditor/extensions.ts
Inventory-id: scenario:composer-editor

## Sub-features

- `composer-editor` waits for the lazy CodeMirror chunk (the field starts as a textarea), then drives the session composer and the New chat launcher.

## How to get to it (user POV)

Type in any chat's prompt or the New chat prompt. Type `@` and a chat title to
attach a chip, press ⌘Z, Backspace, ⌘C, ⌘X, or Enter.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. No source edits during the run.

- **Run.** `node .agents/skills/verify-argmax/verify.mjs drive composer-editor`.
- **Proof.** `native/composer-editor.json` lists the assertions, with PNGs
  `editor-session-codemirror`, `editor-launcher-empty`, `editor-launcher-chip`,
  `editor-launcher-after-clipboard`, `editor-submitted-chat`:
  - the field is `.cm-editor` with no textarea fallback, editable, role textbox
  - ⌘Z in the session composer changes typed text
  - undo after an `@` pick leaves no `argmax://` or `](` fragment
  - each Backspace either keeps the whole chip or removes it whole
  - copy puts the same text in `text/plain` and a typed `application/x-argmax-composer+json`
    payload that names the referenced chat; cut empties the field and ⌘Z restores it
  - an empty selection cuts nothing and puts no line on the clipboard
  - Enter to pick from the `@` menu, then Enter at once, sends the full text with the
    chip's link and no leftover `@Reference` (SQLite `user.message`)

## Gotchas

These assertions describe the correct behavior. They fail on a build that still has the
review findings for undo after a menu pick, line-wise copy and cut with no selection, or
a stale Enter. Copy and cut try the keyboard first and fall back to
`document.execCommand`; the assertion value names which fired. If neither fires, the
drive fails. A real IME candidate window, VoiceOver, and dropping a file onto the editor
are not driven.
