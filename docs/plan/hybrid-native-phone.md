# Plan: hybrid native iPhone app

Status (2026-09-10): phases 1–4 on main and on the phone; three design rounds landed. Remaining: the keyboard pass inside the WKWebView (2b ii), the device bug bash (5b), and cutover docs. Unreproduced: a bridge reconnect popping Settings (seen once during a long host outage; not reproducible via background/foreground). Owner: Adam. This file is the contract the
implementing agents build against; update it when a decision here changes.

## Why

The phone shell wraps the whole web UI, and the chrome — list, navigation,
sheets, header, keyboard arithmetic — is what reads as "not native". The
transcript itself is where the product's complexity lives (streaming markdown,
cards, approvals, review) and renders in the same WebKit either way. So: native
chrome, embedded transcript. See [ADR 0007](../adr/0007-native-chrome-embedded-transcript.md).

## Scope

- SwiftUI app in `ios/Argmax`: pairing, chat list (live), navigation, new chat,
  chat actions, settings, push notifications.
- One warm `WKWebView` hosting `mobile.html?embed=1` for transcript + composer
  (+ review screen and agent overlay, which stay web for now).
- APNs sent by the Rust host directly (token auth, `.p8` on disk). ntfy remains
  an alternate sink.
- Out of scope: widgets, Live Activities, native transcript, Android, changing
  the WS protocol beyond additive channels.

## Phases

1. **Renderer embed mode** — `mobile.html?embed=1` renders only the session
   screen and speaks the native contract below. TS only.
2. **SwiftUI shell** — `BridgeClient`, Codable models pinned by fixture tests,
   `DashboardStore` applying deltas, `ChatListView`, `NavigationStack` →
   `TranscriptScreen` hosting the shared web view, native pairing, `argmax://pair`.
3. **New chat + chat actions native** — project/mode/provider/model/prompt sheet;
   pin, rename, archive, fork from the row.
4. **APNs** — host `push.rs` + `remote:register-push-device` +
   `remote:push-test`; app registration and tap → session.
5. **Feel and cutover** — haptics, restoration, unread, theme follow, docs, ADR.

Cross-cutting, because the current web-only phone is buggy and the point is a
phone that feels finished:

- **2b. Transcript quality inside the container.** Two known defects to
  reproduce and fix in the renderer, verified in the embedded WKWebView on the
  simulator and then the device: (i) tapping a multitask or subagent row
  breaks the view (agent overlay / peek over the transcript); (ii) keyboard
  show/hide leaves the layout wrong (composer offset, dead strip, viewport
  stuck short). The native container owns the safe areas now, so the fix for
  (ii) is decided against the real WKWebView, not Chrome. Runs after Phase 2's
  screens exist; (i) starts earlier in the browser demo.
  Found while fixing (i), still open: `.multitask-row-dismiss` is a 20×20 hit
  target inside a tappable row (thumbs dismiss instead of open); a multitask
  peek's changed-file rows and Review button are inert on the phone
  (`SessionPane` passes `AgentsView` no `onOpenDiff`/`onOpenReview` in overlay
  mode); the light-theme peek has no separation from the page (`--panel`
  `#ffffff` on `#fdfdfd`, 62% scrim); and in the dev-server demo, "Files and
  changes" reloads the page (likely `importChunk`'s reload-once path).
- **5b. Bug bash before cutover.** A checklist pass on the device: open/close
  keyboard ten times across screens, rotate, background/foreground with a turn
  running, lose the Mac and get it back, approval → notification → tap, long
  transcript scroll, review screen, fork. Every finding fixed or filed here.

Follow-ups once the five phases ship (not in this goal, kept so they are not
lost): a Usage page (`usage:summary`), an approvals inbox across chats
(`approvals:pending`), project settings (defaults, check commands), search
across chats (`session:search`), a native review screen.

Success for the whole thing: a week of daily use on the phone without opening
Safari's `mobile.html`; every phase's own check below passes on the device.

