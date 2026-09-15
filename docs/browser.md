# Browser Panel

Argmax has one native browser and two places that show it.

Web links in rendered file previews use the same browser preference as chat links. A plain click opens the configured destination, and ⌘/Ctrl-click opens the other browser without navigating the app's main view. Links routed to Argmax open a new tab on every click, preserving existing tabs.

**Browser page.** The left rail's Browser item (and ⌘K → Open Browser) fills the workspace with the tab strip and address bar. The session sidebar stays. Click a chat, New chat, or Esc to leave. The page remembers it was showing across a restart (`argmax.browser.pageOpen`). There is no dedicated shortcut; `⌘B` still toggles the right sidebar.

**Review panel.** In a chat, Browser is one of the review-panel modes, beside Changes, Files, Agents, and [Terminal](terminal.md). The session actions menu has an "Open browser" item. This is the sidebar next to a transcript, for watching a session browse.

Each chat remembers the panel's visibility and view arrangement across navigation and restarts. Browser can occupy either half of a split review panel. Returning to a chat with Browser visible restores it and claims the native surface again. Focusing the other half leaves Browser visible and keeps its ownership.

Tab strips are per scope. Each chat has its own tabs, order, and active tab. The rail's Browser page has a separate app-wide strip. The launcher review panel has a third. `localStorage` key `argmax.browser.tabs` stores those snapshots. A snapshot from before this split migrates onto the Browser page so chats start empty. Native webviews still share one process-wide pool, and only the current owner is visible.

Links from chat open in the system browser by default; Settings → General → "Web links from chat" can route them to the in-app browser (⌘-click toggles the alternate target). Both the page and the review-panel tab are shown only where the desktop bridge provides `window.argmax.browser` — the mobile remote has none, so they are hidden there.

## One Surface, One Owner

There is a single native browser surface, so exactly one owner shows it at a time. The owner is whichever surface most recently *entered* Browser mode — a review panel or the Browser page — not the focused pane: clicking into another pane's chat leaves the page where it is, while that pane switching to Browser takes it over deliberately. A surface that has been demoted stays in Browser mode and shows a "The browser moved to another pane" placeholder whose "Show here" button claims the surface back.

Focus still routes new open requests: a chat link or the menu item opens Browser in the focused cell, or in the launcher when it is the only surface on screen. If Browser is already visible in a split panel, the request uses that half. The rail item always opens the Browser page. Ownership lives in [browserPanel.ts](../src/renderer/lib/browserPanel.ts) (`claimBrowserSurface` / `releaseBrowserSurface`). [useReviewState.ts](../src/renderer/hooks/useReviewState.ts) claims while Browser is visible in either half and releases when it leaves the visible layout, the panel closes, or the cell unmounts. [BrowserPage.tsx](../src/renderer/components/BrowserPage.tsx) claims for the workspace page. Moving the browser between surfaces unmounts the old chrome and mounts the new one, which repositions the webview.

## Architecture

