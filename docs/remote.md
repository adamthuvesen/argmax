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

- **Server:** [src-tauri/src/remote](../src-tauri/src/remote) runs an `axum` HTTP server on `127.0.0.1:<port>`. `/api/ws` handles WebSocket connections. Authenticated endpoints `/api/attachments/*` and `/api/workspace-assets/*` serve image attachments and workspace screenshots/assets over HTTP (token-authenticated via `Authorization: Bearer` or `?token=`). Other routes serve frontend assets. Tauri's asset resolver answers a miss with the app shell rather than reporting one, so [server.rs](../src-tauri/src/remote/server.rs) treats HTML under a non-HTML path as a 404 — otherwise a hashed chunk the bundle no longer has goes out as `text/html` and gets cached under that URL for a year.
- **Protocol:** JSON frames over WebSocket.
  - Handshake: `{"type":"auth","token":"..."}` within 5 seconds.
  - RPC: `{"type":"request","id", "channel", "input", "operation":{"clientId","operationId"}}` → `{"type":"response","id","ok"|"error"}`. Mutations require UUID operation fields. The host advertises `operationReplay: true` at authentication and marks durably recorded responses `operationSettled: true`. Each connection may run up to 16 requests at once. Further requests receive `REMOTE_REQUEST_LIMIT` until one finishes.
  - Push events: `{"type":"event","channel","payload"}` for `dashboard:delta`, `terminal:data`, and `terminal:exit`. Terminal events ride their own 64-slot broadcast so a flood of PTY output cannot evict a queued delta; a client that falls behind on that stream silently loses the window, while falling behind on `dashboard:delta` costs it a `resync` frame.
  - Heartbeat: `{"type":"ping"}` / `{"type":"pong"}` every 20s. Resync signals (`{"type":"resync"}`) indicate dropped connection recovery; the client reloads its snapshot and the open session's events.
- **Dispatcher:** [src-tauri/src/remote/dispatch.rs](../src-tauri/src/remote/dispatch.rs) maps incoming requests to existing IPC handlers. Desktop-only channels return `REMOTE_UNSUPPORTED`.
- **Renderer Transport:** [wsTransport.ts](../src/renderer/lib/wsTransport.ts) implements `invoke` and `subscribe` over WebSocket when `argmax.remote` is set.
- **Mobile UI:** [mobile.html](../mobile.html) and [src/renderer/mobile](../src/renderer/mobile) provide a touch-optimized view for session management, reviews, and launcher flows. The list shows every non-archived workspace that has a session, side chats included — a side chat's row carries the hidden "Side chats" project as its label and stays out of Priority, the same rule the desktop sidebar applies. The New session screen's workspace picker offers the two repo modes, branching from existing worktrees, plus **Side chat**, which creates a scratch workspace through `workspaces:create-scratch` instead of a checkout; with no project registered it is the only mode, so a phone that has never had a repo added can still start one. Tapping New chat from an active session's header or choosing "New chat here" in the chat actions sheet pre-selects the project, selects "New worktree", and branches from that worktree (`baseRef`). A side chat gets no Changes/Files button — its worktree is an app-owned scratch directory with one empty commit — though a file reference tapped in the transcript still opens the review screen. The Remote menu (the header's ⋯) holds New chat plus appearance: Light/Dark, the same six accent tints as desktop Settings → Appearance, and whether user message bubbles fill with the accent or a quiet gray. Those three persist in the phone's `localStorage` under the desktop keys (`argmax.theme.mode`, `argmax.accent.tint`, `argmax.chat.bubbleTint`) and are not synced from the host. Sending mid-turn queues exactly as on desktop — the queued follow-ups stack above the composer with the same Send now / Multitask / Edit / Cancel actions, grown to thumb-sized hit areas — and the running composer carries its own queue button beside Stop, since the desktop's Enter is not a key a thumb has (see [chat-cards.md](chat-cards.md)). The chat list stays mounted (parked, not unmounted) under the session and new-chat screens so returning to it keeps the scroll offset and search filter. Navigation history is synchronized with browser history in [useMobileBackNavigation.ts](../src/renderer/mobile/useMobileBackNavigation.ts) — every screen a back gesture can pop counts toward the depth it mirrors, including sheets and the review screen's file drill-down, so screens whose open state lives in a child are lifted into `MobileApp`.
- **Mobile attachments & screenshots:** The New chat composer accepts pasted, dropped, or selected PNG, JPEG, GIF, and WebP images. The remote bridge stores path-less images on the host through `attachments:save-image` and sends their paths with the launch. In the agent view, custom schemes `argmax-attachment://` and `argmax-asset://` resolve through [chatImageSrc.ts](../src/renderer/lib/chatImageSrc.ts) and [remoteProtocol.ts](../src/shared/remoteProtocol.ts) into authenticated `/api/attachments/*` and `/api/workspace-assets/*` HTTP endpoints with the remote token, allowing screenshots, images in tool calls, and attachments to render in mobile browsers identically to desktop.
- **Viewport:** the shell is a fixed frame, and `dvh` measures the layout viewport, which no phone shrinks for the on-screen keyboard. Chrome is handled by `interactive-widget=resizes-content` in the viewport meta; iOS has no equivalent, so [useVisualViewportInsets.ts](../src/renderer/mobile/useVisualViewportInsets.ts) publishes the visual viewport's height, pan offset, and keyboard inset as custom properties that [mobile.css](../src/renderer/styles/mobile.css) sizes the shell, sheets, and toast against. That hook also repairs the iOS home-screen bug where the first keyboard shrinks `innerHeight`, `visualViewport.height`, and `dvh` by the top inset for the rest of the session — the shell ends ~60px short of the screen and leaves a strip of bare background under the composer, which nothing can cover because iOS clips fixed content to the layout viewport. When the keyboard closes on a viewport shorter than the tallest one seen (by less than a rotation), a display flip on the shell with a synchronous reflow between the two writes forces iOS to measure again. The New chat screen's hero (fox + greeting) hides itself when the room left for it collapses, through a container query on the screen body rather than a `max-height` media query — a media query would measure the layout viewport, which the keyboard never shrinks. A paired phone keeps a page alive across renderer rebuilds, so the lazily-loaded review screen goes through [importChunk.ts](../src/renderer/lib/importChunk.ts), which reloads once when the chunk hash it holds is gone.

