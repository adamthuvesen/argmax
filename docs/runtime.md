# Runtime

Argmax runs as a Tauri 2 application: Rust manages persistence, PTYs, menus, notifications, updater, and IPC; React/Vite runs the UI.

## Commands

```bash
npm run tauri:dev   # Start dev app (Vite + cargo build)
npm run tauri:dev:isolated   # Same, on its own profile, next to the installed app
npm run tauri:build # Production build
npm run test:rust   # Cargo test suite
```

For UI-only work, `npx vite --host 127.0.0.1` runs browser preview with mock data from [demoSnapshot.ts](../src/renderer/demoSnapshot.ts).

## Rust Structure

- [src-tauri/src/lib.rs](../src-tauri/src/lib.rs): App setup, state, services, menus, and shutdown.
- [src-tauri/src/state.rs](../src-tauri/src/state.rs): Shared service handles.
- [src-tauri/src/ipc](../src-tauri/src/ipc): Tauri command handlers.
- [src-tauri/src/persistence](../src-tauri/src/persistence): SQLite connection and migrations.
- [src-tauri/src/providers](../src-tauri/src/providers): Provider processes, PTYs, event normalization, and flush queues.
- Subsystems: `workspaces`, `review`, `files`, `git`, `gh`, `terminal`, `approvals`, `checks`, and `skills`.

## Open-file Limit

Before starting services, Argmax raises its open-file soft limit to 8,192,
capped by the existing hard limit, and preserves an already higher soft limit.
Providers and their tools inherit this allowance. This avoids passing the
macOS GUI default of 256 descriptors into Codex, where concurrent skill reads
can exhaust it. A failure to raise the limit is reported to stderr. The change
takes effect after rebuilding and restarting Argmax.

## Single Instance Lock

On boot, Argmax acquires an advisory `flock` on `local-state/argmax.lock` ([util/instance_lock.rs](../src-tauri/src/util/instance_lock.rs)) before touching SQLite. If another instance is running, the new process shows an alert and exits immediately, preventing duplicate startup recovery from marking live sessions as orphaned. The lock releases automatically on exit.

## Chat Windows

"Open in new window" on a sidebar row or in a chat's actions menu tears the chat off into a second desktop window ([windows.rs](../src-tauri/src/windows.rs)). Every window runs the same renderer: the new one is built with the main window's chrome (transparent, sidebar vibrancy, overlay title bar) and loads `index.html?session=<id>`, which [windowRole.ts](../src/renderer/lib/windowRole.ts) reads so the grid boots on that chat. Nothing else is per window — `dashboard:delta` and the terminal events are broadcast to every webview, and a torn-off window subscribes like the main one does. Windows are labelled `chat-<n>`; `AppState.chat_windows` maps each to the session it shows so a second request focuses the existing window. The window reports switches through `window:set-session`, and `WindowEvent::Destroyed` drops the entry. Closing the main window closes the torn-off ones with it: the dock badge, the browser's native tabs and notification clicks all live on main, so the app must not linger headless behind a chat window. A torn-off window whose chat is archived closes itself. Torn-off windows are not restored across a relaunch.

The menu is app-global, so `menu:command`, dev reload, and devtools go to the chat window that last had focus (`windows::focused_window_label`, fed by the same window-event hook that clears the dock badge). A browser popup can be the key window without being a chat window: ⌘W then closes the popup, and neither it nor the badge-clearing hook counts as the user looking at their chats. A chat's notification banner carries its session id as the request identifier, so a click raises the window that chat is torn off into. An agent's `terminal:agent-open` goes to that window too, never to every window, since two renderers adopting one PTY would each size it and either could terminate it. The renderer subscribes to every push channel as its own window (`listen(channel, handler, { target: label })` in [tauriBridge.ts](../src/renderer/lib/tauriBridge.ts)): Tauri delivers a targeted `emit_to` to any listener registered with the default `Any` target, so without the label ⌘B would toggle the sidebar in every open window at once. Broadcasts still reach a labelled listener. Page zoom and the theme apply to every chat window. In a torn-off window, ⌘W on the last pane closes the window rather than leaving an empty launcher. The browser page and its native tabs stay with the main window (see [browser.md](browser.md)). `hostsBrowserSurface()` in [tauriBridge.ts](../src/renderer/lib/tauriBridge.ts) is the one gate: a torn-off window offers no Browser rail item, no Browser mode in the review panel, no "Open browser" action, and sends chat links to the system browser — a `browser:set-bounds` from it would drag the main window's tab to that window's coordinates. `window:open-session` is desktop-only (`REMOTE_UNSUPPORTED_CHANNELS`); the capability in `src-tauri/capabilities/default.json` covers `main` and `chat-*`.

