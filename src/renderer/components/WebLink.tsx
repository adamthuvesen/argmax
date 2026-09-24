import type { ComponentPropsWithoutRef, JSX } from "react";
import { openInBrowserPanel } from "../lib/browserPanel.js";
import { readStoredLinkTarget } from "../lib/linkTarget.js";
import { isRemoteBridge } from "../lib/tauriBridge.js";
import { isSecondaryWindow } from "../lib/windowRole.js";
import { withToast } from "../lib/withToast.js";
import { showToast } from "../state/toast.js";

type WebLinkProps = Omit<ComponentPropsWithoutRef<"a">, "href"> & { href: string };

/**
 * An `http(s)` link in the chat surface, wherever it came from: an assistant
 * markdown anchor or a URL the user pasted into a prompt.
 *
 * Plain click follows the configured link target (Settings → General);
 * ⌘/Ctrl-click opens in the other one. The system browser needs an explicit
 * `system:open-path` — the Tauri webview swallows target="_blank" navigation,
 * so an unhandled click would do nothing. The anchor default stays only for
 * the browser demo, where window.argmax is absent.
 */
export function WebLink({ href, children, onClick, ...rest }: WebLinkProps): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        // Over the remote bridge both routes are desktop-only: the browser
        // pane and system:open-path would open the link on the host, not in
        // the reader's hand. Let the anchor's own target="_blank" carry it
        // into the phone's browser.
        if (!isRemoteBridge()) {
          const flipped = event.metaKey || event.ctrlKey;
          // A torn-off chat window has no browser surface to open the link in
          // (docs/browser.md); the system browser takes it instead.
          if (!isSecondaryWindow() && (readStoredLinkTarget() === "argmax") !== flipped) {
            event.preventDefault();
            openInBrowserPanel(href, { newTab: true });
          } else if (window.argmax) {
            event.preventDefault();
            const api = window.argmax;
            void withToast(() => api.system.openPath({ path: href }), showToast, "Could not open this link.");
          }
        }
        // After the link is handed off. A caller can dismiss a dialog here
        // without replacing the open.
        onClick?.(event);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
