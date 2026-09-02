# Browser Panel

Argmax browses inside the review panel: Browser is one of its modes, beside Changes, Files, Agents, and [Terminal](terminal.md). Links from chat open in the system browser by default; Settings → General → "Web links from chat" can route them to the in-app browser (⌘-click toggles the alternate target). The session actions menu has an "Open browser" item, and the panel's own tab strip has a Browser tab, shown only where the desktop bridge provides `window.argmax.browser` — the mobile remote has none, so the tab is hidden there.

## One Surface, One Owner

There is a single native browser surface, so exactly one review panel shows it at a time. The owner is whichever panel most recently *entered* Browser mode, not the focused one: clicking into another pane's chat leaves the page where it is, while that pane switching to Browser takes it over deliberately. A panel that has been demoted stays in Browser mode and shows a "The browser moved to another pane" placeholder whose "Show here" button claims the surface back.

Focus still routes new open requests: a chat link or the menu item opens Browser mode in the focused pane, or in the launcher when it is the only surface on screen. Ownership lives in [browserPanel.ts](../src/renderer/lib/browserPanel.ts) (`claimBrowserSurface` / `releaseBrowserSurface`), and [useReviewState.ts](../src/renderer/hooks/useReviewState.ts) claims on entering Browser mode and releases on leaving it, closing the panel, or unmounting the pane. Moving the browser between panes is therefore a plain unmount/mount: the unmount hides the webview, the mount re-glues it to the new panel's surface.

## Architecture

- **Renderer UI:** [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) fills the review panel's body with navigation controls, address bar with search fallback, 1Password autofill button, and tab strip. The strip in [browserPanel.ts](../src/renderer/lib/browserPanel.ts) *mirrors* the app's registry (below) rather than owning it; its `localStorage` copy only remembers URLs across a restart. Browsing history persists separately via [browserHistory.ts](../src/renderer/lib/browserHistory.ts).
- **Native WebViews:** [src-tauri/src/ipc/browser.rs](../src-tauri/src/ipc/browser.rs) creates one child webview per tab (`browser-<tabId>`) on the main window using Tauri's `Window::add_child` API (`unstable` cargo feature).
- **Positioning:** The renderer measures `.browser-panel-surface` and calls `browser:set-bounds` for the active tab. Inactive tabs are hidden. The review panel's own resizer and side preference need no browser-specific handling — a ResizeObserver on the surface re-glues the webview whenever the panel's width changes.

## Z-Order and Overlays

Native child webviews render on top of DOM elements. [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) checks for open `[role="dialog"]` modals intersecting the surface bounds and sets `visible: false` while an overlay covers the panel area.

## The Tab Registry

[registry.rs](../src-tauri/src/browser/registry.rs) holds `{ tabId, ownerSessionId, url, title, loading }` for every live child webview, in `AppState`. It is the source of truth, because an agent can open a tab with no pane on screen to ask. Every change pushes the whole list as `browser:tabs`, and `applyBrowserTabs` in the renderer folds it into the strip: tabs the app reports are added (and marked live in this run, since their webview already exists), and a tab the registry has reported before and then stops reporting has been closed. A tab the registry has *never* reported is left alone — that is either a URL restored from a previous run or a local tab whose `browser:open` is still in flight.

`ownerSessionId` is set for tabs a session opened and null for the user's own. An owned tab shows an "agent" badge in the strip, and `browser:agent-open` (`{ sessionId, tabId, url }`) asks the pane showing that session to enter Browser mode on it — the same addressed-request shape the terminal's ⌘J uses, because the pane may not be mounted. Nobody answering is a valid outcome: the tab is still in the strip.

## Agent Automation

[automation.rs](../src-tauri/src/browser/automation.rs) is the Rust API an agent's tools call — `open`, `navigate`, `back`, `reload`, `close`, `tabs`, `snapshot`, `find`, `get_text`, `act` (click / type / select / hover / press-key / scroll / wait-for), and `screenshot`. Each takes `&AppHandle` explicitly, because the callers do not all come through Tauri's invoke pipeline: the MCP server answers on a Unix socket and holds a handle of its own.

A target is a tab id or a session; a session with no tab named gets the one it touched most recently, the way a person's foreground tab works. A tab a session opens is created at the window's own size and then hidden — laying it out at 1×1 would collapse the page and every snapshot after that would see a document with no visible boxes.

Two scripts do the work inside the page, embedded with `include_str!`:

- [snapshot.js](../src-tauri/src/browser/snapshot.js) walks the visible DOM and emits a Playwright-shaped aria tree — `- button "Sign in" [ref=e12]`, `- textbox "Search" [ref=e3] value="…"`, `- link "More information" [ref=e7] href=…` — under a `url:` / `title:` header, capped at 800 nodes and 40 KB with a trailing `- (truncated)`. `interactiveOnly` drops prose. It also serves `find(query)` (up to 20 refs matching role/name/value/text) and `getText(maxChars)` (`main`/`article` first, `body` as fallback).
- [actions.js](../src-tauri/src/browser/actions.js) is the write side, addressed by those refs. `type` goes through the prototype's native value setter so React and Vue see the change; `waitFor` is start-and-poll (`evaluateJavaScript:` never awaits a promise), arming a MutationObserver in the page while Rust polls the record.

Refs live in the DOM as `data-argmax-ref`, so a re-snapshot reuses the attribute a node already carries and a ref stays valid for as long as its element does. A ref that no longer resolves fails with a message saying a fresh snapshot is needed. Both scripts are re-sent with every call, guarded by `window.__argmax.v` — the install costs one property read on a warm page and re-arms itself automatically after a navigation.

## IPC Channels

- **Request (panel):** `browser:open`, `browser:navigate`, `browser:back`, `browser:forward`, `browser:reload`, `browser:stop`, `browser:set-bounds`, `browser:close`, `browser:fill-credentials`, `browser:evaluate`.
- **Request (agent):** `browser:list-tabs`, `browser:open-for-session`, `browser:snapshot`, `browser:find`, `browser:get-text`, `browser:act`, and `browser:screenshot` (which also takes a `ref` to crop to one element). These take `{ tabId?, sessionId? }`.
- **Push:** `browser:state` (`{ tabId, url, title, loading }`), `browser:tabs` (the whole registry), `browser:agent-open` (`{ sessionId, tabId, url }`), `browser:new-tab` (popups routed via `argmax-newtab:` scheme), and `browser:page-command` (key shortcuts and mouse thumb-button history clicks passed from webview).

All of them are in `REMOTE_UNSUPPORTED_CHANNELS`: they manipulate the desktop app's native child webviews.

Closing a tab (`browser:close`) disposes the webview. Leaving Browser mode sets `visible: false` to preserve page session state and scroll position.

## Capture and Evaluation

Two channels drive a tab programmatically instead of from the toolbar. Both live in [src-tauri/src/browser](../src-tauri/src/browser):

- `browser:screenshot` (`{ tabId, rect? }` → `{ pngBase64, width, height }`) reaches the child `WKWebView` through `Webview::with_webview` and calls `takeSnapshotWithConfiguration:completionHandler:` — wry has no capture API of its own. `rect` crops in the page's CSS pixels; the returned size is device pixels, so twice that on a retina display. WebKit rasterises rather than reading the screen back, so a hidden tab still captures its page.
- `browser:evaluate` (`{ tabId, script, timeoutMs? }` → `{ resultJson }`) returns WebKit's JSON encoding of the script's value. wry's completion block drops WebKit's `NSError`, so a script that throws is indistinguishable from one returning `undefined` — both arrive as an empty string. `eval::wrap_for_errors` catches inside the page when the difference matters.

Both are async commands with a deadline. WebKit answers on the main queue and the result crosses to the caller over a oneshot, so a page that never answers fails with `BROWSER_EVAL_TIMEOUT` / `BROWSER_SNAPSHOT_TIMEOUT` rather than parking the handler.

## Shortcuts

- `⌘L`: Focus address bar.
- `⌘T`: New tab.
- `⌘⇧T`: Reopen last closed tab.
- `⌘R`: Reload (when focused in the browser chrome).
- `⌃Tab` / `⌃⇧Tab`: Next / previous tab.
- `⌘W`: Closes the active browser tab whenever the browser is mounted. The menu command tries the browser first, then the review panel's file tabs, then the focused pane — `requestCloseActiveBrowserTab()` reports whether a mounted browser consumed it.
- Mouse thumb buttons: back (button 3) / forward (button 4), both over the browser chrome and inside a page.

## 1Password Autofill

`browser:fill-credentials` invokes the `op` CLI:
1. Lists Login items matching the page domain (exact host / dot-boundary check).
2. Retrieves credentials using `op item get --reveal` (triggers Touch ID).
3. Injects values into form fields via webview script evaluation. Fills require HTTPS (or loopback) and match the initial origin.

## Known Limitations

- Extensions and native Safari password autofill are unavailable in WKWebView child views.
- Google OAuth blocks embedded user agents; use the open-external button for Google sign-in flows.
- Downloads are not handled.
- Cookies persist in WKWebView's default store across restarts.
