// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  appendReferencesToPrompt,
  buildAttachmentReferences,
  collectDroppedFiles,
  downscaleImageBlob,
  droppedFileHasUsablePath,
  imageAttachmentReference,
  imageMimeFromDragType,
  imageMimeFromFileName,
  isAttachableDrag,
  isImageDragType,
  isSupportedImageMime,
  isTransientScreenshotPath,
  listDragTypes,
  readBlobAsBase64
} from "./composerAttachments.js";
import { WORKSPACE_DRAG_MIME } from "./gridState.js";

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

  it("skips files with no `path` (web-only File without Tauri extension)", () => {
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

describe("imageMimeFromFileName", () => {
  it("reads the extension of a macOS screenshot name", () => {
    expect(imageMimeFromFileName("Screenshot 2026-09-05 at 10.30.00.png")).toBe("image/png");
  });

  it("returns null when the name has no image extension", () => {
    expect(imageMimeFromFileName("notes.md")).toBeNull();
    expect(imageMimeFromFileName("image")).toBeNull();
  });
});

describe("imageMimeFromDragType", () => {
  it("maps Apple image UTIs to supported MIME types", () => {
    expect(imageMimeFromDragType("public.png")).toBe("image/png");
    expect(imageMimeFromDragType("public.jpeg")).toBe("image/jpeg");
    expect(imageMimeFromDragType("image/png")).toBe("image/png");
  });

  it("rejects TIFF and other unsaved image types", () => {
    expect(imageMimeFromDragType("public.tiff")).toBeNull();
    expect(imageMimeFromDragType("image/tiff")).toBeNull();
    expect(imageMimeFromDragType("text/plain")).toBeNull();
  });
});

describe("isImageDragType", () => {
  it("accepts TIFF pasteboard types so a screenshot thumbnail highlights", () => {
    expect(isImageDragType("public.tiff")).toBe(true);
    expect(isImageDragType("image/tiff")).toBe(true);
    expect(isImageDragType("public.png")).toBe(true);
  });

  it("rejects non-image types", () => {
    expect(isImageDragType("text/plain")).toBe(false);
  });
});

describe("isTransientScreenshotPath", () => {
  it("recognizes the macOS screenshot-thumbnail temp file", () => {
    expect(
      isTransientScreenshotPath(
        "/var/folders/09/w9q/T/TemporaryItems/NSIRD_screencaptureui_2MPBtJ/Screenshot 2026-09-06.png"
      )
    ).toBe(true);
  });

  it("leaves ordinary disk paths alone", () => {
    expect(isTransientScreenshotPath("/Users/me/Desktop/Screenshot.png")).toBe(false);
  });
});

describe("listDragTypes", () => {
  it("reads an array of types", () => {
    expect(listDragTypes({ types: ["Files", "text/plain"] })).toEqual(["Files", "text/plain"]);
  });

  it("splits a comma-separated types string instead of iterating characters", () => {
    expect(listDragTypes({ types: "Files,image/png" })).toEqual(["Files", "image/png"]);
  });

  it("treats missing types as empty", () => {
    expect(listDragTypes({})).toEqual([]);
  });
});

describe("isAttachableDrag", () => {
  it("accepts a Finder-style file drag", () => {
    expect(isAttachableDrag({ types: ["Files"] })).toBe(true);
  });

  it("accepts an in-memory image drag that never advertises Files", () => {
    expect(isAttachableDrag({ types: ["image/png"] })).toBe(true);
  });

  it("accepts a promised-file drag whose types stay empty until drop", () => {
    expect(isAttachableDrag({ types: [] })).toBe(true);
  });

  it("accepts the macOS screenshot thumbnail's Apple UTI", () => {
    expect(isAttachableDrag({ types: ["public.png"] })).toBe(true);
    expect(isAttachableDrag({ types: ["public.tiff"] })).toBe(true);
  });

  it("accepts a file-promise drag", () => {
    expect(
      isAttachableDrag({ types: ["com.apple.pasteboard.promised-file-url"] })
    ).toBe(true);
  });

  it("accepts empty types even when string items are listed", () => {
    // Tauri WKWebView hides the real types until drop and may still expose
    // string items. Rejecting those was how the screenshot thumbnail never
    // highlighted and never fired drop.
    expect(
      isAttachableDrag({
        types: [],
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }]
      })
    ).toBe(true);
  });

  it("rejects a text drag", () => {
    expect(isAttachableDrag({ types: ["text/plain"] })).toBe(false);
  });

  it("rejects an in-app workspace pane drag", () => {
    expect(isAttachableDrag({ types: [WORKSPACE_DRAG_MIME] })).toBe(false);
  });
});

