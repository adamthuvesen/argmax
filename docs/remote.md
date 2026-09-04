# Mobile Remote

Argmax includes a local HTTP + WebSocket bridge for remote control over a private Tailscale network. The server binds only to `127.0.0.1`.

## Setup

Enable in Settings → Integrations → Remote access. Configuration is saved in `remote.json` in the app data directory (`enabled`, `port`, `token`, `ntfy_topic`).

To expose the port over Tailscale:

```bash
tailscale serve --http=8790 --bg 8790
```

Pairing is completed by scanning the QR code in settings or opening `http://<machine>.<tailnet>.ts.net:8790/mobile.html#token=<token>`. The bearer token is passed in the URL fragment.

## Architecture

- **Server:** [src-tauri/src/remote](../src-tauri/src/remote) runs an `axum` HTTP server on `127.0.0.1:<port>`. `/api/ws` handles WebSocket connections; other routes serve frontend assets. Tauri's asset resolver answers a miss with the app shell rather than reporting one, so [server.rs](../src-tauri/src/remote/server.rs) treats HTML under a non-HTML path as a 404 — otherwise a hashed chunk the bundle no longer has goes out as `text/html` and gets cached under that URL for a year.
- **Protocol:** JSON frames over WebSocket.
  - Handshake: `{"type":"auth","token":"..."}` within 5 seconds.
  - RPC: `{"type":"request","id", "channel", "input"}` → `{"type":"response","id","ok"|"error"}`.
  - Push events: `{"type":"event","channel","payload"}` for `dashboard:delta`, `terminal:data`, and `terminal:exit`. Terminal events ride their own 64-slot broadcast so a flood of PTY output cannot evict a queued delta; a client that falls behind on that stream silently loses the window, while falling behind on `dashboard:delta` costs it a `resync` frame.
  - Heartbeat: `{"type":"ping"}` / `{"type":"pong"}` every 20s. Resync signals (`{"type":"resync"}`) indicate dropped connection recovery; the client reloads its snapshot and the open session's events.
- **Dispatcher:** [src-tauri/src/remote/dispatch.rs](../src-tauri/src/remote/dispatch.rs) maps incoming requests to existing IPC handlers. Desktop-only channels return `REMOTE_UNSUPPORTED`.
- **Renderer Transport:** [wsTransport.ts](../src/renderer/lib/wsTransport.ts) implements `invoke` and `subscribe` over WebSocket when `argmax.remote` is set.
- **Mobile UI:** [mobile.html](../mobile.html) and [src/renderer/mobile](../src/renderer/mobile) provide a touch-optimized view for session management, reviews, and launcher flows. The list shows every non-archived workspace that has a session, side chats included — a side chat's row carries the hidden "Side chats" project as its label and stays out of Priority, the same rule the desktop sidebar applies. The New session screen's workspace picker offers the two repo modes plus **Side chat**, which creates a scratch workspace through `workspaces:create-scratch` instead of a checkout; with no project registered it is the only mode, so a phone that has never had a repo added can still start one. A side chat gets no Changes/Files button — its worktree is an app-owned scratch directory with one empty commit — though a file reference tapped in the transcript still opens the review screen. Navigation history is synchronized with browser history in [useMobileBackNavigation.ts](../src/renderer/mobile/useMobileBackNavigation.ts) — every screen a back gesture can pop counts toward the depth it mirrors, including sheets and the review screen's file drill-down, so screens whose open state lives in a child are lifted into `MobileApp`.
- **Mobile attachments:** The New chat composer accepts pasted, dropped, or selected PNG, JPEG, GIF, and WebP images. The remote bridge stores path-less images on the host through `attachments:save-image` and sends their paths with the launch.
- **Viewport:** the shell is a fixed frame, and `dvh` measures the layout viewport, which no phone shrinks for the on-screen keyboard. Chrome is handled by `interactive-widget=resizes-content` in the viewport meta; iOS has no equivalent, so [useVisualViewportInsets.ts](../src/renderer/mobile/useVisualViewportInsets.ts) publishes the visual viewport's height, pan offset, and keyboard inset as custom properties that [mobile.css](../src/renderer/styles/mobile.css) sizes the shell, sheets, and toast against. The New chat screen's hero (fox + greeting) hides itself when the room left for it collapses, through a container query on the screen body rather than a `max-height` media query — a media query would measure the layout viewport, which the keyboard never shrinks. A paired phone keeps a page alive across renderer rebuilds, so the lazily-loaded review screen goes through [importChunk.ts](../src/renderer/lib/importChunk.ts), which reloads once when the chunk hash it holds is gone.

## Push Notifications (ntfy)

Configured via the ntfy topic field in Settings → Remote access.
[src-tauri/src/remote/ntfy.rs](../src-tauri/src/remote/ntfy.rs) watches session state changes and sends HTTP POST notifications for events requiring attention (`approval-needed`, `blocked`, `failed`, `complete`). Each notification includes a click action URL linking directly to the session.

## Security Model

- Binds to `127.0.0.1` only; network access relies on Tailscale TLS and authentication.
- Authentication uses a generated bearer token passed via URL fragment and authenticated in WebSocket headers.
