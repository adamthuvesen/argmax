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

Live updates reach the renderer as `dashboard:delta` events, fanned in from providers / gh poller / workspaces through a single FIFO channel and emitted by one worker task (see `lib.rs`). Three macOS-specific gotchas all had to be handled, or streamed turns appear to "hang" and only render at the end:

- **Emit on the main thread (load-bearing for streaming).** An event emitted from a background thread does **not** reliably wake the macOS `NSApp` event loop, so `dashboard:delta` pushes sit undelivered until some unrelated UI event pumps the loop — mid-turn streaming stalls and the chat fills in only when the turn ends (process exit pumps the loop). Symptoms that confirm this: snapshot/debug counts stay flat during the turn, focus doesn't matter, and navigating to another session and back instantly populates (because *pulls* via IPC invoke stay reliable). The delta worker wraps each emit in `app.run_on_main_thread(...)`, which dispatches the webview eval as a main-thread task the loop processes promptly. See [tao#625](https://github.com/tauri-apps/tao/issues/625) / [winit#219](https://github.com/rust-windowing/winit/issues/219).
- **Running-only pull safety net.** Because that macOS wake-up is historically flaky, `useDashboardSession` polls the *selected, running* session every 250 ms. Each tick pulls only the cheap event tail (`session.eventsSince`, deduped by `mergeByCreatedAt`) so streamed text keeps flowing. The heavier session/workspace state pull (`workspace:status`, upserted via `mergeDashboardDelta`) fires **once**, when the event poll has pulled the turn's terminal event (`session.completed`/`error`) but the `state: running → complete` push — the *last* emit of the turn, the one most likely to lag — hasn't arrived yet; without it the chat finishes streaming but the header stays stuck on "Working". Both IPC handlers are synchronous Rust commands sharing one DB mutex with the provider's event ingestion, so pulling `workspace:status` every tick (and letting `setInterval` ticks overlap) starved a busy turn (e.g. a Codex multi-file read) — hence cheap-tail-every-tick + one status reconcile at the end + an in-flight guard so ticks never pile up. Scoped to running sessions only — idle sessions never poll, and the effect tears down the instant state flips off "running", so steady state stays delta-driven. Belt-and-suspenders behind the main-thread emit; don't expand it into a dashboard-wide recurring poll.
- **App Nap** (process level) suspends the whole WebContent process when the app is backgrounded. [util/app_nap.rs](../../src-tauri/src/util/app_nap.rs) holds an `NSProcessInfo` activity assertion for the process lifetime.
- **WKWebView inactive-window throttling** (webview level) freezes JS/rendering for an inactive window. `app.windows[].backgroundThrottling: "disabled"` in [tauri.conf.json](../../src-tauri/tauri.conf.json) maps to `WKInactiveSchedulingPolicy::None`.

Claude (and Cursor) stream token-by-token, so a turn can emit hundreds of `message.delta` rows. `mergeDashboardDelta`'s event cap (`mergeEventsBounded` in [snapshot.ts](../../src/renderer/lib/snapshot.ts)) caps *droppable answer deltas* and *protected rows* (user message, tool rows, approvals, errors, thinking deltas) independently — so a long streamed answer never evicts the current turn's tool rows or the user bubble, which would otherwise flicker out until the completion prunes the deltas.

## Bindings

`src/shared/bindings.d.ts` is emitted by `tauri-specta` from the Rust command surface. `npm run check:bindings` fails when generated bindings are older than `src-tauri` inputs. `npm run check:tauri-bridge` compares the renderer bridge against `src-tauri/tests/fixtures/channels.txt`.
