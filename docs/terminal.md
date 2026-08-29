# Terminal

User-spawned integrated terminals are independent from provider PTYs. They live in [src-tauri/src/terminal/service.rs](../src-tauri/src/terminal/service.rs).

IPC:

- `terminal:spawn`
- `terminal:write`
- `terminal:resize`
- `terminal:terminate`
- `terminal:data`
- `terminal:exit`

The service uses `portable-pty`, emits data chunks immediately, and terminates through Rust process-control helpers. Provider sessions use their own PTYs in `providers/`.

The renderer subscribes through Tauri's core event plugin, so `src-tauri/capabilities/default.json` must grant `core:event:default`; app commands like `terminal:spawn` can work even when event subscriptions are denied.

`Cmd/Ctrl+J` is owned by the app-level keybinding layer, not an individual chat pane. The app closes transient overlays/settings, focuses an existing session workspace when needed, then toggles that workspace's entry in the terminal store (`toggleTerminalPanel`) directly; pressing it again collapses the same terminal without killing its PTY. (An earlier design bumped a counter prop that `SessionPane` replayed in an effect — a remounted pane re-saw the historical count and flipped the persisted panel on every session switch.)

## Renderer persistence

Terminal state survives session switches. Tab metadata, the active tab, and the panel-open flag live in a workspace-keyed module store, [src/renderer/lib/terminalTabs.ts](../src/renderer/lib/terminalTabs.ts) (import-safe from the main bundle). The xterm instances and PTY wiring live in [src/renderer/lib/terminalRuntime.ts](../src/renderer/lib/terminalRuntime.ts), keyed by tab id and only imported from the lazy xterm chunk. Each runtime owns a host `<div>` that xterm renders into; `TerminalInstance` reparents that host into the pane on mount and detaches it on unmount. Unmounting (tab switch, ⌘J collapse, session switch, pane close) never terminates the PTY — only closing a tab, LRU eviction, or app shutdown does.

Memory guardrails: xterm scrollback is capped at 5000 lines per terminal, and at most `MAX_TERMINAL_WORKSPACES` (6) workspaces keep live terminals. Opening a terminal for a workspace beyond the cap evicts the least-recently-used workspace with no mounted panel, terminating its PTYs and disposing its xterm instances.
