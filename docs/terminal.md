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

`Cmd/Ctrl+J` toggles the terminal panel for the active workspace (`toggleTerminalPanel`). Collapsing the panel keeps the PTY process running.

## Renderer Lifecycle

Terminal state persists across session switches:
- **State stores:** Tab metadata, active tabs, and panel visibility are stored in [src/renderer/lib/terminalTabs.ts](../src/renderer/lib/terminalTabs.ts).
- **xterm runtime:** [src/renderer/lib/terminalRuntime.ts](../src/renderer/lib/terminalRuntime.ts) manages lazy xterm instances and PTY event listeners. Each instance attaches to a host `<div>` that reparents when panes mount or unmount.
- **Resource limits:** Scrollback is capped at 5,000 lines. At most 6 workspaces (`MAX_TERMINAL_WORKSPACES`) retain running terminals; exceeding this evicts the least recently used unmounted workspace.
- **Contrast:** The xterm theme sets `minimumContrastRatio: 4.5` ([terminalRuntime.ts](../src/renderer/lib/terminalRuntime.ts)) to ensure prompt readability.
