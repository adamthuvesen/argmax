import { describe, expect, it } from "vitest";
import {
  appendOpenFilesToPrompt,
  openFilesChipLabel,
  orderedOpenFilePaths
} from "./openFileContext.js";

describe("orderedOpenFilePaths", () => {
  it("puts the active tab first and keeps tab order otherwise", () => {
    const tabs = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }];
    expect(orderedOpenFilePaths(tabs, "b.ts")).toEqual(["b.ts", "a.ts", "c.ts"]);
  });

  it("keeps tab order when no tab is active", () => {
    const tabs = [{ path: "a.ts" }, { path: "b.ts" }];
    expect(orderedOpenFilePaths(tabs, null)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("openFilesChipLabel", () => {
  it("names the active file and counts the rest", () => {
    expect(openFilesChipLabel(["models/deep/query.sql", "docs/notes.md"])).toBe(
      "Open files: query.sql +1"
    );
    expect(openFilesChipLabel(["docs/notes.md"])).toBe("Open file: notes.md");
  });
});

describe("appendOpenFilesToPrompt", () => {
  it("appends @path references after the message", () => {
    expect(appendOpenFilesToPrompt("Fix the join.", ["a.sql", "b.sql"])).toBe(
      "Fix the join.\n\nFor context, I have these files open in the editor:\n@a.sql\n@b.sql"
    );
  });

  it("skips paths the user already mentioned and no-ops when none remain", () => {
    expect(appendOpenFilesToPrompt("Look at @a.sql please.", ["a.sql", "b.sql"])).toBe(
      "Look at @a.sql please.\n\nFor context, I have these files open in the editor:\n@b.sql"
    );
    expect(appendOpenFilesToPrompt("Look at @a.sql please.", ["a.sql"])).toBe(
      "Look at @a.sql please."
    );
  });
});
