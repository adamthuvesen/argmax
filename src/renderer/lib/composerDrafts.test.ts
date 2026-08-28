import { beforeEach, describe, expect, it } from "vitest";
import type { ComposerAttachment } from "../../shared/types.js";
import { readDraft, writeDraftAttachments, writeDraftText } from "./composerDrafts.js";

const DRAFTS_KEY = "argmax.composer.drafts";

function screenshot(filePath: string): ComposerAttachment {
  return { filePath, mimeType: "image/png", sizeBytes: 42 };
}

function stored(): unknown {
  return JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? "{}") as unknown;
}

describe("composer drafts", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps text and screenshots in the same entry", () => {
    writeDraftText("session-a", "look at this");
    writeDraftAttachments("session-a", [screenshot("/att/a.png")]);

    expect(readDraft("session-a")).toEqual({
      text: "look at this",
      attachments: [screenshot("/att/a.png")]
    });
  });

  it("remembers a screenshot with no text typed beside it", () => {
    writeDraftAttachments("session-a", [screenshot("/att/a.png")]);

    expect(readDraft("session-a").attachments).toEqual([screenshot("/att/a.png")]);
  });

  it("drops the entry once neither text nor screenshots are left", () => {
    writeDraftText("session-a", "look at this");
    writeDraftAttachments("session-a", [screenshot("/att/a.png")]);

    writeDraftText("session-a", "");
    expect(readDraft("session-a").attachments).toHaveLength(1);

    writeDraftAttachments("session-a", []);
    expect(stored()).toEqual({});
  });

  it("keeps drafts to their own key", () => {
    writeDraftText("session-a", "for a");
    writeDraftAttachments("session-b", [screenshot("/att/b.png")]);

    expect(readDraft("session-a")).toEqual({ text: "for a", attachments: [] });
    expect(readDraft("session-b")).toEqual({ text: "", attachments: [screenshot("/att/b.png")] });
    expect(readDraft(null)).toEqual({ text: "", attachments: [] });
  });

  it("reads a pre-screenshot draft, written as bare text, as text with no attachments", () => {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify({ "session-a": "typed last release" }));

    expect(readDraft("session-a")).toEqual({ text: "typed last release", attachments: [] });
  });

  it("ignores stored attachments that aren't usable image records", () => {
    window.localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify({
        "session-a": {
          text: "hi",
          attachments: [
            screenshot("/att/a.png"),
            { filePath: "/att/b.pdf", mimeType: "application/pdf", sizeBytes: 1 },
            { filePath: "", mimeType: "image/png", sizeBytes: 1 },
            "not-an-attachment"
          ]
        }
      })
    );

    expect(readDraft("session-a").attachments).toEqual([screenshot("/att/a.png")]);
  });

  it("survives unreadable storage", () => {
    window.localStorage.setItem(DRAFTS_KEY, "{not json");

    expect(readDraft("session-a")).toEqual({ text: "", attachments: [] });
  });

  it("forgets the least recently edited drafts past the cap", () => {
    for (let index = 0; index < 51; index += 1) {
      writeDraftText(`session-${index}`, `draft ${index}`);
    }

    expect(readDraft("session-0").text).toBe("");
    expect(readDraft("session-1").text).toBe("draft 1");
    expect(readDraft("session-50").text).toBe("draft 50");
  });
});
