import { describe, expect, it } from "vitest";
import { ATTACHMENT_PROTOCOL_SCHEME } from "../../shared/attachmentProtocol.js";
import { WORKSPACE_ASSET_PROTOCOL_SCHEME } from "../../shared/assetProtocol.js";
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