describe("collectDroppedFiles", () => {
  it("returns files from the FileList", () => {
    const file = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    expect(collectDroppedFiles({ files: [file] })).toEqual([file]);
  });

  it("reads items when the FileList is empty", () => {
    const file = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    const collected = collectDroppedFiles({
      files: [],
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }]
    });
    expect(collected).toEqual([file]);
  });

  it("stamps the item MIME onto a typeless file", () => {
    const file = new File([new Uint8Array([1])], "shot.png", { type: "" });
    const [collected] = collectDroppedFiles({
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }]
    });
    expect(collected?.type).toBe("image/png");
    expect(collected?.name).toBe("shot.png");
  });

  it("stamps an Apple image UTI onto a typeless file", () => {
    const file = new File([new Uint8Array([1])], "shot.png", { type: "" });
    const [collected] = collectDroppedFiles({
      items: [{ kind: "file", type: "public.png", getAsFile: () => file }]
    });
    expect(collected?.type).toBe("image/png");
  });

  it("does not attach a second copy when files and items both hold the same typeless image", () => {
    const file = new File([new Uint8Array([1])], "shot.png", { type: "" });
    const collected = collectDroppedFiles({
      files: [file],
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }]
    });
    expect(collected).toEqual([file]);
  });

  it("keeps a Finder path and does not also persist a wrapped copy", () => {
    const file = new File([new Uint8Array([1])], "shot.png", { type: "" });
    Object.defineProperty(file, "path", { value: "/tmp/shot.png" });
    const collected = collectDroppedFiles({
      files: [file],
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }]
    });
    expect(collected).toHaveLength(1);
    expect(collected[0]).toBe(file);
    expect((collected[0] as { path?: string }).path).toBe("/tmp/shot.png");
  });

  it("ignores string items", () => {
    expect(
      collectDroppedFiles({
        items: [{ kind: "string", type: "text/html", getAsFile: () => null }]
      })
    ).toEqual([]);
  });
});

describe("droppedFileHasUsablePath", () => {
  it("keeps a Finder path", () => {
    const file = new File([new Uint8Array([1])], "shot.png", { type: "" });
    Object.defineProperty(file, "path", { value: "/tmp/shot.png" });
    expect(droppedFileHasUsablePath(file)).toBe(true);
  });

  it("rejects the screenshot-thumbnail temp path so bytes are persisted instead", () => {
    const file = new File([new Uint8Array([1])], "Screenshot.png", { type: "" });
    Object.defineProperty(file, "path", {
      value:
        "/var/folders/xx/T/TemporaryItems/NSIRD_screencaptureui_abc/Screenshot.png"
    });
    expect(droppedFileHasUsablePath(file)).toBe(false);
  });

  it("rejects a path-less in-memory image", () => {
    const file = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    expect(droppedFileHasUsablePath(file)).toBe(false);
  });
});

describe("imageAttachmentReference", () => {
  it("prefixes an absolute path with @", () => {
    expect(imageAttachmentReference("/Users/me/Library/Application Support/argmax/x.png")).toBe(
      "@/Users/me/Library/Application Support/argmax/x.png"
    );
  });
});

describe("downscaleImageBlob", () => {
  it("passes GIFs through untouched so animation survives", async () => {
    const gif = new Blob([new Uint8Array([1, 2, 3])], { type: "image/gif" });
    await expect(downscaleImageBlob(gif)).resolves.toBe(gif);
  });

  it("returns the original when the runtime cannot decode images", async () => {
    // jsdom has no createImageBitmap: pastes must still attach.
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    expect(typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap).toBe(
      "undefined"
    );
    await expect(downscaleImageBlob(png)).resolves.toBe(png);
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
