import { describe, expect, it } from "vitest";
import {
  CHAT_REFERENCE_PREFIX,
  chatReferenceLink,
  chatReferencesAsTitles,
  decodeClipboardPayload,
  encodeClipboardPayload,
  findChatReferences,
  referencedSessionIds
} from "./composerContext.js";

describe("chat references", () => {
  it("writes a versioned link that reads back to the same reference", () => {
    const link = chatReferenceLink({ sessionId: "abc-123", eventId: "evt_9", title: "Fix login" });

    expect(link).toBe("[Fix login](argmax://chat/abc-123?v=1&e=evt_9)");
    expect(findChatReferences(`see ${link} now`)).toEqual([
      {
        from: 4,
        to: 4 + link.length,
        reference: { v: 1, sessionId: "abc-123", eventId: "evt_9", title: "Fix login" }
      }
    ]);
  });

  it("keeps the backend's grant prefix in the link", () => {
    expect(chatReferenceLink({ sessionId: "s1", title: "x" })).toContain(`(${CHAT_REFERENCE_PREFIX}s1?`);
  });

  it("flattens titles that would break the link and never loses the id", () => {
    const link = chatReferenceLink({ sessionId: "s1", title: "a [b]\nc\t d" });

    expect(link).toBe("[a (b) c d](argmax://chat/s1?v=1)");
    expect(findChatReferences(link)[0]?.reference.sessionId).toBe("s1");
    expect(chatReferenceLink({ sessionId: "s1", title: "  " })).toBe("[Chat](argmax://chat/s1?v=1)");
    expect(chatReferenceLink({ sessionId: "s1", title: "x".repeat(300) })).toHaveLength(
      "[](argmax://chat/s1?v=1)".length + 120
    );
  });

  it("refuses ids that could escape the link", () => {
    expect(() => chatReferenceLink({ sessionId: "a)b", title: "x" })).toThrow("Not a chat id");
    expect(() => chatReferenceLink({ sessionId: "a", eventId: "e&v=2", title: "x" })).toThrow(
      "Not an event id"
    );
  });

  it("leaves a reference this build cannot read as visible text", () => {
    const future = "[Later](argmax://chat/s1?v=2)";
    const withoutVersion = "[Plain](argmax://chat/s2)";

    expect(findChatReferences(future)).toEqual([]);
    // Spelled differently, so the backend's grant parser would not read it either.
    expect(findChatReferences("[x](argmax://chat/s1?v=01)")).toEqual([]);
    expect(findChatReferences("[x](argmax://chat/s1?v=)")).toEqual([]);
    expect(findChatReferences(withoutVersion)).toHaveLength(1);
    expect(findChatReferences("[x](https://example.com/chat/s1)")).toEqual([]);
  });

  it("lists each referenced chat once, in order", () => {
    const text = [
      chatReferenceLink({ sessionId: "b", title: "B" }),
      chatReferenceLink({ sessionId: "a", title: "A" }),
      chatReferenceLink({ sessionId: "b", eventId: "e1", title: "B again" })
    ].join(" and ");

    expect(referencedSessionIds(text)).toEqual(["b", "a"]);
  });
});

describe("chatReferencesAsTitles", () => {
  it("replaces each reference with its title and leaves the rest alone", () => {
    const text = `a ${chatReferenceLink({ sessionId: "s1", title: "One" })} b ${chatReferenceLink({ sessionId: "s2", title: "Two" })}`;

    expect(chatReferencesAsTitles(text)).toBe("a One b Two");
    expect(chatReferencesAsTitles("no links [here](https://x.dev)")).toBe("no links [here](https://x.dev)");
  });
});

describe("composer clipboard payload", () => {
  it("carries the text and the references it holds", () => {
    const text = `ask ${chatReferenceLink({ sessionId: "s1", title: "Source" })}`;
    const decoded = decodeClipboardPayload(encodeClipboardPayload(text));

    expect(decoded).toEqual({
      v: 1,
      text,
      references: [{ v: 1, sessionId: "s1", title: "Source" }]
    });
  });

  it("rejects a payload that is not ours, so paste falls back to the plain text", () => {
    const text = chatReferenceLink({ sessionId: "s1", title: "Source" });
    const forged = JSON.stringify({
      v: 1,
      text,
      references: [{ v: 1, sessionId: "other", title: "Other" }]
    });

    expect(decodeClipboardPayload("{nope")).toBeNull();
    expect(decodeClipboardPayload(JSON.stringify({ v: 2, text, references: [] }))).toBeNull();
    expect(decodeClipboardPayload(JSON.stringify({ v: 1, text: 4, references: [] }))).toBeNull();
    expect(decodeClipboardPayload(forged)).toBeNull();
  });
});
