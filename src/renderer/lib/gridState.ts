// State helpers for the multi-pane session grid. Pure functions so they can
// be unit-tested without React, and so App.tsx stays focused on wiring.

export interface SessionGridCell {
  kind?: "session";
  sessionId: string;
  workspaceId: string;
}

export interface LauncherGridCell {
  kind: "launcher";
  projectId: string;
}

export interface AgentGridCell {
  kind: "agent";
  parentSessionId: string;
  workspaceId: string;
  parentToolUseId: string;
}

export type GridCell = SessionGridCell | LauncherGridCell | AgentGridCell;

export interface GridCoord {
  row: number;
  col: number;
}

export interface GridState {
  rows: GridCell[][];
  focused: GridCoord | null;
}

export type SplitPosition = "replace" | "left" | "right" | "above" | "below";

export const EMPTY_GRID: GridState = { rows: [], focused: null };

export const MAX_ROWS = 3;
export const MAX_COLS = 3;
export const MAX_CELLS = MAX_ROWS * MAX_COLS;

export const WORKSPACE_DRAG_MIME = "application/x-argmax-workspace";

export function isSessionCell(cell: GridCell): cell is SessionGridCell {
  return cell.kind !== "launcher" && cell.kind !== "agent";
}

export function isAgentCell(cell: GridCell): cell is AgentGridCell {
  return cell.kind === "agent";
}

export function isWorkspaceBackedCell(cell: GridCell): cell is SessionGridCell | AgentGridCell {
  return isSessionCell(cell) || isAgentCell(cell);
}

function totalCells(grid: GridState): number {
  let n = 0;
  for (const row of grid.rows) n += row.length;
  return n;
}

function maxColumns(layout?: { maxColumns?: number }): number {
  const requested = layout?.maxColumns;
  if (!Number.isFinite(requested)) return MAX_COLS;
  return Math.max(1, Math.min(MAX_COLS, Math.floor(requested ?? MAX_COLS)));
}

function maxCells(layout?: { maxColumns?: number }): number {
  return MAX_ROWS * maxColumns(layout);
}

export function findWorkspaceCell(grid: GridState, workspaceId: string): GridCoord | null {
  for (let r = 0; r < grid.rows.length; r++) {
    const row = grid.rows[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell && isSessionCell(cell) && cell.workspaceId === workspaceId) return { row: r, col: c };
    }
  }
  return null;
}

export function findAgentCell(grid: GridState, parentSessionId: string, parentToolUseId: string): GridCoord | null {
  for (let r = 0; r < grid.rows.length; r++) {
    const row = grid.rows[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (
        cell &&
        isAgentCell(cell) &&
        cell.parentSessionId === parentSessionId &&
        cell.parentToolUseId === parentToolUseId
      ) {
        return { row: r, col: c };
      }
    }
  }
  return null;
}

export function findLauncherCell(grid: GridState): GridCoord | null {
  for (let r = 0; r < grid.rows.length; r++) {
    const row = grid.rows[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      if (row[c]?.kind === "launcher") return { row: r, col: c };
    }
  }
  return null;
}

function replaceCell(rows: GridCell[][], coord: GridCoord, cell: GridCell): GridCell[][] {
  return rows.map((row, r) =>
    r === coord.row ? row.map((c, j) => (j === coord.col ? cell : c)) : row
  );
}

function compactRows(rows: GridCell[][]): GridCell[][] {
  return rows.filter((row) => row.length > 0);
}

function focusNear(rows: GridCell[][], preferred: GridCoord): GridState {
  const compacted = compactRows(rows);
  if (compacted.length === 0) return EMPTY_GRID;

  const nextRow = Math.min(Math.max(preferred.row, 0), compacted.length - 1);
  const nextRowCells = compacted[nextRow];
  if (!nextRowCells) return EMPTY_GRID;
  const nextCol = Math.min(Math.max(preferred.col, 0), nextRowCells.length - 1);
  return { rows: compacted, focused: { row: nextRow, col: nextCol } };
}

export function findSessionCell(grid: GridState, sessionId: string): GridCoord | null {
  for (let r = 0; r < grid.rows.length; r++) {
    const row = grid.rows[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell && isSessionCell(cell) && cell.sessionId === sessionId) return { row: r, col: c };
    }
  }
  return null;
}

function removeAgentCellsForParent(rows: GridCell[][], parentSessionId: string): GridCell[][] {
  return compactRows(
    rows.map((row) =>
      row.filter((cell) => !(isAgentCell(cell) && cell.parentSessionId === parentSessionId))
    )
  );
}

