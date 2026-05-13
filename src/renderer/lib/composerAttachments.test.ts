import { describe, expect, it } from "vitest";
import { appendReferencesToPrompt, buildAttachmentReferences } from "./composerAttachments.js";

describe("buildAttachmentReferences", () => {
  it("emits workspace-relative @paths for files inside the workspace", () => {
    const refs = buildAttachmentReferences(
      [{ path: "/Users/me/repo/src/app.ts" }, { path: "/Users/me/repo/README.md" }],
      "/Users/me/repo"
    );
    expect(refs).toEqual(["@src/app.ts", "@README.md"]);
  });

  it("emits absolute @paths for files outside the workspace", () => {
    const refs = buildAttachmentReferences(
      [{ path: "/tmp/some/external/file.txt" }],
      "/Users/me/repo"
    );
    expect(refs).toEqual(["@/tmp/some/external/file.txt"]);
  });

  it("falls back to absolute @paths when no workspace path is known", () => {
    const refs = buildAttachmentReferences([{ path: "/tmp/foo.ts" }], null);
    expect(refs).toEqual(["@/tmp/foo.ts"]);
  });

  it("skips files with no `path` (web-only File without Electron extension)", () => {
    const refs = buildAttachmentReferences([{}, { path: "/tmp/foo.ts" }], null);
    expect(refs).toEqual(["@/tmp/foo.ts"]);
  });

  it("handles trailing-slash workspace paths correctly", () => {
    const refs = buildAttachmentReferences([{ path: "/Users/me/repo/a.ts" }], "/Users/me/repo/");
    expect(refs).toEqual(["@a.ts"]);
  });
});

describe("appendReferencesToPrompt", () => {
  it("returns the prompt unchanged when no references are passed", () => {
    expect(appendReferencesToPrompt("hello", [])).toBe("hello");
  });

  it("joins references onto an empty prompt without a leading space", () => {
    expect(appendReferencesToPrompt("", ["@a.ts", "@b.ts"])).toBe("@a.ts @b.ts");
  });

  it("appends references after an existing prompt with a single space separator", () => {
    expect(appendReferencesToPrompt("look at", ["@src/a.ts"])).toBe("look at @src/a.ts");
  });
});
