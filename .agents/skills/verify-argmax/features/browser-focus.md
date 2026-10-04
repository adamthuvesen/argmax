# Hidden browser tab keeps off the keyboard

A page in a hidden agent browser tab that focuses one of its own fields leaves the
New chat composer with the keyboard, so a person typing while agents browse does
not have to click back into the prompt.

Source: scripts/verify.mjs, scripts/verification/workflows.mjs, src-tauri/src/browser/focus_guard.rs, src-tauri/src/ipc/browser.rs
Inventory-id: scenario:browser-focus

## Sub-features

- `browser-focus` opens a hidden tab for the seeded chat through `browser:open-for-session`, the path an agent's `browser_open` takes, then has its page call `focus()` on an input while the launcher composer holds the keyboard.

## How to get to it (user POV)

Have an agent drive a page in Argmax's browser while you type in the New chat
prompt. Pages focus their own fields after clicks and route changes.

## Driving it with verify.mjs

Preconditions: `launch` completed and `doctor` exits 0. No source edits during the run.

- **Run.** `node .agents/skills/verify-argmax/verify.mjs drive browser-focus`.
- **Proof.** `native/browser-focus.json` lists the assertions, with PNG
  `focus-launcher-after-probe`:
  - before the probe, the app document has focus and the composer holds the active element
  - positive control: the hidden page's `document.activeElement` is its probe input
  - 750 ms later, the app document still has focus, the composer still holds the
    active element, and the window saw no `blur`
  - the composer text is unchanged

## Gotchas

The page's own `document.hasFocus()` reads false even when WebKit has made its hidden
WKWebView the window's first responder, so the assertion reads the app document, not
the page. While any tab is open, WebDriver cannot reach the main window (Tauri's
`webview_windows()` drops a window that holds a child webview), so the renderer runs the
open, focus, measure, close sequence itself and the drive reads the result afterwards.
Without the guard the drive fails with `documentHasFocus: false` and one `blur`. WebDriver keys here are untrusted DOM events, so the drive proves which view
owns the keyboard, not that physical keystrokes arrive.