function replaceWorkspaceContext(
  grid: GridState,
  target: GridCoord,
  cell: SessionGridCell
): GridState {
  const targetCell = grid.rows[target.row]?.[target.col];
  if (!targetCell) return grid;

  let replaceCoord = target;
  let parentSessionToDrop: string | null = null;
  if (isSessionCell(targetCell)) {
    parentSessionToDrop = targetCell.sessionId;
  } else if (isAgentCell(targetCell)) {
    parentSessionToDrop = targetCell.parentSessionId;
    replaceCoord = findSessionCell(grid, targetCell.parentSessionId) ?? target;
  }

  let rows = replaceCell(grid.rows, replaceCoord, cell);
  if (parentSessionToDrop) {
    rows = removeAgentCellsForParent(rows, parentSessionToDrop);
  }
  const focused = findWorkspaceCell({ rows, focused: null }, cell.workspaceId);
  if (focused) return { rows, focused };
  return focusNear(rows, replaceCoord);
}

function insertCellInRow(
  rows: GridCell[][],
  rowIndex: number,
  colIndex: number,
  cell: GridCell
): GridCell[][] {
  return rows.map((row, r) =>
    r === rowIndex ? [...row.slice(0, colIndex), cell, ...row.slice(colIndex)] : row
  );
}

function insertRow(rows: GridCell[][], at: number, cell: GridCell): GridCell[][] {
  return [...rows.slice(0, at), [cell], ...rows.slice(at)];
}

/**
 * Open a workspace in the grid. Modifier flags pick the insertion mode:
 *  - none → replace focused cell (or create the first cell when empty).
 *  - ctrlOrMeta → split right of the focused cell (same row).
 *  - alt → new row immediately below the focused row.
 *
 * If the workspace is already in the grid, the focus moves to that cell —
 * no duplicates. If the requested split would exceed the 3x3 cap, falls
 * back to replacing the focused cell.
 */
export function openWorkspaceInGrid(
  grid: GridState,
  cell: SessionGridCell,
  modifiers: { ctrlOrMeta: boolean; alt: boolean },
  layout?: { maxColumns?: number }
): GridState {
  const existing = findWorkspaceCell(grid, cell.workspaceId);
  if (existing) return { ...grid, focused: existing };

  if (grid.rows.length === 0 || grid.focused === null) {
    return { rows: [[cell]], focused: { row: 0, col: 0 } };
  }

  const { row: fr, col: fc } = grid.focused;
  const rowCap = maxColumns(layout);
  const canSplit = totalCells(grid) < maxCells(layout);
  const focusedRow = grid.rows[fr];

  if (modifiers.ctrlOrMeta && canSplit && focusedRow && focusedRow.length < rowCap) {
    return {
      rows: insertCellInRow(grid.rows, fr, fc + 1, cell),
      focused: { row: fr, col: fc + 1 }
    };
  }

  if (
    modifiers.ctrlOrMeta &&
    canSplit &&
    focusedRow &&
    focusedRow.length >= rowCap &&
    rowCap < MAX_COLS &&
    grid.rows.length < MAX_ROWS
  ) {
    return {
      rows: insertRow(grid.rows, fr + 1, cell),
      focused: { row: fr + 1, col: 0 }
    };
  }

  if (modifiers.alt && canSplit && grid.rows.length < MAX_ROWS) {
    return {
      rows: insertRow(grid.rows, fr + 1, cell),
      focused: { row: fr + 1, col: 0 }
    };
  }

  return replaceWorkspaceContext(grid, { row: fr, col: fc }, cell);
}

export function openAgentInGrid(
  grid: GridState,
  cell: AgentGridCell,
  layout?: { maxColumns?: number }
): GridState {
  if (!findSessionCell(grid, cell.parentSessionId)) return grid;
  const existing = findAgentCell(grid, cell.parentSessionId, cell.parentToolUseId);
  if (existing) return { ...grid, focused: existing };
  if (grid.rows.length === 0 || grid.focused === null) return grid;

  const { row: fr, col: fc } = grid.focused;
  const focusedRow = grid.rows[fr];
  const rowCap = maxColumns(layout);
  const canSplit = totalCells(grid) < maxCells(layout);
  if (!canSplit || !focusedRow) return grid;

  if (focusedRow.length < rowCap) {
    return {
      rows: insertCellInRow(grid.rows, fr, fc + 1, cell),
      focused: { row: fr, col: fc + 1 }
    };
  }

  if (grid.rows.length < MAX_ROWS) {
    return {
      rows: insertRow(grid.rows, fr + 1, cell),
      focused: { row: fr + 1, col: 0 }
    };
  }

  return grid;
}

