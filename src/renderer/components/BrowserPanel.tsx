import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { ArrowLeft, ArrowRight, ExternalLink, KeyRound, Plus, RotateCw, X } from "lucide-react";
import type { BrowserBounds } from "../../shared/types.js";
import { errorMessage } from "../../shared/error.js";
import {
  recordBrowserVisit,
  suggestBrowserHistory,
  type BrowserHistoryEntry
} from "../lib/browserHistory.js";
import {
  activateBrowserTab,
  createBrowserTab,
  DEFAULT_BROWSER_URL,
  getActiveBrowserTabId,
  getBrowserTabs,
  isBrowserTabMaterialized,
  markBrowserTabMaterialized,
  onBrowserCloseActiveTabRequest,
  popRecentlyClosedBrowserTab,
  rememberBrowserUrl,
  resolveBrowserInput,
  removeBrowserTab,
  setBrowserTabLoading,
  subscribeBrowserTabs,
  unmarkBrowserTabMaterialized,
  updateBrowserTabState,
  type BrowserTab
} from "../lib/browserPanel.js";
import { WorkingNest } from "./WorkingNest.js";

interface BrowserPanelProps {
  /** Normalized http(s) URL the pane should show. */
  url: string;
  /**
   * Bumped on every open-in-pane request, so asking again for the URL the
   * pane was last sent to still re-navigates after the user browsed away.
   */
  requestSeq?: number;
  onClose: () => void;
  /** Bind for the left-edge width drag; absent hides the handle. */
  onResizeMouseDown?: (event: ReactMouseEvent) => void;
}

/** Tab label: page title once loaded, host until then. */
function tabLabel(tab: BrowserTab): string {
  if (tab.title) return tab.title;
  try {
    return new URL(tab.url).host;
  } catch {
    return tab.url;
  }
}

