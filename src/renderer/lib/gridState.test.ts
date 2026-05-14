import { describe, expect, it } from "vitest";
import {
  EMPTY_GRID,
  MAX_CELLS,
  closeCell,
  dropWorkspaceInGrid,
  focusedCell,
  openLauncherInGrid,
  openWorkspaceInGrid,
  setFocus,
  type GridState
} from "./gridState.js";

const cell = (n: number) => ({ sessionId: `s${n}`, workspaceId: `w${n}` });
const launcher = (n = 1) => ({ kind: "launcher" as const, projectId: `p${n}` });

describe("openWorkspaceInGrid", () => {
  it("creates the first cell when the grid is empty", () => {
    const next = openWorkspaceInGrid(EMPTY_GRID, cell(1), { ctrlOrMeta: false, alt: false });
    expect(next.rows).toEqual([[cell(1)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });

  it("replaces the focused cell with no modifiers", () => {
    const start: GridState = { rows: [[cell(1)]], focused: { row: 0, col: 0 } };
    const next = openWorkspaceInGrid(start, cell(2), { ctrlOrMeta: false, alt: false });
    expect(next.rows).toEqual([[cell(2)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });

  it("splits right with ctrlOrMeta", () => {
    const start: GridState = { rows: [[cell(1)]], focused: { row: 0, col: 0 } };
    const next = openWorkspaceInGrid(start, cell(2), { ctrlOrMeta: true, alt: false });
    expect(next.rows).toEqual([[cell(1), cell(2)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("splits below with alt — new row inserted immediately below focused row", () => {
    const start: GridState = { rows: [[cell(1)]], focused: { row: 0, col: 0 } };
    const next = openWorkspaceInGrid(start, cell(2), { ctrlOrMeta: false, alt: true });
    expect(next.rows).toEqual([[cell(1)], [cell(2)]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });

  it("refocuses an existing workspace instead of duplicating", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2)]],
      focused: { row: 0, col: 0 }
    };
    const next = openWorkspaceInGrid(start, cell(2), { ctrlOrMeta: true, alt: false });
    expect(next.rows).toEqual([[cell(1), cell(2)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("falls back to replace when a split would exceed the row cap", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2), cell(3)]],
      focused: { row: 0, col: 2 }
    };
    const next = openWorkspaceInGrid(start, cell(4), { ctrlOrMeta: true, alt: false });
    expect(next.rows).toEqual([[cell(1), cell(2), cell(4)]]);
    expect(next.focused).toEqual({ row: 0, col: 2 });
  });

  it("falls back to replace when a split below would exceed the row count cap", () => {
    const start: GridState = {
      rows: [[cell(1)], [cell(2)], [cell(3)]],
      focused: { row: 2, col: 0 }
    };
    const next = openWorkspaceInGrid(start, cell(4), { ctrlOrMeta: false, alt: true });
    expect(next.rows).toEqual([[cell(1)], [cell(2)], [cell(4)]]);
    expect(next.focused).toEqual({ row: 2, col: 0 });
  });

  it("respects the global 9-cell cap", () => {
    let g: GridState = EMPTY_GRID;
    for (let i = 1; i <= 9; i++) {
      const lastRow = g.rows.length === 0 ? undefined : g.rows[g.rows.length - 1];
      const mods = !lastRow || lastRow.length === 3
        ? { ctrlOrMeta: false, alt: true }
        : { ctrlOrMeta: true, alt: false };
      g = openWorkspaceInGrid(g, cell(i), mods);
    }
    let total = 0;
    for (const row of g.rows) total += row.length;
    expect(total).toBe(MAX_CELLS);
    // 10th attempt falls back to replace.
    g = openWorkspaceInGrid(g, cell(10), { ctrlOrMeta: true, alt: false });
    let total2 = 0;
    for (const row of g.rows) total2 += row.length;
    expect(total2).toBe(MAX_CELLS);
  });
});

describe("openLauncherInGrid", () => {
  it("splits a launcher to the right of the focused pane", () => {
    const start: GridState = { rows: [[cell(1)]], focused: { row: 0, col: 0 } };
    const next = openLauncherInGrid(start, launcher());
    expect(next.rows).toEqual([[cell(1), launcher()]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("adds the launcher below when the focused row already has 3 columns", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2), cell(3)]],
      focused: { row: 0, col: 1 }
    };
    const next = openLauncherInGrid(start, launcher());
    expect(next.rows).toEqual([[cell(1), cell(2), cell(3)], [launcher()]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });

  it("refocuses an existing launcher instead of adding another blank pane", () => {
    const start: GridState = {
      rows: [[cell(1), launcher()]],
      focused: { row: 0, col: 0 }
    };
    const next = openLauncherInGrid(start, launcher(2));
    expect(next.rows).toEqual([[cell(1), launcher()]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("does nothing when the grid is empty", () => {
    expect(openLauncherInGrid(EMPTY_GRID, launcher())).toBe(EMPTY_GRID);
  });
});

describe("dropWorkspaceInGrid", () => {
  const start: GridState = {
    rows: [[cell(1), cell(2)], [cell(3)]],
    focused: { row: 0, col: 0 }
  };

  it("replace replaces the target cell", () => {
    const next = dropWorkspaceInGrid(start, cell(9), { row: 0, col: 1, position: "replace" });
    expect(next.rows).toEqual([[cell(1), cell(9)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("left inserts a new cell before the target", () => {
    const next = dropWorkspaceInGrid(start, cell(9), { row: 0, col: 1, position: "left" });
    expect(next.rows).toEqual([[cell(1), cell(9), cell(2)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("right inserts a new cell after the target", () => {
    const next = dropWorkspaceInGrid(start, cell(9), { row: 0, col: 0, position: "right" });
    expect(next.rows).toEqual([[cell(1), cell(9), cell(2)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("above inserts a new row above the target row", () => {
    const next = dropWorkspaceInGrid(start, cell(9), { row: 1, col: 0, position: "above" });
    expect(next.rows).toEqual([[cell(1), cell(2)], [cell(9)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });

  it("below inserts a new row below the target row", () => {
    const next = dropWorkspaceInGrid(start, cell(9), { row: 0, col: 0, position: "below" });
    expect(next.rows).toEqual([[cell(1), cell(2)], [cell(9)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });

  it("creates the first cell when grid is empty", () => {
    const next = dropWorkspaceInGrid(EMPTY_GRID, cell(1), { row: 0, col: 0, position: "right" });
    expect(next.rows).toEqual([[cell(1)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });

  it("refocuses existing workspace instead of duplicating", () => {
    const next = dropWorkspaceInGrid(start, cell(2), { row: 1, col: 0, position: "right" });
    expect(next.rows).toEqual([[cell(1), cell(2)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("falls back to replace when split-right would exceed row cap (3 cols full)", () => {
    const full3x3: GridState = {
      rows: [
        [cell(1), cell(2), cell(3)],
        [cell(4), cell(5), cell(6)],
        [cell(7), cell(8), cell(9)]
      ],
      focused: { row: 1, col: 1 }
    };
    const next = dropWorkspaceInGrid(full3x3, cell(99), { row: 0, col: 1, position: "left" });
    // Capped — falls back to replacing the target cell at (0, 1).
    expect(next.rows[0]).toEqual([cell(1), cell(99), cell(3)]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("falls back to replace when split-below would exceed row count cap (3 rows full)", () => {
    const full3Rows: GridState = {
      rows: [[cell(1)], [cell(2)], [cell(3)]],
      focused: { row: 0, col: 0 }
    };
    const next = dropWorkspaceInGrid(full3Rows, cell(99), { row: 1, col: 0, position: "below" });
    // Capped — replaces target at (1, 0) instead of inserting a new row.
    expect(next.rows).toEqual([[cell(1)], [cell(99)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });
});

describe("closeCell", () => {
  it("removes the cell and reflows survivors", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2), cell(3)]],
      focused: { row: 0, col: 1 }
    };
    const next = closeCell(start, 0, 1);
    expect(next.rows).toEqual([[cell(1), cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("drops the row when its last cell is removed", () => {
    const start: GridState = {
      rows: [[cell(1)], [cell(2)]],
      focused: { row: 0, col: 0 }
    };
    const next = closeCell(start, 0, 0);
    expect(next.rows).toEqual([[cell(2)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });

  it("returns to EMPTY_GRID when the last cell is closed", () => {
    const start: GridState = { rows: [[cell(1)]], focused: { row: 0, col: 0 } };
    const next = closeCell(start, 0, 0);
    expect(next.rows).toEqual([]);
    expect(next.focused).toBeNull();
  });

  it("moves focus up when the focused row is fully removed", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2)], [cell(3)]],
      focused: { row: 1, col: 0 }
    };
    const next = closeCell(start, 1, 0);
    // Row 1 had one cell; removing it drops the whole row. Focus falls
    // back to the surviving row, clamped to its rightmost column.
    expect(next.rows).toEqual([[cell(1), cell(2)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });

  it("keeps focus on the same row when a non-last cell is closed in a multi-cell row", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2), cell(3)]],
      focused: { row: 0, col: 0 }
    };
    const next = closeCell(start, 0, 0);
    expect(next.rows).toEqual([[cell(2), cell(3)]]);
    // col was clamped to length - 1 = 1, but Math.min(0, 1) = 0 so focus stays at 0.
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });
});

describe("setFocus", () => {
  it("moves focus to a valid coord", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2)]],
      focused: { row: 0, col: 0 }
    };
    const next = setFocus(start, { row: 0, col: 1 });
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("ignores an out-of-bounds coord", () => {
    const start: GridState = {
      rows: [[cell(1)]],
      focused: { row: 0, col: 0 }
    };
    const next = setFocus(start, { row: 5, col: 5 });
    expect(next).toBe(start);
  });
});

describe("focusedCell", () => {
  it("returns the cell at the focus coord", () => {
    const grid: GridState = { rows: [[cell(1), cell(2)]], focused: { row: 0, col: 1 } };
    expect(focusedCell(grid)).toEqual(cell(2));
  });

  it("returns null when nothing is focused", () => {
    expect(focusedCell(EMPTY_GRID)).toBeNull();
  });
});
