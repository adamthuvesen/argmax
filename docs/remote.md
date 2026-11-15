# Mobile Remote

Argmax includes a local HTTP + WebSocket bridge for remote control over a private Tailscale network. The server binds only to `127.0.0.1`.

## Setup

Enable in Settings → Integrations → Remote access. Configuration is saved in `remote.json` in the app data directory — see [its shape](#remotejson) below.

To expose the port over Tailscale, with Serve terminating TLS on the tailnet's
own certificate:

```bash
tailscale serve --bg 8790
```

HTTPS and MagicDNS have to be enabled for the tailnet first — with certificates
off, this hangs rather than reporting the problem. Settings detects the TLS
handler and shows the pairing link. The iPhone app
([ios/Argmax](../ios/Argmax)) pairs by scanning the QR code in Settings or by
pasting `https://<machine>.<tailnet>.ts.net/mobile.html#token=<token>`; the
bearer token is passed in the URL fragment. The app reads only the host and the
token, and connects to `/api/ws`. The Mac serves no page at `/mobile.html`: the
path stays in the link because paired phones already hold links of that shape.
The iPhone app accepts only an `https://` link.

### Plain HTTP

A tailnet that cannot issue certificates can still run the bridge with
`tailscale serve --http=8790 --bg 8790`. A release iPhone build refuses an
`http://` pairing link; a debug build pointed at one maps it to `ws://`.

## Architecture

- **Server:** [src-tauri/src/remote](../src-tauri/src/remote) runs an `axum` HTTP server on `127.0.0.1:<port>`. `/api/ws` handles WebSocket connections. Authenticated endpoints `/api/attachments/*` and `/api/workspace-assets/*` serve image attachments and workspace screenshots/assets over HTTP (token-authenticated via `Authorization: Bearer` or `?token=`). `/api/transcript` serves transcript pages too large for the socket. Every other path is a 404: the bridge serves no web client.
- **Protocol:** JSON frames over WebSocket.
  - Handshake: `{"type":"auth","token":"..."}` within 5 seconds. A client that adds `"compression":"deflate"` gets `"compression":"deflate"` back in `auth-ok`, and from then on every frame of 16 KiB or more arrives as a binary message: a zero byte, then the JSON as raw DEFLATE. Dashboard and transcript JSON shrink four- to sixfold. The iPhone app asks; an older host ignores the field. Transcript pages too large for the socket already travel over HTTP, where `CompressionLayer` gzips them.
  - RPC: `{"type":"request","id", "channel", "input", "operation":{"clientId","operationId"}}` → `{"type":"response","id","ok"|"error"}`. Mutations require UUID operation fields. The host advertises `operationReplay: true` at authentication and marks durably recorded responses `operationSettled: true`. It also advertises `dashboardChanges: true`: the remote-only read `dashboard:changes` takes `{ baseDigest? }` and answers `{ digest, snapshot }` in full, or, when it still holds the snapshot named by `baseDigest`, `{ digest, base, collections, replace, remove }` — per id-keyed array the changed rows (`upsert`), the departed ids (`remove`) and the whole id order when it changed (`order`), plus every other top-level value that changed and the top-level keys that are gone ([dashboard_changes.rs](../src-tauri/src/remote/dashboard_changes.rs)). The iPhone app reads the dashboard this way when the capability is present and `dashboard:list` otherwise. Each connection may run up to 16 requests at once. Further requests receive `REMOTE_REQUEST_LIMIT` until one finishes.
  - Push events: `{"type":"event","channel","payload"}` for `dashboard:delta`, `terminal:data`, and `terminal:exit`. Terminal events ride their own 64-slot broadcast so a flood of PTY output cannot evict a queued delta; a client that falls behind on that stream silently loses the window, while falling behind on `dashboard:delta` costs it a `resync` frame. A client whose auth frame carries `"terminalOutput":false` never subscribes to the terminal stream; the iPhone app sends it because it shows no terminal, and leaving the field out (`scripts/bridge.mjs terminal`) keeps the push.
  - Heartbeat: `{"type":"ping"}` / `{"type":"pong"}` every 20s. Resync signals (`{"type":"resync"}`) indicate dropped connection recovery; the client reloads its snapshot and the open session's events.
- **Dispatcher:** [src-tauri/src/remote/dispatch.rs](../src-tauri/src/remote/dispatch.rs) maps incoming requests to existing IPC handlers. Desktop-only channels return `REMOTE_UNSUPPORTED`. A handler qualifies by taking `&AppState` alone, which is why the profile directory is resolved once during setup into `AppState::app_data_dir`: the phone registers its own APNs device token over the bridge (`remote:register-push-device`, `remote:unregister-push-device`, `remote:push-test`, and the read `remote:push-capability`), while the pairing token and the APNs key path stay behind `remote:get-status` and the config writes, which do not. Transcript pages are slimmed before they leave the Mac ([transcript_trim.rs](../src-tauri/src/remote/transcript_trim.rs)): the normalizer's `raw` object copy of each provider line, Codex's `aggregated_output`, and base64 image blocks inside tool results are dropped, and answer deltas already superseded by a `message.completed` on the same page are pruned with the renderer's own turn-boundary rule ([turnBoundaries.ts](../src/renderer/lib/turnBoundaries.ts)). Nothing the chat draws is in any of that — measured 2026-09-11 over the 25 most recent chats, the backfill went from 48 MB to 15 MB and the largest chat from 11 MB to 3 MB. The desktop reads the same rows in-process untrimmed, so the Debug panel's event payloads differ between the two surfaces by exactly those fields.
- **Snoozed chats:** `WorkspaceSummary.snoozedUntil` reaches the phone with every row. The iPhone app decodes it and does not shelve rows yet, so a chat snoozed on the Mac still shows in the phone's list. `workspaces:set-snoozed-until` is a `control` channel, so a paired client may write it.
- **Removed git channels:** the Mac no longer serves `git:view-or-create-pr`, `git:commit`, `git:push`, `git:create-branch`, or `review:commit-staged`. An iPhone build from before the removal still sends `git:view-or-create-pr` from its PR pill, and that action now fails against a newer Mac. The rest of the old build keeps working. Reinstall the phone app with `npm run install:ios` to get the current PR pill.
- **iPhone app:** [ios/Argmax](../ios/Argmax) owns native navigation, transcript, composer, review, and notifications. `TranscriptStore` reads `session:events-since` and drains mutation pages through the same `BridgeClient` used by `DashboardStore`. The dashboard is the sole consumer of bridge streams and forwards transcript invalidations, reconnects, and metadata. `TranscriptProjection` folds normalized events into native message and action models. Native cards send questions, plans, approvals, and multitask actions through existing bridge channels. An edit activity row opens that file's diff in the native review screen and shows confirmed addition and deletion counts beside the file name, while file references and reads continue to open the file itself. The iOS 18+ app uses SwiftUI transcript scrolling, MermaidKit for diagrams, and SwaTex for equations. Rich content renders locally without WebKit or JavaScript. Code and diff viewing retains native TextKit 2. See [ADR 0008](adr/0008-native-iphone-transcript.md) and the [iPhone README](../ios/Argmax/README.md).
- **Attachments and screenshots:** The remote bridge stores path-less images on the host through `attachments:save-image`; the iPhone app's composers use that channel for the photo picker and send the stored paths with the launch or follow-up. Images in the transcript load from the authenticated `/api/attachments/*` and `/api/workspace-assets/*` HTTP endpoints with the remote token.

## Transcript reply sizes

Transcript WebSocket replies have a 768 KiB limit, measured after JSON
serialization across the complete response, including raw output and the
envelope. The native client's 4 MiB receive limit is a separate ceiling.
Row pages continue through row cursors. Timeline events fill a row page's
budget first and raw outputs take what is left, so a page of large outputs is
cut like a page of large events. A cut page rewinds `rawOutputCursor` to just
below the first output it did not send, and a page with no events left carries
only raw outputs until the last one hands over `changeCursor`. Mutation pages consume a byte-bounded
prefix of the change feed and continue through `changeCursor`, so updates
and deletions cannot disappear when a page fills.

An individual event or raw-output row may exceed the budget. The host then
returns `REMOTE_RESPONSE_TOO_LARGE` in a small WebSocket response. The browser,
native client, and command-line bridge retry the identical read through authenticated
`POST /api/transcript` with `{channel,input}`. This endpoint accepts only
`session:events-since`, `session:agent-events`, `visualization:read`, and
`visualization:export`, uses the same dispatcher and
remote payload trimming, and returns `{ok}` or `{error}`. HTTP carries the
complete page without splitting a logical event or truncating its content.
The client applies only the successful read's cursors. Older clients report
the size error and need updating to recover the page.

## Recovering remote actions

Blocking question cards (Codex, Cursor, OpenCode) submit `questions:resolve` from both the browser
and native iPhone app. The opaque request ID comes from the timeline. Answering
resumes the waiting turn, and dismissing sends an empty answer map. Reconnecting
reloads pending or settled cards from the same timeline. Nonblocking Codex
questions use the existing async card and next-user-message flow.

Browser launch preferences stay local. Only the desktop client saves the host's default agent for scheduled and automatic chats, because `system:set-default-agent` is unavailable over the remote bridge.

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

## Push notifications

There are two sinks, and they can run together. What fires is not either sink's business: [signal.rs](../src-tauri/src/remote/signal.rs) owns the one trigger table — a chat that needs approval, asked a question, is blocked, failed, or finished — and swallows repeats per session on the (state, attention) pair, so a streaming turn does not push per chunk. Each sink keeps its own latch, so enabling one never silences the other. The body is the opening of the agent's most recent visible message, flattened onto one line, falling back to the chat's prompt only when the agent has not said anything yet — on the phone the push is the only place that text shows before you open the chat, while the prompt is something you already know. `Urgent` (the three attention states) becomes ntfy `Priority: high` and APNs `time-sensitive`; `Normal` (failed, complete) becomes `default` and `active`.

Unlike the desktop toast, phone push is not gated on the window being unfocused — the point is that you are away from the Mac.

### ntfy

Configured via the ntfy topic field in Settings → Remote access.
[ntfy.rs](../src-tauri/src/remote/ntfy.rs) POSTs each signal to the topic URL with the title, body, priority, and tags as HTTP headers, plus a `Click` header deep-linking `<mobile page>?session=<id>`. The Mac no longer serves that page, so the link opens nothing. Header values must be ASCII — `reqwest` rejects anything else, which is why the titles carry no em dashes. A bare topic name expands to `ntfy.sh`, so pick something unguessable: an ntfy topic is public to anyone who knows its name.

### Push notifications (APNs)

For the native Argmax phone app, [apns.rs](../src-tauri/src/remote/apns.rs) sends to Apple directly — no relay, and no third party in the path. It needs an APNs auth key:

1. Apple Developer → **Certificates, Identifiers & Profiles** → **Keys** → **+**.
2. Name the key, tick **Apple Push Notifications service (APNs)**, then **Continue** → **Register**.
3. **Download** the `AuthKey_<KEYID>.p8`. Apple allows the download exactly once — keep the file somewhere durable, `chmod 600`.
4. Note the **Key ID** shown on that page (10 characters) and the **Team ID** from the account's Membership page (also 10).
5. In Settings → Remote access → **Push notifications**, fill in the full path to the `.p8`, the Key ID, and the Team ID. Turn **Apple sandbox** on only while running a debug build of the phone app: a device token is minted for one environment and rejected by the other.
6. Open the app on the phone. It registers its device token over the bridge and appears under **Paired phones**; **Send test push** then goes to every listed phone and reports each answer on its own row.

Only the phone knows its own APNs device token and Apple may rotate it, so the app calls `remote:register-push-device` itself on every launch — an existing token is a rename plus a fresher timestamp, never a second row — and reads `remote:push-capability` first to learn whether this host holds a key at all, since asking iOS for notification permission and then never sending anything is worse than not asking.

The two halves of the phone ship separately: the app updates when it is installed on the phone, the page when the Mac's renderer is rebuilt and the desktop app reinstalled. So a native→web call goes out as `window.argmaxNative?.<name>?.(…)` — optional on the method too, so a page that predates the call leaves it undone instead of throwing — and every field the page adds to a message decodes with a default on the Swift side (`canSteer`). A required field would mean a page one build behind fails to decode `composer` at all. When a phone-side change depends on a renderer change, the desktop app has to be rebuilt before the phone can show it.

One trap on the phone side: `PushDelegate` is `@MainActor` as a whole. UIKit bridges its `async` `UNUserNotificationCenterDelegate` methods back to their Objective-C completion handlers and does UIKit work — a state-restoration snapshot — inside that completion, so a delegate isolated to nothing resumes on the cooperative pool and trips UIKit's main-thread assertion: tapping a notification opened the app and aborted it straight back to the home screen (`SIGABRT` in `-[UIApplication _performBlockAfterCATransactionCommitSynchronizes:]`, fixed 2026-09-11). Device crash reports for this are `xcrun devicectl device copy from --domain-type systemCrashLogs`.

The wire details, for anyone touching this: token-based auth with an ES256 JWT (`{"alg":"ES256","kid":<key id>}` / `{"iss":<team id>,"iat":<now>}`) signed by the `.p8`, cached and re-signed every 50 minutes — Apple rejects a token over an hour old and also rejects re-signing more often than every 20. `POST https://api.push.apple.com/3/device/<token>` (`api.development.push.apple.com` in sandbox) over HTTP/2, `apns-topic: com.argmax.remote`, `apns-push-type: alert`, `apns-priority: 10` or `5`. The payload is `{"aps":{"alert":{"title","body"},"sound":"default","thread-id":<session id>,"interruption-level":…},"sessionId":<session id>}`; `thread-id` stacks a chat's pushes together on the lock screen and `sessionId` is what the app reads to deep-link the tap. A 410 (`Unregistered`) or 400 `BadDeviceToken` is permanent, so that device is dropped from `remote.json` and logged at info rather than retried.

Apple requires HTTP/2, which the `reqwest` client provides through its `http2` feature. The ntfy sink uses the same crate.

### `remote.json`

```jsonc
{
  "enabled": false,
  "port": 8790,
  "token": "<32 hex>",
  "ntfy_topic": "https://ntfy.sh/…",   // optional
  "mobile_url": "https://…/mobile.html", // optional, re-derived on every save
  "apns": {                              // optional; absent means disabled
    "key_path": "/Users/you/Keys/AuthKey_ABC1234567.p8",
    "key_id": "ABC1234567",
    "team_id": "TEAM123456",
    "sandbox": false,
    "devices": [{ "token": "<hex>", "name": "Adam's iPhone", "registered_at": "<RFC 3339>" }]
  }
}
```

Every `apns` field is optional and the block is omitted entirely until it is used. A half-filled block reads as disabled rather than as a request to send with what is there.

## Security Model

- Binds to `127.0.0.1` only; network access relies on Tailscale TLS and authentication.
- Authentication uses a generated bearer token passed via URL fragment and authenticated in WebSocket headers and HTTP asset endpoints (`Authorization: Bearer` or `?token=`).
- Push has two very different trust models. ntfy routes every notification title and answer excerpt through a public relay, addressed only by a topic name anyone who learns it can subscribe to. APNs routes them from this Mac to Apple and nowhere else. The APNs auth key never leaves the machine — `remote.json` stores the path to the `.p8`, not its contents — but that key can send pushes to every install of the app under the team, so treat the file as a credential and keep it `0600`.
- `remote.json` itself holds the bridge's bearer token and every paired device token. It inherits the app data directory's permissions; nothing here narrows them further.

## Native iPhone recovery

The native client retains submitted mutation identities through reconnect and
uses the host's existing durable replay protocol. Saved dashboard and
transcript content can open while the Mac is unavailable. Usage and Activity
remain preloaded. See [iOS performance and recovery](ios-performance.md) for
cache limits, pending-action handling, and the device verification matrix.
