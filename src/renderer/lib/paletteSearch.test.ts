import { describe, expect, it } from "vitest";
import {
  highlightSegments,
  parseFtsSnippet,
  searchPaletteItems,
  searchFilePaths,
  type PaletteItem
} from "./paletteSearch.js";

const noop = () => {};

function item(id: string, label: string, subtitle?: string): PaletteItem {
  return { id, label, subtitle, group: "Sessions", run: noop };
}

describe("searchPaletteItems", () => {
  it("matches terms spread across the title and project", () => {
    const row = { ...item("a", "Fix sidebar resize"), meta: "Argmax" };
    expect(searchPaletteItems([row], "argmax resize").map((hit) => hit.item.id)).toEqual(["a"]);
    const hit = searchPaletteItems([row], "argmax resize")[0];
    expect(highlightSegments(row.label, hit.labelRanges).filter((part) => part.matched).map((part) => part.text)).toEqual(["resize"]);
    expect(highlightSegments(row.meta, hit.subtitleRanges).filter((part) => part.matched).map((part) => part.text)).toEqual(["Argmax"]);
  });

  it("matches a word the user has only started typing", () => {
    const rows = [item("usage", "Open usage"), item("terminal", "Toggle terminal")];
    expect(searchPaletteItems(rows, "us").map((hit) => hit.item.id)).toEqual(["usage"]);
    expect(searchPaletteItems(rows, "term").map((hit) => hit.item.id)).toEqual(["terminal"]);
  });

  it("matches unshown keywords a tier under the label, without highlighting them", () => {
    const terminal = { ...item("terminal", "Toggle terminal"), keywords: ["shell", "console"] };
    const shellChat = item("chat", "Shell script cleanup");
    const hits = searchPaletteItems([shellChat, terminal], "shell");
    expect(hits.map((hit) => hit.item.id)).toEqual(["chat", "terminal"]);
    expect(hits[1].labelRanges).toBeNull();
    expect(searchPaletteItems([terminal], "toggle shell").map((hit) => hit.item.id)).toEqual(["terminal"]);
  });

  it("keeps exact matches first even beyond the fuzzy ranking threshold", () => {
    const rows = Array.from({ length: 1100 }, (_, index) => item(String(index), `Search result ${index}`));
    rows.push(item("exact", "Search"));
    expect(searchPaletteItems(rows, "Search")[0].item.id).toBe("exact");
  });
  it("returns items in original order when the query is empty", () => {
    const items = [item("a", "Alpha"), item("b", "Beta"), item("c", "Gamma")];
    const hits = searchPaletteItems(items, "");
    expect(hits.map((hit) => hit.item.id)).toEqual(["a", "b", "c"]);
    expect(hits.every((hit) => hit.labelRanges === null && hit.subtitleRanges === null)).toBe(true);
  });

  it("ranks substring matches in the label first and returns highlight ranges", () => {
    const items = [
      item("settings", "Open Settings", "Defaults, providers, tools"),
      item("session", "New Chat", "Open the launcher"),
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

  it("handles out-of-order terms", () => {
    const items = [item("a", "Open Settings"), item("b", "Search Sessions")];
    const hits = searchPaletteItems(items, "settings open");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.id).toBe("a");
  });

  it("ranks Files-group items by basename when the query matches the filename", () => {
    const files: PaletteItem[] = [
      { id: "file:src-tauri/src/index.ts", label: "index.ts", subtitle: "src-tauri/src", group: "Files", run: noop },
      { id: "file:src/renderer/App.tsx", label: "App.tsx", subtitle: "src/renderer", group: "Files", run: noop }
    ];
    const hits = searchPaletteItems(files, "App");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.id).toBe("file:src/renderer/App.tsx");
  });
});

describe("searchFilePaths", () => {
  it("prefers a filename match to a directory match", () => {
    expect(searchFilePaths(["app/docs/README.md", "src/App.tsx", "app/server.ts"], "app")[0]).toBe("src/App.tsx");
  });

  it("lets changed files lead ties and an empty query, never a better match", () => {
    const paths = ["src/app.ts", "lib/app.ts", "src/appendix.ts"];
    const changed = new Set(["lib/app.ts", "src/appendix.ts"]);
    expect(searchFilePaths(paths, "app.ts", 50, changed)[0]).toBe("lib/app.ts");
    expect(searchFilePaths(paths, "", 50, changed)).toEqual(["lib/app.ts", "src/appendix.ts", "src/app.ts"]);
    expect(searchFilePaths(["src/app.ts", "src/appendix.ts"], "app.ts", 50, new Set(["src/appendix.ts"]))[0])
      .toBe("src/app.ts");
  });

  it("keeps exact filenames first in large result sets", () => {
    const paths = Array.from({ length: 1100 }, (_, index) => `app/folder-${index}/long.ts`);
    paths.push("src/app.ts");
    expect(searchFilePaths(paths, "app", 8)[0]).toBe("src/app.ts");
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
