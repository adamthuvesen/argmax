// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_PROTOCOL_SCHEME,
  attachmentProtocolUrl
} from "../../shared/attachmentProtocol.js";
import {
  WORKSPACE_ASSET_PROTOCOL_SCHEME,
  workspaceAssetUrl
} from "../../shared/assetProtocol.js";
import {
  REMOTE_BRIDGE_KEY,
  REMOTE_TOKEN_KEY
} from "../../shared/remoteProtocol.js";
import { resolveChatImageSrc } from "./chatImageSrc.js";

describe("resolveChatImageSrc", () => {
  it("routes workspace images through the guarded workspace protocol", () => {
    expect(resolveChatImageSrc("scratch/lane.png", "/repo")).toBe(
      `${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file/repo/scratch/lane.png`
    );
    expect(resolveChatImageSrc("/repo/scratch/lane.png", "/repo")).toBe(
      `${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file/repo/scratch/lane.png`
    );
  });

  it("routes other absolute paths through the guarded attachment protocol", () => {
    expect(
      resolveChatImageSrc(
        "/Users/me/Library/Application%20Support/com.argmax.rs/local-state/attachments/s/shot.png",
        "/repo"
      )
    ).toBe(
      `${ATTACHMENT_PROTOCOL_SCHEME}://file/Users/me/Library/Application%20Support/com.argmax.rs/local-state/attachments/s/shot.png`
    );
  });

  it("keeps web images and rejects relative traversal", () => {
    expect(resolveChatImageSrc("https://example.com/shot.png", "/repo")).toBe(
      "https://example.com/shot.png"
    );
    expect(resolveChatImageSrc("../secret.png", "/repo")).toBeNull();
  });
});

describe("remote image resolution", () => {
  beforeEach(() => {
    window.localStorage.setItem(REMOTE_BRIDGE_KEY, "1");
    window.localStorage.setItem(REMOTE_TOKEN_KEY, "test-remote-token-12345");
  });

  afterEach(() => {
    window.localStorage.removeItem(REMOTE_BRIDGE_KEY);
    window.localStorage.removeItem(REMOTE_TOKEN_KEY);
  });

  it("resolves attachmentProtocolUrl as an authenticated HTTP route on remote", () => {
    const path = "/Users/me/attachments/session-1/screenshot.png";
    const url = attachmentProtocolUrl(path);
    expect(url).toBe(
      "/api/attachments/Users/me/attachments/session-1/screenshot.png?token=test-remote-token-12345"
    );
  });

  it("resolves workspaceAssetUrl as an authenticated HTTP route on remote", () => {
    const path = "/repo/assets/diagram.png";
    const url = workspaceAssetUrl(path);
    expect(url).toBe(
      "/api/workspace-assets/repo/assets/diagram.png?token=test-remote-token-12345"
    );
  });

  it("converts existing argmax-attachment URLs to authenticated remote HTTP URLs", () => {
    const customScheme =
      "argmax-attachment://file/Users/me/attachments/session-1/screenshot.png";
    expect(resolveChatImageSrc(customScheme, "/repo")).toBe(
      "/api/attachments/Users/me/attachments/session-1/screenshot.png?token=test-remote-token-12345"
    );
  });

  it("converts existing argmax-asset URLs to authenticated remote HTTP URLs", () => {
    const customScheme = "argmax-asset://file/repo/assets/diagram.png";
    expect(resolveChatImageSrc(customScheme, "/repo")).toBe(
      "/api/workspace-assets/repo/assets/diagram.png?token=test-remote-token-12345"
    );
  });
});
