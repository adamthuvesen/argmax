import { describe, expect, it } from "vitest";
import {
  appendReferencesToPrompt,
  buildAttachmentReferences,
  imageAttachmentReference,
  isSupportedImageMime,
  readBlobAsBase64
} from "./composerAttachments.js";

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

describe("isSupportedImageMime", () => {
  it("accepts the four supported types", () => {
    expect(isSupportedImageMime("image/png")).toBe(true);
    expect(isSupportedImageMime("image/jpeg")).toBe(true);
    expect(isSupportedImageMime("image/gif")).toBe(true);
    expect(isSupportedImageMime("image/webp")).toBe(true);
  });

  it("rejects other types", () => {
    expect(isSupportedImageMime("image/bmp")).toBe(false);
    expect(isSupportedImageMime("text/plain")).toBe(false);
    expect(isSupportedImageMime("")).toBe(false);
  });
});

describe("imageAttachmentReference", () => {
  it("prefixes an absolute path with @", () => {
    expect(imageAttachmentReference("/Users/me/Library/Application Support/argmax/x.png")).toBe(
      "@/Users/me/Library/Application Support/argmax/x.png"
    );
  });
});

describe("readBlobAsBase64", () => {
  it("returns the base64 of the blob payload without the data: prefix", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const blob = new Blob([bytes], { type: "image/png" });
    const encoded = await readBlobAsBase64(blob);
    // 0x89 0x50 0x4e 0x47 → "iVBORw==" in base64 (no padding stripped)
    expect(encoded).toBe("iVBORw==");
  });

  it("handles an empty blob without throwing", async () => {
    const blob = new Blob([], { type: "image/png" });
    const encoded = await readBlobAsBase64(blob);
    expect(encoded).toBe("");
  });
});
