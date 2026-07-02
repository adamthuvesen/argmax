import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

const SIDEBAR_WIDTH_KEY = "argmax.sidebar.width";
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 272;
export const DEFAULT_WORKSPACE_MIN_WIDTH_PX = 320;

function normalizedWorkspaceMinWidth(workspaceMinWidth: number): number {
  if (!Number.isFinite(workspaceMinWidth)) return DEFAULT_WORKSPACE_MIN_WIDTH_PX;
  return Math.max(DEFAULT_WORKSPACE_MIN_WIDTH_PX, Math.ceil(workspaceMinWidth));
}

function sidebarMaxForViewport(workspaceMinWidth: number): number {
  if (typeof window === "undefined") return SIDEBAR_MAX;
  const workspaceMin = normalizedWorkspaceMinWidth(workspaceMinWidth);
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - workspaceMin));
}

function clampSidebarWidth(width: number, workspaceMinWidth: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(sidebarMaxForViewport(workspaceMinWidth), width));
}

export interface SidebarResizeState {
  /** Current sidebar width in CSS pixels, persisted to localStorage. */
  sidebarWidth: number;
  /** True while a drag is in flight — surface on the app shell so the grid can disable transitions. */
  isResizing: boolean;
  /** Bind on the resize handle's `onMouseDown`. */
  onResizeMouseDown: (event: ReactMouseEvent) => void;
}

/**
 * Sidebar drag-resize state machine.
 *
 * Owns: width state (clamped to [SIDEBAR_MIN, SIDEBAR_MAX]), in-progress flag,
 * localStorage round-trip, document-level mousemove/mouseup listeners during
 * a drag, and a cleanup ref that replays the listener-removal +
 * body-style-reset on unmount so a mid-drag unmount doesn't leak listeners
 * or freeze the body cursor.
 */
export function useSidebarResize(workspaceMinWidth = DEFAULT_WORKSPACE_MIN_WIDTH_PX): SidebarResizeState {
  const workspaceMin = normalizedWorkspaceMinWidth(workspaceMinWidth);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(SIDEBAR_WIDTH_KEY) : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return clampSidebarWidth(Number.isFinite(n) ? n : SIDEBAR_DEFAULT, workspaceMin);
  });
  const [isResizing, setIsResizing] = useState(false);

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
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = (): void => setSidebarWidth((current) => clampSidebarWidth(current, workspaceMin));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [workspaceMin]);

  useEffect(() => {
    setSidebarWidth((current) => clampSidebarWidth(current, workspaceMin));
  }, [workspaceMin]);

  const onResizeMouseDown = useCallback(
    (event: ReactMouseEvent): void => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      setIsResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (e: MouseEvent): void => {
        setSidebarWidth(clampSidebarWidth(startWidth + (e.clientX - startX), workspaceMin));
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
    [sidebarWidth, workspaceMin]
  );

  return { sidebarWidth, isResizing, onResizeMouseDown };
}
