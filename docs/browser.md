# Browser Panel

Argmax has a native browser with separate tab strips for each chat, the launcher, and the Browser page. Native child webviews share one process-wide pool, and each visible scope shows its own active tab. The mobile remote has no `window.argmax.browser`, so these surfaces are hidden there.

| Concern | Owner |
|---|---|
| Panel UI | [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) |
| Strip state and persistence | [browserPanel.ts](../src/renderer/lib/browserPanel.ts) |
| Native webviews | [ipc/browser.rs](../src-tauri/src/ipc/browser.rs) |
| Live tab registry | [registry.rs](../src-tauri/src/browser/registry.rs) |
| Agent API | [automation.rs](../src-tauri/src/browser/automation.rs) |
| Page scripts | [snapshot.js](../src-tauri/src/browser/snapshot.js), [actions.js](../src-tauri/src/browser/actions.js), [capture.js](../src-tauri/src/browser/capture.js), [dialog.js](../src-tauri/src/browser/dialog.js), [cookie.js](../src-tauri/src/browser/cookie.js) |
| Frames | [frames.rs](../src-tauri/src/browser/frames.rs), [frame_probe.js](../src-tauri/src/browser/frame_probe.js) |
| MCP path | [browser_tools.rs](../src-tauri/src/mcp/browser_tools.rs), [browser_bridge.rs](../src-tauri/src/mcp/browser_bridge.rs) |
| Tab order drag | [useBrowserTabDrag.ts](../src/renderer/hooks/useBrowserTabDrag.ts) |
| Find in page | [browserFind.ts](../src/renderer/lib/browserFind.ts) |

The catalogue marks browser commands `desktop`, because they manipulate native child webviews.

## Surfaces

