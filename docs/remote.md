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
  - Push events: `{"type":"event","channel","payload"}` for `dashboard:delta`, `terminal:data`, and `terminal:exit`.
  - Heartbeat: `{"type":"ping"}` / `{"type":"pong"}` every 20s. Resync signals (`{"type":"resync"}`) indicate dropped connection recovery.
- **Dispatcher:** [src-tauri/src/remote/dispatch.rs](../src-tauri/src/remote/dispatch.rs) maps incoming requests to existing IPC handlers. Desktop-only channels return `REMOTE_UNSUPPORTED`.
- **Renderer Transport:** [wsTransport.ts](../src/renderer/lib/wsTransport.ts) implements `invoke` and `subscribe` over WebSocket when `argmax.remote` is set.
- **Mobile UI:** [mobile.html](../mobile.html) and [src/renderer/mobile](../src/renderer/mobile) provide a touch-optimized view for session management, reviews, and launcher flows. Navigation history is synchronized with browser history in [useMobileBackNavigation.ts](../src/renderer/mobile/useMobileBackNavigation.ts). A paired phone keeps a page alive across renderer rebuilds, so the lazily-loaded review screen goes through [importChunk.ts](../src/renderer/lib/importChunk.ts), which reloads once when the chunk hash it holds is gone.

## Push Notifications (ntfy)

Configured via the ntfy topic field in Settings → Remote access.
[src-tauri/src/remote/ntfy.rs](../src-tauri/src/remote/ntfy.rs) watches session state changes and sends HTTP POST notifications for events requiring attention (`approval-needed`, `blocked`, `failed`, `complete`). Each notification includes a click action URL linking directly to the session.

## Security Model

- Binds to `127.0.0.1` only; network access relies on Tailscale TLS and authentication.
- Authentication uses a generated bearer token passed via URL fragment and authenticated in WebSocket headers.
