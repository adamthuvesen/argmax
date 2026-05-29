# Runtime

Argmax runs as a Tauri 2 app: Rust owns the native runtime, persistence, PTYs, menus, notifications, updater, and IPC; React/Vite owns the renderer.

## Commands

```bash
npm run tauri:dev
npm run tauri:build
npm run test:rust
```

`npm run tauri:dev` starts Vite through Tauri's `beforeDevCommand`, builds `src-tauri`, and opens the app webview. `npx vite --host 127.0.0.1` remains useful for browser-preview UI work; without `window.__TAURI_INTERNALS__`, [tauriBridge.ts](../../src/renderer/lib/tauriBridge.ts) leaves `window.argmax` unset and the renderer uses demo data.

## Rust Layout

- [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs) wires app setup, state, services, menu, protocols, and shutdown.
- [src-tauri/src/state.rs](../../src-tauri/src/state.rs) stores shared service handles.
- [src-tauri/src/ipc](../../src-tauri/src/ipc) contains Tauri commands.
- [src-tauri/src/persistence](../../src-tauri/src/persistence) owns SQLite and migrations.
- [src-tauri/src/providers](../../src-tauri/src/providers) owns provider launch, PTYs, event normalization, and flush queues.
- [src-tauri/src/workspaces](../../src-tauri/src/workspaces), [review](../../src-tauri/src/review), [files](../../src-tauri/src/files), [git](../../src-tauri/src/git), [gh](../../src-tauri/src/gh), [terminal](../../src-tauri/src/terminal), [mcp](../../src-tauri/src/mcp), [approvals](../../src-tauri/src/approvals), [checks](../../src-tauri/src/checks), [memory](../../src-tauri/src/memory), and [skills](../../src-tauri/src/skills) map to user-facing subsystems.

## Event delivery

Live updates reach the renderer as `dashboard:delta` events emitted from a background Tokio worker (see `lib.rs`). On macOS two separate power features stall delivery/rendering when the window isn't the active one, so both are disabled:

- **App Nap** (process level) suspends the whole WebContent process. [util/app_nap.rs](../../src-tauri/src/util/app_nap.rs) holds an `NSProcessInfo` activity assertion for the process lifetime.
- **WKWebView inactive-window throttling** (webview level) freezes JS/rendering and makes a backgrounded turn paint in bursts and stick on the thinking indicator. `app.windows[].backgroundThrottling: "disabled"` in [tauri.conf.json](../../src-tauri/tauri.conf.json) maps to `WKInactiveSchedulingPolicy::None`.

Do not paper over delivery gaps with a renderer poll; the dashboard is delta-driven by design.

## Bindings

`src/shared/bindings.d.ts` is emitted by `tauri-specta` from the Rust command surface. `npm run check:bindings` fails when generated bindings are older than `src-tauri` inputs. `npm run check:tauri-bridge` compares the renderer bridge against `src-tauri/tests/fixtures/channels.txt`.
