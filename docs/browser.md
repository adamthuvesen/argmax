# Browser Panel

Argmax browses inside the review panel: Browser is one of its modes, beside Changes, Files, Agents, and [Terminal](terminal.md). Links from chat open in the system browser by default; Settings → General → "Web links from chat" can route them to the in-app browser (⌘-click toggles the alternate target). The session actions menu has an "Open browser" item, and the panel's own tab strip has a Browser tab, shown only where the desktop bridge provides `window.argmax.browser` — the mobile remote has none, so the tab is hidden there.

## One Surface, One Owner

There is a single native browser surface, so exactly one review panel shows it at a time. The owner is whichever panel most recently *entered* Browser mode, not the focused one: clicking into another pane's chat leaves the page where it is, while that pane switching to Browser takes it over deliberately. A panel that has been demoted stays in Browser mode and shows a "The browser moved to another pane" placeholder whose "Show here" button claims the surface back.

Focus still routes new open requests: a chat link or the menu item opens Browser mode in the focused pane, or in the launcher when it is the only surface on screen. Ownership lives in [browserPanel.ts](../src/renderer/lib/browserPanel.ts) (`claimBrowserSurface` / `releaseBrowserSurface`), and [useReviewState.ts](../src/renderer/hooks/useReviewState.ts) claims on entering Browser mode and releases on leaving it, closing the panel, or unmounting the pane. Moving the browser between panes is therefore a plain unmount/mount: the unmount hides the webview, the mount re-glues it to the new panel's surface.

## Architecture

- **Renderer UI:** [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) fills the review panel's body with navigation controls, address bar with search fallback, 1Password autofill button, and tab strip. Tab list state lives in [browserPanel.ts](../src/renderer/lib/browserPanel.ts); browsing history persists in `localStorage` via [browserHistory.ts](../src/renderer/lib/browserHistory.ts).
- **Native WebViews:** [src-tauri/src/ipc/browser.rs](../src-tauri/src/ipc/browser.rs) creates one child webview per tab (`browser-<tabId>`) on the main window using Tauri's `Window::add_child` API (`unstable` cargo feature).
- **Positioning:** The renderer measures `.browser-panel-surface` and calls `browser:set-bounds` for the active tab. Inactive tabs are hidden. The review panel's own resizer and side preference need no browser-specific handling — a ResizeObserver on the surface re-glues the webview whenever the panel's width changes.

## Z-Order and Overlays

Native child webviews render on top of DOM elements. [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) checks for open `[role="dialog"]` modals intersecting the surface bounds and sets `visible: false` while an overlay covers the panel area.

## IPC Channels

- **Request:** `browser:open`, `browser:navigate`, `browser:back`, `browser:forward`, `browser:reload`, `browser:stop`, `browser:set-bounds`, `browser:close`, `browser:fill-credentials`.
- **Push:** `browser:state` (`{ tabId, url, title, loading }`), `browser:new-tab` (popups routed via `argmax-newtab:` scheme), and `browser:page-command` (key shortcuts and mouse thumb-button history clicks passed from webview).

Closing a tab (`browser:close`) disposes the webview. Leaving Browser mode sets `visible: false` to preserve page session state and scroll position.

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
