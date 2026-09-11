import { describe, expect, it } from "vitest";
import {
  EMPTY_GRID,
  MAX_CELLS,
  closeCell,
  dropWorkspaceInGrid,
  focusedCell,
  openLauncherInGrid,
  setLauncherProject,
  openWorkspaceInGrid,
  revertSessionToLauncher,
  setFocus,
  terminalWorkspaceId,
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

  it("starts a second row when split-right reaches the two-column cap", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2)]],
      focused: { row: 0, col: 1 }
    };
    const next = openWorkspaceInGrid(start, cell(3), { ctrlOrMeta: true, alt: false });
    expect(next.rows).toEqual([[cell(1), cell(2)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });

  it("opens below when split-right would exceed the measured layout cap", () => {
    const start: GridState = {
      rows: [[cell(1)]],
      focused: { row: 0, col: 0 }
    };
    const next = openWorkspaceInGrid(
      start,
      cell(2),
      { ctrlOrMeta: true, alt: false },
      { maxColumns: 1 }
    );
    expect(next.rows).toEqual([[cell(1)], [cell(2)]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });

  it("fills another row before replacing when a modifier split cannot use the focused row", () => {
    const start: GridState = {
      rows: [[cell(1)], [cell(2), cell(3)]],
      focused: { row: 1, col: 1 }
    };
    const next = openWorkspaceInGrid(start, cell(4), { ctrlOrMeta: false, alt: true });
    expect(next.rows).toEqual([[cell(1), cell(4)], [cell(2), cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("never exceeds two rows, two columns, or four cells for any modifier sequence", () => {
    const modifierChoices = [
      { ctrlOrMeta: true, alt: false },
      { ctrlOrMeta: false, alt: true }
    ];

    for (let sequence = 0; sequence < 16; sequence++) {
      let grid = openWorkspaceInGrid(EMPTY_GRID, cell(1), {
        ctrlOrMeta: false,
        alt: false
      });
      for (let step = 0; step < 4; step++) {
        grid = openWorkspaceInGrid(grid, cell(step + 2), modifierChoices[(sequence >> step) & 1]);
        expect(grid.rows.length).toBeLessThanOrEqual(2);
        expect(grid.rows.every((row) => row.length <= 2)).toBe(true);
        expect(grid.rows.flat()).toHaveLength(Math.min(step + 2, MAX_CELLS));
      }
    }
  });

  it("replaces the focused cell only after all four slots are occupied", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2)], [cell(3), cell(4)]],
      focused: { row: 1, col: 0 }
    };
    const next = openWorkspaceInGrid(start, cell(5), { ctrlOrMeta: true, alt: false });
    expect(next.rows).toEqual([[cell(1), cell(2)], [cell(5), cell(4)]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });
});

describe("setLauncherProject", () => {
  it("retargets the launcher cell and leaves session panes untouched", () => {
    const start: GridState = { rows: [[cell(1), launcher(1)]], focused: { row: 0, col: 1 } };

    const next = setLauncherProject(start, "p2");

    expect(next.rows).toEqual([[cell(1), launcher(2)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("is referentially stable with no launcher, or when already on that project", () => {
    const noLauncher: GridState = { rows: [[cell(1)]], focused: { row: 0, col: 0 } };
    expect(setLauncherProject(noLauncher, "p2")).toBe(noLauncher);

    const sameProject: GridState = { rows: [[launcher(1)]], focused: { row: 0, col: 0 } };
    expect(setLauncherProject(sameProject, "p1")).toBe(sameProject);
  });
});

describe("openLauncherInGrid", () => {
  it("splits a launcher to the right of the focused pane", () => {
    const start: GridState = { rows: [[cell(1)]], focused: { row: 0, col: 0 } };
    const next = openLauncherInGrid(start, launcher());
    expect(next.rows).toEqual([[cell(1), launcher()]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("adds the launcher below when the focused row already has 2 columns", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2)]],
      focused: { row: 0, col: 1 }
    };
    const next = openLauncherInGrid(start, launcher());
    expect(next.rows).toEqual([[cell(1), cell(2)], [launcher()]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });

  it("adds the launcher below when the measured layout cap is reached", () => {
    const start: GridState = {
      rows: [[cell(1)]],
      focused: { row: 0, col: 0 }
    };
    const next = openLauncherInGrid(start, launcher(), { maxColumns: 1 });
    expect(next.rows).toEqual([[cell(1)], [launcher()]]);
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

  it("fills the other row when the focused row is full", () => {
    const start: GridState = {
      rows: [[cell(1)], [cell(2), cell(3)]],
      focused: { row: 1, col: 1 }
    };
    const next = openLauncherInGrid(start, launcher());
    expect(next.rows).toEqual([[cell(1), launcher()], [cell(2), cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("does nothing when all four slots are occupied", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2)], [cell(3), cell(4)]],
      focused: { row: 0, col: 0 }
    };
    expect(openLauncherInGrid(start, launcher())).toBe(start);
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
    const openRow: GridState = {
      rows: [[cell(1)], [cell(3)]],
      focused: { row: 0, col: 0 }
    };
    const next = dropWorkspaceInGrid(openRow, cell(9), { row: 0, col: 0, position: "left" });
    expect(next.rows).toEqual([[cell(9), cell(1)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });

  it("right inserts a new cell after the target", () => {
    const openRow: GridState = {
      rows: [[cell(1)], [cell(3)]],
      focused: { row: 0, col: 0 }
    };
    const next = dropWorkspaceInGrid(openRow, cell(9), { row: 0, col: 0, position: "right" });
    expect(next.rows).toEqual([[cell(1), cell(9)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("above inserts a new row above the target row", () => {
    const oneRow: GridState = { rows: [[cell(1), cell(2)]], focused: { row: 0, col: 0 } };
    const next = dropWorkspaceInGrid(oneRow, cell(9), { row: 0, col: 0, position: "above" });
    expect(next.rows).toEqual([[cell(9)], [cell(1), cell(2)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });

  it("below inserts a new row below the target row", () => {
    const oneRow: GridState = { rows: [[cell(1), cell(2)]], focused: { row: 0, col: 0 } };
    const next = dropWorkspaceInGrid(oneRow, cell(9), { row: 0, col: 0, position: "below" });
    expect(next.rows).toEqual([[cell(1), cell(2)], [cell(9)]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });

  it("creates the first cell when grid is empty", () => {
    const next = dropWorkspaceInGrid(EMPTY_GRID, cell(1), { row: 0, col: 0, position: "right" });
    expect(next.rows).toEqual([[cell(1)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });

  it("keeps an existing workspace in place for an edge drop", () => {
    const next = dropWorkspaceInGrid(start, cell(2), { row: 1, col: 0, position: "right" });
    expect(next.rows).toEqual([[cell(1), cell(2)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
    expect(
      next.rows.flat().filter((item) => item.kind !== "launcher" && item.workspaceId === "w2")
    ).toHaveLength(1);
  });

  it("swaps existing workspaces dropped onto another occupied cell", () => {
    const next = dropWorkspaceInGrid(start, cell(1), {
      row: 1,
      col: 0,
      position: "replace"
    });
    expect(next.rows).toEqual([[cell(3), cell(2)], [cell(1)]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
    expect(
      next.rows.flat().filter((item) => item.kind !== "launcher" && item.workspaceId === "w1")
    ).toHaveLength(1);
    expect(
      next.rows.flat().filter((item) => item.kind !== "launcher" && item.workspaceId === "w3")
    ).toHaveLength(1);
  });

  it("does nothing when an existing workspace is dropped onto itself", () => {
    const next = dropWorkspaceInGrid(start, cell(2), {
      row: 0,
      col: 1,
      position: "replace"
    });
    expect(next).toBe(start);
  });

  it("falls back to replace when split-right would exceed the two-column cap", () => {
    const full2x2: GridState = {
      rows: [[cell(1), cell(2)], [cell(3), cell(4)]],
      focused: { row: 1, col: 1 }
    };
    const next = dropWorkspaceInGrid(full2x2, cell(99), { row: 0, col: 1, position: "left" });
    expect(next.rows).toEqual([[cell(1), cell(99)], [cell(3), cell(4)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });

  it("falls back to replace when split-below would exceed the two-row cap", () => {
    const full2Rows: GridState = {
      rows: [[cell(1)], [cell(2)]],
      focused: { row: 0, col: 0 }
    };
    const next = dropWorkspaceInGrid(full2Rows, cell(99), {
      row: 1,
      col: 0,
      position: "below"
    });
    expect(next.rows).toEqual([[cell(1)], [cell(99)]]);
    expect(next.focused).toEqual({ row: 1, col: 0 });
  });

  it("falls back to replace when a drop would exceed the measured layout cap", () => {
    const next = dropWorkspaceInGrid(
      start,
      cell(9),
      { row: 0, col: 0, position: "right" },
      { maxColumns: 2 }
    );
    expect(next.rows).toEqual([[cell(9), cell(2)], [cell(3)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });
});

describe("closeCell", () => {
  it("removes the cell and reflows survivors", () => {
    const start: GridState = {
      rows: [[cell(1), cell(2)]],
      focused: { row: 0, col: 1 }
    };
    const next = closeCell(start, 0, 0);
    expect(next.rows).toEqual([[cell(2)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
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
      rows: [[cell(1), cell(2)]],
      focused: { row: 0, col: 0 }
    };
    const next = closeCell(start, 0, 0);
    expect(next.rows).toEqual([[cell(2)]]);
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

describe("terminalWorkspaceId", () => {
  it("prefers the focused session cell", () => {
    const grid: GridState = { rows: [[cell(1), cell(2)]], focused: { row: 0, col: 1 } };
    expect(terminalWorkspaceId(grid, ["fallback"])).toBe("w2");
  });

  it("uses the first visible session when the focused cell is a launcher", () => {
    const grid: GridState = {
      rows: [[launcher(), cell(1)], [cell(2)]],
      focused: { row: 0, col: 0 }
    };
    expect(terminalWorkspaceId(grid, ["fallback"])).toBe("w1");
  });

  it("falls back to selected or recent workspace ids when the grid has no session", () => {
    const grid: GridState = { rows: [[launcher()]], focused: { row: 0, col: 0 } };
    expect(terminalWorkspaceId(grid, [null, undefined, "recent"])).toBe("recent");
    expect(terminalWorkspaceId(grid, [null, undefined])).toBeNull();
  });
});

describe("revertSessionToLauncher", () => {
  it("replaces the session cell with a launcher cell and focuses it", () => {
    const start: GridState = { rows: [[cell(1), cell(2)]], focused: { row: 0, col: 0 } };
    const next = revertSessionToLauncher(start, "s1", "p1");
    expect(next.rows).toEqual([[launcher(1), cell(2)]]);
    expect(next.focused).toEqual({ row: 0, col: 0 });
  });

  it("returns EMPTY_GRID when called on an empty grid", () => {
    expect(revertSessionToLauncher(EMPTY_GRID, "s1", "p1")).toEqual(EMPTY_GRID);
  });

  it("opens launcher in grid if session is not in grid but grid is non-empty", () => {
    const start: GridState = { rows: [[cell(2)]], focused: { row: 0, col: 0 } };
    const next = revertSessionToLauncher(start, "s1", "p1");
    expect(next.rows).toEqual([[cell(2), launcher(1)]]);
    expect(next.focused).toEqual({ row: 0, col: 1 });
  });
});
