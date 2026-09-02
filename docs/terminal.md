# Terminal

Integrated terminal instances run independently from provider PTYs under [src-tauri/src/terminal/service.rs](../src-tauri/src/terminal/service.rs).

## IPC Channels

- `terminal:spawn`
- `terminal:write`
- `terminal:resize`
- `terminal:terminate`
- `terminal:data` (push)
- `terminal:exit` (push)

The backend uses `portable-pty` for process execution and event chunk emission. Subscriptions require `core:event:default` in `src-tauri/capabilities/default.json`.

## Where It Lives

The terminal is a mode of the review panel — the fifth, beside Changes, Files, Agents, and [Browser](browser.md) — so shells sit in the same dock as the diff and the files they act on. The tab is shown only where a workspace backs the panel: the launcher's project-backed panel has no worktree to run in, and the mobile remote has no terminal at all.

`Cmd/Ctrl+J` shows the terminal for the active workspace, and hides the panel when the terminal is already the thing on screen. The workspace card's Terminal row does the same. Switching to another panel mode leaves the PTYs running.

## Renderer Lifecycle

Terminal state persists across session switches:

- **State stores:** Tab metadata, the active tab, and whether the terminal was on screen live in [src/renderer/lib/terminalTabs.ts](../src/renderer/lib/terminalTabs.ts), keyed by workspace.
- **xterm runtime:** [src/renderer/lib/terminalRuntime.ts](../src/renderer/lib/terminalRuntime.ts) manages lazy xterm instances and PTY event listeners. Each instance attaches to a host `<div>` that reparents when panes mount or unmount.
- **Resource limits:** Scrollback is capped at 5,000 lines. At most 6 workspaces (`MAX_TERMINAL_WORKSPACES`) retain running terminals; exceeding this evicts the least recently used unmounted workspace.
- **Contrast:** The xterm theme sets `minimumContrastRatio: 4.5` ([terminalRuntime.ts](../src/renderer/lib/terminalRuntime.ts)) to ensure prompt readability.

Panes are keyed by session, so the review panel's mode dies on every session switch. The `showing` flag in the store is what survives it: [useReviewState.ts](../src/renderer/hooks/useReviewState.ts) seeds its initial mode from that flag and writes back what the panel shows. Nothing else reads it.

## How ⌘J Reaches The Panel

The keypress is handled in `App`, which has no handle on the pane's review state — and the pane it means may only be mounting in the same tick (⌘J from Settings opens the chat first). So `App` resolves the toggle against the workspace's remembered state and files a `TerminalVisibilityRequest` naming the workspace and the state it wants. The matching panel consumes it once, on its next render. Same shape as the browser's open request in [browserPanel.ts](../src/renderer/lib/browserPanel.ts).

The request carries a target state rather than "toggle" on purpose: a pane mounting into a restored terminal would otherwise flip the panel the latch just brought back.

## Chrome

[TerminalTabsPanel.tsx](../src/renderer/components/TerminalTabsPanel.tsx) wears the panel's own tab grammar — the `.file-tabs` strip that Files and Agents use, plus a trailing `+` and a `.review-status-bar` footer naming the working directory and the active shell. Inactive tabs stay mounted (`display: none`) so switching is instant. Closing the last tab rests on an empty state with a "New terminal" button rather than yanking the reader out of the mode.

The terminal surface sits on `--bg`, a shade below the panel, so a shell reads as a window onto the machine rather than as more chrome.
