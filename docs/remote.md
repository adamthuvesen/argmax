# Mobile Remote

Argmax can expose a local HTTP + WebSocket bridge so a browser on the same
tailnet — typically a phone — can drive the running desktop instance. There is
no cloud component: the server binds `127.0.0.1` only and Tailscale provides
reachability, identity, and TLS.

## Enabling

Settings → Integrations → Remote access. The toggle starts and stops the
bridge immediately (no restart), the panel shows a pairing QR code, and the
port and ntfy topic are editable there. Config persists to `remote.json` in
the app data directory, created on first boot as
`{ "enabled": false, "port": 8790, "token": "<generated>" }`; hand-editing it
still works and is picked up at the next boot. The token survives every
settings change — rotation would strand the paired phone.

Expose the port on the tailnet from the MacBook (the panel shows this command
with a copy button; use plain `tailscale serve --bg 8790` instead when your
tailnet has HTTPS certificates enabled):

```bash
tailscale serve --http=8790 --bg 8790
```

Scan the QR with the phone camera. It encodes
`http://<machine>.<tailnet>.ts.net:<port>/mobile.html#token=<token>` — the
token rides the URL fragment, which never leaves the browser; the mobile page
stores it and scrubs it from the address bar. Manual fallback: open the URL
and enter the token at the prompt. Use Safari's Add to Home Screen for a
standalone app. The desktop UI is also reachable at `/`. The three `remote:*`
channels backing the panel are desktop-only (`REMOTE_UNSUPPORTED_CHANNELS`):
pairing happens at the machine, never from a remote client.

## Architecture

- **Server** ([src-tauri/src/remote](../src-tauri/src/remote)): axum on
  `127.0.0.1:<port>`, spawned after setup so it never touches the boot path.
  `/api/ws` upgrades to the bridge socket; every other path serves frontend
  assets through Tauri's asset resolver (packaged builds embed them; dev
  builds can point `ARGMAX_REMOTE_ASSETS` at a `vite build` output).
- **Protocol**: JSON text frames. First frame must be
  `{"type":"auth","token"}` within 5s; a wrong token gets
  `{"type":"auth-error"}` before the close so the client clears its stored
  token and re-prompts instead of retrying forever. Then
  `{"type":"request","id","channel","input"}` →
  `{"type":"response","id","ok"|"error"}`, mirroring the Tauri invoke
  contract (errors serialize the same `ArgmaxError` shape). Server pushes
  `{"type":"event","channel","payload"}` for `dashboard:delta`,
  `terminal:data`, and `terminal:exit` to every authenticated client.
  `{"type":"ping"}` → `{"type":"pong"}` is an app-level heartbeat: a phone's
  radio drops the NAT mapping without closing the socket, and the browser
  never surfaces protocol-level pongs to JS.
- **Dispatcher** ([dispatch.rs](../src-tauri/src/remote/dispatch.rs)): a match
  over `ipc::REGISTERED_CHANNELS` calling the same `pub(crate)` `&AppState`
  impl functions the `#[tauri::command]` wrappers delegate to — one body per
  channel, so the two paths cannot drift. Channels that need native chrome or
  the `AppHandle` (folder picker, attachment save, open-path, set-theme,
  diagnostics, the `remote:*` settings channels) return `REMOTE_UNSUPPORTED`;
  a parity test pins that every registered channel is either dispatched or
  explicitly unsupported.
- **Renderer transport** ([wsTransport.ts](../src/renderer/lib/wsTransport.ts)):
  implements the same two primitives the Tauri bridge uses (`invoke`,
  `subscribe`) over one reconnecting WebSocket. `tauriBridge.ts` picks the
  transport at load: Tauri runtime → IPC; `argmax.remote` flag → WebSocket;
  neither → browser-preview demo mode, unchanged. It pings every 20s and
  drops a socket that has not ponged within 8s, and reconnects with no
  backoff on `visibilitychange` → visible or `online` (the wake path for a
  home-screen app). `subscribeRemoteConnection()` publishes
  `connecting | connected | offline`, with a `resync` flag on any auth after
  the first: events pushed while the socket was dead are gone, so the mobile
  UI reloads its snapshot instead of resuming. Runtimes with no remote bridge
  never leave `connected`, so the state is inert on the desktop.
- **Mobile entry** ([mobile.html](../mobile.html),
  [src/renderer/mobile](../src/renderer/mobile)): a second Vite entry that
  renders the triage loop — priority-ordered session list, then the full
  `SessionPane` (conversation, approvals, composer) in a single column — plus
  a minimal new-session screen (project, current-branch/worktree, and model
  pickers as bottom sheets — native selects clip near the bottom edge on
  iOS — seeded like the desktop launcher: the stored global model preference,
  else the factory pick; note the phone's localStorage is its own store),
  an archive button in the session header (same dirty-worktree confirm rules
  as the desktop sidebar), and a
  full-screen Files & changes view (`MobileReviewScreen`) reached from the
  session header — the desktop review panel's Changes/Files split as a
  drill-down, reusing the same data hooks and leaf components with a
  read-only file preview.
  Desktop-only chrome is hidden by `styles/mobile.css`, not ported.

## Push notifications (ntfy)

Set the topic in Settings → Remote access — a bare name like `argmax-adam-x7`
expands to `https://ntfy.sh/<name>`, a full URL (self-hosted ntfy included) is
kept verbatim — and install the ntfy app on the phone subscribed to the same
topic. "Send test notification" round-trips a real POST so a wrong topic
fails loudly. [ntfy.rs](../src-tauri/src/remote/ntfy.rs) watches
the same session deltas the desktop notifier sees and POSTs on transitions a
phone cares about — approval needed, blocked, failed, complete — deduplicated
per session, regardless of window focus (phone push exists for when you are
away). The topic name is the only secret; treat it like one. Notifications
work even with `enabled: false`.

## Security model

Localhost bind + Tailscale Serve means only tailnet peers can reach the
server, over TLS, and the bearer token guards against other local processes.
The token is never logged. Do not bind non-loopback interfaces; do not put
the token in URL paths or query strings — the pairing link carries it only in
the fragment, which browsers never send over the wire.