/**
 * Open a blank launcher inside an existing grid. Prefer splitting to the
 * right of the focused pane; when the focused row is already at 3 columns,
 * insert a new row below. If the grid is full, leave it unchanged.
 */
export function openLauncherInGrid(
  grid: GridState,
  cell: LauncherGridCell,
  layout?: { maxColumns?: number }
): GridState {
  const existing = findLauncherCell(grid);
  if (existing) return { ...grid, focused: existing };

  if (grid.rows.length === 0 || grid.focused === null) {
    return grid;
  }

  const { row: fr, col: fc } = grid.focused;
  const focusedRow = grid.rows[fr];
  const rowCap = maxColumns(layout);
  const canSplit = totalCells(grid) < maxCells(layout);
  if (!canSplit || !focusedRow) return grid;

  if (focusedRow.length < rowCap) {
    return {
      rows: insertCellInRow(grid.rows, fr, fc + 1, cell),
      focused: { row: fr, col: fc + 1 }
    };
  }

  if (grid.rows.length < MAX_ROWS) {
    return {
      rows: insertRow(grid.rows, fr + 1, cell),
      focused: { row: fr + 1, col: 0 }
    };
  }

  return grid;
}

/**
 * Drop a workspace at an explicit target+position (from a drag). Same caps
 * and duplicate-guard as `openWorkspaceInGrid`. Falls back to replace if a
 * split would exceed the cap.
 */
export function dropWorkspaceInGrid(
  grid: GridState,
  cell: SessionGridCell,
  target: GridCoord & { position: SplitPosition },
  layout?: { maxColumns?: number }
): GridState {
  const existing = findWorkspaceCell(grid, cell.workspaceId);
  if (existing) return { ...grid, focused: existing };

  if (grid.rows.length === 0) {
    return { rows: [[cell]], focused: { row: 0, col: 0 } };
  }

  const { row: tr, col: tc, position } = target;
  const targetRow = grid.rows[tr];
  if (!targetRow) return { ...grid, focused: { row: 0, col: 0 } };

  const rowCap = maxColumns(layout);
  const canSplit = totalCells(grid) < maxCells(layout);

  if (position === "replace") {
    return replaceWorkspaceContext(grid, { row: tr, col: tc }, cell);
  }

  if ((position === "left" || position === "right") && canSplit && targetRow.length < rowCap) {
    const insertCol = position === "left" ? tc : tc + 1;
    return {
      rows: insertCellInRow(grid.rows, tr, insertCol, cell),
      focused: { row: tr, col: insertCol }
    };
  }

  if ((position === "above" || position === "below") && canSplit && grid.rows.length < MAX_ROWS) {
    const insertRowIndex = position === "above" ? tr : tr + 1;
    return {
      rows: insertRow(grid.rows, insertRowIndex, cell),
      focused: { row: insertRowIndex, col: 0 }
    };
  }

  // Capped — fall back to replacing the target cell.
  return replaceWorkspaceContext(grid, { row: tr, col: tc }, cell);
}

/**
 * Remove a pane. If its row becomes empty the row is dropped so survivors
 * reflow. When the last cell is removed, returns the empty grid.
 */
export function closeCell(grid: GridState, row: number, col: number): GridState {
  const closedCell = grid.rows[row]?.[col] ?? null;
  let rows = grid.rows.map((r, i) => (i === row ? r.filter((_, j) => j !== col) : r));
  if (closedCell && isSessionCell(closedCell)) {
    rows = removeAgentCellsForParent(rows, closedCell.sessionId);
  }
  return focusNear(rows, { row, col });
}

export function setFocus(grid: GridState, coord: GridCoord): GridState {
  if (grid.focused && grid.focused.row === coord.row && grid.focused.col === coord.col) return grid;
  const row = grid.rows[coord.row];
  if (!row || !row[coord.col]) return grid;
  return { ...grid, focused: coord };
}

export function focusedCell(grid: GridState): GridCell | null {
  if (!grid.focused) return null;
  const row = grid.rows[grid.focused.row];
  if (!row) return null;
  return row[grid.focused.col] ?? null;
}

export function terminalWorkspaceId(
  grid: GridState,
  fallbacks: readonly (string | null | undefined)[]
): string | null {
  const focused = focusedCell(grid);
  if (focused && isWorkspaceBackedCell(focused)) return focused.workspaceId;

  for (const row of grid.rows) {
    const sessionCell = row.find(isWorkspaceBackedCell);
    if (sessionCell) return sessionCell.workspaceId;
  }

  return fallbacks.find((workspaceId): workspaceId is string => Boolean(workspaceId)) ?? null;
}
