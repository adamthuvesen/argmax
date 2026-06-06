import { describe, expect, it } from "vitest";
import { groupWorkspacesByDate, sortWorkspaceGroup } from "./projects.js";

interface WorkspaceFixture {
  id: string;
  pinned: boolean;
  lastActivityAt: string;
}

const ROW_OLD: WorkspaceFixture = { id: "w-old", pinned: false, lastActivityAt: "2026-05-01T00:00:00.000Z" };
const ROW_MID: WorkspaceFixture = { id: "w-mid", pinned: false, lastActivityAt: "2026-05-02T00:00:00.000Z" };
const ROW_NEW: WorkspaceFixture = { id: "w-new", pinned: false, lastActivityAt: "2026-05-03T00:00:00.000Z" };
const ROW_PINNED_OLD: WorkspaceFixture = { id: "w-pin-old", pinned: true, lastActivityAt: "2026-04-01T00:00:00.000Z" };
const ROW_PINNED_NEW: WorkspaceFixture = { id: "w-pin-new", pinned: true, lastActivityAt: "2026-05-04T00:00:00.000Z" };

describe("sortWorkspaceGroup", () => {
  it("pinned items appear before unpinned regardless of recency", () => {
    const result = sortWorkspaceGroup([ROW_NEW, ROW_PINNED_OLD, ROW_OLD], []);
    expect(result.map((row) => row.id)).toEqual(["w-pin-old", "w-new", "w-old"]);
  });

  it("honors a manual order within pinned and unpinned groups", () => {
    const result = sortWorkspaceGroup(
      [ROW_OLD, ROW_NEW, ROW_PINNED_OLD, ROW_PINNED_NEW],
      ["w-new", "w-old", "w-pin-new", "w-pin-old"]
    );
    // Pinned bubble first; within each group the manual order wins.
    expect(result.map((row) => row.id)).toEqual(["w-pin-new", "w-pin-old", "w-new", "w-old"]);
  });

  it("tiebreaks on lastActivityAt descending when no manual order is set", () => {
    const result = sortWorkspaceGroup([ROW_OLD, ROW_NEW, ROW_MID], []);
    expect(result.map((row) => row.id)).toEqual(["w-new", "w-mid", "w-old"]);
  });

  it("places items in the manual order ahead of items outside it", () => {
    const result = sortWorkspaceGroup([ROW_OLD, ROW_MID, ROW_NEW], ["w-mid"]);
    // w-mid is in the manual order — it wins over w-new/w-old, which fall
    // back to recency among themselves.
    expect(result.map((row) => row.id)).toEqual(["w-mid", "w-new", "w-old"]);
  });
});

describe("groupWorkspacesByDate", () => {
  // Fixed reference instant: midday on 5 June 2026, local time. Fixtures are
  // built with the local Date constructor so the day-diff math is timezone
  // independent (both `now` and each activity go through the same local
  // getters).
  const NOW = new Date(2026, 5, 5, 12, 0, 0);
  const at = (y: number, m: number, d: number, h = 9): { id: string; lastActivityAt: string } => ({
    id: `${y}-${m}-${d}-${h}`,
    lastActivityAt: new Date(y, m, d, h).toISOString()
  });

  it("buckets into Today / Yesterday / Previous 7 / Previous 30 / months", () => {
    const groups = groupWorkspacesByDate(
      [
        at(2026, 5, 5), // today
        at(2026, 5, 4), // yesterday
        at(2026, 5, 1), // 4 days ago → Previous 7 Days
        at(2026, 4, 20), // 16 days ago → Previous 30 Days
        at(2026, 3, 10), // April → same-year month label
        at(2025, 11, 10) // Dec 2025 → cross-year month label
      ],
      NOW
    );
    expect(groups.map((group) => [group.key, group.label])).toEqual([
      ["today", "Today"],
      ["yesterday", "Yesterday"],
      ["prev-7", "Previous 7 Days"],
      ["prev-30", "Previous 30 Days"],
      ["month-2026-3", "April"],
      ["month-2025-11", "December 2025"]
    ]);
  });

  it("treats exactly 7 days ago as Previous 7 Days and 8 days as Previous 30 Days", () => {
    const groups = groupWorkspacesByDate([at(2026, 4, 29), at(2026, 4, 28)], NOW);
    expect(groups.map((group) => group.key)).toEqual(["prev-7", "prev-30"]);
  });

  it("sorts newest first and groups multiple sessions per bucket", () => {
    const groups = groupWorkspacesByDate([at(2026, 5, 5, 8), at(2026, 5, 5, 18), at(2026, 5, 5, 12)], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((row) => row.id)).toEqual([
      "2026-5-5-18",
      "2026-5-5-12",
      "2026-5-5-8"
    ]);
  });

  it("drops empty buckets and returns nothing for no input", () => {
    expect(groupWorkspacesByDate([], NOW)).toEqual([]);
  });

  it("counts future timestamps as Today rather than dropping them", () => {
    const groups = groupWorkspacesByDate([at(2026, 5, 6)], NOW);
    expect(groups.map((group) => group.key)).toEqual(["today"]);
  });
});
