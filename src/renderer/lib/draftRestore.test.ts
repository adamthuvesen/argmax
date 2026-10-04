import { describe, expect, it } from "vitest";
import type { ComposerAttachment } from "../../shared/types.js";
import { restoreDraftAttachments, restoreDraftText } from "./draftRestore.js";

const shot = (filePath: string): ComposerAttachment => ({
  filePath,
  mimeType: "image/png",
  sizeBytes: 1
});

describe("restoring a failed background send", () => {
  it("puts the draft back in an empty composer", () => {
    expect(restoreDraftText("", "ship it")).toBe("ship it");
    expect(restoreDraftText("  \n", "ship it")).toBe("ship it");
  });

  it("keeps what the person has typed since, below the restored draft", () => {
    expect(restoreDraftText("next idea", "ship it")).toBe("ship it\n\nnext idea");
  });

  it("changes nothing when there is nothing to restore", () => {
    expect(restoreDraftText("next idea", "  ")).toBe("next idea");
  });

  it("merges attachments, restored first, without repeats", () => {
    expect(
      restoreDraftAttachments([shot("/b.png"), shot("/a.png")], [shot("/a.png")])
    ).toEqual([shot("/a.png"), shot("/b.png")]);
  });
});
