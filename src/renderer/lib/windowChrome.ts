import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./tauriBridge.js";

// The macOS overlay titlebar (titleBarStyle: "Overlay") leaves the top strip to
// the web content. WKWebView ignores Chromium's `-webkit-app-region: drag`, so
// Argmax implements drag and double-click zoom through the Tauri window API.
//
// We act only when the mousedown target *is* a marked element (exact match, not
// a descendant), so interactive children inside a header stay clickable without
// needing per-child opt-outs. Mark drag handles with `data-window-drag`.
function installWindowChrome(): void {
  if (!isTauriRuntime()) return;
  window.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return; // primary button only
    const target = event.target;
    if (!(target instanceof Element) || !target.hasAttribute("data-window-drag")) return;
    const appWindow = getCurrentWindow();
    if (event.detail === 2) {
      void appWindow.toggleMaximize(); // double-click → zoom, like every other macOS app
    } else {
      void appWindow.startDragging();
    }
  });
}

// Mirrors document visibility onto the root element so CSS can stop the app's
// decorative loops while nobody is watching — see styles/motion.css. Runs
// outside the Tauri guard: the browser demo harness and the mobile surface both
// benefit, and it costs one attribute write per visibility change.
function installDocumentVisibility(): void {
  const sync = (): void => {
    document.documentElement.dataset.documentHidden = String(document.hidden);
  };
  document.addEventListener("visibilitychange", sync);
  sync();
}

/**
 * ⌘+/⌘− zoom the page, and page zoom scales CSS px — but the traffic lights are
 * AppKit's and stay the same size in window points whatever the page does. The
 * band the sidebar reserves for them is therefore expressed in CSS px divided
 * by this factor (styles/shell-layout.css), so it stays 44 points tall at every
 * zoom instead of shrinking under the buttons. The backend owns the value
 * (menu.rs) and restates it on every load, so a reload never leaves a stale one
 * behind.
 */
export function applyWindowZoom(factor: number): void {
  const safe = Number.isFinite(factor) && factor > 0 ? factor : 1;
  document.documentElement.style.setProperty("--app-zoom", String(safe));
}

function installWindowZoom(): void {
  window.argmax?.system?.onZoom?.(applyWindowZoom);
}

installWindowChrome();
installDocumentVisibility();
installWindowZoom();
