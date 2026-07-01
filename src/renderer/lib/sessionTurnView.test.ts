import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import { coalesceAssistantGroups } from "./sessionTurnView.js";

function assistantEvent(
  id: string,
  type: "message.completed" | "message.delta",
  message: string,
  createdAt: string,
  payload: Record<string, unknown> = {}
): TimelineEvent {
  return {
    id,
    sessionId: "s1",
    type,
    message,
    payload,
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

  it("keeps a thinking delta as its own group, separate from the answer", () => {
    // Extended-thinking arrives as a complete message.delta with
    // payload.thinking === true, followed by the answer's message.completed.
    // The thinking text must NOT be folded into the answer group — it renders
    // as a distinct, collapsible Thought block.
    const groups = coalesceAssistantGroups([
      assistantEvent("t1", "message.delta", "The user wants me to read files.", "2026-05-12T15:00:01.000Z", {
        thinking: true
      }),
      assistantEvent("a1", "message.completed", "Here's the answer.", "2026-05-12T15:00:02.000Z")
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      text: "The user wants me to read files.",
      thinking: true,
      streaming: false
    });
    expect(groups[1]).toMatchObject({ text: "Here's the answer.", streaming: false });
    expect(groups[1]?.thinking).toBeFalsy();
  });

  it("does not merge a thinking delta into a streaming answer delta", () => {
    // A thinking block followed by streaming answer deltas (no completion yet):
    // the answer deltas still coalesce into one streaming group, distinct from
    // the thinking group.
    const groups = coalesceAssistantGroups([
      assistantEvent("t1", "message.delta", "Let me think.", "2026-05-12T15:00:01.000Z", { thinking: true }),
      assistantEvent("a1", "message.delta", "Hello ", "2026-05-12T15:00:02.000Z"),
      assistantEvent("a2", "message.delta", "world", "2026-05-12T15:00:03.000Z")
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ text: "Let me think.", thinking: true });
    expect(groups[1]).toMatchObject({ text: "Hello world", streaming: true });
  });

  it("keeps streaming answer group ids stable when earlier deltas are capped away", () => {
    const beforeCap = coalesceAssistantGroups([
      assistantEvent("a1", "message.delta", "Hello ", "2026-05-12T15:00:01.000Z"),
      assistantEvent("a2", "message.delta", "world", "2026-05-12T15:00:02.000Z")
    ]);
    const afterCap = coalesceAssistantGroups([
      assistantEvent("a2", "message.delta", "world", "2026-05-12T15:00:02.000Z"),
      assistantEvent("a3", "message.delta", "!", "2026-05-12T15:00:03.000Z")
    ]);

    expect(beforeCap[0]?.id).toBe("assistant-answer-0");
    expect(afterCap[0]?.id).toBe(beforeCap[0]?.id);
  });

  it("folds streamed thinking_delta fragments into ONE growing group", () => {
    // With token streaming, reasoning arrives as many thinking_delta fragments.
    // They must accumulate into a single Thought group, not N tiny ones.
    const groups = coalesceAssistantGroups([
      assistantEvent("t1", "message.delta", "I need ", "2026-05-12T15:00:01.000Z", { thinking: true }),
      assistantEvent("t2", "message.delta", "to read ", "2026-05-12T15:00:02.000Z", { thinking: true }),
      assistantEvent("t3", "message.delta", "the docs.", "2026-05-12T15:00:03.000Z", { thinking: true })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ text: "I need to read the docs.", thinking: true });
  });

  it("dedups the trailing complete thinking block against the fragments", () => {
    // The whole assistant message re-sends the FULL reasoning after the
    // fragments. Cumulative-aware append makes that a no-op, not a doubling.
    const groups = coalesceAssistantGroups([
      assistantEvent("t1", "message.delta", "I need ", "2026-05-12T15:00:01.000Z", { thinking: true }),
      assistantEvent("t2", "message.delta", "to read.", "2026-05-12T15:00:02.000Z", { thinking: true }),
      assistantEvent("t3", "message.delta", "I need to read.", "2026-05-12T15:00:03.000Z", { thinking: true })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.text).toBe("I need to read.");
  });

  it("anchors a streamed answer group's lastActivityAt to its FINAL delta", () => {
    // The first delta can predate the turn's tool calls (Cursor streams from
    // the turn start). Ordering keys off lastActivityAt so the answer settles
    // below the tools rather than floating above them.
    const groups = coalesceAssistantGroups([
      assistantEvent("a1", "message.delta", "Hello ", "2026-05-12T15:00:01.000Z"),
      assistantEvent("a2", "message.delta", "world", "2026-05-12T15:00:05.000Z")
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      createdAt: "2026-05-12T15:00:01.000Z",
      lastActivityAt: "2026-05-12T15:00:05.000Z",
      text: "Hello world"
    });
  });

  it("splits assistant groups when a tool starts between streamed chunks", () => {
    const groups = coalesceAssistantGroups(
      [
        assistantEvent("a1", "message.delta", "Exploring the repo.", "2026-05-12T15:00:01.000Z"),
        assistantEvent("a2", "message.delta", "Here is the map.", "2026-05-12T15:00:05.000Z")
      ],
      { splitAt: ["2026-05-12T15:00:03.000Z"] }
    );

    expect(groups.map((group) => group.text)).toEqual(["Exploring the repo.", "Here is the map."]);
  });

  it("flushes the open buffer whenever the kind flips", () => {
    // thinking → answer → thinking yields three groups in order, never merged.
    const groups = coalesceAssistantGroups([
      assistantEvent("t1", "message.delta", "x", "2026-05-12T15:00:01.000Z", { thinking: true }),
      assistantEvent("a1", "message.delta", "y", "2026-05-12T15:00:02.000Z"),
      assistantEvent("t2", "message.delta", "z", "2026-05-12T15:00:03.000Z", { thinking: true })
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ text: "x", thinking: true });
    expect(groups[1]).toMatchObject({ text: "y", streaming: true });
    expect(groups[1]?.thinking).toBeFalsy();
    expect(groups[2]).toMatchObject({ text: "z", thinking: true });
  });
});
