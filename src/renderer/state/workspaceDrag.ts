import { useEffect, useSyncExternalStore } from "react";

// The sidebar row currently being dragged towards the grid.
//
// The drag starts in a sidebar row and ends over a pane, a drop overlay, or
// nowhere at all, so no component spans it. Separate from `paneGrid` so a drag
// starting does not wake every pane subscriber.

let draggingWorkspaceId: string | null = null;
const listeners = new Set<() => void>();
const POINTER_DRAG_THRESHOLD_PX = 5;

export interface WorkspaceDragPoint {
  clientX: number;
  clientY: number;
}

interface WorkspacePointerDragListener {
  move: (point: WorkspaceDragPoint) => void;
  drop: (point: WorkspaceDragPoint) => void;
  cancel: () => void;
}

const pointerDragListeners = new Set<WorkspacePointerDragListener>();
let cancelPointerCandidate: (() => void) | null = null;
let suppressedClickWorkspaceId: string | null = null;
let currentPointerPoint: WorkspaceDragPoint | null = null;

function publish(next: string | null): void {
  if (next === draggingWorkspaceId) return;
  draggingWorkspaceId = next;
  for (const listener of listeners) listener();
}

export function beginWorkspaceDrag(workspaceId: string): void {
  publish(workspaceId);
}

export function endWorkspaceDrag(): void {
  publish(null);
}

/**
 * Internal sidebar-to-grid dragging deliberately uses pointer events instead
 * of WebKit's native HTML drag session. A native session can become wedged
 * window-wide after a missing dragend; pointerup/pointercancel always give us
 * a local cleanup seam and do not interfere with Finder file drops.
 */
export function beginWorkspacePointerDrag(
  workspaceId: string,
  start: WorkspaceDragPoint & { pointerId: number; button: number; onFinish?: () => void }
): void {
  if (start.button !== 0 || typeof window === "undefined") return;
  cancelPointerCandidate?.();

  let active = false;
  const matches = (event: PointerEvent): boolean => event.pointerId === start.pointerId;
  const pointFrom = (event: PointerEvent): WorkspaceDragPoint => ({
    clientX: event.clientX,
    clientY: event.clientY
  });
  const cleanup = (): void => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("blur", onBlur);
    if (cancelPointerCandidate === cancel) cancelPointerCandidate = null;
  };
  const finish = (event: PointerEvent | null, dropped: boolean): void => {
    if (event && !matches(event)) return;
    if (active) {
      if (event) event.preventDefault();
      const point = event ? pointFrom(event) : null;
      if (dropped && point) {
        for (const listener of pointerDragListeners) listener.drop(point);
      } else {
        for (const listener of pointerDragListeners) listener.cancel();
      }
      suppressedClickWorkspaceId = workspaceId;
      window.setTimeout(() => {
        if (suppressedClickWorkspaceId === workspaceId) suppressedClickWorkspaceId = null;
      }, 0);
    }
    currentPointerPoint = null;
    cleanup();
    endWorkspaceDrag();
    start.onFinish?.();
  };
  const cancel = (): void => finish(null, false);
  const onPointerMove = (event: PointerEvent): void => {
    if (!matches(event)) return;
    if (!active) {
      const distance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
      if (distance < POINTER_DRAG_THRESHOLD_PX) return;
      active = true;
      currentPointerPoint = pointFrom(event);
      beginWorkspaceDrag(workspaceId);
    }
    event.preventDefault();
    const point = pointFrom(event);
    currentPointerPoint = point;
    for (const listener of pointerDragListeners) listener.move(point);
  };
  const onPointerUp = (event: PointerEvent): void => finish(event, true);
  const onPointerCancel = (event: PointerEvent): void => finish(event, false);
  const onBlur = (): void => finish(null, false);

  window.addEventListener("pointermove", onPointerMove, { passive: false });
  window.addEventListener("pointerup", onPointerUp, { passive: false });
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("blur", onBlur);
  cancelPointerCandidate = cancel;
}

export function subscribeWorkspacePointerDrag(listener: WorkspacePointerDragListener): () => void {
  pointerDragListeners.add(listener);
  if (currentPointerPoint) listener.move(currentPointerPoint);
  return () => {
    pointerDragListeners.delete(listener);
  };
}

export function consumeWorkspaceDragClick(workspaceId: string): boolean {
  if (suppressedClickWorkspaceId !== workspaceId) return false;
  suppressedClickWorkspaceId = null;
  return true;
}

function subscribeWorkspaceDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function workspaceDragSnapshot(): string | null {
  return draggingWorkspaceId;
}

export function useDraggingWorkspaceId(): string | null {
  return useSyncExternalStore(subscribeWorkspaceDrag, workspaceDragSnapshot, workspaceDragSnapshot);
}

/**
 * A drag that ends outside any drop target fires neither `drop` nor a row's
 * own `dragend`, so the shell watches the document while one is in flight.
 */
export function useWorkspaceDragCleanup(): void {
  const dragging = useDraggingWorkspaceId();
  useEffect(() => {
    if (!dragging) return undefined;
    const clear = (): void => endWorkspaceDrag();
    document.addEventListener("dragend", clear, true);
    document.addEventListener("drop", clear);
    return () => {
      document.removeEventListener("dragend", clear, true);
      document.removeEventListener("drop", clear);
    };
  }, [dragging]);
}

export function resetWorkspaceDragForTests(): void {
  cancelPointerCandidate?.();
  cancelPointerCandidate = null;
  suppressedClickWorkspaceId = null;
  currentPointerPoint = null;
  publish(null);
}