- **Renderer UI:** [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) fills the review panel's body with a tab strip on top and, under it, navigation controls, the address bar with search fallback, and the 1Password autofill button. Tabs share the strip evenly up to a cap and ellipsize past it; only the active one lifts to a ringed pill, matching the Files strip. Dragging a tab moves it (below). The strip in [browserPanel.ts](../src/renderer/lib/browserPanel.ts) *mirrors* the app's registry (below) rather than owning it, scoped to the chat, launcher, or Browser page that is showing. Its `localStorage` copy only remembers URLs across a restart. Browsing history persists separately via [browserHistory.ts](../src/renderer/lib/browserHistory.ts).
- **Native WebViews:** [src-tauri/src/ipc/browser.rs](../src-tauri/src/ipc/browser.rs) creates one child webview per tab (`browser-<tabId>`) on the main window using Tauri's `Window::add_child` API (`unstable` cargo feature).
- **Appearance:** Settings → Appearance → Browser theme stores `argmax.browser.theme.mode` separately from the app theme. `browser:set-theme` updates every live tab, and new tabs read the current process setting before their first paint. On macOS, [theme.rs](../src-tauri/src/browser/theme.rs) sets the child `WKWebView` appearance directly, so Light and Dark can differ from the surrounding Argmax window. System resolves the global macOS appearance instead of inheriting the app's override, then reapplies it to live tabs and popups when macOS appearance changes.
- **Login popups:** `window.open` creates a native browser window using Tauri's `on_new_window` callback and the opener's webview configuration. This preserves the popup reference, `window.opener`, `postMessage`, and closure checks that popup authentication needs, including opening a blank window before assigning its login URL. Ordinary `target="_blank"` links and modified clicks in panel tabs still open panel tabs. Popups skip the inherited tab-strip shortcuts. On macOS, [popup.rs](../src-tauri/src/browser/popup.rs) adds WebKit's missing close callback to Wry's delegate class before a popup is requested, so JavaScript closure also removes its native window without changing the delegate during WebKit's new-page callback.
- **Keyboard focus:** Activating a tab hands the window's first responder to that tab's page through `browser:focus`, the way clicking into it would — the arrow keys scroll the page, and `⌘F` reaches it as a page command. Without it, first responder stays on the app's own webview, where the same keys are Argmax's. Only an explicit activation focuses: a tab click (including a re-click of the tab already showing), a carry that lands, and `⌃Tab`. Restoring a panel, routing an open request, or an agent opening a tab must not focus, or a chat's composer would lose keystrokes to a page nobody asked for.
- **Positioning:** The renderer measures `.browser-panel-surface` and calls `browser:set-bounds` for the active tab. Inactive tabs are hidden. ResizeObserver and window-resize notifications share one measurement per animation frame, and unchanged bounds or visibility skip IPC. Tab switches, pane moves, and overlay visibility changes still synchronize immediately. Failed updates remain retryable, and unmounting cancels pending resize work before it can show the old surface again.

## Ad and Tracker Blocking

On macOS, user tabs and their popups use WebKit's compiled content rules to block third-party requests to domains in the bundled HaGeZi Multi LIGHT list. Rules are installed before the first page request. This is domain blocking, without cosmetic filters or a JavaScript request interceptor.

The toolbar shield turns blocking off or on for the current exact hostname, across ports and schemes. Exceptions persist in `browser-content-blocking.json` in the app profile. Changing a preference updates existing user views and reloads the selected tab. Agent-owned tabs and popups stay unfiltered for website testing. Localhost, its subdomains, and loopback addresses also bypass blocking. Other test sites can use the shield.

The first user-tab open prepares the rules asynchronously. Later opens reuse the active compiled list, and WebKit's on-disk cache avoids recompilation across restarts. Close, stop, navigation, and visibility changes during preparation are respected before creating the view. Preparation errors are reported instead of silently opening an unfiltered user tab.

The pinned source, provenance, and separate GPL-3.0 license are in [assets/browser-blocking](../assets/browser-blocking/README.md), bundled together as app resources. Update the list with `node scripts/update-browser-blocklist.mjs <full-upstream-commit-sha>` and commit the resulting source and provenance. There are no runtime list downloads. Native blocking is currently macOS-only.

Run `cargo test --manifest-path src-tauri/Cargo.toml native_browser_content_blocking -- --ignored --nocapture` on macOS to compile the production list in WebKit and check blocked requests, exact-host bypass, iframe bypass, local testing, and unfiltered views. This manual check needs Swift and network access to the probe resource.

## Importing Chrome History

The browser toolbar's **Import from Chrome** button opens a profile picker.
Choose a profile and click **Import history** to merge its recent pages into
Argmax's address suggestions. The result reports how many pages were read and
how many were new. Cookies and saved logins are not imported.

The desktop-only `browser:chrome-profiles` and `browser:import-chrome-history`
commands read Chrome's default data directory on macOS, Windows, and Linux.
History is normally read through a read-only SQLite transaction, including
committed WAL rows. If SQLite requires rollback-journal recovery, the importer
recovers a private temporary copy of the database and journal. It checks source
file identity and timestamps around the copy, retries changed copies, and rejects
a WAL appearing during the copy. These checks detect ordinary concurrent writes
but are not a transactional snapshot guarantee. Close Chrome and retry if the
copy cannot stabilize. Only visible HTTP(S) pages with a visit timestamp are
included, up to the 10,000 most recent.
Profile paths must remain inside Chrome's data directory.

