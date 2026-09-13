# Argmax for iPhone

The iPhone app uses native navigation, a native transcript, and a native
composer over the paired Mac's authenticated WebSocket bridge. SwiftUI owns
transcript scrolling, messages, and controls. MermaidKit draws diagrams and
SwaTex draws equations locally without WebKit or JavaScript. Requires iOS 18
or later.

See [the native transcript decision](../../docs/adr/0008-native-iphone-transcript.md)
for the boundary and maintenance tradeoff.

## Data and screens

- `Sources/Bridge/BridgeClient.swift` — one authenticated WebSocket to the
  paired Mac, speaking the protocol in [docs/remote.md](../../docs/remote.md).
- `Sources/Bridge/Models.swift` — Codable mirrors of the TypeScript dashboard
  shapes, tolerant of fields and enum values this app has not heard of.
- `Sources/Chats/DashboardStore.swift` — one snapshot, kept current by
  `dashboard:delta`, grouped into Pinned / Priority / Chats by the same rules
  the desktop sidebar and `mobile.html` apply.
- `Sources/Chats/ChatListView.swift` — the list itself: Pinned / Priority /
  Today / Yesterday / Last 7 Days / Older, custom rows, search, pull to refresh, and the
  quiet connection states. The brief it is drawn to is in
  [the plan](../../docs/plan/hybrid-native-phone.md#design-brief-phase-2-3-5).
- `Sources/Transcript/TranscriptStore.swift` owns transcript history, cursor
  recovery, and composer state. `DashboardStore` forwards invalidations from
  the shared connection.
- `Sources/Transcript/TranscriptProjection.swift` turns normalized events
  into messages, tool groups, plans, questions, approvals, and delegated work.
- `Sources/Transcript/NativeTranscriptList.swift` owns eager SwiftUI rows and
  reading position. `TranscriptMarkdown.swift` renders native prose and code.
- `Sources/Transcript/TranscriptScreen.swift` connects the transcript to the
  existing composer, review routes, and chat actions.

The transcript opens at the bottom. When the remote response budget splits
history into pages, the store accumulates them before publishing the rows so
the screen opens on the latest messages. Live output follows the bottom until
the reader scrolls away.

Tool action labels and file links display paths relative to the chat's
workspace. Labels shorten the path before truncating it so the filename stays
visible. Raw tool inputs and file-opening targets retain their original paths.
Paths outside the workspace keep their full location.

Workspace read timestamps are shared through the host dashboard. Opening a
chat acknowledges its observed activity with `workspaces:mark-viewed`, so a
completed reply read on either device leaves Priority on both. Newer replies
become unread again. Questions, failures, and open pull requests retain their
own Priority rules. This requires a host build with shared read-state support.

## Type

Every piece of text goes through a role in `Sources/Design/Typography.swift`
— `typeOutput()`, `typeChrome()`, `typeMeta()`, `typeChip()`, and the
`typeStyle` / `typeSize` escape hatches. That is the only place a font is
named, because Settings → Typeface can only reach a call site that asks the
`TypeScale` in the environment for its font. `npm run check:ios-fonts` fails
the push on a `.font(...)`, a hand-built `UIFont`, or a fourth type size in
the transcript; a call site with a real exception says so in a
`// type-exception:` comment on the line.

SF Symbols are the standing exception and take `typeSymbol()`: a symbol is
drawn by SF, and sizing it off a face with no glyph for it is meaningless.

Four typefaces ship: SF Pro (and SF Mono for identifiers), SF Rounded, Geist,
and Inter. SF Pro is the default because it is the closest match to the
ChatGPT-style iPhone reference. The ids are the desktop's own where a choice
is shared, from `src/renderer/lib/fonts.ts`, under the desktop's key
(`argmax.font.family`), but the value is per device the way theme and accent
are. A desktop-only choice reads as the default rather than as nothing.

The faces themselves are generated, not vendored: `npm run build:ios-fonts`
converts the `@fontsource` woff2 the renderer already ships into the TrueType
`UIAppFonts` wants, and creates the static Geist and Inter cuts the type scale
uses. Geist's two italic cuts are sheared, while Inter's are taken from its
actual italic font. The `.ttf` files are committed so an Xcode build never
needs Python. Adding a weight means adding it to `Resources/Fonts` *and* to
`UIAppFonts` in `project.yml`; `TypographyTests` fails if a declared face does
not register.

Geist Mono is intentionally not part of the iOS app. Code, paths, and other
identifiers use Apple's SF Mono in every typeface, which keeps the transcript
closer to the native iOS and ChatGPT reference styling.

The transcript runs on three sizes and only three: output at `.body`, all
chrome at `.footnote`, badges at `.caption2` semibold. Output prose has 4pt of
extra line spacing so wrapped agent paragraphs do not form a dense wall, while
thinking previews and tool details stay compact. Hierarchy inside the chrome
tier comes from weight and colour. Two exceptions: mono — a command in its
activity row, the payload under an opened one — sits at `.caption`, because
mono reads larger than sans at the same nominal size; and narration folded
into an activity group drops to `.subheadline` in muted-strong, so what the
agent said on the way does not read as the reply.

An opened activity group is a ledger, the desktop's grammar
(`docs/chat-cards.md`, "Activity Rows"): one 36pt line per step, `icon · verb ·
target`, no fill and no chevron, down a 2pt rail. A command row peeks through
the `/bin/zsh -lc` launcher; a thought row is titled by its reasoning's first
line. Opening a row grows one block — arguments (never for a command), payload,
footer — and nothing else moves. The mockups the shape was chosen from are in
`docs/design/phone-activity-group`.

An edit row is the exception: it carries a navigation chevron and opens that
file's diff directly in the native review screen. Once the provider confirms
the edit, reported additions and deletions sit beside the file name in the
same diff colors as the review screen. File reads and file links continue to
open the current file contents.

Settings → Chat detail controls this iPhone independently of the desktop.
Compact is the default and folds thoughts and tool activity together between
messages. Minimal also folds interim narration once an answer arrives.
Balanced shows short thought previews inline. Detailed shows individual tool
steps with longer thought previews, while raw inputs and outputs stay folded.
Session errors and requests for input remain visible at every level. A failed
tool call is not one of them: the agent reads the error and tries again, so a
recovered turn used to arrive as a screen of red. It folds with the rest of the
work, and its error text is rose under an `Error` label once the row is
expanded — the desktop's rule. A cancelled call is an interruption, not a
failure. The same setting applies to subagent and multitask details.

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

`Sources/Review` is the review surface — Changes, the checkout's tree, one
file's diff, one file's text — over the four reads the desktop panel makes
(`review:list-changed-files`, `review:load-diff`, `workspace:list-files`,
`workspace:read-file`), all of them already on the bridge. Changed files open
in diff tabs, and tree files open in source tabs. The horizontal tab strip
keeps several files within reach while rendering only the selected viewer, and
is the open file's only bar: the tab names it, so the viewer under it drops its
own header and shows code from the first line. The context control rides the
strip's trailing edge. A viewer pushed on its own — from a transcript file link
— keeps the header, since nothing else there says which file it is.
Close a tab with its cross, or use File list to choose another file. Transcript
file links open the file directly. Workspace activity and reconnects refresh
the selected file and changes list, including edits that leave the file count
unchanged. One active `UITextView` on TextKit 2 keeps layout proportional to
what is on screen. `CodeText.swift` has the why. Read-only, three scopes,
no syntax colouring; the reasoning for each is in
[the plan](../../docs/plan/hybrid-native-phone.md#review-notes-from-the-first-device-build-2026-09-10).

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

The glyph that leads a list row's second line is its own pair of files,
because what goes in it is a rule rather than a glyph:

- `Sources/Chats/ChatRowGlyph.swift` — the order it resolves in. A running
  chat shows the working nest, in its own icon colour when it has one; a
  quiet one shows the icon the desktop's picker gave it; failing both, the
  provider's mark, which is the only thing Settings → Appearance's "Provider
  marks" switch hides. A row with nothing to show leaves the slot out; the
  glyph gave up its leading column so an empty one could not indent the
  title (`docs/design/chat-list-glyphs`).
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

## Driving it on a simulator

`simctl` can launch the app but cannot tap through its pairing alert.
Three debug-only launch
arguments exist for that, and for taking the screenshots the design brief asks
for:

```bash
xcrun simctl launch <device> com.argmax.remote \
  -argmax-pair 'https://your-mac.tailnet.ts.net/mobile.html#token=…' \
  -argmax-open-review <workspace id> \
  -argmax-open-diff docs/remote.md      # or -argmax-open-file <path>
```

`-argmax-unpaired` is the fourth: it starts on the pairing screen without
touching the keychain, so first run can be reviewed on a phone that is paired.
All four are `#if DEBUG` and none of them ships.

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
`#af5b00` light and `#e79647` dark — and is the app's global accent. So is
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

From the command line instead, `npm run install:ios` does the whole round —
`xcodegen`, build, install, launch — against the one connected iPhone:

```bash
npm run install:ios
npm run install:ios -- --list                  # connected devices
npm run install:ios -- --device <udid>         # when more than one is attached
npm run install:ios -- --pair '<pairing link>' # launch straight into pairing
npm run install:ios -- --no-launch
```

It takes the team from `--team`, `$ARGMAX_IOS_TEAM`, or an installed
`com.argmax.remote` provisioning profile, and reports whether the app is
actually running plus the bridge's client count, since a physical device
cannot be screenshotted. The build deliberately targets
`generic/platform=iOS` rather than `id=<udid>`: Xcode's destination list and
devicectl's device list disagree often enough that a phone devicectl shows as
connected is rejected as "unable to find a destination matching".

The bare build, if you want it:

```bash
xcodebuild -project Argmax.xcodeproj -scheme Argmax \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<your-team-id> build
```

## Tests

`ArgmaxTests` covers models, projection, native rendering, and hosted scroll
behavior. `ArgmaxUITests` drives real gestures against a deterministic debug
transcript with the production composer and rows. Neither suite needs a paired
Mac or a paid provider session.

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

## Verifying the transcript

A debug build accepts `-argmax-open-session <session id>` alongside
`-argmax-pair <pairing link>` to open a real conversation on a simulator.
Check a long conversation while streaming, scroll upward, open the keyboard,
and return with Jump to latest. Check questions, approval failures, queued
messages, code, tables, diagrams, images, and file links in both appearances
and with larger accessibility text.

`Tests/Transcript*Tests.swift` cover event projection, revision recovery,
card actions, Markdown structure, and native rich rendering.
`NativeTranscriptListTests` hosts the SwiftUI list to check reading position
and following streamed content. Native packages are pinned in `project.yml`
and `Argmax.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
Regenerate the project with `xcodegen` after changing package configuration.

The UI scenarios check streaming, reading older messages while history changes,
Jump to latest, keyboard dismissal, larger text, and full-screen rich content
with zoom controls. Their screenshots are retained as test attachments.
To inspect the same fixture manually in a debug simulator build:

```bash
xcrun simctl launch booted com.argmax.remote -argmax-transcript-scenario
```

The Stream and Prepend buttons update the real transcript store. Rich shows
equations, a diagram, a table, and code. Theme and Size switch the rendering
environment without changing saved preferences. Ask docks a live question in
the composer's slot. Add `-scenario-wide` to test very wide equations and
diagrams, `-scenario-ask` to start on the docked question, or
`-scenario-activity` to inspect semantic activity icons and MCP artwork. These
controls are excluded from release builds.

MermaidKit supports core diagram syntax rather than every Mermaid extension.
SwaTex supports KaTeX-compatible math. The native viewers retain the source
for copying and inspection. Math accessibility currently reads the LaTeX
source rather than navigating MathML. Code and diff views keep TextKit 2 for
continuous text selection and large-file layout. UIKit also supplies the
swipe-back and shake-to-re-pair gesture helpers.

Native tool icons reuse the desktop artwork in `src/renderer/lib/serverIcons.ts`.
Settings → Appearance → Activity icons switches both system symbols and MCP
artwork between their semantic colours and a muted monochrome treatment.
Built-in activity uses the same stable mapping as desktop: purple changes,
blue local discovery, teal web activity, orange execution, gold skills, and
red destructive or failed work. MCP artwork keeps its own brand colours.
After changing that artwork or its native aliases, run `npm run export:ios-tool-icons`
and commit the generated `Assets.xcassets/Integrations` and `Resources/toolIcons.json`.

## Known edges

App Transport Security is at its default, so the app only reaches `https://`
and `wss://`. Pairing requires the Mac's HTTPS Tailscale origin. A tailnet
without HTTPS certificates can still use the browser client over HTTP.

Transcript presentation ships with the phone app. Host renderer rebuilds no
longer change its UI. The phone still requires compatible bridge channels and
normalised event payloads, so unknown event kinds remain visible as notices
where possible and fixture tests pin the supported contracts.

The native phone client journals mutation identities and retries a dropped
response with the same identity. Repeating an unresolved action after relaunch
also retains its identity. Host-interrupted outcomes require inspection before
acknowledgement in Settings → Unconfirmed actions. The host must advertise
operation replay support. See [recovery details](../../docs/ios-performance.md).

## Performance and recovery

Use [iOS performance and recovery](../../docs/ios-performance.md) for the
`ArgmaxPerformance` optimized test scheme, Instruments intervals, local cache
behavior, and dropped-connection verification. Usage and Activity still preload
from the root screen. Native performance tests live in `Tests/NativePerformanceTests.swift`
and `UITests/NativePerformanceUITests.swift`.
