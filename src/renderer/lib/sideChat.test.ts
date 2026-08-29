import { describe, expect, it } from "vitest";
import { buildDetailsSeed, buildSideChatSeed } from "./sideChat.js";
import type { TimelineEvent } from "../../shared/types.js";

function event(id: string, type: TimelineEvent["type"], message: string): TimelineEvent {
  return {
    id,
    sessionId: "session-a",
    type,
    message,
    payload: {},
    createdAt: "2026-05-12T15:00:00.000Z"
  };
}

describe("buildSideChatSeed", () => {
  it("quotes the excerpt and includes only conversation messages", () => {
    const seed = buildSideChatSeed("the interesting part", [
      event("u1", "user.message", "fix the flaky test"),
      event("c1", "command.started", "npm test"),
      event("d1", "message.delta", "partial stream"),
      event("m1", "message.completed", "The retry masks a race condition.")
    ]);

    expect(seed).toContain("> the interesting part");
    expect(seed).toContain("User: fix the flaky test");
    expect(seed).toContain("Assistant: The retry masks a race condition.");
    expect(seed).not.toContain("npm test");
    expect(seed).not.toContain("partial stream");
    expect(seed.endsWith("Give me your read on this excerpt, then answer my follow-up questions.")).toBe(true);
  });

  it("quotes every line of a multi-line excerpt", () => {
    const seed = buildSideChatSeed("first line\nsecond line", []);
    expect(seed).toContain("> first line\n> second line");
  });

  it("omits the context block when there are no conversation messages", () => {
    const seed = buildSideChatSeed("orphan excerpt", [event("c1", "command.started", "ls")]);
    expect(seed).not.toContain("Recent context from that session:");
    expect(seed).toContain("> orphan excerpt");
  });

  it("keeps only the newest exchanges and clips long messages", () => {
    const events = Array.from({ length: 15 }, (_, index) =>
      event(`m${index}`, "message.completed", `answer number ${index}`)
    );
    events.push(event("long", "message.completed", "x".repeat(900)));

    const seed = buildSideChatSeed("excerpt", events);

    // 16 messages, limit 12: the oldest four fall off.
    expect(seed).not.toContain("answer number 3");
    expect(seed).toContain("answer number 4");
    expect(seed).toContain(`${"x".repeat(700)}…`);
    expect(seed).not.toContain("x".repeat(701));
  });

  it("skips blank messages entirely", () => {
    const seed = buildSideChatSeed("excerpt", [event("m1", "message.completed", "   ")]);
    expect(seed).not.toContain("Recent context from that session:");
  });
});

describe("buildDetailsSeed", () => {
  it("shares the context block but asks for an explanation", () => {
    const seed = buildDetailsSeed("the interesting part", [
      event("u1", "user.message", "fix the flaky test"),
      event("m1", "message.completed", "The retry masks a race condition.")
    ]);

    expect(seed).toContain("> the interesting part");
    expect(seed).toContain("User: fix the flaky test");
    expect(seed).toContain("Explain this excerpt in more detail");
    expect(seed).toContain("answer my follow-up questions");
  });
});
