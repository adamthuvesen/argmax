import { describe, expect, it } from "vitest";
import {
  highlightSegments,
  parseFtsSnippet,
  searchPaletteItems,
  type PaletteItem
} from "./paletteSearch.js";

const noop = () => {};

function item(id: string, label: string, subtitle?: string): PaletteItem {
  return { id, label, subtitle, group: "Sessions", run: noop };
}

describe("searchPaletteItems", () => {
  it("returns items in original order when the query is empty", () => {
    const items = [item("a", "Alpha"), item("b", "Beta"), item("c", "Gamma")];
    const hits = searchPaletteItems(items, "");
    expect(hits.map((hit) => hit.item.id)).toEqual(["a", "b", "c"]);
    expect(hits.every((hit) => hit.labelRanges === null && hit.subtitleRanges === null)).toBe(true);
  });

  it("ranks substring matches in the label first and returns highlight ranges", () => {
    const items = [
      item("settings", "Open Settings", "Defaults, providers, tools"),
      item("session", "New Session", "Open the launcher"),
      item("search", "Search Sessions", "Full-text search across every session timeline")
    ];
    const hits = searchPaletteItems(items, "Settings");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.id).toBe("settings");
    expect(hits[0].labelRanges).not.toBeNull();
    // The highlighted slice should reproduce the query.
    const ranges = hits[0].labelRanges!;
    const slice = hits[0].item.label.slice(ranges[0], ranges[1]).toLowerCase();
    expect(slice).toBe("settings");
  });

  it("tolerates a single-character typo in the term", () => {
    const items = [item("a", "Dashboard"), item("b", "Repository"), item("c", "Sidebar")];
    // "dashbaord" — a single transposition vs "dashboard"
    const hits = searchPaletteItems(items, "dashbaord");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.id).toBe("a");
  });

  it("falls back to subtitle matching when the label has no match", () => {
    const items = [
      item("a", "Open Settings", "Defaults, providers, tools"),
      item("b", "Search Sessions", "Full-text search across every session timeline")
    ];
    const hits = searchPaletteItems(items, "providers");
    expect(hits.length).toBe(1);
    expect(hits[0].item.id).toBe("a");
    expect(hits[0].labelRanges).toBeNull();
    expect(hits[0].subtitleRanges).not.toBeNull();
  });

  it("returns an empty array when nothing matches", () => {
    const items = [item("a", "Alpha"), item("b", "Beta")];
    expect(searchPaletteItems(items, "zzz")).toEqual([]);
  });

  it("handles out-of-order terms", () => {
    const items = [item("a", "Open Settings"), item("b", "Search Sessions")];
    const hits = searchPaletteItems(items, "settings open");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.id).toBe("a");
  });
});

describe("highlightSegments", () => {
  it("returns a single unmatched segment when ranges are null", () => {
    expect(highlightSegments("Hello", null)).toEqual([{ text: "Hello", matched: false }]);
  });

  it("splits text into matched and unmatched segments", () => {
    const segments = highlightSegments("Dashboard", [0, 4]);
    expect(segments).toEqual([
      { text: "Dash", matched: true },
      { text: "board", matched: false }
    ]);
  });

  it("handles ranges in the middle of the string", () => {
    const segments = highlightSegments("Open Settings", [5, 13]);
    expect(segments).toEqual([
      { text: "Open ", matched: false },
      { text: "Settings", matched: true }
    ]);
  });

  it("handles disjoint matched ranges", () => {
    const segments = highlightSegments("foo bar baz", [0, 3, 8, 11]);
    expect(segments).toEqual([
      { text: "foo", matched: true },
      { text: " bar ", matched: false },
      { text: "baz", matched: true }
    ]);
  });
});

describe("parseFtsSnippet", () => {
  it("returns a single unmatched segment when no markers are present", () => {
    expect(parseFtsSnippet("plain text")).toEqual([{ text: "plain text", matched: false }]);
  });

  it("extracts <b>...</b> matched tokens as matched segments", () => {
    const segments = parseFtsSnippet("the <b>quick</b> brown <b>fox</b>");
    expect(segments).toEqual([
      { text: "the ", matched: false },
      { text: "quick", matched: true },
      { text: " brown ", matched: false },
      { text: "fox", matched: true }
    ]);
  });

  it("treats angle-bracket content outside <b> tags as plain text", () => {
    const segments = parseFtsSnippet("<script>alert(1)</script>");
    // No <b> markers — entire string is unmatched.
    expect(segments).toEqual([{ text: "<script>alert(1)</script>", matched: false }]);
  });
});
