# Browser Panel

A passive in-app browser: web links from chat open in a right-hand panel
instead of the system browser. One native child webview (WKWebView on macOS),
no tabs, no agent driving.

## Architecture

The panel is two halves that only meet through IPC:

- **Renderer chrome** — [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx)
  renders the toolbar (back/forward/reload, address bar, 1Password fill,
  open-external, close) and an empty `.browser-panel-surface` div.
- **Native webview** — [src-tauri/src/ipc/browser.rs](../src-tauri/src/ipc/browser.rs)
  creates a child webview (label `browser`) on the main window via
  `Window::add_child`, which requires the **`unstable`** Tauri cargo feature.
  Treat Tauri minor bumps as a checkpoint for this API.

The child webview is a sibling native view glued onto the surface div: the
renderer measures the div (`ResizeObserver` + window resize) and sends
`browser:set-bounds`. CSS pixels are logical pixels on macOS, so the rect maps
1:1 onto window coordinates.

## Z-order rule

The native webview always paints **above** the renderer DOM. Any overlay that
could overlap it must hide it first. BrowserPanel watches the document for
`[role="dialog"]` (every modal/popover in this codebase uses it) and sends
`visible: false` while one is open. New overlays keep working automatically as
long as they carry `role="dialog"`.

## Channels

Request: `browser:open`, `browser:navigate`, `browser:back`, `browser:forward`,
`browser:reload`, `browser:set-bounds`, `browser:close`,
`browser:fill-credentials`. Push: `browser:state` (`{url, title}` on
navigation/page-load). All are declared remote-unsupported in
[dispatch.rs](../src-tauri/src/remote/dispatch.rs) — they manipulate the
desktop app's native view.

`browser:close` hides the webview instead of destroying it so history and the
logged-in session survive a reopen. Only `http(s)` URLs are accepted;
`on_navigation` also blocks other schemes from inside the page. An
initialization script rewrites `window.open` and `target="_blank"` clicks to
in-place navigation — they are dead ends in a child webview otherwise.

## Link routing

[StreamingMarkdown.tsx](../src/renderer/components/StreamingMarkdown.tsx)
routes plain clicks on `http(s)` links to the panel through the
`openInBrowserPanel` bus in
[browserPanel.ts](../src/renderer/lib/browserPanel.ts); ⌘-click keeps the
system browser. App owns the panel state and adds a third grid column while
it is open.

## 1Password fill

`browser:fill-credentials` shells out to the `op` CLI: list Login items,
match the current page host (dot-boundary match, so `evilgithub.com` never
matches a `github.com` item), fetch username/password with `--reveal` (this
is where 1Password prompts Touch ID), and inject them into the login form via
`eval`. Values flow Rust → child webview only; the renderer never sees them,
and nothing is logged. If the page host changed while 1Password was
unlocking, the fill is refused.

## Known limits

- No browser extensions, no Safari/macOS password autofill (WKWebView
  limitation) — the `op` fill button is the substitute.
- "Sign in with Google" OAuth blocks embedded webviews (`disallowed_useragent`);
  use the open-external button for those flows.
- Downloads are ignored in v1.
- Cookies persist in WKWebView's default data store, so logins survive app
  restarts.
