import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { COMPOSER_MIN_WIDTH_PX } from "../lib/layoutConstants.js";

const SIDEBAR_WIDTH_KEY = "argmax.sidebar.width";
export const SIDEBAR_MIN_WIDTH_PX = 220;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 272;
export const SIDEBAR_AUTO_EXPAND_HYSTERESIS_PX = 24;
export const DEFAULT_WORKSPACE_MIN_WIDTH_PX = COMPOSER_MIN_WIDTH_PX;

function normalizedWorkspaceMinWidth(workspaceMinWidth: number): number {
  if (!Number.isFinite(workspaceMinWidth)) return DEFAULT_WORKSPACE_MIN_WIDTH_PX;
  return Math.max(DEFAULT_WORKSPACE_MIN_WIDTH_PX, Math.ceil(workspaceMinWidth));
}

/**
 * Down to the nearest even pixel. The sidebar sets where the chat pane starts,
 * so an odd width puts the transcript's whole reading column — and every
 * activity mark in it — on an odd pixel. On a 4K panel driven at "looks like
 * 2560x1440" two CSS pixels are exactly three physical ones, so odd positions
 * land mid-pixel and the marks straddle the panel grid. The floors and the
 * default are already even; this keeps a drag from landing between them.
 */
function toEvenPx(width: number): number {
  return Math.floor(width / 2) * 2;
}

function sidebarMaxForViewport(workspaceMinWidth: number, viewportWidth: number): number {
  const workspaceMin = normalizedWorkspaceMinWidth(workspaceMinWidth);
  return Math.max(SIDEBAR_MIN_WIDTH_PX, toEvenPx(Math.min(SIDEBAR_MAX, viewportWidth - workspaceMin)));
}

function clampSidebarWidth(width: number, workspaceMinWidth: number, viewportWidth: number): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH_PX,
    Math.min(sidebarMaxForViewport(workspaceMinWidth, viewportWidth), toEvenPx(width))
  );
}

function clampSavedSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH_PX, Math.min(SIDEBAR_MAX, width));
}

export interface SidebarResizeState {
  /** Current expanded-layout sidebar width in CSS pixels. */
  sidebarWidth: number;
  /** True when the sidebar is folded by the window-width responsive policy. */
  responsiveCollapsed: boolean;
  /** True while a drag is in flight — surface on the app shell so the grid can disable transitions. */
  isResizing: boolean;
  /** Bind on the resize handle's `onMouseDown`. */
  onResizeMouseDown: (event: ReactMouseEvent) => void;
}

/**
 * Sidebar drag-resize state machine.
 *
 * Owns: the saved width preference, the responsive width derived from the
 * viewport and workspace floor, the responsive fold state, in-progress flag,
 * localStorage round-trip, and document-level mousemove/mouseup listeners
 * during a drag. Automatic squeezing never overwrites the saved preference,
 * so a sidebar returns to its chosen width when the window grows again.
 */
export function useSidebarResize(workspaceMinWidth = DEFAULT_WORKSPACE_MIN_WIDTH_PX): SidebarResizeState {
  const workspaceMin = normalizedWorkspaceMinWidth(workspaceMinWidth);
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window === "undefined" ? 0 : window.innerWidth
  );
  const [savedSidebarWidth, setSavedSidebarWidth] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(SIDEBAR_WIDTH_KEY) : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return clampSavedSidebarWidth(Number.isFinite(n) ? n : SIDEBAR_DEFAULT);
  });
  const [isResizing, setIsResizing] = useState(false);
  const [responsiveCollapsed, setResponsiveCollapsed] = useState(() => {
    const initialViewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
    return initialViewportWidth <= workspaceMin + SIDEBAR_MIN_WIDTH_PX;
  });

  // Captures the listener-removal + body-style-reset for any drag currently
  // in flight; the unmount cleanup below replays it so a mid-drag unmount
  // doesn't leak document-level listeners or leave the cursor frozen.
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
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(savedSidebarWidth));
  }, [savedSidebarWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const collapseAt = workspaceMin + SIDEBAR_MIN_WIDTH_PX;
    const expandAt = collapseAt + SIDEBAR_AUTO_EXPAND_HYSTERESIS_PX;
    setResponsiveCollapsed((current) => {
      if (current) return viewportWidth < expandAt;
      return viewportWidth <= collapseAt;
    });
  }, [viewportWidth, workspaceMin]);

  const sidebarWidth = clampSidebarWidth(savedSidebarWidth, workspaceMin, viewportWidth);

  const onResizeMouseDown = useCallback(
    (event: ReactMouseEvent): void => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      setIsResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (e: MouseEvent): void => {
        setSavedSidebarWidth(
          clampSidebarWidth(startWidth + (e.clientX - startX), workspaceMin, viewportWidth)
        );
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
    [sidebarWidth, viewportWidth, workspaceMin]
  );

  return { sidebarWidth, responsiveCollapsed, isResizing, onResizeMouseDown };
}
