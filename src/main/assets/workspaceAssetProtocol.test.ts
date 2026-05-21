import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerWorkspaceAssetProtocolHandler } from "./workspaceAssetProtocol.js";
import { workspaceAssetUrl, WORKSPACE_ASSET_PROTOCOL_SCHEME } from "../../shared/assetProtocol.js";

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

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("registerWorkspaceAssetProtocolHandler", () => {
  it("serves an image inside an allowed root with the right content-type", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "argmax-asset-"));
    const assetsDir = path.join(root, "docs", "assets");
    await mkdir(assetsDir, { recursive: true });
    const filePath = path.join(assetsDir, "logo.png");
    await writeFile(filePath, pngBytes);

    const cap = captureHandler();
    registerWorkspaceAssetProtocolHandler({ getAllowedRoots: () => [root] }, cap);

    const url = workspaceAssetUrl(filePath);
    expect(url.startsWith(`${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file`)).toBe(true);

    const response = await cap.current!(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.equals(pngBytes)).toBe(true);
  });

  it("returns 403 for paths outside any allowed root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "argmax-asset-"));
    const cap = captureHandler();
    registerWorkspaceAssetProtocolHandler({ getAllowedRoots: () => [root] }, cap);

    const response = await cap.current!(new Request(workspaceAssetUrl("/etc/passwd.png")));
    expect(response.status).toBe(403);
  });

  it("returns 403 when traversal escapes the allowed root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "argmax-asset-"));
    const sibling = await mkdtemp(path.join(tmpdir(), "argmax-other-"));
    const filePath = path.join(sibling, "leak.png");
    await writeFile(filePath, pngBytes);

    const cap = captureHandler();
    registerWorkspaceAssetProtocolHandler({ getAllowedRoots: () => [root] }, cap);

    const response = await cap.current!(new Request(workspaceAssetUrl(filePath)));
    expect(response.status).toBe(403);
  });

  it("returns 415 for non-image extensions even inside an allowed root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "argmax-asset-"));
    const filePath = path.join(root, "secret.env");
    await writeFile(filePath, "TOKEN=hunter2");

    const cap = captureHandler();
    registerWorkspaceAssetProtocolHandler({ getAllowedRoots: () => [root] }, cap);

    const response = await cap.current!(new Request(workspaceAssetUrl(filePath)));
    expect(response.status).toBe(415);
  });

  it("returns 404 when the file inside an allowed root does not exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "argmax-asset-"));
    const cap = captureHandler();
    registerWorkspaceAssetProtocolHandler({ getAllowedRoots: () => [root] }, cap);

    const missing = path.join(root, "missing.png");
    const response = await cap.current!(new Request(workspaceAssetUrl(missing)));
    expect(response.status).toBe(404);
  });

  it("re-reads allowed roots on each request so newly added workspaces work without re-register", async () => {
    const rootA = await mkdtemp(path.join(tmpdir(), "argmax-asset-"));
    const rootB = await mkdtemp(path.join(tmpdir(), "argmax-asset-"));
    const filePath = path.join(rootB, "later.png");
    await writeFile(filePath, pngBytes);

    let roots: string[] = [rootA];
    const cap = captureHandler();
    registerWorkspaceAssetProtocolHandler({ getAllowedRoots: () => roots }, cap);

    const url = workspaceAssetUrl(filePath);
    expect((await cap.current!(new Request(url))).status).toBe(403);

    roots = [rootA, rootB];
    expect((await cap.current!(new Request(url))).status).toBe(200);
  });
});
