import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX
} from "react";
import { ArrowLeft, ArrowRight, ExternalLink, KeyRound, RotateCw, X } from "lucide-react";
import type { BrowserBounds } from "../../shared/types.js";
import { normalizeBrowserUrl } from "../lib/browserPanel.js";

interface BrowserPanelProps {
  /** Normalized http(s) URL the pane should show. */
  url: string;
  onClose: () => void;
}

/**
 * Chrome for the native browser child webview. The webview is a sibling
 * native view glued onto `.browser-panel-surface` via `browser:set-bounds`;
 * it always paints above the renderer DOM, so this component hides it
 * whenever any `[role="dialog"]` overlay is open.
 */
export function BrowserPanel({ url, onClose }: BrowserPanelProps): JSX.Element {
  const browser = window.argmax?.browser ?? null;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(false);
  const overlayOpenRef = useRef(false);
  const [addressValue, setAddressValue] = useState(url);
  const [addressEditing, setAddressEditing] = useState(false);
  const [pageUrl, setPageUrl] = useState(url);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);

  const measureBounds = useCallback((): BrowserBounds | null => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, []);

  const syncBounds = useCallback(() => {
    if (!browser || !readyRef.current) return;
    const bounds = measureBounds();
    if (!bounds) return;
    void browser
      .setBounds({ bounds, visible: !overlayOpenRef.current })
      .catch(() => undefined);
  }, [browser, measureBounds]);

  // Create (or re-show) the native webview once the placeholder has a size.
  useEffect(() => {
    if (!browser) return;
    let cancelled = false;
    const bounds = measureBounds();
    if (!bounds) return;
    void browser
      .open({ url, bounds })
      .then(() => {
        if (cancelled) return;
        readyRef.current = true;
        syncBounds();
      })
      .catch((error: unknown) => {
        if (!cancelled) showNotice(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      // Hide instead of destroy: history and session survive a reopen.
      if (readyRef.current) void browser.close().catch(() => undefined);
      readyRef.current = false;
    };
    // `url` changes are handled by the navigation effect below; the webview
    // itself is created once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser]);

  // Later open requests while mounted navigate the existing webview.
  useEffect(() => {
    if (!browser || !readyRef.current) return;
    setAddressValue(url);
    setPageUrl(url);
    void browser.navigate(url).catch((error: unknown) => {
      showNotice(error instanceof Error ? error.message : String(error));
    });
  }, [browser, showNotice, url]);

  // Keep the native view glued to the placeholder.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const observer = new ResizeObserver(() => syncBounds());
    observer.observe(surface);
    window.addEventListener("resize", syncBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [syncBounds]);

  // Yield to renderer overlays: the native webview covers dropdowns and
  // dialogs otherwise. Any [role="dialog"] in the DOM hides the webview.
  useEffect(() => {
    const update = (): void => {
      const overlayOpen = document.querySelector('[role="dialog"]') !== null;
      if (overlayOpen === overlayOpenRef.current) return;
      overlayOpenRef.current = overlayOpen;
      syncBounds();
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    update();
    return () => observer.disconnect();
  }, [syncBounds]);

  // Track navigation from inside the webview (link clicks, redirects).
  useEffect(() => {
    if (!browser) return;
    const subscription = browser.onState((event) => {
      setPageUrl(event.url);
      if (!addressEditing) setAddressValue(event.url);
    });
    return () => subscription();
  }, [addressEditing, browser]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    []
  );

  const handleAddressSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!browser) return;
    const normalized = normalizeBrowserUrl(addressValue);
    if (!normalized) {
      showNotice("Enter a web address (http/https).");
      return;
    }
    setAddressEditing(false);
    void browser.navigate(normalized).catch((error: unknown) => {
      showNotice(error instanceof Error ? error.message : String(error));
    });
  };

  const handleFillCredentials = (): void => {
    if (!browser) return;
    showNotice("Waiting for 1Password…");
    void browser
      .fillCredentials()
      .then((result) => showNotice(`Filled from 1Password: ${result.itemTitle}`))
      .catch((error: unknown) => {
        showNotice(error instanceof Error ? error.message : String(error));
      });
  };

  const handleOpenExternal = (): void => {
    void window.argmax?.system.openPath({ path: pageUrl }).catch(() => undefined);
  };

  if (!browser) {
    return (
      <aside className="browser-panel" aria-label="Browser">
        <div className="browser-panel-fallback">Browser pane needs the desktop app.</div>
      </aside>
    );
  }

  return (
    <aside className="browser-panel" aria-label="Browser">
      <div className="browser-panel-toolbar">
        <button type="button" title="Back" aria-label="Back" onClick={() => void browser.back()}>
          <ArrowLeft size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Forward"
          aria-label="Forward"
          onClick={() => void browser.forward()}
        >
          <ArrowRight size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Reload"
          aria-label="Reload"
          onClick={() => void browser.reload()}
        >
          <RotateCw size={14} strokeWidth={1.75} />
        </button>
        <form className="browser-panel-address" onSubmit={handleAddressSubmit}>
          <input
            type="text"
            aria-label="Address"
            value={addressValue}
            spellCheck={false}
            onFocus={() => setAddressEditing(true)}
            onBlur={() => setAddressEditing(false)}
            onChange={(event) => setAddressValue(event.target.value)}
          />
        </form>
        <button
          type="button"
          title="Fill login from 1Password"
          aria-label="Fill login from 1Password"
          onClick={handleFillCredentials}
        >
          <KeyRound size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Open in default browser"
          aria-label="Open in default browser"
          onClick={handleOpenExternal}
        >
          <ExternalLink size={14} strokeWidth={1.75} />
        </button>
        <button type="button" title="Close browser" aria-label="Close browser" onClick={onClose}>
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
      {notice ? (
        <div className="browser-panel-notice" role="status">
          {notice}
        </div>
      ) : null}
      <div ref={surfaceRef} className="browser-panel-surface" />
    </aside>
  );
}
