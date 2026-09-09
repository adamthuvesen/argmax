# Browser Panel

Argmax has one native browser and two places that show it.

Web links in rendered file previews use the same browser preference as chat links. A plain click opens the configured destination, and ⌘/Ctrl-click opens the other browser without navigating the app's main view. Links routed to Argmax open a new tab on every click, preserving existing tabs.

**Browser page.** The left rail's Browser item (and ⌘K → Open Browser) fills the workspace with the tab strip and address bar. The session sidebar stays. Click a chat, New chat, or Esc to leave. The page remembers it was showing across a restart (`argmax.browser.pageOpen`). There is no dedicated shortcut; `⌘B` still toggles the right sidebar.

**Review panel.** In a chat, Browser is one of the review-panel modes, beside Changes, Files, Agents, and [Terminal](terminal.md). The session actions menu has an "Open browser" item. This is the sidebar next to a transcript, for watching a session browse.

Each chat remembers the panel's visibility and view arrangement across navigation and restarts. Browser can occupy either half of a split review panel. Returning to a chat with Browser visible restores it and claims the native surface again. Focusing the other half leaves Browser visible and keeps its ownership.

Links from chat open in the system browser by default; Settings → General → "Web links from chat" can route them to the in-app browser (⌘-click toggles the alternate target). Both the page and the review-panel tab are shown only where the desktop bridge provides `window.argmax.browser` — the mobile remote has none, so they are hidden there.

## One Surface, One Owner

There is a single native browser surface, so exactly one owner shows it at a time. The owner is whichever surface most recently *entered* Browser mode — a review panel or the Browser page — not the focused pane: clicking into another pane's chat leaves the page where it is, while that pane switching to Browser takes it over deliberately. A surface that has been demoted stays in Browser mode and shows a "The browser moved to another pane" placeholder whose "Show here" button claims the surface back.

Focus still routes new open requests: a chat link or the menu item opens Browser in the focused cell, or in the launcher when it is the only surface on screen. If Browser is already visible in a split panel, the request uses that half. The rail item always opens the Browser page. Ownership lives in [browserPanel.ts](../src/renderer/lib/browserPanel.ts) (`claimBrowserSurface` / `releaseBrowserSurface`). [useReviewState.ts](../src/renderer/hooks/useReviewState.ts) claims while Browser is visible in either half and releases when it leaves the visible layout, the panel closes, or the cell unmounts. [BrowserPage.tsx](../src/renderer/components/BrowserPage.tsx) claims for the workspace page. Moving the browser between surfaces unmounts the old chrome and mounts the new one, which repositions the webview.

## Architecture

- **Renderer UI:** [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) fills the review panel's body with a tab strip on top and, under it, navigation controls, the address bar with search fallback, and the 1Password autofill button. Tabs share the strip evenly up to a cap and ellipsize past it; only the active one lifts to a ringed pill, matching the Files strip. Dragging a tab moves it (below). The strip in [browserPanel.ts](../src/renderer/lib/browserPanel.ts) *mirrors* the app's registry (below) rather than owning it; its `localStorage` copy only remembers URLs across a restart. Browsing history persists separately via [browserHistory.ts](../src/renderer/lib/browserHistory.ts).
- **Native WebViews:** [src-tauri/src/ipc/browser.rs](../src-tauri/src/ipc/browser.rs) creates one child webview per tab (`browser-<tabId>`) on the main window using Tauri's `Window::add_child` API (`unstable` cargo feature).
- **Positioning:** The renderer measures `.browser-panel-surface` and calls `browser:set-bounds` for the active tab. Inactive tabs are hidden. The review panel's own resizer and side preference need no browser-specific handling — a ResizeObserver on the surface re-glues the webview whenever the panel's width changes.

## Z-Order and Overlays

Native child webviews render on top of DOM elements. [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) hides the active webview while the collapsed sidebar peeks, so its navigation buttons receive clicks. It also checks for `[role="dialog"]` and `[data-browser-overlay="true"]` elements intersecting the surface bounds and sets `visible: false` while an overlay covers the panel area. Split menus and drop targets use the latter attribute. The webview returns when overlapping overlays are dismissed, preserving the current tab.

