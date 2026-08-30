# Browser Panel

Argmax provides a tabbed browser panel in a right-hand dock. Links from chat open in the system browser by default; Settings → General → "Web links from chat" can route them to the in-app panel (⌘-click toggles the alternate target).

## Architecture

- **Renderer UI:** [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) renders navigation controls, address bar with search fallback, 1Password autofill button, and tab strip. Tab list state lives in [browserPanel.ts](../src/renderer/lib/browserPanel.ts); browsing history persists in `localStorage` via [browserHistory.ts](../src/renderer/lib/browserHistory.ts).
- **Native WebViews:** [src-tauri/src/ipc/browser.rs](../src-tauri/src/ipc/browser.rs) creates one child webview per tab (`browser-<tabId>`) on the main window using Tauri's `Window::add_child` API (`unstable` cargo feature).
- **Positioning:** The renderer measures `.browser-panel-surface` and calls `browser:set-bounds` for the active tab. Inactive tabs are hidden.

## Z-Order and Overlays

Native child webviews render on top of DOM elements. [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx) checks for open `[role="dialog"]` modals intersecting the surface bounds and sets `visible: false` while an overlay covers the panel area.

## IPC Channels

- **Request:** `browser:open`, `browser:navigate`, `browser:back`, `browser:forward`, `browser:reload`, `browser:stop`, `browser:set-bounds`, `browser:close`, `browser:fill-credentials`.
- **Push:** `browser:state` (`{ tabId, url, title, loading }`), `browser:new-tab` (popups routed via `argmax-newtab:` scheme), and `browser:page-command` (key shortcuts passed from webview).

Closing a tab (`browser:close`) disposes the webview. Hiding the panel sets `visible: false` to preserve page session state and scroll position.

## Shortcuts

- `⌘L`: Focus address bar.
- `⌘T`: New tab.
- `⌘⇧T`: Reopen last closed tab.
- `⌘R`: Reload (when focused in panel chrome).
- `⌃Tab` / `⌃⇧Tab`: Next / previous tab.
- `⌘W`: Closes the active tab when browser has focus.

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
