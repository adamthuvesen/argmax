# Terminal

User-spawned integrated terminals are independent from provider PTYs. They live in [src-tauri/src/terminal/service.rs](../../src-tauri/src/terminal/service.rs).

IPC:

- `terminal:spawn`
- `terminal:write`
- `terminal:resize`
- `terminal:terminate`
- `terminal:data`
- `terminal:exit`

The service uses `portable-pty`, emits data chunks immediately, and terminates through Rust process-control helpers. Provider sessions use their own PTYs in `providers/`.

The renderer subscribes through Tauri's core event plugin, so `src-tauri/capabilities/default.json` must grant `core:event:default`; app commands like `terminal:spawn` can work even when event subscriptions are denied.

`Cmd/Ctrl+J` is owned by the app-level keybinding layer, not an individual chat pane. The app closes transient overlays/settings, focuses an existing session workspace when needed, then sends a toggle signal to the focused `SessionPane`; pressing it again collapses the same terminal without killing its PTY.
