# Argmax for iPhone

Native chrome around an embedded transcript: the list, navigation and sheets
are SwiftUI, and the transcript stays the same React app in a web view,
because that is where the product's complexity lives. See
[docs/plan/hybrid-native-phone.md](../../docs/plan/hybrid-native-phone.md) for
the plan and its design brief.

Phase 2 — the data layer — is what is here now:

- `Sources/Bridge/BridgeClient.swift` — one authenticated WebSocket to the
  paired Mac, speaking the protocol in [docs/remote.md](../../docs/remote.md).
- `Sources/Bridge/Models.swift` — Codable mirrors of the TypeScript dashboard
  shapes, tolerant of fields and enum values this app has not heard of.
- `Sources/Chats/DashboardStore.swift` — one snapshot, kept current by
  `dashboard:delta`, grouped into Pinned / Priority / Chats by the same rules
  the desktop sidebar and `mobile.html` apply.
- `Sources/Chats/ChatListView.swift` — the list itself: Pinned / Priority /
  Chats, custom rows rather than stock cells, search, pull to refresh, and the
  quiet connection states. The brief it is drawn to is in
  [the plan](../../docs/plan/hybrid-native-phone.md#design-brief-phase-2-3-5).
- `Sources/Transcript/` — the embedded transcript. `NativeMessages.swift`
  mirrors the contract in `src/renderer/mobile/nativeHost.ts`;
  `TranscriptWebView.swift` owns the one `WKWebView`, which loads
  `mobile.html?embed=1` once and lives for the app's life;
  `TranscriptScreen.swift` is the pushed screen around it.

Phase 3 — new chat and chat actions — adds:

- `Sources/Bridge/Channels.swift` — typed calls for the channels the phone
  writes on, each input mirroring its generated binding key for key. Whether a
  request carries an `operation` record is decided by
  `src/shared/remoteReadChannels.json`, not by the call site.
- `Sources/Chats/NewChatPlan.swift` — the sheet's choices as a value: which
  `workspaces:create-*` a mode runs, and the launch payload after it.
- `Sources/Chats/NewChatSheet.swift`, `Sources/Chats/ChatRowActions.swift` —
  the sheet and the row's swipe actions and context menu.
- `Sources/Chats/ProviderCatalog.swift` — the model catalogue, decoded from
  `Resources/providerModels.json`.

The Usage page carries the desktop's remaining read:

- `Sources/Insights/PlanLimits.swift`, `Sources/Insights/PlanLimitsSection.swift`
  — "Remaining on your plans" ([docs/usage.md](../../docs/usage.md)) as a
  card under the provider ledger: one block per
  provider login, a meter per window, the window labels ("5-hour", "Weekly",
  "Weekly Fable") as the Mac words them. The store is owned by `RootView`,
  one per pairing, and warmed once the list is up and again on each return to
  the foreground, so the screen opens with numbers rather than the second the
  Mac spends asking five providers. A read inside two minutes is skipped and
  a stale one runs under the rows already on screen; nothing polls, because
  Claude's endpoint is rate-limited. The ledger
  above it on the desktop, spend per provider, is not here: it is a page, and
  it reads no better for being squeezed into a group.

The list row's leading column is its own pair of files, because what goes in
it is a rule rather than a glyph:

- `Sources/Chats/ChatRowGlyph.swift` — the order it resolves in. A running
  chat shows the working nest, in its own icon colour when it has one; a
  quiet one shows the icon the desktop's picker gave it; failing both, the
  provider's mark, which is the only thing Settings → Appearance's "Provider
  marks" switch hides. The column itself always stands.
- `Sources/Design/SessionIcon.swift` — the wire vocabulary that rule reads:
  the desktop's curated Lucide names mapped to SF Symbols, and its nine
  palette *tokens* ("violet", not a hex value) resolved per appearance from
  `tokens.css`. A name with no counterpart here falls through, which is why
  the rule is written as a fall-through.

## The model catalogue

`Resources/providerModels.json` is generated, not written:

```bash
npm run export:provider-models   # from the repository root
```

It resolves `src/shared/providerModels.ts` — labels, ids, per-model effort
ladders, per-provider defaults and title models — into data the app decodes.
Generated because half of that catalogue is a function rather than a table:
Codex's ladder depends on the model id and Grok Build's stops at Extra High,
so a hand-kept Swift copy would drift into offering a rung the CLI rejects.

Re-run it after any change to the catalogue, then `xcodegen`.
`ProviderCatalogTests` fails when the file is missing or stale in a way the
Swift side cannot read, which is the reminder that works.

For measuring viewport behaviour, use [../probe](../probe) instead; it prints
the numbers. This is the app you actually carry.

## Build and install

The project is generated, so start there:

```bash
brew install xcodegen   # once, if you don't have it
npm run build:icons     # only after the fox sprite changes
cd ios/Argmax && xcodegen
open Argmax.xcodeproj
```

The app icon is generated with every other icon artifact: `build:icons` writes
`Sources/Assets.xcassets/AppIcon.appiconset` from the same pixel fox the
desktop icon draws, at full bleed and without an alpha channel, which is what
iOS takes. It is committed, so a plain build needs nothing. The `Accent`
colorset beside it is hand-kept — the desktop orange tint from `tokens.css`,
`#bd580f` light and `#e88845` dark — and is the app's global accent. So is
`Sources/Assets.xcassets/Providers`: the five CLIs' own brand marks, as
template vectors, with the source URL and date for each in the README beside
them. Adding a provider to `providerModels.json` means adding its mark there
in the same change, which `ProviderMarkTests` enforces.

Then in Xcode: select the **Argmax** target → Signing & Capabilities → pick your
team, plug in the phone, and Run.

A **free Apple Account works** — sign into Xcode with your normal Apple ID and
it appears as a Personal Team. The catch is that its provisioning profile
expires **7 days** from issuance, after which the app stops launching until you
rebuild from Xcode. The paid Developer Program ($99/yr) removes that expiry; it
buys nothing else you need here, since this never sees the App Store and
notifications already arrive through ntfy.

From the command line instead:

```bash
xcodebuild -project Argmax.xcodeproj -scheme Argmax \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<your-team-id> build
```

## Tests

`ArgmaxTests` is a hosted unit-test bundle: the models, the delta merge, and
the list grouping, with no socket and no simulator interaction.

```bash
cd ios/Argmax && xcodegen
xcodebuild -project Argmax.xcodeproj -scheme Argmax \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

`Tests/Fixtures/*.json` are trimmed captures of real payloads, which is the
point: hand-written literals would only pin what this app already believes.
Take fresh ones with the desktop app running —

```bash
node scripts/bridge.mjs call dashboard:list '{}'
node scripts/bridge.mjs call projects:list '{}'
node scripts/bridge.mjs call providers:discover '{}'
```

— then keep a handful of chats plus the workspaces and projects they name, and
read the prompts before committing: they are whatever you happened to be
working on.

## Pairing

On first launch the app asks for the pairing link from **Argmax → Settings →
Integrations → Remote access**. Paste it whole: the token rides in the URL
fragment. The link has to be `https://`, which Settings shows once Tailscale
Serve terminates TLS for the bridge (`tailscale serve --bg 8790`, see
[docs/remote.md](../../docs/remote.md)); the app refuses plain `http://` because
App Transport Security would refuse it anyway, only later and less clearly.

The link is a credential, so it lives in the keychain rather than
`UserDefaults`, which would put it in an unencrypted backup.

**Shake the phone** to re-pair against a different Mac or a rotated token.

The app also opens `argmax://pair?url=<pairing link>` (the link percent-encoded
as a query value), which pairs without touching the phone. From the Mac, with
the phone plugged in or on the same network:

```bash
xcrun devicectl device process launch --device <udid> \
  --payload-url 'argmax://pair?url=https%3A%2F%2Fyour-mac.tailnet.ts.net%2Fmobile.html%23token%3D...' \
  com.argmax.remote
```

That is how a phone moves between Macs, or from the old `http://…:8790` origin
to the TLS one, without re-typing the token.

## Known edges

App Transport Security is at its default, so the app only reaches `https://`
and `wss://`. That is deliberate: the transcript's page is only a secure
context there, and the service worker, `crypto.randomUUID`, and the clipboard
all depend on it. A tailnet without HTTPS certificates enabled cannot run this
app — the browser at `http://…:8790` still works for that case. `PairingLink`
derives `ws://` from an `http://` link anyway, so a debug build pointed at
loopback reaches the bridge rather than failing obscurely; pairing itself
still refuses the link.

The transcript is only as new as the renderer the Mac is serving. `embed=1`,
`window.argmaxNative` and the `ready` message all arrive with a built
renderer (`npm run build`); against an older bundle the page loads, never
says `ready`, and the screen falls back to "This chat didn’t load" after
twelve seconds rather than spinning forever.

The phone does not replay mutations. The renderer persists an unresolved
operation's identity in session storage and reuses it after a reload, so the
host can recognise the retry (see "Recovering remote actions" in
[docs/remote.md](../../docs/remote.md)); this client mints a fresh
`operationId` per attempt and retries nothing on its own. So a launch or an
archive whose reply is lost to a dropped socket has an unknown outcome: the
chat list is the place to look, and the sheet says "Can't reach your Mac"
rather than trying again.