Argmax retains up to 10,000 pages in IndexedDB, with an in-memory copy for
address suggestions. Existing `argmax.browser.history` localStorage data migrates
after a successful save. Repeating an import refreshes existing entries without
adding duplicate URLs or inflating visit counts. Address suggestions favor URL
prefixes, frequent visits, and recent visits. An empty address field shows the
most recent pages. Typing also completes the address inline, Chrome-style: when
the top suggestion's address extends what was typed, the rest of it fills the
field selected, so the next keystroke replaces it, Escape restores the typed
text, and Enter goes to the URL that suggestion was visited under rather than
the shortened text. Only ordinary typing at the end of the field completes —
never a deletion, a paste, or an in-progress IME composition. Storage failures are shown in the import dialog instead of
reporting success.

For a local source check, run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml imports_local_chrome_history_without_exposing_entries -- --ignored --nocapture
```

It reads installed Chrome profiles and prints counts and payload sizes without
printing URLs or titles.

## Z-Order and Overlays

Native child webviews render on top of DOM elements. [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) hides the active webview while the collapsed sidebar peeks, so its navigation buttons receive clicks. It also checks for `[role="dialog"]` and `[data-browser-overlay="true"]` elements intersecting the surface bounds and sets `visible: false` while an overlay covers the panel area. Split menus and drop targets use the latter attribute. The webview returns when overlapping overlays are dismissed, preserving the current tab.

## The Tab Registry

[registry.rs](../src-tauri/src/browser/registry.rs) holds `{ tabId, ownerSessionId, url, title, loading, group }` for every live child webview, in `AppState`. It is the source of truth, because an agent can open a tab with no pane on screen to ask. Every change pushes the whole list as `browser:tabs`, and `applyBrowserTabs` in the renderer folds it into the matching strip: a tab a session opened lands in that session's strip, and a user tab stays in the scope that already listed it. Tabs the app reports are marked live in this run, since their webview already exists. A tab the registry has reported before and then stops reporting has been closed. A tab the registry has *never* reported is left alone — that is either a URL restored from a previous run or a local tab whose `browser:open` is still in flight.

`ownerSessionId` is set for tabs a session opened and null for the user's own. `group` is a label a session put on a set of related tabs, and only an owned tab can carry one — so the label *replaces* the "agent" badge rather than crowding beside it, since the chip already says the tab is not the user's. Grouping is a per-tab attribute, not a position: `applyBrowserTabs` folds it in without touching the strip's order, which is why there is no reorder verb. The strip's order is the user's — theirs to drag, and never the registry's to adopt, which would move tabs under their cursor. An agent addresses tabs by id, so it has nothing to say about where they sit. An owned tab shows that badge in the strip, and `browser:agent-open` (`{ sessionId, tabId, url }`) asks the pane showing that session to enter Browser mode on it — the same addressed-request shape the terminal's ⌘J uses, because the pane may not be mounted. Nobody answering is a valid outcome: the tab is still in the strip.

## Carrying a Tab

Tabs reorder by drag, in [useBrowserTabDrag.ts](../src/renderer/hooks/useBrowserTabDrag.ts). Pointer events, not HTML5 drag and drop: the strip wants the tab under the cursor from the first pixel and its neighbours sliding out of the way, which a drag image and `dragover` cannot give — and drag and drop is the one input path in this app that wedges after hours of use ([dragLog.ts](../src/renderer/lib/dragLog.ts)), so a reorder that never opens a WebKit drag session is one fewer way to lose the strip.

Nothing reorders until the drop lands. The press measures every tab's slot once, in the strip's *content* coordinates (client x plus `scrollLeft`, so carrying into the edge band can scroll an overflowing strip without moving the geometry out from under the pointer). The carried tab then rides a transform, and the tabs whose middles it has passed slide one slot the other way — the list itself never renumbers under the cursor, so a `browser:tabs` push mid-carry cannot fight the measurement. The landing slot is addressed by the tab it displaces rather than by an index, because that push can add or drop tabs while a carry is in flight.

The drop rides the last stretch into the slot, then commits at the end of that ride — where the list's own layout already puts the tab, so the commit is invisible. Its length is the strip's own `--duration-fast`, read off the element: the CSS transition and the settle cannot drift, and "reduce motion", which zeroes that token, drops the tab into place at once. The transform transition hangs off the strip's `[data-dragging]` rather than off `.browser-tab`, so the render that commits takes the transitions away in the same breath as the transforms — left in the after-change style, every tab would animate from the slot it just left to the layout it is already sitting in.

Order is the user's and it persists: `browserPanel.ts` writes each scope's strip to `localStorage`, so a carried tab keeps its place across a restart.

Tab changes notify the UI immediately, but persistence waits for one idle callback
(with a one-second timeout and a zero-delay timer fallback). The callback serializes
the latest state once and skips the write if it matches the last saved snapshot.
Loading, ownership, and group changes do not schedule a save because those fields
are not persisted. Pending changes flush when the document becomes hidden or
receives `pagehide`. This removes full-strip serialization from tab switching
while preserving the existing restart format. An abrupt process termination can
still lose changes queued since the last save.

## Agent Automation

[automation.rs](../src-tauri/src/browser/automation.rs) is the Rust API an agent's tools call — `open`, `navigate`, `back`, `reload`, `close`, `tabs`, `activate`, `duplicate`, `group_tabs`, `snapshot`, `find`, `link_url`, `get_text`, `extract`, `read_capture`, `act` (click / type / select / hover / drag / press-key / scroll / wait-for), and `screenshot`. Each takes `&AppHandle` explicitly, because the callers do not all come through Tauri's invoke pipeline: the MCP server answers on a Unix socket and holds a handle of its own.

Cookie banners on agent-owned tabs are dismissed automatically by an
initialization script (known CMP accept controls, then accept/reject buttons
inside a cookie-shaped dialog). Localhost and loopback are skipped so a
first-party banner under test still shows. The MCP server instructions still
say leftover prompts may be accepted without asking the user.

A target is a tab id or a session; a session with no tab named gets the one it touched most recently, the way a person's foreground tab works. A tab a session opens is created at the window's own size and then hidden — laying it out at 1×1 would collapse the page and every snapshot after that would see a document with no visible boxes.

Three scripts do the work inside the page, embedded with `include_str!`:

- [snapshot.js](../src-tauri/src/browser/snapshot.js) walks the visible DOM and emits a Playwright-shaped aria tree — `- button "Sign in" [ref=e12]`, `- textbox "Search" [ref=e3] value="…"`, `- link "More information" [ref=e7] href=…` — under a `url:` / `title:` header, capped at 800 nodes and 40 KB with a trailing `- (truncated)`. `interactiveOnly` drops prose. It also serves `find(query)` (up to 20 refs matching role/name/value/text), `getText(maxChars)` (`main`/`article` first, `body` as fallback), `linkUrl(ref)` (a link ref's absolute URL, for opening it in a tab of its own), and `extract(maxChars)`.

  `extract` is the structured read: metadata (og/twitter/article tags, canonical URL, language), headings, heading-keyed sections, tables as headers plus rows, unique http(s) links, repeating items (cards, list rows), and filled form fields, each capped independently so one enormous page cannot blow the budget. It prefers `<article>`, then `<main>`, then the whole body — and on that last fallback only, it skips `nav`, `aside`, `footer` and their ARIA equivalents, because with no article element to trust the page's chrome reads as content. `<header>` stays: an h1 often lives in one.

  Snapshot, extract, and get-text also report `state`: `captcha`, `cookie`, `error`, `loading`, or `ready`, with a short reason. The snapshot prints it as a `state:` header line, next to `dialog:`. Wait misses return the same state instead of a bare timeout error.
- [actions.js](../src-tauri/src/browser/actions.js) is the write side, addressed by those refs. `type` goes through the prototype's native value setter so React and Vue see the change; `waitFor` is start-and-poll (`evaluateJavaScript:` never awaits a promise), arming a MutationObserver in the page while Rust polls the record. Click and type also report how much visible text moved and whether a listbox opened. `waitFor` can wait for text, a ref, a URL substring, network quiet (`quiet_ms`), or a minimum number of list-like items (`min_count`).

  Click and type only call DOM `focus()` when the browser document already has keyboard focus. Focusing an input in a hidden WKWebView can otherwise redirect the user's composer keystrokes into the agent's page. Background actions remember their target for subsequent `pressKey` calls, including Enter to submit a form. When the browser has focus, keys follow its actual focused element. This guards the automation script's own focus calls, not focus changes made by the page's event handlers.

  A drag is **three** calls, not one: `dragBegin` presses and records the gesture under an id, `dragStep` moves it one increment, `dragEnd` releases. Rust drives the loop, so every step is a separate `evaluateJavaScript:` and therefore a separate macrotask in the page. That is the whole point — dispatching a gesture in one task never lets the page render between moves, and the drag libraries that matter need exactly that: dnd-kit measures its drop targets in an effect after the drag-start commit, and react-beautiful-dnd throttles moves through `requestAnimationFrame`. A one-task drag lands the item back where it started. A page-side `rAF` stepper would not work either, because agent tabs are created hidden and a hidden `WKWebView` suspends animation frames. `dragBegin` puts the button down, so `automation::drag` calls `dragEnd` on every exit path, cancelling with `pointercancel` when a step fails.

  The steps also **flush animation frames by hand**, for the length of the gesture only. A hidden `WKWebView` never fires `requestAnimationFrame` — measured on a real agent tab, `setTimeout` and microtasks both run between two calls while rAF stays at zero forever — and agent tabs are created hidden. Drag libraries schedule their measuring and their move handling on frames, so without this the drop lands nowhere while the tool reports success, which is the worst outcome available. `dragBegin` therefore wraps `requestAnimationFrame`, each step runs whatever the previous step queued, and `dragEnd` restores it. The native frame is still requested, so on a visible tab a real frame can win the race; a callback runs at most once either way.
- [capture.js](../src-tauri/src/browser/capture.js) records console calls,
  uncaught errors, unhandled promise rejections, fetch and XHR outcomes, and
  resource timings in bounded per-tab buffers. It is an initialization script
  on agent-owned tabs, so it runs before page scripts. `browser_console` and
  `browser_network` read the newest records and can clear the buffer before an
  interaction. Each buffer keeps 200 records. This is page-level capture,
  since WKWebView has no Chrome DevTools Protocol connection. Response bodies,
  request headers, and native navigation response details are unavailable.

Refs live in the DOM as `data-argmax-ref`, so a re-snapshot reuses the attribute a node already carries and a ref stays valid for as long as its element does. A ref that no longer resolves fails with a message saying a fresh snapshot is needed. Both scripts are re-sent with every call, guarded by `window.__argmax.v` — the install costs one property read on a warm page and re-arms itself automatically after a navigation. Before a DOM call during the first navigation, a side-effect-free probe waits until WebKit can return an evaluation result. The requested script then runs exactly once. A page that neither finishes nor answers fails as `BROWSER_PAGE_LOAD_TIMEOUT` with its URL instead of reporting an unrelated script timeout.

A fourth script, [dialog.js](../src-tauri/src/browser/dialog.js), is different: it is an *initialization* script, fixed when the webview is created, and it is installed **only on tabs a session opened**. [cookie.js](../src-tauri/src/browser/cookie.js) is the same kind of install, on every frame of those tabs, so a consent iframe can still be clicked. A page's `alert` / `confirm` / `prompt` is synchronous — it must return a value before the page's next statement runs — so it cannot wait for an answer from an agent in another process. On an agent's tab the three are therefore overridden, answered on the spot from whatever `browser_handle_dialog` armed (dismissively when nothing did: `confirm` → false, `prompt` → null), and recorded. `snapshot.js` prints the record for 30 seconds as a `dialog:` header line, so the agent whose click hit a confirm box learns that it did. The page also pings Rust through the `argmax-newtab://dialog` scheme, which `on_navigation` intercepts, logs and blocks — there is no push event for it, because the snapshot header is where the agent reads it and the user's own tabs never raise one. Tabs the user opened keep the engine's native dialogs: silently answering a person's confirm box would misreport what they clicked.

