# Terminal

Integrated terminal instances run independently from provider PTYs under [src-tauri/src/terminal/service.rs](../src-tauri/src/terminal/service.rs).

## IPC Channels

- `terminal:spawn`
- `terminal:write`
- `terminal:resize`
- `terminal:terminate`
- `terminal:data` (push)
- `terminal:exit` (push)
- `terminal:agent-open` (push)

The backend uses `portable-pty` for process execution and event chunk emission. Subscriptions require `core:event:default` in `src-tauri/capabilities/default.json`.

Input is a stream, so `terminal:write` has to preserve order. Each PTY owns a
writer thread draining a queue, and the command only enqueues — which is why it
is the one synchronous handler that touches a PTY: Tauri resolves a synchronous
command inline, in the order the webview sent its messages, while an `async` one
spawns a task per call. When it was `async`, two keystrokes in flight raced and a
`\r` that won made the shell run a fragment: `open .` typed quickly executed as
`en`. A write that fails against a live PTY is reported to the next caller, since
by then the failing write is on the terminal's own thread. The remote bridge
dispatches each request on its own task, so a bridge client that wants ordered
input has to await one write before sending the next.

The backend prepares the PTY reader and writer before starting the shell, so a
setup failure cannot leave an untracked child. Closing a live terminal signals
every process group still in the shell's PTY session, then escalates from
`SIGTERM` to `SIGKILL` after one shared grace period. Natural shell exit cleans
up ordinary background jobs from that session too. Processes that deliberately
create a new session keep their independent lifecycle.

The shell is a login shell (`$SHELL -l`), as macOS terminals start one, so
`.zprofile` runs. Its PTY has `IUTF8` on, so line-mode prompts (`read`, a
`[Y/n]`) erase a whole `å` rather than half of it. It starts with
`LANG=en_US.UTF-8` when nothing names a locale: from Finder Argmax has none,
and in the C locale zsh counts each byte of `❯` or `å` as a column, so every
redraw after it lands in the wrong cells — Backspace looks dead while the text
is in fact gone. Input may carry NUL, which Ctrl+Space and Ctrl+@ send.

It also starts with `OP_BIOMETRIC_UNLOCK_ENABLED=true` unless Argmax's own
environment sets it. Both defaults are set before the rc files run, so an
export there wins.
Without it `op` fails here where Ghostty works: `op` first reads 1Password's
settings file in the app's group container, macOS app-data protection denies
that read to processes Argmax spawns, and `op` reports "No accounts configured"
instead of the error. Provider CLIs get the same default through
[environment.rs](../src-tauri/src/providers/environment.rs).

The `terminal_spawn` agent tool uses the same service and can type a command
into the new shell. The PTY belongs to Argmax, so it survives the provider turn
that created it. `terminal:agent-open` adds it to the workspace's terminal tabs
and opens that panel, where the renderer adopts the existing PTY instead of
starting another shell. The event is emitted before Argmax types the command;
the renderer buffers output until xterm mounts, so a short-lived command still
appears in the tab. `terminal_read` lists the
terminals known for a workspace or returns one terminal's captured output,
running state, and exit code. The service keeps the newest 128 KiB of output
per terminal in memory. It trims finished records oldest first toward a
64-record cap. Live records are never evicted.

## Where It Lives

The terminal is a mode of the review panel — the fifth, beside Changes, Files, Agents, and [Browser](browser.md) — so shells sit in the same dock as the diff and the files they act on. The tab is shown wherever a workspace backs the panel: session panes use that session's workspace; the launcher's project-backed panel uses the project's shared checkout workspace (created on demand if none exists yet). The mobile remote has no terminal at all.

`Cmd/Ctrl+J` shows the terminal for the active workspace. If Terminal is already visible in a split panel, the shortcut closes that half and expands the other view. If Terminal fills the panel, it hides the panel. The workspace card's Terminal row does the same. Switching views leaves the PTYs running.

## Renderer Lifecycle

Terminal state persists across session switches:

- **State stores:** Tab metadata, the active tab, and whether the terminal was on screen live in [src/renderer/lib/terminalTabs.ts](../src/renderer/lib/terminalTabs.ts), keyed by workspace.
- **xterm runtime:** [src/renderer/lib/terminalRuntime.ts](../src/renderer/lib/terminalRuntime.ts) manages lazy xterm instances and PTY event listeners. Each instance attaches to a host `<div>` that reparents when panes mount or unmount.
- **Resource limits:** Scrollback is capped at 5,000 lines. At most 6 workspaces (`MAX_TERMINAL_WORKSPACES`) retain running terminals; exceeding this evicts the least recently used unmounted workspace.
- **Contrast:** The xterm theme sets `minimumContrastRatio: 4.5` ([terminalRuntime.ts](../src/renderer/lib/terminalRuntime.ts)) to ensure prompt readability. ANSI 8 (bright black) stays a mid gray in both themes: shells draw text not yet typed in it (zsh-autosuggestions defaults to `fg=8`), and when it sat near the light foreground a suggestion read as typed text, so Backspace looked dead while the deleted character came back as the suggestion.
- **Text size:** `--text-terminal` follows `--text-xs`, matching the app's compact monospace surfaces at the app font scale (13px at the default level 6). Open terminals resize when the app font size changes.
- **Caret:** A 2px bar in the user's `--accent`, not xterm's default block — a block fills the whole cell, and at `lineHeight: 1.2` that is a slab taller than the glyphs beside it, covering the character it sits on. Unfocused falls back to xterm's hollow outline. The caret is the one terminal color that isn't shell output, so [xtermTheme.ts](../src/renderer/lib/xtermTheme.ts) reads `--accent` live and the appearance observer watches `data-accent` alongside `data-theme`. A shell that sets its own shape (DECSCUSR, vi-mode, a TUI) still wins.

The review panel restores its saved layout per session. For sessions without a saved preference, [useReviewState.ts](../src/renderer/hooks/useReviewState.ts) falls back to the workspace's `showing` flag. It writes back whether Terminal is visible in either half, so shortcuts also work while another view has focus. The panel mounts one terminal host per workspace.

## How ⌘J Reaches The Panel

The keypress is handled in `App`, which has no handle on the pane's review state — and the pane it means may only be mounting in the same tick (⌘J from Settings opens the chat first). So `App` resolves the toggle against the workspace's remembered state and files a `TerminalVisibilityRequest` naming the workspace and the state it wants. The matching panel consumes it once, on its next render. Same shape as the browser's open request in [browserPanel.ts](../src/renderer/lib/browserPanel.ts).

The request carries a target state rather than "toggle" on purpose: a pane mounting into a restored terminal would otherwise flip the panel the latch just brought back.

## Chrome

[TerminalTabsPanel.tsx](../src/renderer/components/TerminalTabsPanel.tsx) wears the panel's own tab grammar — the `.file-tabs` strip that Files and Agents use, plus a trailing `+` and a `.review-status-bar` footer naming the working directory and the active shell. Inactive tabs stay mounted (`display: none`) so switching is instant. Closing the last tab rests on an empty state with a "New terminal" button rather than yanking the reader out of the mode.

The terminal surface sits on `--bg`, a shade below the panel, so a shell reads as a window onto the machine rather than as more chrome. Background intensity also updates the xterm canvas through `--terminal-surface`. Level 7 keeps the original terminal palette. Other levels scale its background with the page, and the runtime observes `data-background-intensity` so open terminals update immediately.
