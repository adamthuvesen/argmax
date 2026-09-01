import type { ComponentPropsWithoutRef, JSX } from "react";
import { openInBrowserPanel } from "../lib/browserPanel.js";
import { readStoredLinkTarget } from "../lib/linkTarget.js";
import { isRemoteBridge } from "../lib/tauriBridge.js";

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
export function WebLink({ href, children, ...rest }: WebLinkProps): JSX.Element {
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
        if (isRemoteBridge()) return;
        const flipped = event.metaKey || event.ctrlKey;
        if ((readStoredLinkTarget() === "argmax") !== flipped) {
          event.preventDefault();
          openInBrowserPanel(href);
          return;
        }
        if (!window.argmax) return;
        event.preventDefault();
        void window.argmax.system.openPath({ path: href }).catch(() => undefined);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