Each chat shows its browser alongside other chats in the grid. A pane claims individual tab IDs through `claimBrowserTabSurface`, so two panes cannot claim one page. An ownership transfer reapplies bounds after a late native open, so the previous owner cannot hide the page. Unmounting hides a page, and closing a tab destroys its webview. A chat torn off into its own window has no browser, because every tab is a child of the main window ([runtime.md](runtime.md#chat-windows)).

Focus routes chat links and menu requests to the focused cell, or to the launcher when it is the only surface. Native page commands route by the source tab's scope. Native page focus is relayed to the grid, so app-menu commands follow the page the user clicked.

The first agent tab opened while its chat is mounted reveals Browser in the sidebar, remembered per session. Later agent opens do not switch the view, change split focus, or reopen a closed sidebar, because an agent must not take the screen from the user.

Web links from chat open in the system browser by default. A Settings option can route them in-app, and ⌘-click takes the other target.

## Native webviews

- **Injected scripts are replaced wholesale.** Wry gives every webview a frozen `window.ipc`, and any page whose script declares `function ipc(…)` at global scope dies. Google Sheets' editor does. No script can undo the definition afterwards, so [user_scripts.rs](../src-tauri/src/browser/user_scripts.rs) reinstalls the script list on the main thread before WebKit creates the first document.
- **User agent.** Tabs present as desktop Safari, because Google refuses OAuth from an embedded webview. `docs.google.com` claims Chrome, because Google serves Safari a grid canvas at half the device scale. A link that walks into an editor may only upgrade, because the navigation callback fires for iframes too ([user_agent.rs](../src-tauri/src/browser/user_agent.rs)).
- **Appearance.** [theme.rs](../src-tauri/src/browser/theme.rs) sets the child `WKWebView` appearance directly, so it can differ from the window. System resolves the global macOS appearance instead of inheriting the app's override.
- **Login popups.** `window.open` creates a native window with the opener's configuration, which preserves `window.opener` and `postMessage`. [popup.rs](../src-tauri/src/browser/popup.rs) adds WebKit's missing close callback before a popup is requested.
- **Focus.** Only an explicit activation hands first responder to the page: a tab click, a carry that lands, or `⌃Tab`. Restoring a panel or an agent opening a tab must not focus, or a composer would lose keystrokes.
- **Positioning.** Bounds are CSS px, and a child webview is placed in window points, so `ipc/browser.rs` multiplies by the window's page zoom. Skipping that scale leaves a zoomed-out window glued to a webview too large.
- **Z-order.** Native webviews render above the DOM. `BrowserPanel` hides the active webview when a `[role="dialog"]` or `[data-browser-overlay="true"]` element intersects it, and draws a `browser:screenshot` still in its place. Add that attribute to a new overlay. WebKit rasterises hidden webviews, so the still works.

## Ad and tracker blocking

On macOS, user tabs and their popups use WebKit's compiled content rules against the bundled HaGeZi Multi LIGHT list. This is domain blocking only. Rules install before the first page request, and a preparation error is reported rather than silently opening an unfiltered tab.

The shield toggles blocking per exact hostname. Agent-owned tabs stay unfiltered for website testing, and localhost bypasses blocking.

There are no runtime list downloads. [assets/browser-blocking](../assets/browser-blocking/README.md) holds the source, provenance, and separate GPL-3.0 license. Update with `node scripts/update-browser-blocklist.mjs <full-upstream-commit-sha>`.

Manual macOS check, which needs Swift and network access:

```bash
cargo test --manifest-path src-tauri/Cargo.toml native_browser_content_blocking -- --ignored --nocapture
```

## Importing Chrome history

`browser:import-chrome-history` merges a Chrome profile's recent pages into address suggestions. Cookies and logins are not imported. Profile paths must stay inside Chrome's data directory.

History is read through a read-only SQLite transaction. If SQLite needs rollback-journal recovery, the importer recovers a private temporary copy and checks file identity around the copy. That detects ordinary concurrent writes, but it is not a transactional snapshot guarantee.

[browserHistory.ts](../src/renderer/lib/browserHistory.ts) retains pages in IndexedDB. A repeated import refreshes entries without inflating visit counts. Inline completion runs only for ordinary typing at the end of the field, never a deletion, a paste, or an IME composition. Storage failures show in the dialog.

Local source check, which prints counts and never URLs:

```bash
cargo test --manifest-path src-tauri/Cargo.toml imports_local_chrome_history_without_exposing_entries -- --ignored --nocapture
```

## The tab registry

The registry is the source of truth, because an agent can open a tab with no pane on screen to ask. Every change pushes the whole list as `browser:tabs`, and `applyBrowserTabs` folds it into the matching strip. The strip mirrors the registry, and its `localStorage` copy only remembers URLs across a restart.

- A tab the registry reported and then stops reporting has been closed.
- A tab it has never reported is left alone, because it is a restored URL or an open still in flight.

`ownerSessionId` is null for the user's tabs. `group` is a label on an owned tab, and it replaces the "agent" badge. Grouping is a per-tab attribute, not a position. The strip's order is the user's, and adopting the registry's would move tabs under their cursor. An agent addresses tabs by id, so there is no reorder verb.

`browser:agent-open` asks the pane showing that session to select a tab. Nobody answering is valid, because the tab is still in the strip.

Persistence waits for an idle callback, because tab changes must not serialize the whole strip on the interaction. Pending changes flush on `pagehide`.

## Carrying a tab

Tabs reorder with pointer events, not HTML5 drag and drop. The strip wants the tab under the cursor from the first pixel, and drag and drop is the one input path that wedges after hours of use ([dragLog.ts](../src/renderer/lib/dragLog.ts)).

Nothing reorders until the drop lands. The press measures slots once in content coordinates, so a `browser:tabs` push mid-carry cannot fight the measurement. The landing slot is addressed by the tab it displaces, not an index, because that push can add or drop tabs. The settle reads `--duration-fast` off the element, so CSS and JS cannot drift, and reduced motion zeroes both.

## Agent automation

Each `automation` function takes `&AppHandle` explicitly, because the MCP path answers on a Unix socket and does not come through Tauri's invoke pipeline.

A target is a tab id or a session. A session with no tab named gets the one it touched most recently. A session's tab is created at window size and then hidden, because a 1×1 layout collapses the page and every later snapshot sees no visible boxes.

Page scripts are re-sent with every call, guarded by `window.__argmax.v`, so a navigation re-arms them. During the first navigation, a side-effect-free probe waits until WebKit can answer, so the requested script runs exactly once. A page that never answers fails as `BROWSER_PAGE_LOAD_TIMEOUT`.

**Refs** live in the DOM as `data-argmax-ref`, so a ref stays valid as long as its element.

**`extract` on a body fallback skips `nav`, `aside`, and `footer`,** because with no article element the page's chrome reads as content. `<header>` stays, because an h1 often lives in one.

**`type`** uses the prototype's native value setter, so React and Vue see the change. **`waitFor`** is start-and-poll, because `evaluateJavaScript:` never awaits a promise.

**Focus.** Click and type call DOM `focus()` only when the document already has keyboard focus. Focusing an input in a hidden WKWebView can redirect the user's composer keystrokes into the agent's page. Background actions remember their target for later `pressKey` calls. This guards the script's own focus calls, not the page's handlers.

**Drags are three calls.** `dragBegin`, `dragStep`, and `dragEnd` are separate `evaluateJavaScript:` macrotasks, so the page renders between moves. dnd-kit measures drop targets after the drag-start commit, and a one-task drag lands the item back where it started. `automation::drag` calls `dragEnd` on every exit path.

**Steps flush animation frames by hand.** A hidden `WKWebView` never fires `requestAnimationFrame`, and agent tabs are hidden. Without this, the drop lands nowhere while the tool reports success, which is the worst outcome available. `dragBegin` wraps `requestAnimationFrame`, and `dragEnd` restores it.

**Capture** is an initialization script in every frame of agent tabs, so it runs before page scripts. WKWebView has no CDP connection, so response bodies and request headers are unavailable.

**Cookie banners** on agent tabs are dismissed by an initialization script. Localhost is skipped, so a first-party banner under test still shows.

**Dialogs.** `alert`, `confirm`, and `prompt` are synchronous, so an agent in another process cannot answer in time. On an agent's tab, `dialog.js` answers on the spot from what `browser_handle_dialog` armed, dismissively otherwise, and records it. `snapshot.js` prints the record as a `dialog:` header line.

User tabs get native dialogs, because silently answering a person's confirm would misreport what they clicked. WKWebView draws none on its own, so [js_dialogs.rs](../src-tauri/src/browser/js_dialogs.rs) adds the methods to wry's delegate class and shows an `NSAlert` sheet. WebKit reads a delegate's methods when it is assigned, so each new tab is handed its delegate again. A hidden webview answers dismissively.

## Frames

A cross-origin `<iframe>` is a document of its own, and no main-frame script can read it. Frame access is macOS-only and agent-tab-only.

WebKit evaluates in a child frame only given its `WKFrameInfo`, and the public API hands one out only in a message from that frame's script. Every frame of an agent tab therefore runs `frame_probe.js` in an isolated content world (`argmax-agent`), where the `argmaxFrame` handler is visible and the page's scripts are not. `snapshot.js` tags each `<iframe>` with an id (`data-argmax-frame="f3"`) and posts the id and a nonce into it. The answer ties a frame Rust can evaluate in to the element in the parent's DOM.

**Trust.** The id alone proves nothing, because any frame can create a child and post a probe naming another frame's id. An answer counts only with the exact nonce the parent posted to that `<iframe>`. Composition also does not trust a frame's page: a `[frame=…]` marker is spliced only when that document's own probe found it, each frame is spliced once, and refs a document does not own are dropped.

**Reads.** `automation::walk` runs a call in the main frame, waits briefly for frames to answer, then runs it in each that did, parents first, within depth and count limits. Tracking pixels are skipped. A frame that did not answer is not waited for again for a while, so a sandbox without `allow-scripts` costs one wait, not one per read.

**Routing.** A frame's refs carry its id (`f3e5`), and Rust routes them. A ref whose frame has no handle yet probes once and retries. Key presses follow focus into frames. A scroll on a window a person could not scroll moves a frame instead, but a window only at its end stays put, so the agent learns it reached the end.

## The MCP path

Settings → Agents → Tools → **Browser tools** decides whether an agent gets them. Off removes 27 of the server's 63 tools. The user's browser still works. See [agent-tools.md](agent-tools.md#what-the-surface-costs).

The MCP server has no `AppHandle`, so each tool sends `SessionControlAction::Browser` over the socket, and `browser_bridge.rs` runs it app-side against the same `automation` functions the IPC channels use. Two rules live there:

- **Ownership:** a session may drive only tabs it opened.
- **Threading:** creating, navigating, and destroying a webview are AppKit calls and go through `run_on_main_thread`. Reads do not need it, because WebKit's callbacks hop the queue themselves.

A screenshot has to survive the provider's JSON stream, because the normalizer refuses oversized lines and a dropped line takes the tool's completion with it. It is rasterised narrower when too large. The capture is saved to the attachment store even when the reply had to drop it, so the agent can show the user a screenshot it cannot see itself.

## Capture and evaluation

- `browser:screenshot` reaches `WKWebView` through `Webview::with_webview`, because wry has no capture API. WebKit rasterises, so a hidden tab still captures its page.
- `browser:evaluate` returns WebKit's JSON encoding. Wry drops the `NSError`, so a throw looks like `undefined`. `eval::wrap_for_errors` catches inside the page when the difference matters.

`browser_evaluate` uses the page's own `eval`. A page whose CSP lacks `unsafe-eval` refuses it, and the wrapper probes `eval` with a constant first, so a refusal never follows a side effect. Script WebKit injects itself is not subject to the page's policy, so `automation::evaluate` then runs the expression through `frames::eval`, inside a block that keeps `let` and `const` out of global scope.

Both have deadlines (`BROWSER_EVAL_TIMEOUT`, `BROWSER_SNAPSHOT_TIMEOUT`), so a page that never answers cannot park the handler.

## Shortcuts

Page shortcuts ignore synthetic events (`!event.isTrusted`), so an agent's `browser_press_key` never closes the panel or switches tabs.

- Escape inside a page closes the panel only when the page did not handle it. The relay skips the key on `preventDefault`, in an editable field, or over an open dialog.
- Enter in the address bar reloads when it is the current page, because WKWebView does not navigate to the URL it already shows.
- Thumb-button release navigates history directly and prevents the default, so wry's fallback cannot navigate a second time.
- `⌘W` tries the browser, then file tabs, then the pane. `requestCloseActiveBrowserTab()` reports whether it consumed it.

## Find in page

WKWebView exposes no find API through wry, so search is a page script over `browser:evaluate`. It wraps matches in a custom element, and closing restores the text nodes. The find bar is a layout row, not an overlay, because the page must stay visible while the highlights live inside it.

The focused panel claims `⌘F`. Scoping the claim to focus inside the chrome made it depend on the last click, because WebKit leaves focus on `<body>` after a button click. A `[role="dialog"]` on top keeps its own `⌘F`.

Matching is per text node, so a query across an element boundary is not found. `<input>` values are not searched.

## 1Password autofill

`browser:fill-credentials` invokes `op`, matching the page domain at a dot boundary. Fills require HTTPS or loopback and must match the initial origin.

`op` runs with `OP_BIOMETRIC_UNLOCK_ENABLED=true` unless the shell sets it. The app integration is the only sign-in path, because there is no terminal for `op signin`, and asking explicitly keeps `op` from silently listing zero accounts.

## Known limitations

- Agent input is synthetic (`isTrusted` is false), so a page that ignores untrusted events does not react.
- Extensions and native Safari autofill are unavailable in WKWebView child views.
- Google OAuth blocks embedded user agents. Use the open-external button.
- Downloads are not handled.
- Cookies persist in WKWebView's default store.
