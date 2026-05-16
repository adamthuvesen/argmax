# Terminal panel

The integrated terminal panel (`⌘J`) spawns a real PTY scoped to the selected session's worktree. Distinct from provider PTYs — see [providers.md](providers.md).

## Why a separate service

Provider PTYs are owned by `ProviderSessionService` and tied to a session's provider lifecycle. User-spawned terminals have no provider, no event normalization, no approval flow. They're plain shells. Mixing the two would entangle two very different lifecycles, so they live apart in [src/main/terminal/terminalService.ts](../../src/main/terminal/terminalService.ts).

## Spawn

`window.argmax.terminal.spawn({ workspaceId, cols, rows })` →

1. `TerminalService.spawn(input)` reads the workspace's `path` from SQLite.
2. Picks a shell: `$SHELL`, falling back to `/bin/zsh` on macOS or `/bin/bash` on Linux.
3. Spawns via `node-pty.spawn(shell, [], { name: "xterm-256color", cols, rows, cwd, env })`. `TERM=xterm-256color` and `COLORTERM=truecolor` are forced so apps that probe stay in true-color mode.
4. Returns `{ terminalId }`. The renderer wires up xterm.js against that id.

## Streams

PTY output is broadcast to **every** open `BrowserWindow` (the standard `webContents.send` loop with `isDestroyed()` filtering). The renderer routes data to the right xterm instance by matching `terminalId`.

| Event | Carrier |
|---|---|
| `terminal:data` | `{ terminalId, data }` per PTY chunk |
| `terminal:exit` | `{ terminalId, exitCode, signal }` once the child exits |

Both are push-only — they don't go through Zod and don't belong in `IPC_CHANNELS`. See [ipc.md](ipc.md#push-channels).

## Write / resize / terminate

| Method | Behavior |
|---|---|
| `terminal.write({ terminalId, data })` | Forwards `data` to the PTY's stdin. Used for keystrokes and pasted text. |
| `terminal.resize({ terminalId, cols, rows })` | `pty.resize(cols, rows)`. The xterm fit-addon drives this on container resize. |
| `terminal.terminate(terminalId)` | Sends SIGHUP; relies on `node-pty`'s normal teardown. The `exit` event still fires. |

`disposeAll()` is wired to Electron's `before-quit` so spawned shells are torn down cleanly. The cleanup loop intentionally swallows individual errors so one stuck PTY doesn't strand the others.

## Renderer integration

xterm.js + the fit addon live in the renderer. Each tab owns one xterm instance and resize observer; the main process is only the data pump. Two gotchas worth knowing:

- `@xterm/xterm` ships its own CSS — it's already imported in the renderer entry. Don't add it again per-component or you'll double-paint.
- Keep the listener cleanup intact (`onData(...)` and `onExit(...)` both return unsubscribe functions). Leaked listeners surface as duplicated keystrokes after a hot reload.

## Tabs

The panel is multi-tab: `TerminalTabsPanel` ([src/renderer/components/TerminalTabsPanel.tsx](../../src/renderer/components/TerminalTabsPanel.tsx)) owns the tab list and renders one `TerminalInstance` per tab. Each instance spawns its own PTY, so `terminal:spawn` is called once per `+`-click. The main-process surface is unchanged — every PTY is still keyed by its UUID `terminalId`, and `terminal:data` / `terminal:exit` push events are id-filtered in the leaf.

Tabs are per-workspace: the parent passes `key={workspace.id}` so changing workspaces remounts the container, unmounting every leaf and terminating its PTY. Within a workspace, inactive tabs stay mounted (`display: none`) so long-running processes (`npm run dev`, `tail -f`) survive both tab switches and ⌘J collapse. The outer panel collapses via `data-collapsed="true"` rather than unmounting, preserving the same survival guarantee.

Two close paths:
- `onCollapse` — the header `×` (and `⌘J`). Hides the panel via CSS; PTYs stay alive.
- `onRequestClose` — fired when the user closes the last tab. The parent fully unmounts the container, which tears every PTY down.
