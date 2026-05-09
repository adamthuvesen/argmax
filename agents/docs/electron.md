# Electron mechanics

## The native-module rebuild dance

`better-sqlite3` and `node-pty` ship with prebuilt binaries that target a specific `NODE_MODULE_VERSION`. Electron's bundled Node is **not** the same as your system Node — recompile when switching contexts.

| Command | Compiles for | Use when |
|---|---|---|
| `npm run rebuild:electron` | Electron 35.7.5 (`NODE_MODULE_VERSION` 127) | running the app |
| `npm run rebuild:node` | System Node | running tests, scripts |

`npm run dev` runs `rebuild:electron` first; `npm test` runs `rebuild:node` first. If you bypass these and call `vite` / `vitest` directly, you'll see `NODE_MODULE_VERSION` errors. **The fix is one of the rebuild commands, not `npm install`.**

[scripts/ensure-node-pty-helper.cjs](../../scripts/ensure-node-pty-helper.cjs) runs after rebuilds to copy node-pty's helper binary into place — required on macOS. Don't edit it without understanding why.

## Lifecycle

- `app.whenReady()` instantiates the database + `ProviderSessionService`, registers all IPC handlers, opens the `BrowserWindow`
- `before-quit` calls `ProviderSessionService.disposeAll()` to terminate any spawned PTYs gracefully
- IPC teardown iterates `REGISTERED_IPC_CHANNELS` to remove handlers cleanly

## Window + preload

Hard rules in [src/main/main.ts](../../src/main/main.ts) BrowserWindow config:

- `contextIsolation: true`
- `nodeIntegration: false`

The renderer talks to main **only** through `window.maestro` (defined in [src/main/preload.ts](../../src/main/preload.ts)). Never reach for `require()`, `process`, or `ipcRenderer` directly from renderer code — they don't exist there. The preload bridge is the only place where main and renderer share a runtime.

## Browser-preview fallback

When the renderer is opened via Vite alone (no Electron host, e.g. via `npx vite` for visual debugging), `window.maestro` is `undefined` and the app falls back to [demoSnapshot.ts](../../src/renderer/demoSnapshot.ts). The bridge-missing banner is suppressed when `location.hostname` is `127.0.0.1` or `localhost` (see `isBrowserPreview()` in `App.tsx`). Use this for fast UI iteration without the full Electron rebuild loop.