## The MCP Path

Settings → Agents → Tools → **Browser tools** decides whether an agent gets
them at all. Off is a real saving — 27 of the server's 55 tools and about 37%
of its bytes, roughly 4,900 tokens off every turn — and it costs the panel
nothing: the user still browses, and the chat's Browser tab still works. The
choice is read when a launch is issued, so it reaches a chat on its next turn
and never changes the tool list under a running one. See "What the surface
costs" in [agent-tools.md](agent-tools.md).

The tools an agent calls are `mcp__argmax__browser_*`, defined in [browser_tools.rs](../src-tauri/src/mcp/browser_tools.rs) and listed in [agent-tools.md](agent-tools.md). They do not run in the app: the MCP server is a separate `argmax mcp` process with no `AppHandle`, so each tool sends a `SessionControlAction::Browser` over the session-control socket, and [browser_bridge.rs](../src-tauri/src/mcp/browser_bridge.rs) runs it app-side against the same `automation` functions the IPC channels use.

Two rules live in that bridge. **Ownership:** a session may only drive tabs it opened — the user's tabs and other sessions' tabs are refused with `BROWSER_TAB_NOT_OWNED`, and naming no tab resolves to the caller's own most recently used one. **Threading:** the socket handler runs on Tauri's async runtime, so creating, navigating and destroying a webview (AppKit calls, main-thread only) go through `run_on_main_thread`, while reads do not need it — WebKit's `evaluateJavaScript:` and `takeSnapshot` callbacks hop the queue themselves.