/** Site favicon with a first-letter fallback when the host serves none. */
function TabFavicon({ url }: { url: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    // Not a parseable URL: fall through to the letter fallback.
  }
  if (!host || failed) {
    return (
      <span className="browser-tab-favicon browser-tab-favicon-fallback" aria-hidden>
        {(host || url).charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="browser-tab-favicon"
      src={`https://${host}/favicon.ico`}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Chrome for the native browser tabs. Each tab is its own child webview glued
 * onto `.browser-panel-surface` via `browser:set-bounds`; only the active
 * tab's webview is visible, the rest stay hidden but alive. Native webviews
 * always paint above the renderer DOM, so this component hides the active one
 * whenever a `[role="dialog"]` overlay actually overlaps the surface.
 */
export function BrowserPanel({ url, requestSeq, onClose, onResizeMouseDown }: BrowserPanelProps): JSX.Element {
  const browser = window.argmax?.browser ?? null;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  /** What the user typed, before ↑/↓ started swapping in suggestions. */
  const typedValueRef = useRef("");
  const overlayOpenRef = useRef(false);
  const tabs = useSyncExternalStore(subscribeBrowserTabs, getBrowserTabs);
  const activeTabId = useSyncExternalStore(subscribeBrowserTabs, getActiveBrowserTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const [addressValue, setAddressValue] = useState(activeTab?.url ?? url);
  // Ref, not state: it's only read inside event handlers, and a state dep
  // would resubscribe the onState listener on every focus/blur/keystroke —
  // Tauri re-registration is async, so events emitted in that gap are lost.
  const addressEditingRef = useRef(false);
  const [suggestions, setSuggestions] = useState<BrowserHistoryEntry[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);

  const reportError = useCallback(
    (error: unknown): void => showNotice(errorMessage(error)),
    [showNotice]
  );

  const measureBounds = useCallback((): BrowserBounds | null => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, []);

  /** True when a `[role="dialog"]` overlay's box overlaps `bounds`. Only those
   *  need the webview out of the way — a dialog scoped to a session pane sits
   *  in another column and never covers the page. */
  const overlaysSurface = useCallback((bounds: BrowserBounds): boolean => {
    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    return Array.from(document.querySelectorAll('[role="dialog"]')).some((overlay) => {
      const rect = overlay.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return rect.left < right && rect.right > bounds.x && rect.top < bottom && rect.bottom > bounds.y;
    });
  }, []);

  /** Re-glue the active tab's webview to the surface (or hide it under overlays). */
  const syncBounds = useCallback(() => {
    const tabId = getActiveBrowserTabId();
    if (!browser || !tabId) return;
    const bounds = measureBounds();
    if (!bounds) return;
    overlayOpenRef.current = overlaysSurface(bounds);
    void browser
      .setBounds({ bounds, visible: !overlayOpenRef.current, tabId })
      .catch(() => undefined);
  }, [browser, measureBounds, overlaysSurface]);

  /** Create the tab's webview, or navigate + show it when it already exists. */
  const openTabWebview = useCallback(
    (tab: BrowserTab): void => {
      if (!browser) return;
      const bounds = measureBounds();
      if (!bounds) return;
      markBrowserTabMaterialized(tab.id);
      void browser
        .open({ url: tab.url, bounds, tabId: tab.id })
        // browser:open always shows the webview; re-sync so an overlay that
        // is open right now (palette, dialog) stays on top of it.
        .then(() => syncBounds())
        .catch((error: unknown) => {
          // Un-mark, or the tab is a zombie: every later command would hit a
          // webview label that was never created.
          unmarkBrowserTabMaterialized(tab.id);
          reportError(error);
        });
    },
    [browser, measureBounds, reportError, syncBounds]
  );

  /** Show a tab's webview, recreating it first when this app run has not
   *  materialized it yet (tabs restored from a previous run). */
  const showTabWebview = useCallback(
    (tab: BrowserTab): void => {
      if (isBrowserTabMaterialized(tab.id)) {
        syncBounds();
      } else {
        openTabWebview(tab);
      }
    },
    [openTabWebview, syncBounds]
  );

  const hideTabWebview = useCallback(
    (tabId: string): void => {
      if (!browser) return;
      void browser
        .setBounds({ bounds: { x: 0, y: 0, width: 1, height: 1 }, visible: false, tabId })
        .catch(() => undefined);
    },
    [browser]
  );

  const switchToTab = useCallback(
    (tabId: string): void => {
      const previous = getActiveBrowserTabId();
      if (previous === tabId) return;
      if (previous) hideTabWebview(previous);
      activateBrowserTab(tabId);
      const tab = getBrowserTabs().find((candidate) => candidate.id === tabId);
      if (tab) showTabWebview(tab);
    },
    [hideTabWebview, showTabWebview]
  );

  const cycleTab = useCallback(
    (step: 1 | -1): void => {
      const list = getBrowserTabs();
      if (list.length < 2) return;
      const index = list.findIndex((tab) => tab.id === getActiveBrowserTabId());
      const next = list[(index + step + list.length) % list.length];
      if (next) switchToTab(next.id);
    },
    [switchToTab]
  );

  const addTab = useCallback((): void => {
    const previous = getActiveBrowserTabId();
    if (previous) hideTabWebview(previous);
    openTabWebview(createBrowserTab(DEFAULT_BROWSER_URL));
  }, [hideTabWebview, openTabWebview]);

  const closeTab = useCallback(
    (tabId: string): void => {
      void browser?.close(tabId).catch(() => undefined);
      const nextActive = removeBrowserTab(tabId);
      if (getBrowserTabs().length === 0) {
        onClose();
        return;
      }
      // showTabWebview, not syncBounds: the promoted neighbor may be a
      // restored tab whose webview doesn't exist yet in this app run.
      if (nextActive) showTabWebview(nextActive);
    },
    [browser, onClose, showTabWebview]
  );

  // Route open-in-pane requests: no tabs yet creates the first one; otherwise
  // the active tab navigates — unless it is already on that URL, so reopening
  // the pane does not force a reload. A tab restored from a previous run has
  // no webview yet; opening it recreates one at the requested URL.
  useEffect(() => {
    if (!browser) return;
    const active = getBrowserTabs().find((tab) => tab.id === getActiveBrowserTabId()) ?? null;
    if (!active) {
      openTabWebview(createBrowserTab(url));
      return;
    }
    if (active.url !== url) {
      setAddressValue(url);
      updateBrowserTabState(active.id, url, null);
    }
    if (!isBrowserTabMaterialized(active.id)) {
      openTabWebview({ ...active, url });
      return;
    }
    syncBounds();
    if (active.url === url) return;
    void browser.navigate(url, active.id).catch(reportError);
  }, [browser, openTabWebview, reportError, requestSeq, syncBounds, url]);

  // Popups / target="_blank" inside a page arrive as new-tab events.
  useEffect(() => {
    if (!browser) return;
    const subscription = browser.onNewTab((event) => {
      const active = getActiveBrowserTabId();
      if (event.tabId !== active) {
        // A hidden background tab opened a popup (timer, ad): add the tab
        // without stealing focus. It materializes on first activation.
        createBrowserTab(event.url, false);
        return;
      }
      if (active) hideTabWebview(active);
      openTabWebview(createBrowserTab(event.url));
    });
    return () => subscription();
  }, [browser, hideTabWebview, openTabWebview]);

  const goBack = useCallback(
    (tabId: string): void => {
      void browser?.back(tabId).catch(reportError);
    },
    [browser, reportError]
  );

  const goForward = useCallback(
    (tabId: string): void => {
      void browser?.forward(tabId).catch(reportError);
    },
    [browser, reportError]
  );

  // Shortcuts pressed while the page itself has focus never reach renderer
  // JS; the webview init script intercepts them and Rust relays them here.
  useEffect(() => {
    if (!browser) return;
    const subscription = browser.onPageCommand((event) => {
      if (event.command === "back") {
        goBack(event.tabId);
        return;
      }
      if (event.command === "forward") {
        goForward(event.tabId);
        return;
      }
      if (event.command === "close-tab") {
        closeTab(event.tabId);
        return;
      }
      if (event.command === "new-tab") {
        addTab();
        return;
      }
      if (event.command === "focus-address") {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      }
    });
    return () => subscription();
  }, [addTab, browser, closeTab, goBack, goForward]);

  // Mouse thumb buttons over the pane chrome (toolbar, tab strip). Clicks
  // landing on the page itself go to the native webview instead and come back
  // as browser:page-command events.
  useEffect(() => {
    if (!browser) return;
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return;
      const panel = panelRef.current;
      if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return;
      const active = getActiveBrowserTabId();
      if (!active) return;
      event.preventDefault();
      if (event.button === 3) goBack(active);
      else goForward(active);
    };
    document.addEventListener("mouseup", onMouseUp, true);
    return () => document.removeEventListener("mouseup", onMouseUp, true);
  }, [browser, goBack, goForward]);

  // Menu ⌘W with the pane open: App routes it here to close the active tab.
  useEffect(
    () =>
      onBrowserCloseActiveTabRequest(() => {
        const active = getActiveBrowserTabId();
        if (active) closeTab(active);
      }),
    [closeTab]
  );

  // Hide the active webview when the panel unmounts; the tab store and the
  // native webviews survive, so reopening restores every tab's session.
  useEffect(
    () => () => {
      const tabId = getActiveBrowserTabId();
      if (tabId) {
        void window.argmax?.browser
          .setBounds({ bounds: { x: 0, y: 0, width: 1, height: 1 }, visible: false, tabId })
          .catch(() => undefined);
      }
    },
    []
  );

  // Keep the active native view glued to the placeholder.
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
  // dialogs otherwise. Only overlays whose box reaches the surface hide it.
  useEffect(() => {
    const update = (): void => {
      // Streaming chat fires this on every DOM batch, so take the cheap
      // selector first and measure rects only once an overlay exists.
      const anyOverlay = document.querySelector('[role="dialog"]') !== null;
      if (!anyOverlay && !overlayOpenRef.current) return;
      const bounds = measureBounds();
      if (!bounds) return;
      if (overlaysSurface(bounds) === overlayOpenRef.current) return;
      syncBounds();
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    update();
    return () => observer.disconnect();
  }, [measureBounds, overlaysSurface, syncBounds]);

  // Track navigation inside any tab's webview (link clicks, redirects).
  // WKWebView only reports load start and finish — a failed, cancelled, or
  // stopped load never finishes, so a watchdog clears the spinner when no
  // further event arrives for a loading tab.
  const loadingTimersRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!browser) return;
    const timers = loadingTimersRef.current;
    const subscription = browser.onState((event) => {
      updateBrowserTabState(event.tabId, event.url, event.title);
      setBrowserTabLoading(event.tabId, event.loading);
      const timer = timers.get(event.tabId);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.delete(event.tabId);
      if (event.loading) {
        timers.set(
          event.tabId,
          window.setTimeout(() => setBrowserTabLoading(event.tabId, false), 20_000)
        );
      }
      rememberBrowserUrl(event.url);
      if (!event.loading) recordBrowserVisit(event.url, event.title);
      if (event.tabId === getActiveBrowserTabId() && !addressEditingRef.current) {
        setAddressValue(event.url);
      }
    });
    // Re-arm for tabs already mid-load: the effect re-subscribes on address
    // focus changes, and cleanup below dropped their timers.
    for (const tab of getBrowserTabs()) {
      if (tab.loading && !timers.has(tab.id)) {
        timers.set(
          tab.id,
          window.setTimeout(() => setBrowserTabLoading(tab.id, false), 20_000)
        );
      }
    }
    return () => {
      subscription();
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, [browser]);

  // Switching tabs swaps the address bar to the new tab's URL.
  useEffect(() => {
    if (!addressEditingRef.current) setAddressValue(activeTab?.url ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the tab switch resets the field
  }, [activeTabId]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    []
  );

  const closeSuggestions = useCallback((): void => {
    setSuggestions([]);
    setSuggestionIndex(-1);
  }, []);

  const navigateTo = useCallback(
    (raw: string): void => {
      if (!browser || !activeTabId) return;
      const destination = resolveBrowserInput(raw);
      if (!destination) return;
      addressEditingRef.current = false;
      closeSuggestions();
      void browser.navigate(destination, activeTabId).catch(reportError);
    },
    [activeTabId, browser, closeSuggestions, reportError]
  );

  const handleAddressSubmit = (event: FormEvent): void => {
    event.preventDefault();
    navigateTo(addressValue);
  };

  const handleAddressKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (suggestionIndex + step + suggestions.length + 1) % (suggestions.length + 1);
      const index = next === suggestions.length ? -1 : next;
      setSuggestionIndex(index);
      // Cycling past the ends restores what the user actually typed.
      setAddressValue(index === -1 ? typedValueRef.current : (suggestions[index]?.url ?? ""));
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSuggestions();
    }
  };

  // Panel-wide shortcuts. ⌘L and ⌘T work from anywhere while the panel is
  // open (the app claims neither); ⌘W/⌘R only fire while focus is inside the
  // panel chrome, so they never shadow the app's Close Window and Reload.
  // Keys pressed inside a page land in the native webview instead — the
  // init-script intercept relays those as browser:page-command events.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      const key = event.key.toLowerCase();
      // ⌘⇧T reopens the most recently closed tab, from anywhere.
      if (event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey && key === "t") {
        const url = popRecentlyClosedBrowserTab();
        if (!url) return;
        event.preventDefault();
        const previous = getActiveBrowserTabId();
        if (previous) hideTabWebview(previous);
        openTabWebview(createBrowserTab(url));
        return;
      }
      if (!event.metaKey || event.altKey || event.shiftKey || event.ctrlKey) return;
      if (key === "l") {
        event.preventDefault();
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      }
      if (key === "t") {
        event.preventDefault();
        addTab();
        return;
      }
      // macOS WebKit leaves focus on <body> after button clicks, so this
      // guard only passes with focus in the address bar — fine for these
      // two, which must not shadow the app's own bindings.
      const panel = panelRef.current;
      if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return;
      if (key === "w") {
        event.preventDefault();
        const active = getActiveBrowserTabId();
        if (active) closeTab(active);
      } else if (key === "r") {
        event.preventDefault();
        const active = getActiveBrowserTabId();
        if (active) void browser?.reload(active).catch(reportError);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [addTab, browser, closeTab, cycleTab, hideTabWebview, openTabWebview, reportError]);

  const handleFillCredentials = (): void => {
    if (!browser || !activeTabId) return;
    showNotice("Waiting for 1Password…");
    void browser
      .fillCredentials(activeTabId)
      .then((result) => showNotice(`Filled from 1Password: ${result.itemTitle}`))
      .catch(reportError);
  };

  const handleOpenExternal = (): void => {
    if (!activeTab) return;
    void window.argmax?.system.openPath({ path: activeTab.url }).catch(() => undefined);
  };

  if (!browser) {
    return (
      <aside className="browser-panel" aria-label="Browser">
        <div className="browser-panel-fallback">Browser pane needs the desktop app.</div>
      </aside>
    );
  }

  return (
    <aside className="browser-panel" aria-label="Browser" ref={panelRef}>
      {onResizeMouseDown ? (
        <div className="browser-panel-resizer" aria-hidden="true" onMouseDown={onResizeMouseDown} />
      ) : null}
      <div className="browser-panel-toolbar">
        <button
          type="button"
          title="Back"
          aria-label="Back"
          onClick={() => activeTabId && goBack(activeTabId)}
        >
          <ArrowLeft size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Forward"
          aria-label="Forward"
          onClick={() => activeTabId && goForward(activeTabId)}
        >
          <ArrowRight size={14} strokeWidth={1.75} />
        </button>
        {activeTab?.loading ? (
          <button
            type="button"
            title="Stop loading"
            aria-label="Stop loading"
            onClick={() => {
              if (!activeTabId) return;
              void browser.stop(activeTabId).catch(reportError);
              // A stopped load never reports "finished" — clear the spinner now.
              setBrowserTabLoading(activeTabId, false);
            }}
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        ) : (
          <button
            type="button"
            title="Reload"
            aria-label="Reload"
            onClick={() => activeTabId && void browser.reload(activeTabId).catch(reportError)}
          >
            <RotateCw size={14} strokeWidth={1.75} />
          </button>
        )}
        <form className="browser-panel-address" onSubmit={handleAddressSubmit}>
          <input
            ref={addressInputRef}
            type="text"
            aria-label="Address"
            value={addressValue}
            spellCheck={false}
            onFocus={(event) => {
              addressEditingRef.current = true;
              typedValueRef.current = event.target.value;
              event.target.select();
              setSuggestions(suggestBrowserHistory(event.target.value));
              setSuggestionIndex(-1);
            }}
            onBlur={() => {
              addressEditingRef.current = false;
              closeSuggestions();
            }}
            onChange={(event) => {
              // Submitting clears the editing flag without blurring; typing
              // again must re-claim the field or a load event stomps it.
              addressEditingRef.current = true;
              setAddressValue(event.target.value);
              typedValueRef.current = event.target.value;
              setSuggestions(suggestBrowserHistory(event.target.value));
              setSuggestionIndex(-1);
            }}
            onKeyDown={handleAddressKeyDown}
          />
          {suggestions.length > 0 ? (
            // role="dialog" also makes the panel's overlay watcher hide the
            // native webview, which would otherwise paint over this popover.
            <div
              className="browser-address-suggestions"
              role="dialog"
              aria-label="History suggestions"
              // Keep focus in the input so blur doesn't unmount the popover
              // before a suggestion click lands.
              onMouseDown={(event) => event.preventDefault()}
            >
              {suggestions.map((entry, index) => (
                <button
                  key={entry.url}
                  type="button"
                  className="browser-address-suggestion"
                  data-active={index === suggestionIndex || undefined}
                  onClick={() => navigateTo(entry.url)}
                >
                  <span className="browser-address-suggestion-title">
                    {entry.title ?? entry.url}
                  </span>
                  {entry.title ? (
                    <span className="browser-address-suggestion-url">{entry.url}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
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
      <div className="browser-tab-strip" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="browser-tab"
            role="tab"
            aria-selected={tab.id === activeTabId}
            title={tab.url}
          >
            <button
              type="button"
              className="browser-tab-label"
              onClick={() => switchToTab(tab.id)}
            >
              {tab.loading ? (
                <WorkingNest active size={11} />
              ) : (
                <TabFavicon url={tab.url} />
              )}
              <span className="browser-tab-text">{tabLabel(tab)}</span>
            </button>
            <button
              type="button"
              className="browser-tab-close"
              aria-label={`Close tab ${tabLabel(tab)}`}
              onClick={() => closeTab(tab.id)}
            >
              <X size={11} strokeWidth={1.75} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="browser-tab-add"
          title="New tab"
          aria-label="New tab"
          onClick={addTab}
        >
          <Plus size={13} strokeWidth={1.75} />
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
