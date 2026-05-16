import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "./attachmentStore.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

describe("AttachmentStore", () => {
  let baseDir: string;
  let store: AttachmentStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "argmax-attachments-"));
    store = new AttachmentStore(baseDir);
  });

  afterEach(async () => {
    await store.pruneSession("session-1");
    await store.pruneSession("session-2");
  });

  it("saves a PNG into the per-session folder and reports its size", async () => {
    const result = await store.saveImage({
      sessionId: "session-1",
      mimeType: "image/png",
      dataBase64: PNG_BYTES.toString("base64")
    });

    expect(result.sizeBytes).toBe(PNG_BYTES.length);
    expect(result.filePath.startsWith(path.join(baseDir, "session-1"))).toBe(true);
    expect(result.filePath.endsWith(".png")).toBe(true);

    const written = await readFile(result.filePath);
    expect(written.equals(PNG_BYTES)).toBe(true);
  });

  it("uses the right extension for each supported mime type", async () => {
    const cases: Array<{ mime: Parameters<typeof store.saveImage>[0]["mimeType"]; ext: string }> = [
      { mime: "image/jpeg", ext: ".jpg" },
      { mime: "image/gif", ext: ".gif" },
      { mime: "image/webp", ext: ".webp" }
    ];

    for (const { mime, ext } of cases) {
      const result = await store.saveImage({
        sessionId: "session-1",
        mimeType: mime,
        dataBase64: PNG_BYTES.toString("base64")
      });
      expect(result.filePath.endsWith(ext)).toBe(true);
    }
  });

  it("rejects an unsupported mime type", async () => {
    await expect(
      store.saveImage({
        sessionId: "session-1",
        // @ts-expect-error -- testing runtime guard
        mimeType: "image/bmp",
        dataBase64: PNG_BYTES.toString("base64")
      })
    ).rejects.toMatchObject({ code: "INVALID_MIME" });
  });

  it("rejects an oversized payload", async () => {
    const tooBig = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0xff);
    await expect(
      store.saveImage({
        sessionId: "session-1",
        mimeType: "image/png",
        dataBase64: tooBig.toString("base64")
      })
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("rejects an empty payload", async () => {
    await expect(
      store.saveImage({
        sessionId: "session-1",
        mimeType: "image/png",
        dataBase64: ""
      })
    ).rejects.toThrow();
  });

  it("isolates sessions in distinct subfolders", async () => {
    const a = await store.saveImage({
      sessionId: "session-1",
      mimeType: "image/png",
      dataBase64: PNG_BYTES.toString("base64")
    });
    const b = await store.saveImage({
      sessionId: "session-2",
      mimeType: "image/png",
      dataBase64: PNG_BYTES.toString("base64")
    });
    expect(path.dirname(a.filePath)).not.toBe(path.dirname(b.filePath));
  });

  it("pruneSession removes the per-session folder", async () => {
    await store.saveImage({
      sessionId: "session-1",
      mimeType: "image/png",
      dataBase64: PNG_BYTES.toString("base64")
    });
    const sessionDir = path.join(baseDir, "session-1");
    expect((await readdir(sessionDir)).length).toBeGreaterThan(0);

    await store.pruneSession("session-1");

    await expect(stat(sessionDir)).rejects.toThrow();
  });

  it("pruneSession is a no-op for a missing folder", async () => {
    await expect(store.pruneSession("never-existed")).resolves.toBeUndefined();
  });
});
