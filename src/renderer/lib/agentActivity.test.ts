import { describe, expect, it } from "vitest";
import type { EventType, TimelineEvent } from "../../shared/types.js";
import { buildAgentActivity } from "./agentActivity.js";

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

describe("buildAgentActivity", () => {
  it("collects Claude-style subagent messages and child tool calls", () => {
    const activity = buildAgentActivity({
      parentToolUseId: "toolu_parent",
      events: [
        event("done", "command.completed", "2026-05-12T15:00:04.000Z", "tool_result", {
          tool_use_id: "toolu_child",
          content: "readme"
        }),
        event("child", "command.started", "2026-05-12T15:00:03.000Z", "Read", {
          id: "toolu_child",
          name: "Read",
          parent_tool_use_id: "toolu_parent",
          input: { file_path: "README.md" }
        }),
        event("msg", "message.completed", "2026-05-12T15:00:02.000Z", "I checked README.", {
          parent_tool_use_id: "toolu_parent"
        }),
        event("parent", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
          id: "toolu_parent",
          name: "Task",
          input: { description: "Audit docs", prompt: "Read the docs." }
        })
      ],
      sessionRunning: false
    });

    expect(activity.title).toBe("Audit docs");
    expect(activity.prompt).toBe("Read the docs.");
    expect(activity.items.map((item) => item.kind)).toEqual(["message", "tool"]);
    expect(activity.items[0]?.kind === "message" ? activity.items[0].event.message : null)
      .toBe("I checked README.");
    expect(activity.items[1]?.kind === "tool" ? activity.items[1].tool.output : null)
      .toBe("readme");
    expect(activity.limited).toBe(false);
  });

  it("drops child messages that only echo the subagent prompt", () => {
    const activity = buildAgentActivity({
      parentToolUseId: "toolu_parent",
      events: [
        event("real", "message.completed", "2026-05-12T15:00:03.000Z", "I checked README.", {
          parent_tool_use_id: "toolu_parent"
        }),
        event("echo", "message.completed", "2026-05-12T15:00:02.000Z", "Read the docs.\n\nThen summarize.", {
          parent_tool_use_id: "toolu_parent"
        }),
        event("parent", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
          id: "toolu_parent",
          name: "Task",
          input: { description: "Audit docs", prompt: "Read the docs. Then summarize." }
        })
      ],
      sessionRunning: false
    });

    expect(activity.items).toHaveLength(1);
    expect(activity.items[0]?.kind === "message" ? activity.items[0].event.message : null)
      .toBe("I checked README.");
    expect(activity.limited).toBe(false);
  });

  it("treats prompt-only echoes as missing child activity", () => {
    const activity = buildAgentActivity({
      parentToolUseId: "toolu_parent",
      events: [
        event("echo", "message.completed", "2026-05-12T15:00:02.000Z", "Read the docs.", {
          parent_tool_use_id: "toolu_parent"
        }),
        event("parent", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
          id: "toolu_parent",
          name: "Task",
          input: { description: "Audit docs", prompt: "Read the docs." }
        })
      ],
      sessionRunning: false
    });

    expect(activity.items).toEqual([]);
    expect(activity.limited).toBe(true);
  });

  it("links Codex agent messages through receiver thread ids", () => {
    // Mirrors the real stream shape (fixtures/codex/collab_spawn_agent.jsonl):
    // `item.started` carries an empty receiver list; the ids only arrive on
    // the spawn completion.
    const activity = buildAgentActivity({
      parentToolUseId: "item_spawn",
      events: [
        event("agent-message", "message.completed", "2026-05-12T15:00:03.000Z", "Found the renderer.", {
          item_type: "agent_message",
          thread_id: "thread-child",
          item: { type: "agent_message", thread_id: "thread-child" }
        }),
        event("spawn-end", "command.completed", "2026-05-12T15:00:02.000Z", "spawn_agent", {
          id: "item_spawn",
          name: "spawn_agent",
          status: "in_progress",
          input: {
            prompt: "Explore repo.",
            receiver_thread_ids: ["thread-child"],
            sender_thread_id: "thread-parent"
          }
        }),
        event("spawn", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
          id: "item_spawn",
          name: "spawn_agent",
          input: {
            prompt: "Explore repo.",
            receiver_thread_ids: [],
            sender_thread_id: "thread-parent"
          }
        })
      ],
      sessionRunning: true
    });

    expect(activity.receiverThreadIds).toEqual(["thread-child"]);
    expect(activity.items).toHaveLength(1);
    expect(activity.items[0]?.kind === "message" ? activity.items[0].event.message : null)
      .toBe("Found the renderer.");
    expect(activity.limited).toBe(false);
  });

  it("links Codex agent messages through a wait row when the spawn completion is missing", () => {
    const activity = buildAgentActivity({
      parentToolUseId: "item_spawn",
      events: [
        event("agent-message", "message.completed", "2026-05-12T15:00:03.000Z", "Found the renderer.", {
          item_type: "agent_message",
          thread_id: "thread-child",
          item: { type: "agent_message", thread_id: "thread-child" }
        }),
        event("wait-start", "command.started", "2026-05-12T15:00:02.000Z", "wait", {
          id: "item_wait",
          name: "wait",
          input: {
            receiver_thread_ids: ["thread-child"],
            sender_thread_id: "thread-parent"
          }
        }),
        event("spawn", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
          id: "item_spawn",
          name: "spawn_agent",
          input: {
            prompt: "Explore repo.",
            receiver_thread_ids: [],
            sender_thread_id: "thread-parent"
          }
        })
      ],
      sessionRunning: true
    });

    expect(activity.receiverThreadIds).toEqual(["thread-child"]);
    expect(activity.items).toHaveLength(1);
    expect(activity.limited).toBe(false);
  });

  it("marks provider-limited panes when only launch metadata exists", () => {
    const activity = buildAgentActivity({
      parentToolUseId: "call_task",
      events: [
        event("task", "command.started", "2026-05-12T15:00:01.000Z", "taskToolCall", {
          call_id: "call_task",
          name: "taskToolCall",
          input: { description: "Map renderer surface" }
        })
      ],
      sessionRunning: true
    });

    expect(activity.title).toBe("Map renderer surface");
    expect(activity.status).toBe("running");
    expect(activity.items).toEqual([]);
    expect(activity.limited).toBe(true);
  });
});
