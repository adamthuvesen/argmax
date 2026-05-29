import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import { coalesceAssistantGroups } from "./sessionTurnView.js";

function assistantEvent(
  id: string,
  type: "message.completed" | "message.delta",
  message: string,
  createdAt: string
): TimelineEvent {
  return {
    id,
    sessionId: "s1",
    type,
    message,
    payload: {},
    createdAt,
    rowCursor: 0
  };
}

describe("coalesceAssistantGroups", () => {
  it("drops a duplicate message.completed with the same text as the prior group", () => {
    const groups = coalesceAssistantGroups([
      assistantEvent("a1", "message.completed", "Hey!", "2026-05-12T15:00:01.000Z"),
      assistantEvent("a2", "message.completed", "Hey!", "2026-05-12T15:00:02.000Z")
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.text).toBe("Hey!");
  });
});
