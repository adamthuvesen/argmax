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
handler and shows the `https://<machine>.<tailnet>.ts.net/mobile.html` links.
Pairing is completed by scanning the QR code in Settings or opening
`https://<machine>.<tailnet>.ts.net/mobile.html#token=<token>`; the bearer token
is passed in the URL fragment. The iPhone app ([ios/Argmax](../ios/Argmax))
accepts only this origin.

### Plain HTTP

A tailnet that cannot issue certificates can still serve the page to a browser:

```bash
tailscale serve --http=8790 --bg 8790
```

That costs more than it looks. The phone runs the renderer as an insecure origin
there: `crypto.randomUUID` and `navigator.clipboard` are missing (see
**Insecure origin** below), and a service worker cannot register at all, so the
app shell never caches. Moving from this origin to `https://` later is a **new
origin**: the home-screen icon has to be removed and re-added (or the iPhone app
re-paired), and the appearance preferences kept in `localStorage`
(`argmax.theme.mode`, `argmax.accent.tint`, `argmax.chat.bubbleTint`) start
again at their defaults.

## Architecture

- **Server:** [src-tauri/src/remote](../src-tauri/src/remote) runs an `axum` HTTP server on `127.0.0.1:<port>`. `/api/ws` handles WebSocket connections. Authenticated endpoints `/api/attachments/*` and `/api/workspace-assets/*` serve image attachments and workspace screenshots/assets over HTTP (token-authenticated via `Authorization: Bearer` or `?token=`). Other routes serve frontend assets. Tauri's asset resolver answers a miss with the app shell rather than reporting one, so [server.rs](../src-tauri/src/remote/server.rs) treats HTML under a non-HTML path as a 404 — otherwise a hashed chunk the bundle no longer has goes out as `text/html` and gets cached under that URL for a year.
- **Protocol:** JSON frames over WebSocket.
  - Handshake: `{"type":"auth","token":"..."}` within 5 seconds.
  - RPC: `{"type":"request","id", "channel", "input", "operation":{"clientId","operationId"}}` → `{"type":"response","id","ok"|"error"}`. Mutations require UUID operation fields. The host advertises `operationReplay: true` at authentication and marks durably recorded responses `operationSettled: true`. Each connection may run up to 16 requests at once. Further requests receive `REMOTE_REQUEST_LIMIT` until one finishes.
  - Push events: `{"type":"event","channel","payload"}` for `dashboard:delta`, `terminal:data`, and `terminal:exit`. Terminal events ride their own 64-slot broadcast so a flood of PTY output cannot evict a queued delta; a client that falls behind on that stream silently loses the window, while falling behind on `dashboard:delta` costs it a `resync` frame.
  - Heartbeat: `{"type":"ping"}` / `{"type":"pong"}` every 20s. Resync signals (`{"type":"resync"}`) indicate dropped connection recovery; the client reloads its snapshot and the open session's events.