## The Tab Registry

[registry.rs](../src-tauri/src/browser/registry.rs) holds `{ tabId, ownerSessionId, url, title, loading, group }` for every live child webview, in `AppState`. It is the source of truth, because an agent can open a tab with no pane on screen to ask. Every change pushes the whole list as `browser:tabs`, and `applyBrowserTabs` in the renderer folds it into the strip: tabs the app reports are added (and marked live in this run, since their webview already exists), and a tab the registry has reported before and then stops reporting has been closed. A tab the registry has *never* reported is left alone — that is either a URL restored from a previous run or a local tab whose `browser:open` is still in flight.

`ownerSessionId` is set for tabs a session opened and null for the user's own. `group` is a label a session put on a set of related tabs, and only an owned tab can carry one — so the label *replaces* the "agent" badge rather than crowding beside it, since the chip already says the tab is not the user's. Grouping is a per-tab attribute, not a position: `applyBrowserTabs` folds it in without touching the strip's order, which is why there is no reorder verb. The strip's order is the user's — theirs to drag, and never the registry's to adopt, which would move tabs under their cursor. An agent addresses tabs by id, so it has nothing to say about where they sit. An owned tab shows that badge in the strip, and `browser:agent-open` (`{ sessionId, tabId, url }`) asks the pane showing that session to enter Browser mode on it — the same addressed-request shape the terminal's ⌘J uses, because the pane may not be mounted. Nobody answering is a valid outcome: the tab is still in the strip.

## Carrying a Tab

Tabs reorder by drag, in [useBrowserTabDrag.ts](../src/renderer/hooks/useBrowserTabDrag.ts). Pointer events, not HTML5 drag and drop: the strip wants the tab under the cursor from the first pixel and its neighbours sliding out of the way, which a drag image and `dragover` cannot give — and drag and drop is the one input path in this app that wedges after hours of use ([dragLog.ts](../src/renderer/lib/dragLog.ts)), so a reorder that never opens a WebKit drag session is one fewer way to lose the strip.

Nothing reorders until the drop lands. The press measures every tab's slot once, in the strip's *content* coordinates (client x plus `scrollLeft`, so carrying into the edge band can scroll an overflowing strip without moving the geometry out from under the pointer). The carried tab then rides a transform, and the tabs whose middles it has passed slide one slot the other way — the list itself never renumbers under the cursor, so a `browser:tabs` push mid-carry cannot fight the measurement. The landing slot is addressed by the tab it displaces rather than by an index, because that push can add or drop tabs while a carry is in flight.

The drop rides the last stretch into the slot, then commits at the end of that ride — where the list's own layout already puts the tab, so the commit is invisible. Its length is the strip's own `--duration-fast`, read off the element: the CSS transition and the settle cannot drift, and "reduce motion", which zeroes that token, drops the tab into place at once. The transform transition hangs off the strip's `[data-dragging]` rather than off `.browser-tab`, so the render that commits takes the transitions away in the same breath as the transforms — left in the after-change style, every tab would animate from the slot it just left to the layout it is already sitting in.

Order is the user's and it persists: `browserPanel.ts` writes the strip's array to `localStorage`, so a carried tab keeps its place across a restart.

## Agent Automation

[automation.rs](../src-tauri/src/browser/automation.rs) is the Rust API an agent's tools call — `open`, `navigate`, `back`, `reload`, `close`, `tabs`, `activate`, `duplicate`, `group_tabs`, `snapshot`, `find`, `link_url`, `get_text`, `extract`, `act` (click / type / select / hover / drag / press-key / scroll / wait-for), and `screenshot`. Each takes `&AppHandle` explicitly, because the callers do not all come through Tauri's invoke pipeline: the MCP server answers on a Unix socket and holds a handle of its own.

Cookie acceptance is standing user authorization. The MCP server instructions
tell the agent to accept cookie prompts without asking the user.

