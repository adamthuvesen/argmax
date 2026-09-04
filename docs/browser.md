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

[registry.rs](../src-tauri/src/browser/registry.rs) holds `{ tabId, ownerSessionId, url, title, loading, group }` for every live child webview, in `AppState`. It is the source of truth, because an agent can open a tab with no pane on screen to ask. Every change pushes the whole list as `browser:tabs`, and `applyBrowserTabs` in the renderer folds it into the strip: tabs the app reports are added (and marked live in this run, since their webview already exists), and a tab the registry has reported before and then stops reporting has been closed. A tab the registry has *never* reported is left alone — that is either a URL restored from a previous run or a local tab whose `browser:open` is still in flight.

`ownerSessionId` is set for tabs a session opened and null for the user's own. `group` is a label a session put on a set of related tabs, and only an owned tab can carry one — so the label *replaces* the "agent" badge rather than crowding beside it, since the chip already says the tab is not the user's. Grouping is a per-tab attribute, not a position: `applyBrowserTabs` folds it in without touching the strip's order, which is why there is no reorder verb. An agent addresses tabs by id, so order would only ever be for the human, and adopting the registry's order would move tabs under their cursor. An owned tab shows that badge in the strip, and `browser:agent-open` (`{ sessionId, tabId, url }`) asks the pane showing that session to enter Browser mode on it — the same addressed-request shape the terminal's ⌘J uses, because the pane may not be mounted. Nobody answering is a valid outcome: the tab is still in the strip.

## Agent Automation

[automation.rs](../src-tauri/src/browser/automation.rs) is the Rust API an agent's tools call — `open`, `navigate`, `back`, `reload`, `close`, `tabs`, `activate`, `duplicate`, `group_tabs`, `snapshot`, `find`, `link_url`, `get_text`, `extract`, `act` (click / type / select / hover / drag / press-key / scroll / wait-for), and `screenshot`. Each takes `&AppHandle` explicitly, because the callers do not all come through Tauri's invoke pipeline: the MCP server answers on a Unix socket and holds a handle of its own.

Cookie acceptance is standing user authorization. Every provider launch and
the MCP server instructions tell the agent to accept cookie prompts without
asking the user.

A target is a tab id or a session; a session with no tab named gets the one it touched most recently, the way a person's foreground tab works. A tab a session opens is created at the window's own size and then hidden — laying it out at 1×1 would collapse the page and every snapshot after that would see a document with no visible boxes.

Two scripts do the work inside the page, embedded with `include_str!`:

- [snapshot.js](../src-tauri/src/browser/snapshot.js) walks the visible DOM and emits a Playwright-shaped aria tree — `- button "Sign in" [ref=e12]`, `- textbox "Search" [ref=e3] value="…"`, `- link "More information" [ref=e7] href=…` — under a `url:` / `title:` header, capped at 800 nodes and 40 KB with a trailing `- (truncated)`. `interactiveOnly` drops prose. It also serves `find(query)` (up to 20 refs matching role/name/value/text), `getText(maxChars)` (`main`/`article` first, `body` as fallback), `linkUrl(ref)` (a link ref's absolute URL, for opening it in a tab of its own), and `extract(maxChars)`.

  `extract` is the structured read: metadata (og/twitter/article tags, canonical URL, language), headings, heading-keyed sections, tables as headers plus rows, and unique http(s) links, each capped independently so one enormous page cannot blow the budget. It prefers `<article>`, then `<main>`, then the whole body — and on that last fallback only, it skips `nav`, `aside`, `footer` and their ARIA equivalents, because with no article element to trust the page's chrome reads as content. `<header>` stays: an h1 often lives in one.
- [actions.js](../src-tauri/src/browser/actions.js) is the write side, addressed by those refs. `type` goes through the prototype's native value setter so React and Vue see the change; `waitFor` is start-and-poll (`evaluateJavaScript:` never awaits a promise), arming a MutationObserver in the page while Rust polls the record.

  A drag is **three** calls, not one: `dragBegin` presses and records the gesture under an id, `dragStep` moves it one increment, `dragEnd` releases. Rust drives the loop, so every step is a separate `evaluateJavaScript:` and therefore a separate macrotask in the page. That is the whole point — dispatching a gesture in one task never lets the page render between moves, and the drag libraries that matter need exactly that: dnd-kit measures its drop targets in an effect after the drag-start commit, and react-beautiful-dnd throttles moves through `requestAnimationFrame`. A one-task drag lands the item back where it started. A page-side `rAF` stepper would not work either, because agent tabs are created hidden and a hidden `WKWebView` suspends animation frames. `dragBegin` puts the button down, so `automation::drag` calls `dragEnd` on every exit path, cancelling with `pointercancel` when a step fails.

  The steps also **flush animation frames by hand**, for the length of the gesture only. A hidden `WKWebView` never fires `requestAnimationFrame` — measured on a real agent tab, `setTimeout` and microtasks both run between two calls while rAF stays at zero forever — and agent tabs are created hidden. Drag libraries schedule their measuring and their move handling on frames, so without this the drop lands nowhere while the tool reports success, which is the worst outcome available. `dragBegin` therefore wraps `requestAnimationFrame`, each step runs whatever the previous step queued, and `dragEnd` restores it. The native frame is still requested, so on a visible tab a real frame can win the race; a callback runs at most once either way.

Refs live in the DOM as `data-argmax-ref`, so a re-snapshot reuses the attribute a node already carries and a ref stays valid for as long as its element does. A ref that no longer resolves fails with a message saying a fresh snapshot is needed. Both scripts are re-sent with every call, guarded by `window.__argmax.v` — the install costs one property read on a warm page and re-arms itself automatically after a navigation.

A third script, [dialog.js](../src-tauri/src/browser/dialog.js), is different: it is an *initialization* script, fixed when the webview is created, and it is installed **only on tabs a session opened**. A page's `alert` / `confirm` / `prompt` is synchronous — it must return a value before the page's next statement runs — so it cannot wait for an answer from an agent in another process. On an agent's tab the three are therefore overridden, answered on the spot from whatever `browser_handle_dialog` armed (dismissively when nothing did: `confirm` → false, `prompt` → null), and recorded. `snapshot.js` prints the record for 30 seconds as a `dialog:` header line, so the agent whose click hit a confirm box learns that it did. The page also pings Rust through the `argmax-newtab://dialog` scheme, which `on_navigation` intercepts, logs and blocks — there is no push event for it, because the snapshot header is where the agent reads it and the user's own tabs never raise one. Tabs the user opened keep the engine's native dialogs: silently answering a person's confirm box would misreport what they clicked.

## The MCP Path

The tools an agent calls are `mcp__argmax__browser_*`, defined in [browser_tools.rs](../src-tauri/src/mcp/browser_tools.rs) and listed in [agent-tools.md](agent-tools.md). They do not run in the app: the MCP server is a separate `argmax mcp` process with no `AppHandle`, so each tool sends a `SessionControlAction::Browser` over the session-control socket, and [browser_bridge.rs](../src-tauri/src/mcp/browser_bridge.rs) runs it app-side against the same `automation` functions the IPC channels use.

Two rules live in that bridge. **Ownership:** a session may only drive tabs it opened — the user's tabs and other sessions' tabs are refused with `BROWSER_TAB_NOT_OWNED`, and naming no tab resolves to the caller's own most recently used one. **Threading:** the socket handler runs on Tauri's async runtime, so creating, navigating and destroying a webview (AppKit calls, main-thread only) go through `run_on_main_thread`, while reads do not need it — WebKit's `evaluateJavaScript:` and `takeSnapshot` callbacks hop the queue themselves.

A screenshot taken through a tool is rasterised at 720 CSS pixels wide and dropped past 900 KB of base64, because it has to survive the provider's JSON stream: the normalizer refuses lines over 4 MiB, and a dropped line takes the tool's completion with it.

## IPC Channels

- **Request (panel):** `browser:open`, `browser:navigate`, `browser:back`, `browser:forward`, `browser:reload`, `browser:stop`, `browser:set-bounds`, `browser:close`, `browser:fill-credentials`, `browser:evaluate`.
- **Request (agent):** `browser:list-tabs`, `browser:open-for-session`, `browser:snapshot`, `browser:find`, `browser:get-text`, `browser:extract`, `browser:act`, and `browser:screenshot` (which also takes a `ref` to crop to one element). These take `{ tabId?, sessionId? }`.
- **Push:** `browser:state` (`{ tabId, url, title, loading }`), `browser:tabs` (the whole registry), `browser:agent-open` (`{ sessionId, tabId, url }`), `browser:new-tab` (popups routed via `argmax-newtab:` scheme), and `browser:page-command` (key shortcuts and mouse thumb-button history clicks passed from webview).

All of them are in `REMOTE_UNSUPPORTED_CHANNELS`: they manipulate the desktop app's native child webviews.

Closing a tab (`browser:close`) disposes the webview. Leaving Browser mode sets `visible: false` to preserve page session state and scroll position.

## Capture and Evaluation

Two channels drive a tab programmatically instead of from the toolbar. Both live in [src-tauri/src/browser](../src-tauri/src/browser):

- `browser:screenshot` (`{ tabId, rect? }` → `{ pngBase64, width, height }`) reaches the child `WKWebView` through `Webview::with_webview` and calls `takeSnapshotWithConfiguration:completionHandler:` — wry has no capture API of its own. `rect` crops in the page's CSS pixels; the returned size is device pixels, so twice that on a retina display. `WKSnapshotConfiguration`'s `snapshotWidth` narrows the capture at rasterisation time rather than resizing afterwards, which is how the agent path keeps a PNG small enough to travel. WebKit rasterises rather than reading the screen back, so a hidden tab still captures its page.
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