## Native ↔ web contract (Phase 1 ↔ Phase 2)

URL the native side loads, once, into its single web view:

```
https://<host>/mobile.html?embed=1[&session=<id>]#token=<token>
```

`embed=1` means: no list screen, no web header, no `history.pushState`
mirroring (native owns the stack), body background transparent so the native
container's colour shows through during load. The composer, transcript, agent
overlay, and review screen render as today.

Web → native, `window.webkit.messageHandlers.argmax.postMessage(msg)`; every
message is an object with a `type` string:

| type | fields | when |
|---|---|---|
| `ready` | — | app mounted and bridge authenticated; native may call in |
| `session` | `sessionId`, `title`, `state`, `attention` | on open and whenever any of these change for the open session |
| `composer` | `sessionId`, `provider`, `modelId`, `modelLabel`, `effort`, `efforts`, `queued: {id, text}[]`, `running` | on open and whenever any of these change, so the native composer card can draw itself without re-deriving the composer's own rules |
| `back` | — | web asked to leave the session (its own back affordance, or Escape) |
| `review` | `open: boolean` | review screen opened/closed, so native can hide its own bar |
| `haptic` | `kind: "light" \| "success" \| "warning"` | send, approve, error |
| `error` | `message` | bridge auth failed / disconnected for >5s |

Native → web, functions on `window.argmaxNative` (installed by the page; native
calls them through `evaluateJavaScript` and must tolerate their absence before
`ready`):