A screenshot taken through a tool starts at about 720 device pixels wide on Retina displays and is rasterised again at a narrower width when its encoded PNG would exceed 900 KB. It has to survive the provider's JSON stream: the normalizer refuses lines over 4 MiB, and a dropped line takes the tool's completion with it. The same capture is written into the caller's attachment store and its `path` returned, which is the only way the user gets to see it — the image block itself is the model's copy. An oversized capture that the reply had to drop is still saved, so the agent can put a screenshot on screen that it cannot see itself.

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

- `⌘⇧I`: Toggle the browser in the focused pane's review panel, from a chat or the launcher. Closes only the browser half of a split, like `⌘G` for Files.
- `⌘L`: Focus address bar.
- Enter in the address bar: go to the URL. Reloads when it's already the current page — WKWebView does not navigate to the URL it is already showing.
- `⌘T`: New tab.
- `⌘⇧T`: Reopen last closed tab.
- `⌘F`: Find in page on the active tab, from anywhere while the browser is on screen — the Browser page or a review panel. From the app's own DOM it opens the find bar directly; from inside a page the init-script relay carries it, and Rust hands native focus back to the main webview so the find field receives typing. Enter / Shift+Enter walk matches, Escape closes and clears the highlights.
- `⌘R`: Reload the tab when focused in the page or browser chrome. In development builds, app reload stays available in View → Reload and View → Force Reload, neither with a shortcut: `⌘⇧R` opens the launcher's folder picker.
- `⌃Tab` / `⌃⇧Tab`: Next / previous tab.
- `⌥←` / `⌥→` with a tab focused: move that tab one slot, the keyboard's way to reorder.
- `⌘W`: Closes the active browser tab whenever the browser is mounted. The menu command tries the browser first, then the review panel's file tabs, then the focused pane — `requestCloseActiveBrowserTab()` reports whether a mounted browser consumed it.
- Mouse thumb buttons: back (button 3) / forward (button 4), both over the browser chrome and inside a page.

