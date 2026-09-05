import { useSyncExternalStore } from "react";
import {
  EMPTY_GRID,
  closeCell,
  dropWorkspaceInGrid,
  findLauncherCell,
  openLauncherInGrid,
  openWorkspaceInGrid,
  revertSessionToLauncher,
  setFocus,
  setLauncherProject,
  type GridCell,
  type GridCoord,
  type GridState,
  type LauncherGridCell,
  type SessionGridCell,
  type SplitPosition
} from "../lib/gridState.js";

// The live pane grid: which chats and launchers are on screen, and which one
// has focus.
//
// The reducers in `lib/gridState.ts` stay pure; this module holds the value
// they fold over. Panes, the sidebar (which paints a row as open), the app
// menu, and every launch path all move the grid, so it belongs to none of
// them. Each move is a named mutator — `openWorkspacePane`, `closePane` — so
// a caller states what it is doing rather than handing over a whole grid.

let grid: GridState = EMPTY_GRID;
const listeners = new Set<() => void>();

function publish(next: GridState): void {
  if (next === grid) return;
  grid = next;
  for (const listener of listeners) listener();
}

export function subscribePaneGrid(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between moves, so `useSyncExternalStore` does not loop. */
export function paneGridSnapshot(): GridState {
  return grid;
}

export function usePaneGrid(): GridState {
  return useSyncExternalStore(subscribePaneGrid, paneGridSnapshot, paneGridSnapshot);
}

export function openWorkspacePane(
  cell: SessionGridCell,
  modifiers: { ctrlOrMeta: boolean; alt: boolean },
  layout: { maxColumns: number }
): void {
  publish(openWorkspaceInGrid(grid, cell, modifiers, layout));
}

export function dropWorkspacePane(
  cell: SessionGridCell,
  target: GridCoord & { position: SplitPosition },
  layout: { maxColumns: number }
): void {
  publish(dropWorkspaceInGrid(grid, cell, target, layout));
}

/**
 * Adds (or focuses) the in-grid new-chat composer. An empty grid already shows
 * the launcher as its whole surface, so the request is satisfied by clearing.
 * A full grid otherwise swallows the request silently, which reads as a dead
 * button rather than as a limit — so say which happened.
 */
export function openLauncherPane(
  cell: LauncherGridCell,
  layout: { maxColumns: number }
): "opened" | "grid-full" {
  if (grid.rows.length === 0) {
    publish(EMPTY_GRID);
    return "opened";
  }
  const alreadyOpen = findLauncherCell(grid) !== null;
  const next = openLauncherInGrid(grid, cell, layout);
  publish(next);
  return next === grid && !alreadyOpen ? "grid-full" : "opened";
}

export function setLauncherPaneProject(projectId: string): void {
  publish(setLauncherProject(grid, projectId));
}

export function closePane(coord: GridCoord): void {
  publish(closeCell(grid, coord.row, coord.col));
}

export function focusPane(coord: GridCoord): void {
  publish(setFocus(grid, coord));
}

/**
 * Replaces the whole grid with one pane. A launch out of the full-screen
 * launcher is a hard context switch: the old grid was hidden while composing,
 * so stale split panes should not reappear beside the fresh session.
 */
export function showOnlyPane(cell: SessionGridCell): void {
  publish({ rows: [[cell]], focused: { row: 0, col: 0 } });
}

export function clearPaneGrid(): void {
  publish(EMPTY_GRID);
}

/** Turns a stopped session's pane back into the composer it launched from. */
export function revertPaneToLauncher(sessionId: string, projectId: string): void {
  publish(revertSessionToLauncher(grid, sessionId, projectId));
}

/**
 * Drops panes whose session or project left the snapshot (archive, restart),
 * keeping focus on the nearest surviving pane. `keep` answers for one cell;
 * only the caller knows the snapshot it is judged against.
 */
export function prunePaneGrid(keep: (cell: GridCell) => boolean): void {
  if (grid.rows.length === 0) return;
  let dropped = false;
  const rows = grid.rows
    .map((row) =>
      row.filter((cell) => {
        if (keep(cell)) return true;
        dropped = true;
        return false;
      })
    )
    .filter((row) => row.length > 0);
  if (!dropped) return;
  if (rows.length === 0) {
    publish(EMPTY_GRID);
    return;
  }
  const focused = grid.focused;
  if (focused) {
    const nextRow = Math.min(focused.row, rows.length - 1);
    const targetRow = rows[nextRow];
    if (targetRow) {
      const nextCol = Math.min(focused.col, targetRow.length - 1);
      publish({ rows, focused: { row: nextRow, col: Math.max(nextCol, 0) } });
      return;
    }
  }
  publish({ rows, focused: { row: 0, col: 0 } });
}

export function resetPaneGridForTests(): void {
  grid = EMPTY_GRID;
  for (const listener of listeners) listener();
}
