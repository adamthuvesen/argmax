import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerAttachmentProtocolHandler } from "./attachmentProtocol.js";
import { attachmentProtocolUrl, ATTACHMENT_PROTOCOL_SCHEME } from "../../shared/attachmentProtocol.js";

type Handler = (request: Request) => Response | Promise<Response>;

function captureHandler(): { handle: (scheme: string, h: Handler) => void; current: Handler | null } {
  const captured: { handle: (scheme: string, h: Handler) => void; current: Handler | null } = {
    current: null,
    handle(_scheme, h) {
      captured.current = h;
    }
  };
  return captured;
}

describe("registerAttachmentProtocolHandler", () => {
  it("serves a real file inside the base dir with the right content-type", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "argmax-proto-"));
    const sessionDir = path.join(base, "session-x");
    const filePath = path.join(sessionDir, "shot.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(filePath, bytes).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(filePath, bytes);
    });

    const cap = captureHandler();
    registerAttachmentProtocolHandler(base, cap);

    const url = attachmentProtocolUrl(filePath);
    expect(url.startsWith(`${ATTACHMENT_PROTOCOL_SCHEME}://file`)).toBe(true);

    const response = await cap.current!(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.equals(bytes)).toBe(true);
  });

  it("returns 403 for paths that escape the base dir", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "argmax-proto-"));
    const cap = captureHandler();
    registerAttachmentProtocolHandler(base, cap);

    const outsidePath = "/etc/passwd";
    const response = await cap.current!(new Request(attachmentProtocolUrl(outsidePath)));
    expect(response.status).toBe(403);
  });

  it("returns 404 when the file inside the base dir does not exist", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "argmax-proto-"));
    const cap = captureHandler();
    registerAttachmentProtocolHandler(base, cap);

    const missing = path.join(base, "missing", "thing.png");
    const response = await cap.current!(new Request(attachmentProtocolUrl(missing)));
    expect(response.status).toBe(404);
  });
});