- **Dispatcher:** [src-tauri/src/remote/dispatch.rs](../src-tauri/src/remote/dispatch.rs) maps incoming requests to existing IPC handlers. Desktop-only channels return `REMOTE_UNSUPPORTED`. A handler qualifies by taking `&AppState` alone, which is why the profile directory is resolved once during setup into `AppState::app_data_dir`: the phone registers its own APNs device token over the bridge (`remote:register-push-device`, `remote:unregister-push-device`, `remote:push-test`, and the read `remote:push-capability`), while the pairing token and the APNs key path stay behind `remote:get-status` and the config writes, which do not.
- **Renderer Transport:** [wsTransport.ts](../src/renderer/lib/wsTransport.ts) implements `invoke` and `subscribe` over WebSocket when `argmax.remote` is set.
- **Mobile UI:** [mobile.html](../mobile.html) and [src/renderer/mobile](../src/renderer/mobile) provide a touch-optimized view for session management, reviews, and launcher flows. The list shows every non-archived workspace that has a session, side chats included — a side chat's row carries the hidden "Side chats" project as its label and stays out of Priority, the same rule the desktop sidebar applies. A multitask has no list row (`hiddenMultitaskWorkspaceIds`); a running one still lights the launching chat's nest through `workingWorkspaceIds`, even after that chat's own turn has ended. The New session screen's workspace picker offers the two repo modes, branching from existing worktrees, plus **Side chat**, which creates a scratch workspace through `workspaces:create-scratch` instead of a checkout; with no project registered it is the only mode, so a phone that has never had a repo added can still start one. Tapping New chat from an active session's header or choosing "New chat here" in the chat actions sheet pre-selects the project, selects "New worktree", and branches from that worktree (`baseRef`). Starting a chat lands on its transcript directly: the launch response carries the new workspace and session, which are seeded into the snapshot and opened in the same update, so the list never appears between the two screens while a dashboard refresh catches up behind them. The native app does the same with the same rows — `DashboardStore.ingest(delta:)` then a swap of the top of the navigation stack — rather than popping to the list and waiting for the host's delta to name the row. A side chat gets no Changes/Files button — its worktree is an app-owned scratch directory with one empty commit — though a file reference tapped in the transcript still opens the review screen. Subagent and multitask rows raise a peek over the transcript ([AgentOverlay.tsx](../src/renderer/mobile/AgentOverlay.tsx)) as a bottom sheet: it rises from the screen's bottom edge and covers the parent's composer and its multitask lane, which come back when it closes, so nothing about the parent chat is answerable while its delegated work is on screen; there is no review dock, so a multitask's changed-file rows and its Review button open the review screen instead (`onOpenChanges` on [SessionPane.tsx](../src/renderer/components/SessionPane.tsx)) — the same screen a file reference tapped in the transcript opens, on the checkout the multitask shares. "Open as full chat" on a multitask closes that peek and switches the session. Stop and Dismiss on a multitask row stand open at a thumb's hit area here rather than waiting for the hover that reveals them on the desktop. The Remote menu (the header's ⋯) holds New chat plus appearance: Light/Dark, the same seven accent tints as desktop Settings → Appearance, and whether user message bubbles fill with the accent or a quiet gray. Those three persist in the phone's `localStorage` under the desktop keys (`argmax.theme.mode`, `argmax.accent.tint`, `argmax.chat.bubbleTint`) and are not synced from the host. Sending mid-turn queues exactly as on desktop — the queued follow-ups stack above the composer with the same Send now / Multitask / Edit / Cancel actions, grown to thumb-sized hit areas — and the running composer carries its own queue button beside Stop, since the desktop's Enter is not a key a thumb has (see [chat-cards.md](chat-cards.md)). In the native iPhone app this is `TranscriptComposer.swift` instead of the page's own: the same Stop-while-running and queue-beside-Stop shape, the desktop lane's five actions per queued follow-up as glyphs rather than words — Steer, Send now, Multitask, Edit, Cancel — since a phone row cannot spell them out and still show the follow-up they act on. Steer appears only when the page says the row can take it: that rule reads the session and the row together ([queuedSteer.ts](../src/renderer/lib/queuedSteer.ts)), so it rides on the `composer` message rather than being re-derived in Swift. Multitask goes through `session:multitask` with the queued row named, so the row is claimed in the same operation and the running turn is left alone, and the chat it starts is auto-titled by the same cheap model the launcher uses, and and the model and effort inside one chip — two tap targets in one pill, no chevrons and no provider mark, which stays in the picker where the choice is made — opening the same `PickerSheet` and `EffortDial` New chat uses. The composer floor reads left to right as plus, that chip, then the mic and send/stop on the right: adding to the prompt on one side, sending it on the other. New chat's card carries the same controls, so starting a chat and continuing one are still the same gesture — its images go to the launcher's own store key (`launch-<project>`) and ride the launch, since there is no session to key them to yet. A plus leads that row and a mic sits beside send. The mic dictates into the field ([Dictation.swift](../ios/Argmax/Sources/Transcript/Dictation.swift)): the phone's own `SFSpeechRecognizer`, pinned to on-device recognition wherever the model is there for it, so a prompt is not audio sent to Apple; where a locale or an older phone has no model it falls back to the service rather than refusing, which is what the Info.plist string says. Partial results fold into the draft that was in the field when the mic opened, so a half-typed prompt can be finished out loud, and sending or leaving the chat closes the mic. The keyboard's own mic key still works; this one starts from a closed keyboard. The plus opens the photo picker, and each pick is stored on the Mac as it is read (`attachments:save-image`) so the send only names the files, the same pair of `@path` reference and `attachments` entry the desktop composer sends. [PickedImage.swift](../ios/Argmax/Sources/Transcript/PickedImage.swift) is what makes a pick acceptable to that store: PNG, JPEG, GIF and WebP inside the long-edge and byte caps go up untouched, and everything else — HEIC, which is most of an iPhone's library, and any full-resolution photo — is redrawn as a JPEG no longer than 1920px. Forking works the same as on desktop and behind the same provider gate ([providers.md](providers.md)): the turn footer’s fork button stands open on the phone rather than waiting for a hover it will never get, and the chat actions sheet carries **Fork chat** for a fork you want without opening the chat first — both hidden while the chat is mid-turn, since `fork_session` refuses a running or waiting session. The chat list stays mounted (parked, not unmounted) under the session and new-chat screens so returning to it keeps the scroll offset and search filter. The open session is parked the same way under New chat and review, so a back gesture restores the transcript, overlay, and composer instead of remounting them. Navigation history is synchronized with browser history in [useMobileBackNavigation.ts](../src/renderer/mobile/useMobileBackNavigation.ts) — every screen a back gesture can pop counts toward the depth it mirrors, including sheets, the agent overlay, and the review screen's file drill-down, so screens whose open state lives in a child are lifted into `MobileApp`.
- **Embed mode (the native iPhone shell):** `mobile.html?embed=1[&session=<id>]#token=<token>` is what the SwiftUI app loads, once, into a single warm `WKWebView`, and it changes what this page is: no chat list, no New chat screen, no web header, and no history mirroring — the shell owns all of that, and the session screen is the root, parked and transparent until `openSession(id)` or the URL names one. Either way the id is a latch, not a lookup: the shell starts a chat on its own socket and opens it in the same breath, so the id routinely arrives ahead of the delta carrying its row, and the page re-reads the dashboard for it rather than dropping the link on the first miss (one grace period, then it goes back to parked). The two sides speak through [nativeHost.ts](../src/renderer/mobile/nativeHost.ts), which holds the whole contract as types: web → native `ready`, `session`, `composer`, `back`, `review`, `agents`, `haptic` and `error` messages on `window.webkit.messageHandlers.argmax`, native → web `openSession`, `closeSession`, `setTheme`, `setAccent`, `setUserBubble`, `openReview` and `setComposer` on `window.argmaxNative`. `composer` carries the session's provider, model, effort and queued follow-ups so `TranscriptComposer.swift` can draw the same card New chat uses under the web view instead of the page's own; `setComposer(true)` is what tells the page to get its composer stack out of the way once that card is up, and `agents` is the reverse for the peek at delegated work: that sheet is drawn to cover the parent's composer, which here is native chrome it cannot reach over, so the native card stands down for as long as the peek is open and comes back the moment it closes. `ready` waits for the socket's `auth-ok`, and `error` for a drop that outlasts five seconds, since backgrounding the phone kills the socket routinely. Unlike `?session=`, `embed=1` is never scrubbed from the address bar: `importChunk` reloads the page when a chunk hash it holds has gone missing, and that reload has to come back embedded. Theme, accent and the user-bubble tint the shell sets apply for the page's lifetime and leave the phone's own stored preferences alone. The bubble tint is the shell's Settings → Appearance toggle ("Accent bubbles") even though the bubbles are drawn by this page, and it is stored under the web client's own key with the page's own word — `accent` or `neutral` — so the value crosses unchanged. The Swift half mirrors these types; both halves are specified in [docs/plan/hybrid-native-phone.md](plan/hybrid-native-phone.md).
- **iPhone app:** [ios/Argmax](../ios/Argmax) is a SwiftUI app that owns the chrome — pairing, the chat list, navigation, new chat, row actions, settings, notifications — and hosts the transcript in one app-lifetime `WKWebView` in embed mode (above; the decision is [ADR 0007](adr/0007-native-chrome-embedded-transcript.md)). `Sources/Bridge` is an actor `BridgeClient` over `URLSessionWebSocketTask` speaking the protocol above (auth frame, sixteen in flight, ping/pong, `resync`, backoff; an `auth-error` is terminal, not a reconnect loop) plus hand-written Codable mirrors of the TS types, pinned by decoding captured `dashboard:list`, `projects:list` and `providers:discover` payloads in `Tests/Fixtures`; unknown fields and unknown enum strings decode rather than throw, so a host that adds a field never breaks a phone. `Sources/Chats` ports `mergeDashboardDelta` and the list grouping (Pinned · Priority · Chats, hidden multitasks, the side-chats project) with the sort made stable, and holds the New chat sheet and the row actions, whose payloads are pinned to what `NewSessionScreen.tsx` sends; the model catalogue is `Resources/providerModels.json`, exported from `src/shared/providerModels.ts` by `scripts/export-provider-models.mjs` so there is one source. `Sources/Transcript` is the `TranscriptHost`: commands queue until the page posts `ready`, re-seed on every load (the page reloads itself when a chunk hash goes missing), and a 12 s watchdog turns a page that never reports in into a Retry state. `Sources/Design` is the phone's design language — tokens from `tokens.css` for both appearances, our own header instead of the navigation bar, custom rows, chips and capsules, the working nest and the fox mark (`FoxMark.imageset`, generated by `build-icons`) — specified in [docs/plan/hybrid-native-phone.md](plan/hybrid-native-phone.md). Pairing accepts only the TLS origin and also arrives as `argmax://pair?url=…` (`ios/Argmax/README.md`).
- **App shell:** [public/sw.js](../public/sw.js) is a service worker registered by the mobile entry through [registerServiceWorker.ts](../src/renderer/mobile/registerServiceWorker.ts). Without it every cold tap on the home-screen icon waits on the whole bundle arriving from the Mac, and a Mac that is asleep gives Safari's connection error instead of an app; with it the shell paints from cache and the page's own "Reconnecting…" banner carries the news. It takes `mobile.html` and the assets that document loads eagerly at install — not from the fetch handler, because the navigation that registers a worker is not controlled by it, so nothing else would ever pull them in. Hashed assets are served cache-first (a new build is a new URL, so a hit cannot be stale) and the document stale-while-revalidate. Nothing under `/api/` is cached: it is all live and authenticated. The two gates on registration are a secure context and a production build, so **this does not run behind the plain-HTTP spelling** (above), and never in front of the dev server.
- **Insecure origin:** behind the plain-HTTP Serve spelling the phone runs the renderer outside a secure context and the secure-context-only web APIs are simply missing there. `crypto.randomUUID` is `undefined` — use [uuidV4()](../src/renderer/lib/uuid.ts) instead, which an eslint rule enforces across `src/renderer` — and `navigator.clipboard` is unavailable, which is why [useCopyToClipboard.ts](../src/renderer/hooks/useCopyToClipboard.ts) keeps an `execCommand` fallback. `crypto.getRandomValues` is not gated and works on both.
- **Mobile attachments & screenshots:** The New chat composer accepts pasted, dropped, or selected PNG, JPEG, GIF, and WebP images. The remote bridge stores path-less images on the host through `attachments:save-image` and sends their paths with the launch; the native app's chat composer uses that same channel for its photo picker. In the agent view, custom schemes `argmax-attachment://` and `argmax-asset://` resolve through [chatImageSrc.ts](../src/renderer/lib/chatImageSrc.ts) and [remoteProtocol.ts](../src/shared/remoteProtocol.ts) into authenticated `/api/attachments/*` and `/api/workspace-assets/*` HTTP endpoints with the remote token, allowing screenshots, images in tool calls, and attachments to render in mobile browsers identically to desktop.
- **Viewport:** the shell is a fixed frame, and `dvh` measures the layout viewport, which no phone shrinks for the on-screen keyboard. Chrome is handled by `interactive-widget=resizes-content` in the viewport meta; iOS has no equivalent, so [useVisualViewportInsets.ts](../src/renderer/mobile/useVisualViewportInsets.ts) publishes the visual viewport's height, pan offset, and keyboard inset as custom properties that [mobile.css](../src/renderer/styles/mobile.css) sizes the shell, sheets, and toast against. Viewport measurements continue while a native file picker is open. Freezing them preserves the keyboard’s old height and pan offset after it closes, leaving the screen shifted down until the picker returns. Sheets cap themselves to the visual viewport, not `70dvh` of the layout one, so a picker opened from a focused composer cannot paint above the visible frame. That hook also attempts to recover from the older iOS home-screen bug where the first keyboard shrinks `innerHeight`, `visualViewport.height`, and `dvh` by the top inset for the rest of the session — the shell ends ~60px short of the screen and leaves a strip of bare background under the composer, which nothing can cover because iOS clips fixed content to the layout viewport. When the keyboard closes on a viewport shorter than the tallest one seen (by less than a rotation), a display flip on the shell with a synchronous reflow between the two writes requests a new measurement. This recovery depends on observing a taller viewport before the keyboard opens, so it cannot repair the persistent initial-layout gap described below. The New chat screen's hero (fox + greeting) hides itself when the room left for it collapses, through a container query on the screen body rather than a `max-height` media query — a media query would measure the layout viewport, which the keyboard never shrinks. A paired phone keeps a page alive across renderer rebuilds, so every split chunk — the review screen, the delegated-work overlay, the transcript's math and Mermaid renderers — loads through [importChunk.ts](../src/renderer/lib/importChunk.ts), which reloads once when the chunk hash it holds is gone. A rejected lazy load has no local fallback: it reaches the app error boundary and takes the page down mid-transcript, which is why the rule covers every `lazy()` in the renderer and [importChunk.callSites.test.ts](../src/renderer/lib/importChunk.callSites.test.ts) holds it there. A page that reloads itself when a split route is first opened under `npx vite` is Vite's dependency optimizer, not this: the dev server answers a request for a dep it has re-optimized with `504 Outdated Optimize Dep` and its own client reloads. `importChunk` leaves `argmax.chunk.reloaded` in the tab's `sessionStorage`, which survives the reload — check it before blaming this path.

The search dock and both composers reserve only the bottom safe area that
still overlaps the visual viewport. They do not add decorative bottom padding,
and subtract the keyboard inset because WebKit can retain its home-indicator
inset while the keyboard covers it. This spacing rule does not repair a
shortened viewport in the browser itself.

The iOS home-screen status bar uses `default`, not `black-translucent`.
On iOS 26.5, translucent mode places the web view at the screen's top but
subtracts the status-bar height from its drawable area. On the iPhone 17 Pro
simulator this left an extra 62px bottom strip on an 874px screen, before any
keyboard interaction. Increasing the CSS height only clipped the controls.
The default mode positions the web view below the status bar, so its 812px
viewport reaches the physical bottom correctly. The top safe-area inset then
becomes zero, avoiding duplicate header padding.

iOS caches this status-bar mode when adding a home-screen icon. After installing
an Argmax build with this change, remove the old phone icon and add the mobile
page to the home screen again. Use the pairing link or QR code in Settings →
Integrations → Remote access if the new installation needs pairing.

## Recovering remote actions

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

There are two sinks, and they can run together. What fires is not either sink's business: [signal.rs](../src-tauri/src/remote/signal.rs) owns the one trigger table — a chat that needs approval, asked a question, is blocked, failed, or finished — and swallows repeats per session on the (state, attention) pair, so a streaming turn does not push per chunk. Each sink keeps its own latch, so enabling one never silences the other. `Urgent` (the three attention states) becomes ntfy `Priority: high` and APNs `time-sensitive`; `Normal` (failed, complete) becomes `default` and `active`.

Unlike the desktop toast, phone push is not gated on the window being unfocused — the point is that you are away from the Mac.

### ntfy

Configured via the ntfy topic field in Settings → Remote access.
[ntfy.rs](../src-tauri/src/remote/ntfy.rs) POSTs each signal to the topic URL with the title, body, priority, and tags as HTTP headers, plus a `Click` header deep-linking `<mobile page>?session=<id>`. Header values must be ASCII — `ureq` rejects anything else, which is why the titles carry no em dashes. A bare topic name expands to `ntfy.sh`, so pick something unguessable: an ntfy topic is public to anyone who knows its name.

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

Apple requires HTTP/2, which `ureq` (the ntfy client) does not speak, so this path uses the `reqwest` client already in the tree via `tauri-plugin-updater`.

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
- Push has two very different trust models. ntfy routes every notification title and prompt excerpt through a public relay, addressed only by a topic name anyone who learns it can subscribe to. APNs routes them from this Mac to Apple and nowhere else. The APNs auth key never leaves the machine — `remote.json` stores the path to the `.p8`, not its contents — but that key can send pushes to every install of the app under the team, so treat the file as a credential and keep it `0600`.
- `remote.json` itself holds the bridge's bearer token and every paired device token. It inherits the app data directory's permissions; nothing here narrows them further.