## Find in Page

The find bar is a layout row between the toolbar and the surface, not an overlay: the page must stay visible while searching, because the highlights live *inside* the page. WKWebView exposes no find API through wry, so search runs as a page script over the existing `browser:evaluate` channel ([browserFind.ts](../src/renderer/lib/browserFind.ts)). The script installs a runtime guarded by `window.__argmaxFind` — re-evaluated after every navigation, so it re-arms itself — that walks text nodes, wraps each match in a styled custom element (`argmax-find-hl`), and steps through them, scrolling the current one into view. Closing the bar or unmounting the panel unwraps the marks and restores the page's text nodes.

The bar claims `⌘F` for as long as the browser owns the native surface, taking it off the app's search palette — `⌘K` and `⌘⇧F` still reach chat and content search. Scoping the claim to focus inside the panel chrome instead made the shortcut depend on where the last click landed: macOS WebKit leaves focus on `<body>` after a button click, and opening the Browser page leaves it in the rail, so the palette answered until the user clicked into the page. A `[role="dialog"]` on top keeps its own `⌘F`, including the palette's Messages and Contents filters. Keys pressed inside the page arrive as the `find` page-command, which routes through the `focus-address`-style native focus handoff so typing lands in the find field. Typing re-searches on a 200ms debounce; Enter / Shift+Enter step matches; Escape closes.

Per-text-node matching is a known limit: a query spanning an element boundary is not found, and nothing inside `<input>` values (which cannot be highlighted) is searched.

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
