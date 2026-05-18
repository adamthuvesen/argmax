# Electron mechanics

Native rebuilds, the preload bridge, lifecycle, packaging.

## The native-module rebuild dance

`better-sqlite3` and `node-pty` ship prebuilt binaries pinned to a specific `NODE_MODULE_VERSION`. Electron's bundled Node ≠ your system Node — recompile when switching contexts.

| Command | Compiles for | Use when |
|---|---|---|
| `npm run rebuild:electron` | Electron 35 (uses `@electron/rebuild`) | running the app |
| `npm run rebuild:node` | System Node | running tests, scripts |

`npm run dev` runs `rebuild:electron` first; `npm test` runs `rebuild:node` first. Skipping them and calling `vite` / `vitest` directly surfaces `NODE_MODULE_VERSION` errors. **Fix = the right rebuild command, never `npm install`.**

[scripts/ensure-node-pty-helper.cjs](../../scripts/ensure-node-pty-helper.cjs) copies node-pty's macOS helper binary into place after each rebuild. Don't edit it without understanding the install layout.

> `electron` is a `devDependency`; the binary is not bundled into the app — `electron-builder` packages its own copy.

## Window + preload contract

[src/main/main.ts](../../src/main/main.ts) `BrowserWindow` config has three hard rules:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

The renderer talks to main **only** through `window.argmax`, exposed by [src/main/preload.ts](../../src/main/preload.ts) via `contextBridge.exposeInMainWorld`. There is no `require`, no `process`, no `ipcRenderer` in renderer code — they don't exist there. Two extra rails:

- `webContents.setWindowOpenHandler` denies all `window.open` / `target="_blank"` attempts. `https?://` URLs route through `shell.openExternal`; everything else is dropped.
- `webContents.on("will-navigate")` blocks any in-page navigation away from the loaded bundle (dev server origin or `file://`).

Request/response IPC uses `ipcRenderer.invoke`; pushed events (`dashboard:delta`, `terminal:data`, `terminal:exit`, `mcp:auth:data`, `mcp:auth:exit`, `menu:command`) use `ipcRenderer.on` with a returned unsubscribe. See [ipc.md](ipc.md) for the channel inventory.

## Lifecycle

`app.whenReady()` runs in this order:

1. Set dock icon (macOS).
2. `createDatabase()` opens SQLite at `app.getPath("userData")/local-state/argmax.sqlite`.
3. Construct `NotificationService` (window-focus aware) and `DockBadgeService`.
4. Construct `ProviderSessionService` and call `recoverOrphanedSessions()` — any session still `running` from a previous crash is reconciled before IPC handlers register, so the renderer never sees a phantom live session.
5. Construct `TerminalService` (integrated terminal panel — see [terminal.md](terminal.md)).
6. Construct `McpAuthService` (interactive PTY for OAuth-style MCP enrollment).
7. `registerIpcHandlers()` wires every channel; the returned list is later used to remove handlers on shutdown.
8. Start the `GhPoller` (CI feedback loop — see [gh.md](gh.md)).
9. In packaged builds only, instantiate `UpdateService` and call `runStartupCheck()`. Auto-update no-ops in dev.
10. Build the application menu (`buildAppMenuTemplate`); menu items forward `menu:command` events to the focused window.
11. `createWindow()`.

`before-quit` is intercepted exactly once (`shutdownInProgress` flag), `event.preventDefault()`'d, and routed through `shutdown()`. Each step is independent so one failure doesn't strand the others:

- `ghPoller.stop()`
- `providerSessions.disposeAll()` (awaited — gracefully terminates every PTY/child, then SIGKILL-escalates stragglers)
- `terminals.disposeAll()`
- `mcpAuth.disposeAll()` (any open MCP auth PTY)
- `ipcMain.removeHandler()` for every channel in the registered list
- `database.clearPruneInterval()` + `database.connection.close()`
- `app.exit(0)`

## Push channels (preload)

| Channel | Sender | Renderer API |
|---|---|---|
| `dashboard:delta` | `ProviderSessionService` → `DeltaCoalescer` → `BrowserWindow.webContents.send` (~60 fps) | `dashboard.onDelta(listener)` returns unsubscribe |
| `terminal:data` | `TerminalService` | `terminal.onData(listener)` |
| `terminal:exit` | `TerminalService` | `terminal.onExit(listener)` |
| `mcp:auth:data` | `McpAuthService` | `mcp.auth.onData(listener)` |
| `mcp:auth:exit` | `McpAuthService` | `mcp.auth.onExit(listener)` |
| `menu:command` | Application menu | `menu.onCommand(listener)` |

These are **not** in `IPC_CHANNELS` / `REGISTERED_IPC_CHANNELS` (those are request/response only). Keep listener cleanup intact in components and tests — leaked subscriptions show up as duplicate UI updates after hot-reload or window re-creation.

## Building a distributable

```bash
npm run package   # npm run build && electron-builder --mac
```

`electron-builder` is configured in `package.json` → `build`:

- App ID `com.argmax.app`, product name `Argmax`.
- Targets: `dmg` + `zip` for `arm64` and `x64`.
- Icon: `assets/icon.icns`.
- Hardened runtime + notarization (`notarize: true`). Entitlements at `build/entitlements.mac.plist`.
- Bundled files: `dist/**/*`, `assets/**/*`. Native modules rebuild via `npmRebuild: true`.

For the full signing/notarization story — credentials, entitlements, smoke procedure, failure modes — see [release.md](release.md).

## Browser-preview fallback

`npx vite --host 127.0.0.1` starts the renderer without Electron. `window.argmax` is `undefined`, so the app substitutes [demoSnapshot.ts](../../src/renderer/demoSnapshot.ts) and suppresses the bridge-missing banner when the host is `127.0.0.1` / `localhost` (`isBrowserPreview()`). Use it for fast visual iteration without the full rebuild loop.
