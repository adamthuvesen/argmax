# Browser Panel

A passive in-app browser in a right-hand panel, with real tabs. Web links
from chat open in the system browser by default; Settings → General → "Web
links from chat" can route them here instead, and ⌘-click always opens the
other target (`src/renderer/lib/linkTarget.ts`). The session actions menu
(⋯ → Open browser) opens the panel directly at the last browsed URL. Each tab
is its own native child webview (WKWebView on macOS) — background tabs stay
hidden but alive, keeping their history, scroll position, and session. No
agent driving.

## Architecture

The panel is two halves that only meet through IPC:

- **Renderer chrome** — [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx)
  renders the toolbar (back/forward/reload, address bar with history
  suggestions, 1Password fill, open-external, close), the tab strip, and an
  empty `.browser-panel-surface` div. Address input that doesn't read as a
  URL becomes a Google search. WKWebView reports only load start/finish —
  never failure or cancellation — so the tab's loading mark is cleared by the stop
  button directly and by a 20s no-event watchdog. Visits persist to localStorage via
  [browserHistory.ts](../src/renderer/lib/browserHistory.ts) and feed the
  address bar's suggestion popover. The tab list lives in a module-level store in
  [browserPanel.ts](../src/renderer/lib/browserPanel.ts) so it survives the
  panel unmounting; tab ids are never reused within an app run.
- **Native webviews** — [src-tauri/src/ipc/browser.rs](../src-tauri/src/ipc/browser.rs)
  creates one child webview per tab (label `browser-<tabId>`) on the main
  window via `Window::add_child`, which requires the **`unstable`** Tauri
  cargo feature. Treat Tauri minor bumps as a checkpoint for this API.

Each child webview is a sibling native view glued onto the surface div: the
renderer measures the div (`ResizeObserver` + window resize) and sends
`browser:set-bounds` for the active tab; inactive tabs sit hidden. CSS pixels
are logical pixels on macOS, so the rect maps 1:1 onto window coordinates.

## Z-order rule

The native webview always paints **above** the renderer DOM. Any overlay that
overlaps it must hide it first. BrowserPanel watches the document for
`[role="dialog"]` (every modal/popover in this codebase uses it) and sends
`visible: false` while one of them *intersects the surface rect*. New overlays
keep working automatically as long as they carry `role="dialog"`.

The intersection test is the point: window-level overlays (command palette,
lightbox, cheat sheet) still blank the page, while pane-scoped ones — the
provider-switch dialog, composer and context popovers — sit in another grid
column and leave the browser live. Hiding on any dialog anywhere made the pane
go black whenever a session raised a confirmation next to it.

## Channels

Request: `browser:open`, `browser:navigate`, `browser:back`, `browser:forward`,
`browser:reload`, `browser:stop`, `browser:set-bounds`, `browser:close`,
`browser:fill-credentials` — every input carries a `tabId`. Push:
`browser:state` (`{tabId, url, title, loading}`, emitted only from the
main-frame page-load callbacks — `on_navigation` also fires for iframe
navigations, whose URLs must not reach the address bar or loading mark),
`browser:new-tab`
(a page requested a popup; the renderer opens a tab), and
`browser:page-command` (a browser shortcut pressed while the page had
focus). All
are declared remote-unsupported in
[dispatch.rs](../src-tauri/src/remote/dispatch.rs) — they manipulate the
desktop app's native views.

`browser:close` destroys that tab's webview (the tab strip's ✕); hiding the
whole pane goes through `browser:set-bounds` with `visible: false`, so
history and logged-in sessions survive a panel reopen. Tabs also persist to
localStorage and are restored after an app restart — their webviews are
recreated lazily at each tab's last URL on first activation. The webviews
present a desktop Safari user agent; the WKWebView default reads as an
embedded webview, which Google flags as unsupported. Only `http(s)` URLs
are accepted;
`on_navigation` also blocks other schemes from inside the page. An
initialization script routes `window.open` and `target="_blank"` clicks
through the `argmax-newtab:` scheme, which `on_navigation` intercepts and
turns into a `browser:new-tab` push — pages open popups as real tabs. A
popup requested by a *background* tab is added without stealing focus.

Shortcuts while the panel is open: ⌘L (focus address bar), ⌘T (new tab),
and ⌘⇧T (reopen last closed tab, session-scoped) work from anywhere — the
app claims none of them; ⌘R (reload) only fires with focus inside the panel
chrome, so it never shadows the app's Reload; ⌃Tab / ⌃⇧Tab cycle tabs.
Inside a page, ⌘-click on any link opens it as a new tab. ⌘W is special: with focus inside a native page,
keys bypass renderer JS entirely and land on the app menu, so the File menu
carries a custom "Close" item (`MenuCommand::CloseSurface`) instead of the
predefined Close Window — the renderer routes it to the active browser tab
when the pane is open, and to the focused session pane otherwise. The init
script additionally intercepts plain ⌘W / ⌘T / ⌘L in the page and relays
them through `argmax-newtab://command?c=…` as `browser:page-command`, for
platforms where the page sees the key before any menu.

## Link routing

[StreamingMarkdown.tsx](../src/renderer/components/StreamingMarkdown.tsx)
routes plain clicks on `http(s)` links to the panel through the
`openInBrowserPanel` bus in
[browserPanel.ts](../src/renderer/lib/browserPanel.ts); ⌘-click keeps the
system browser. App owns the panel state and adds a third grid column while
it is open.

## 1Password fill

`browser:fill-credentials` shells out to the `op` CLI: walk the user's
1Password accounts (personal `my.1password.com` accounts before business
ones, so a site saved in both fills with the personal login), list each
account's Login items until one matches the current page host (dot-boundary
match, so `evilgithub.com` never matches a `github.com` item, and subdomain
crossing is refused on shared-hosting parents like `github.io` /
`vercel.app`), fetch username/password with `--reveal` (this is where
1Password prompts Touch ID), and inject them into the login form via
`eval`. Fills are https-only (loopback excepted, for dev servers), the
script refuses to touch anything when the main frame has no password
field, and the fill is refused if the page origin (scheme, host, or port)
changed while 1Password was unlocking. Values flow Rust → child webview
only; the renderer never sees them, and nothing is logged.

## Known limits

- No browser extensions, no Safari/macOS password autofill (WKWebView
  limitation) — the `op` fill button is the substitute.
- "Sign in with Google" OAuth blocks embedded webviews (`disallowed_useragent`);
  use the open-external button for those flows.
- Downloads are ignored in v1.
- Cookies persist in WKWebView's default data store, so logins survive app
  restarts.
