import { useEffect, useSyncExternalStore } from "react";

// The sidebar row currently being dragged towards the grid.
//
// The drag starts in a sidebar row and ends over a pane, a drop overlay, or
// nowhere at all, so no component spans it. Separate from `paneGrid` so a drag
// starting does not wake every pane subscriber.

let draggingWorkspaceId: string | null = null;
const listeners = new Set<() => void>();

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

export function subscribeWorkspaceDrag(listener: () => void): () => void {
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
  publish(null);
}