`localStorage` is shared between windows: sidebar width and collapse, drafts, and viewed marks are last-write-wins and do not sync live. Showing one chat in two windows doubles its per-mount work (follow-up suggestion, PR refresh), the same cost the phone already incurs beside the desktop.

## Event Delivery

Live updates reach the renderer through `dashboard:delta` events:

- **Main thread dispatch:** The delta worker uses `app.run_on_main_thread(...)` so macOS event loops process webview updates immediately.
- **Bounded delivery:** Transcript writes push compact session-change hints, while metadata writes push a `dashboardChanged` invalidation. The queue holds at most 512 items and 4 MiB of exact serialized payloads. If the main thread falls behind that budget, the incomplete window is discarded and one `resyncRequired` delta makes clients reload durable state. The worker waits for each main-thread closure to run before scheduling another, so scheduled closures cannot accumulate outside the queue.
- **Running session pull fallback:** `useDashboardSession` polls running sessions at 250 ms for new event tails (`session:events-since`). Workspace status (`workspace:status`) runs on a throttled ~2s interval and once at turn end to avoid SQLite lock contention. Idle sessions do not poll.
- **App Nap prevention:** [util/app_nap.rs](../src-tauri/src/util/app_nap.rs) holds an `NSProcessInfo` assertion so the backgrounded app keeps receiving provider output.
- **WKWebView throttling:** Background throttling is disabled in [tauri.conf.json](../src-tauri/tauri.conf.json) (`WKInactiveSchedulingPolicy::None`).

Transcript pushes and history reads enter [SessionTimelines](../src/renderer/lib/sessionTimelines.ts), with independent event and raw-output caps per session. The store uses `mergeEventsBounded` ([snapshot.ts](../src/renderer/lib/snapshot.ts)) to cap replaceable answer deltas while retaining separate budgets for tool rows, user messages, thinking, and trace imports. Approvals remain in dashboard metadata.

## Desktop Notifications

[notifications.rs](../src-tauri/src/notifications.rs) fires "Chat complete" / "Chat failed" from the dashboard delta stream when a session reaches a terminal state while the main window is not focused, and dedupes per session until that session runs again. The sink is chosen once at setup by `desktop_sink`:

- **Bundled macOS app:** [notifications/macos.rs](../src-tauri/src/notifications/macos.rs) sends through `UNUserNotificationCenter`. It asks for permission on first launch, reports the real authorization state (a denied app fails "Send test notification" with a message instead of silently succeeding), presents banners even while Argmax is frontmost, and focuses the window when a banner is clicked. `UNUserNotificationCenter` refuses bundles that only carry the linker's signature (`UNErrorDomain 1`), so `tauri.conf.json` ad-hoc signs local builds (`signingIdentity: "-"`; `APPLE_SIGNING_IDENTITY` still wins for releases) A refused request turns notifications off for that install (usernoted denies legacy sends from a process that has used the modern API, so there is no runtime fallback); the log says why and the test button reports it. Answer the first-launch permission prompt before quitting: if the app quits while the prompt is open, macOS refuses later requests for that install (seen on macOS 26) and the only recovery is System Settings > Notifications.
- **Unbundled binary or other platforms:** the Tauri notification plugin. On macOS that is the deprecated `NSUserNotificationCenter`, which never shows a banner while the app is frontmost and files the notification into Notification Center history instead. `tauri dev` runs unbundled, so use a bundled build to check banner behavior.

## Pending Follow-up Recovery

The composer queue is SQLite-backed. Enqueue, removal, editing, reordering,
and restoration commit the complete per-session order before the renderer is
notified. Dispatch marks a row `launching` before removing it from the
in-memory queue, and deletes it only after the user turn is durably recorded.
Attachments, agent references, model choices, fast mode, and cross-session
message origin travel with the journal row.

Startup restores every journal row to the composer but never drains recovered
work automatically. A row that was merely waiting is labeled **Paused • not sent**.
Provider launch and runtime failures also
pause unsent messages instead of deleting them. A row that had entered `launching` is labeled
**Delivery uncertain • check the chat before sending again**,
because the provider may have accepted it before the app stopped. Both require
an explicit **Send** action. New follow-ups queued during the current process
may drain past paused recovered rows, so reviewing old work does not stall new
work. Agent-originated messages remain authoritative in `session_messages`;
their pending-turn copy uses the same journal but still checks the inbox row
before dispatch to prevent double delivery.

## Type Bindings

`src/shared/bindings.d.ts` is generated by `tauri-specta` from Rust commands.
- `generated_ipc_files_are_current` in `src-tauri/tests/integration/ipc_inventory.rs` (part of `cargo test`) fails when the checked-in bindings or channel inventories drift from what the exporter emits; `npm run generate:bindings` refreshes them.
- `npm run check:tauri-bridge`: Verifies channel parity against `src-tauri/tests/fixtures/channels.txt`.
