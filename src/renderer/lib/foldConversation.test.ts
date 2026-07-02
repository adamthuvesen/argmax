import { describe, expect, it } from "vitest";
import type { EventType, TimelineEvent } from "../../shared/types.js";
import { foldConversationItems, foldRenderItems } from "./foldConversation.js";
import type { ConversationItem, ToolCall, TurnToolItem } from "./toolCalls.js";

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

function tool(id: string, name: string, createdAt: string): ToolCall {
  return {
    id,
    toolUseId: id,
    name,
    inputPreview: id,
    inputFull: {},
    output: null,
    status: "done",
    createdAt,
    completedAt: createdAt,
    error: null
  };
}

describe("foldConversationItems", () => {
  it("keeps agent tool launches out of adjacent tool groups", () => {
    const read = tool("read", "Read", "2026-05-12T15:00:01.000Z");
    const task = tool("task", "Task", "2026-05-12T15:00:02.000Z");
    const bash = tool("bash", "Bash", "2026-05-12T15:00:03.000Z");
    const glob = tool("glob", "Glob", "2026-05-12T15:00:04.000Z");

    const folded = foldConversationItems([], [read, task, bash, glob]);

    expect(folded).toHaveLength(3);
    expect(folded[0]?.kind).toBe("tool");
    expect(folded[0]?.kind === "tool" ? folded[0].tool.id : null).toBe("read");
    expect(folded[1]).toEqual({ kind: "tool", tool: task });
    expect(folded[2]?.kind).toBe("tool-group");
    expect(folded[2]?.kind === "tool-group" ? folded[2].group.tools.map((t) => t.id) : []).toEqual([
      "bash",
      "glob"
    ]);
  });

  it("keeps agent-like tool names standalone for every provider", () => {
    const names = ["Task", "taskToolCall", "collab_tool_call"];

    for (const name of names) {
      const folded = foldConversationItems(
        [],
        [
          tool(`${name}-read`, "Read", "2026-05-12T15:00:01.000Z"),
          tool(`${name}-agent`, name, "2026-05-12T15:00:02.000Z"),
          tool(`${name}-bash`, "Bash", "2026-05-12T15:00:03.000Z")
        ]
      );

      expect(folded.map((item) => item.kind)).toEqual(["tool", "tool", "tool"]);
      expect(folded[1]?.kind === "tool" ? folded[1].tool.name : null).toBe(name);
    }
  });
});

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