## Recovering remote actions

Before sending a mutation, the browser saves its identity and request in the
tab's session storage, which survives reloads without mixing active actions
between tabs. Distinct active calls get distinct identities, even when their
inputs match. Only an uncertain call or one from a previous page instance
reuses an identity. A connection drop retries that identity for up to 15 seconds.
SQLite admits it once and records either its result or its error. Concurrent
replays wait briefly for the original invocation, then report that it is still
running so the browser can check again. Reusing an identity with different
input is rejected. The read-only channel manifest in
`src/shared/remoteReadChannels.json` is shared by the browser and host. New
channels default to requiring a durable operation.

If reconnection takes too long, the browser reports an unconfirmed outcome and
keeps the operation. Retrying the same request, even after a page reload,
reuses that identity. Once an outcome is confirmed it is removed, so a later
intentional action gets a new identity. If the host stopped after admission
but before recording an outcome, it reports delivery uncertainty and will not
rerun the action. Inspect the chat or checkout before deciding what to do next.
An explicit retry of that interrupted action asks for confirmation before
creating a new identity, because the original may already have taken effect.
There is no exactly-once guarantee across a host crash and an external provider
or Git process. The guarantee is that a replay never starts that operation
again. Operation records are retained to preserve that guarantee.

Older browser pages must reload before issuing mutations to an updated host.
The repository bridge client also supplies operation IDs. It does not
automatically reconnect or retry failed calls.

## Push Notifications (ntfy)

Configured via the ntfy topic field in Settings → Remote access.
[src-tauri/src/remote/ntfy.rs](../src-tauri/src/remote/ntfy.rs) watches session state changes and sends HTTP POST notifications for events requiring attention (`approval-needed`, `blocked`, `failed`, `complete`). Each notification includes a click action URL linking directly to the session.

## Security Model

- Binds to `127.0.0.1` only; network access relies on Tailscale TLS and authentication.
- Authentication uses a generated bearer token passed via URL fragment and authenticated in WebSocket headers and HTTP asset endpoints (`Authorization: Bearer` or `?token=`).
