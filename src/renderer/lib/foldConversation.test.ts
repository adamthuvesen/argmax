import { describe, expect, it } from "vitest";
import type { EventType, TimelineEvent } from "../../shared/types.js";
import { foldRenderItems } from "./foldConversation.js";
import type { ConversationItem, TurnToolItem } from "./toolCalls.js";

function event(
  id: string,
  type: EventType,
  createdAt: string,
  message = id,
  payload: Record<string, unknown> = {}
): TimelineEvent {
  return {
    id,
    sessionId: "s1",
    type,
    message,
    payload,
    createdAt
  };
}

const keepToolItems = (items: TurnToolItem[]): TurnToolItem[] => items;

describe("foldRenderItems", () => {
  it("anchors a turn id to the user message when early assistant deltas are capped away", () => {
    const user: ConversationItem = {
      kind: "message",
      event: event("user-1", "user.message", "2026-05-12T15:00:00.000Z", "Go")
    };
    const firstView: ConversationItem[] = [
      user,
      { kind: "message", event: event("delta-1", "message.delta", "2026-05-12T15:00:01.000Z", "Hello ") },
      { kind: "message", event: event("delta-2", "message.delta", "2026-05-12T15:00:02.000Z", "world") }
    ];
    const cappedView: ConversationItem[] = [
      user,
      { kind: "message", event: event("delta-2", "message.delta", "2026-05-12T15:00:02.000Z", "world") },
      { kind: "message", event: event("delta-3", "message.delta", "2026-05-12T15:00:03.000Z", "!") }
    ];

    const firstTurn = foldRenderItems(firstView, null, keepToolItems).find((item) => item.kind === "turn");
    const cappedTurn = foldRenderItems(cappedView, null, keepToolItems).find((item) => item.kind === "turn");

    expect(firstTurn?.id).toBe("turn-user-1");
    expect(cappedTurn?.id).toBe(firstTurn?.id);
  });
});
