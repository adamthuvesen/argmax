import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

const BROWSER_WIDTH_KEY = "argmax.browser.width";
const BROWSER_MIN = 320;
const BROWSER_MAX = 900;
const BROWSER_DEFAULT = 420;
/** Room the sidebar + conversation keep no matter how wide the panel drags. */
const WORK_AREA_MIN = 560;

function browserMaxForViewport(): number {
  if (typeof window === "undefined") return BROWSER_MAX;
  return Math.max(BROWSER_MIN, Math.min(BROWSER_MAX, window.innerWidth - WORK_AREA_MIN));
}

function clampBrowserWidth(width: number): number {
  return Math.max(BROWSER_MIN, Math.min(browserMaxForViewport(), width));
}

export interface BrowserPanelResizeState {
  /** Current panel width in CSS pixels, persisted to localStorage. */
  browserPanelWidth: number;
  /** True while a drag is in flight — disables grid transitions on the shell. */
  isResizingBrowserPanel: boolean;
  /** Bind on the panel's left-edge resize handle. */
  onBrowserResizeMouseDown: (event: ReactMouseEvent) => void;
}

/**
 * Drag-resize for the browser panel's left edge. Same state machine as
 * useSidebarResize, mirrored for a right-docked panel: dragging left grows
 * the panel, so width moves opposite to the pointer.
 */
export function useBrowserPanelResize(): BrowserPanelResizeState {
  const [browserPanelWidth, setBrowserPanelWidth] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(BROWSER_WIDTH_KEY) : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return clampBrowserWidth(Number.isFinite(n) ? n : BROWSER_DEFAULT);
  });
  const [isResizingBrowserPanel, setIsResizing] = useState(false);

  // Replayed on unmount so a mid-drag unmount doesn't leak document-level
  // listeners or leave the cursor frozen.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(BROWSER_WIDTH_KEY, String(browserPanelWidth));
  }, [browserPanelWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = (): void => setBrowserPanelWidth((current) => clampBrowserWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onBrowserResizeMouseDown = useCallback(
    (event: ReactMouseEvent): void => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = browserPanelWidth;
      setIsResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (e: MouseEvent): void => {
        setBrowserPanelWidth(clampBrowserWidth(startWidth - (e.clientX - startX)));
      };
      const cleanup = (): void => {
        setIsResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        dragCleanupRef.current = null;
      };
      const onMouseUp = (): void => cleanup();
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      dragCleanupRef.current = cleanup;
    },
    [browserPanelWidth]
  );

  return { browserPanelWidth, isResizingBrowserPanel, onBrowserResizeMouseDown };
}