A target is a tab id or a session; a session with no tab named gets the one it touched most recently, the way a person's foreground tab works. A tab a session opens is created at the window's own size and then hidden — laying it out at 1×1 would collapse the page and every snapshot after that would see a document with no visible boxes.

Two scripts do the work inside the page, embedded with `include_str!`:

- [snapshot.js](../src-tauri/src/browser/snapshot.js) walks the visible DOM and emits a Playwright-shaped aria tree — `- button "Sign in" [ref=e12]`, `- textbox "Search" [ref=e3] value="…"`, `- link "More information" [ref=e7] href=…` — under a `url:` / `title:` header, capped at 800 nodes and 40 KB with a trailing `- (truncated)`. `interactiveOnly` drops prose. It also serves `find(query)` (up to 20 refs matching role/name/value/text), `getText(maxChars)` (`main`/`article` first, `body` as fallback), `linkUrl(ref)` (a link ref's absolute URL, for opening it in a tab of its own), and `extract(maxChars)`.

  `extract` is the structured read: metadata (og/twitter/article tags, canonical URL, language), headings, heading-keyed sections, tables as headers plus rows, and unique http(s) links, each capped independently so one enormous page cannot blow the budget. It prefers `<article>`, then `<main>`, then the whole body — and on that last fallback only, it skips `nav`, `aside`, `footer` and their ARIA equivalents, because with no article element to trust the page's chrome reads as content. `<header>` stays: an h1 often lives in one.
- [actions.js](../src-tauri/src/browser/actions.js) is the write side, addressed by those refs. `type` goes through the prototype's native value setter so React and Vue see the change; `waitFor` is start-and-poll (`evaluateJavaScript:` never awaits a promise), arming a MutationObserver in the page while Rust polls the record.

  Click and type only call DOM `focus()` when the browser document already has keyboard focus. Focusing an input in a hidden WKWebView can otherwise redirect the user's composer keystrokes into the agent's page. Background actions remember their target for subsequent `pressKey` calls, including Enter to submit a form. When the browser has focus, keys follow its actual focused element. This guards the automation script's own focus calls, not focus changes made by the page's event handlers.

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
- Enter in the address bar: go to the URL. Reloads when it's already the current page — WKWebView does not navigate to the URL it is already showing.
- `⌘T`: New tab.
- `⌘⇧T`: Reopen last closed tab.
- `⌘R`: Reload the tab when focused in the page or browser chrome. In development builds, app reload stays available in View → Reload and via `⌘⇧R`.
- `⌃Tab` / `⌃⇧Tab`: Next / previous tab.
- `⌥←` / `⌥→` with a tab focused: move that tab one slot, the keyboard's way to reorder.
- `⌘W`: Closes the active browser tab whenever the browser is mounted. The menu command tries the browser first, then the review panel's file tabs, then the focused pane — `requestCloseActiveBrowserTab()` reports whether a mounted browser consumed it.
- Mouse thumb buttons: back (button 3) / forward (button 4), both over the browser chrome and inside a page.

## 1Password Autofill

`browser:fill-credentials` invokes the `op` CLI:
1. Lists Login items matching the page domain (exact host / dot-boundary check).
2. Retrieves credentials using `op item get --reveal` (triggers Touch ID).
3. Injects values into form fields via webview script evaluation. Fills require HTTPS (or loopback) and match the initial origin.

`op` runs with the login shell's `PATH` and `OP_*` exports, and with
`OP_BIOMETRIC_UNLOCK_ENABLED=true` unless the shell sets it. The 1Password app
integration is the only sign-in path a fill can use (there is no terminal for
`op signin`), and asking for it explicitly keeps `op` from silently listing zero
accounts when it cannot read the app's settings file.

## Known Limitations

- Extensions and native Safari password autofill are unavailable in WKWebView child views.
- Google OAuth blocks embedded user agents; use the open-external button for Google sign-in flows.
- Downloads are not handled.
- Cookies persist in WKWebView's default store across restarts.
