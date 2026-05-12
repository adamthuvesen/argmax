import { describe, expect, it } from "vitest";
import { sortWorkspaceGroup } from "./projects.js";

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