| call | effect |
|---|---|
| `openSession(id)` | switch the transcript in place, no reload |
| `closeSession()` | park the pane (used when the native stack pops) |
| `setTheme("light" \| "dark")` | follow the system, overriding `argmax.theme.mode` |
| `setAccent(tint)` | one of the desktop tints; default `"orange"` |
| `openReview()` | open the web review screen for the open session (the native trailing menu's "Changes") |
| `setComposer(hidden: boolean)` | hide (or restore) the page's own composer stack — field, queued lane, model/effort chips — because the native card under the web view is drawing it instead |

Types live in `src/renderer/mobile/nativeHost.ts` and are mirrored in
`ios/Argmax/Sources/Transcript/NativeMessages.swift`; a change to one is a
change to both.

## Design brief (Phase 2, 3, 5)

The bar is "the best-built indie iOS app you've used". Not stock iOS: a
`Form`, a grouped-inset `List`, a default nav bar with a blue tint, a system
alert with two buttons — each of those is a decision to *not* design, and each
needs a written reason in the code comment if it stays. The phone should look
like Argmax — the desktop app redrawn for a thumb — with the platform's
physics underneath (scroll, swipe, push, sheet detents, haptics are the
system's; the pixels are ours).

### Language

- **Surfaces.** One ground per appearance, from `tokens.css`: dark `#141414`
  (`--bg`), light `#fdfdfd`. Raised surfaces are the ground plus 4% ink, never
  a grey card with a shadow. Hairline separators `--line` (`#2b2b29` dark /
  `#e3e6e8` light), inset to the text column. No borders around cards; edges
  are made by tone and spacing. Sheets use the same ground, not
  `.regularMaterial`, with a 36×5 grabber.
- **Ink.** `#f4f2ec` on dark, `#1f1d18` on light for primary text; secondary
  is the `--muted` warm grey (`#8a857b` blended toward the ink). Never pure
  white or pure black text.
- **Accent.** One: the fox orange, `#e88845` dark / `#bd580f` light
  (`Color("Accent")`). It marks *the running thing* and *the primary action*
  and nothing else. Attention uses its own three: needs-you amber, failed
  red, done sage (`--sage` from tokens) — muted fills at 16% with the full
  colour for glyph and text, not saturated system red/green.
- **Type.** SF Pro throughout via text styles so Dynamic Type works; the
  scale is `.title2` semibold for screen titles (we draw our own header, not
  the system large title), `.body` for row titles, `.subheadline` for
  content, `.footnote` for meta, `.caption2` for chips. SF Mono for branch
  names, ids, model ids. Weights: semibold and regular only.
- **Spacing.** 4pt grid. Screen gutter 20pt. Row 12/16. Section gap 28pt.
  Header height 52pt below the safe area.
- **Corners.** 10pt for chips and buttons, 14pt for sheets and cards, `.continuous`.
- **Motion.** System durations. Allowed custom motion: the fox nest breathing
  while a chat runs (the same 1.2s easeInOut the web uses), a 150ms fade for
  attention chips appearing, the list's rows settling in on first load with a
  40ms stagger, once. Nothing bounces.
- **Glyphs.** SF Symbols, `.medium` weight, hierarchical rendering. Provider
  marks are the repo's own (`docs/design/agent-emblems`), drawn at 16pt.
- **Copy.** Sentence case; CONTEXT.md vocabulary (chat, project, workspace,
  checkout). Empty and error states are one line and one action.
- **The fox.** Appears exactly four places: the app icon, the pairing screen
  (large, idle), beside "Argmax" in the root screen's header (34pt), and as
  the nest glyph on a running chat's row. Not as decoration anywhere else.

### Screens

- **Pairing.** Full-bleed ground, the fox centred in the upper third, title
  "Pair with your Mac" `.title2`, one line of help, a single field styled as
  ours (ground + 4%, 14pt corners, mono placeholder), "Paste link" as a quiet
  secondary button and "Connect" as the one accent-filled primary. Errors
  appear under the field in attention-red text, not an alert.
- **Chats.** Our header: the fox mark then "Argmax" `.title2` semibold, trailing "+" (accent
  glyph, no circle) and a connection dot that is invisible when live. Search is
  a native `.searchable` field but tinted to our ground. Sections Pinned ·
  Priority · Chats as `.footnote` semibold secondary headers with counts.
  Rows: 36pt leading glyph column (fox nest breathing for running; provider
  mark otherwise), title `.body` semibold one line, second line `.footnote`
  secondary "project · branch" (branch mono), trailing relative time
  `.caption2` above an attention chip when one applies ("Needs you" ·
  "Blocked" · "Failed" · "Done"). Pressed = 6% ink highlight, no scale. Swipe
  actions and context menu keep system behaviour with our tints. Empty: fox,
  "No chats yet", "Start one" button. Reconnecting: a 28pt strip under the
  header, ground + 4%, "Reconnecting to your Mac…" with a small spinner —
  never a banner that pushes content.
- **Transcript.** Our header again (back chevron, title one line + a
  `.caption2` line under it: project · state), trailing menu glyph. Below it
  the web view to the bottom safe area, on our ground so the page's
  transparent body shows the same colour. Until ready: a single thin progress
  line under the header, not a spinner in space.
- **New chat.** A `.large` sheet on our ground: title "New chat", the prompt
  editor first and biggest (it is the point), then a compact row of pickers
  as chips that open our own pickers (project · mode · provider/model ·
  effort), branch picker when relevant, "Start chat" accent-filled at the
  bottom above the keyboard. Not a `Form`.
- **Settings.** Reachable from the header (gear on the Chats screen):
  paired Mac (host, "Re-pair"), notifications (status, "Enable", test), and
  appearance (follow system / light / dark, accent tint chips from the
  desktop's seven). Our rows, our toggles tinted accent.

### Review notes from the first device build (2026-09-10)

Adam's calls after using the design-pass build on his phone, binding:

- Row titles were too heavy → `.medium`, done.
- New chat: the four pickers read as four differently shaped cards with
  borders. Make them one control family: a 2×2 grid of equal width and
  height (label `.caption2` muted over value `.subheadline`, provider mark
  inline), ground + 4% fill, 12pt continuous corners, no borders, 8pt gaps,
  the grid the full width of the prompt above it.
- Provider marks in the list must be the real brand marks — Anthropic,
  OpenAI (Codex), Cursor, OpenCode, xAI (Grok) — in their **brand colour**
  — in the colour each owner ships: Claude `#D97757` on both grounds; OpenAI,
  Cursor (`#14120B`/`#F7F7F4`) and xAI monochrome, near-black on light and
  near-white on dark; opencode (no published palette) in the ink — 16pt, from
  official vector assets (done: `Design/ProviderMark.swift`); and Settings → Appearance gets a
  "Provider marks" toggle that hides the glyph column entirely (text moves
  to the gutter).
- The header's "+" becomes the compose glyph (`square.and.pencil`, the
  `SquarePen` the desktop's "New chat here" uses) in the **ink**, same as the
  gear — not the accent — and no circle. (Accent in the list is for the
  running nest and selection only.)
- The transcript's type is one step too small on the phone: embed mode sets
  the renderer's `data-font-size` one step above the default (the desktop's
  Settings → Appearance scale), without touching the phone's stored web
  preference.

- The list row's glyph column, in this order: a **running** chat shows the
  working-nest animation, always — it wins over any icon or mark; the nest is
  tinted with the chat's own icon colour (`WorkspaceSummary.iconColor`, set by
  the desktop's icon picker) when there is one, else the accent. A chat that is
  not running shows its own icon (`icon`, the desktop's curated SF-Symbol-like
  set — map the names to SF Symbols) in `iconColor` when set; else the provider
  brand mark, subject to the "Provider marks" toggle.

- Section titles (Pinned · Priority · Chats) must scroll with the content —
  `List`'s plain-style section headers pin to the top; render them as plain
  rows (or use a `LazyVStack` with no `pinnedViews`) so nothing sticks.

- The agent peek (subagent and multitask, `AgentOverlay.tsx`) is the sheet:
  it rises from the bottom edge and covers the parent's composer and multitask
  lane rather than stopping above them (reverse the current "stops above the
  parent's floor" rule and its `composerInset` measurement); the parent
  composer comes back when the peek closes. Its own header must sit above its
  scrolling body, not over it — today the body's first lines render under the
  "researcher · McCarthy · model" header. Verify in embed mode on the
  simulator with a subagent and a multitask, and update the docs/remote.md
  sentence that describes where the peek stops.

- New chat's model picker mirrors the desktop composer's model menu: one
  list grouped by provider (header = provider mark + name in `.caption2`
  muted, tracking wide), rows = model label left, context window right in
  muted mono (`1M`, `200K`, `272K` — format from `contextWindow`, blank when
  absent), a check on the selected row, unavailable providers dimmed with the
  reason. Effort stays its own picker. The catalogue export must carry
  `contextWindow`.

- Revisited (2026-09-11): the set-aside above. The active chat's composer is
  now native — `TranscriptComposer.swift` draws the same card New chat uses
  (field, model chip opening `PickerSheet`, effort chip opening `EffortDial`,
  round send button) under the web view, which hides its own via
  `setComposer(true)`. What tipped it: the two ways of picking did start to
  grate, and the running-state controls (Stop, the queue button, queued
  follow-ups) read as native chrome everywhere else in the app. The `composer`
  message above is what lets the card draw itself without re-deriving the web
  composer's rules.

### Non-negotiables

Light and dark both designed, not derived. Dynamic Type up to
accessibility sizes without truncation of primary text. Every state reachable
in a `#Preview` with fixture data so the design can be reviewed without a Mac
attached. Screenshots of every screen in both appearances are part of the
deliverable.

## Ownership map (who edits what)

- Renderer (TS): `src/renderer/mobile/**`, `src/renderer/styles/mobile.css`.
- Swift app: `ios/Argmax/**`.
- Host (Rust): `src-tauri/src/remote/**`, `src-tauri/src/ipc/remote.rs`,
  `src-tauri/Cargo.toml`, `src/shared/remoteReadChannels.json`,
  `src-tauri/tests/fixtures/channels.txt`.
- Docs: `docs/remote.md`, `ios/Argmax/README.md`, `docs/adr/0007-*.md`.
