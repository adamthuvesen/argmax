# Runtime

Argmax runs as a Tauri 2 app: Rust owns the native runtime, persistence, PTYs, menus, notifications, updater, and IPC; React/Vite owns the renderer.

## Commands

```bash
npm run tauri:dev
npm run tauri:build
npm run test:rust
```

`npm run tauri:dev` starts Vite through Tauri's `beforeDevCommand`, builds `src-tauri`, and opens the app webview. `npx vite --host 127.0.0.1` remains useful for browser-preview UI work; without `window.__TAURI_INTERNALS__`, [tauriBridge.ts](../src/renderer/lib/tauriBridge.ts) leaves `window.argmax` unset and the renderer uses demo data.

## Rust Layout

- [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) wires app setup, state, services, menu, protocols, and shutdown.
- [src-tauri/src/state.rs](../src-tauri/src/state.rs) stores shared service handles.
- [src-tauri/src/ipc](../src-tauri/src/ipc) contains Tauri commands.
- [src-tauri/src/persistence](../src-tauri/src/persistence) owns SQLite and migrations.
- [src-tauri/src/providers](../src-tauri/src/providers) owns provider launch, PTYs, event normalization, and flush queues.
- [src-tauri/src/workspaces](../src-tauri/src/workspaces), [review](../src-tauri/src/review), [files](../src-tauri/src/files), [git](../src-tauri/src/git), [gh](../src-tauri/src/gh), [terminal](../src-tauri/src/terminal), [mcp](../src-tauri/src/mcp), [approvals](../src-tauri/src/approvals), [checks](../src-tauri/src/checks), [memory](../src-tauri/src/memory), and [skills](../src-tauri/src/skills) map to user-facing subsystems.

## Event delivery

Live updates reach the renderer as `dashboard:delta` events. Providers, the gh poller, and workspaces feed one FIFO channel; one worker task in `lib.rs` emits the events. Three macOS-specific issues had to be handled, or streamed turns look like they hang and only render at the end:

- **Emit on the main thread.** Background-thread emits do **not** reliably wake the macOS `NSApp` event loop. `dashboard:delta` pushes can sit undelivered until another UI event pumps the loop, so mid-turn streaming stalls and the chat fills in only when the turn ends. Symptoms: snapshot/debug counts stay flat during the turn, focus does not matter, and navigating away and back instantly populates because IPC pulls are still reliable. The delta worker wraps each emit in `app.run_on_main_thread(...)`, which dispatches the webview eval as a main-thread task the loop processes promptly. See [tao#625](https://github.com/tauri-apps/tao/issues/625) / [winit#219](https://github.com/rust-windowing/winit/issues/219).
- **Running-only pull safety net.** Because macOS wake-up has been flaky, `useDashboardSession` polls the *selected, running* session every 250 ms. Each tick pulls the cheap event tail (`session.eventsSince`, deduped by `mergeByCreatedAt`) so streamed text keeps flowing. The heavier session/workspace state pull (`workspace:status`, upserted via `mergeDashboardDelta`) runs on two slower cadences. A throttled mid-turn refresh (~2 s) keeps `changedFiles` and dirty markers live. A guaranteed pull at turn end catches the common lag where the event poll has pulled `session.completed`/`error`, but the final `state: running → complete` push has not arrived yet. Without that final pull, the chat finishes streaming but the header stays stuck on "Working". Both IPC handlers are synchronous Rust commands sharing one DB mutex with provider event ingestion. Pulling `workspace:status` on every 250 ms tick, and letting `setInterval` ticks overlap, starved busy turns such as a Codex multi-file read. Keep the status pull throttled and guarded in flight. Idle sessions never poll, and the effect tears down as soon as state stops being `running`, so steady state stays delta-driven.
- **App Nap** (process level) suspends the whole WebContent process when the app is backgrounded. [util/app_nap.rs](../src-tauri/src/util/app_nap.rs) holds an `NSProcessInfo` activity assertion for the process lifetime.
- **WKWebView inactive-window throttling** (webview level) freezes JS/rendering for an inactive window. `app.windows[].backgroundThrottling: "disabled"` in [tauri.conf.json](../src-tauri/tauri.conf.json) maps to `WKInactiveSchedulingPolicy::None`.

Claude and Cursor stream token-by-token, so a turn can emit hundreds of `message.delta` rows. `mergeDashboardDelta`'s event cap (`mergeEventsBounded` in [snapshot.ts](../src/renderer/lib/snapshot.ts)) caps *droppable answer deltas* and *protected rows* independently. Protected rows include the user message, tool rows, approvals, errors, and thinking deltas. This keeps a long streamed answer from evicting the current turn's tool rows or user bubble before completion prunes the deltas.

## Bindings

`src/shared/bindings.d.ts` is emitted by `tauri-specta` from the Rust command surface. `npm run check:bindings` fails when generated bindings are older than `src-tauri` inputs. `npm run check:tauri-bridge` compares the renderer bridge against `src-tauri/tests/fixtures/channels.txt`.
