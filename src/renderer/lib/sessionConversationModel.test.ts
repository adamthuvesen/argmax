import { describe, expect, it } from "vitest";
import type { EventType, TimelineEvent } from "../../shared/types.js";
import {
  buildConversationEvents,
  buildSessionToolCalls,
  hasRenderableSessionContent,
  lastSignificantSessionEvent
} from "./sessionConversationModel.js";

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

describe("buildConversationEvents", () => {
  it("returns oldest-first visible chat events and prunes duplicated answer deltas", () => {
    const events = [
      event("done", "message.completed", "2026-05-12T15:00:04.000Z", "Final answer"),
      event("raw", "message.completed", "2026-05-12T15:00:03.900Z", "raw", { raw: true }),
      event("delta", "message.delta", "2026-05-12T15:00:03.000Z", "Final "),
      event("thinking", "message.delta", "2026-05-12T15:00:02.000Z", "Reasoning", { thinking: true }),
      event("subagent", "message.delta", "2026-05-12T15:00:01.500Z", "echo", { parent_tool_use_id: "tool-1" }),
      event("truncated", "error", "2026-05-12T15:00:01.400Z", "event payload truncated", {
        truncatedEventId: "big"
      }),
      event("turn", "message.completed", "2026-05-12T15:00:01.300Z", "turn.completed"),
      event("user", "user.message", "2026-05-12T15:00:01.000Z", "Go")
    ];

    expect(buildConversationEvents(events).map((e) => e.id)).toEqual(["user", "thinking", "done"]);
  });

  it("keeps streaming answer deltas until a completed answer lands", () => {
    const events = [
      event("delta-2", "message.delta", "2026-05-12T15:00:03.000Z", "there"),
      event("delta-1", "message.delta", "2026-05-12T15:00:02.000Z", "Hi "),
      event("user", "user.message", "2026-05-12T15:00:01.000Z", "Go")
    ];

    expect(buildConversationEvents(events).map((e) => e.id)).toEqual(["user", "delta-1", "delta-2"]);
  });
});

describe("hasRenderableSessionContent", () => {
  it("treats assistant events, tool starts, and first-byte beacons as renderable content", () => {
    const onlyUser = [event("user", "user.message", "2026-05-12T15:00:01.000Z", "Go")];
    expect(hasRenderableSessionContent(buildConversationEvents(onlyUser), onlyUser)).toBe(false);

    const withAssistant = [
      event("done", "message.completed", "2026-05-12T15:00:02.000Z", "Done"),
      ...onlyUser
    ];
    expect(hasRenderableSessionContent(buildConversationEvents(withAssistant), withAssistant)).toBe(true);

    const withTool = [
      event("tool", "command.started", "2026-05-12T15:00:02.000Z", "", { id: "tool-1", name: "Read" }),
      ...onlyUser
    ];
    expect(hasRenderableSessionContent(buildConversationEvents(withTool), withTool)).toBe(true);

    const withBeacon = [
      event("beacon", "session.streaming", "2026-05-12T15:00:02.000Z"),
      ...onlyUser
    ];
    expect(hasRenderableSessionContent(buildConversationEvents(withBeacon), withBeacon)).toBe(true);
  });
});

describe("buildSessionToolCalls", () => {
  it("pairs starts with completions and sorts by start time", () => {
    const events = [
      event("bash-start", "command.started", "2026-05-12T15:00:03.000Z", "", {
        id: "bash-1",
        name: "Bash",
        input: { command: "npm test" }
      }),
      event("read-done", "command.completed", "2026-05-12T15:00:02.000Z", "", {
        tool_use_id: "read-1",
        content: "ok"
      }),
      event("read-start", "command.started", "2026-05-12T15:00:01.000Z", "", {
        id: "read-1",
        name: "Read",
        input: { file_path: "src/renderer/App.tsx" }
      })
    ];

    const tools = buildSessionToolCalls(events);

    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => tool.toolUseId)).toEqual(["read-1", "bash-1"]);
    expect(tools[0]).toMatchObject({
      name: "Read",
      inputPreview: "src/renderer/App.tsx",
      output: "ok",
      status: "done"
    });
    expect(tools[1]).toMatchObject({
      name: "Bash",
      inputPreview: "npm test",
      status: "running",
      completedAt: null
    });
  });

  it("uses completion input as a fallback and preserves tool errors", () => {
    const events = [
      event("done", "command.completed", "2026-05-12T15:00:02.000Z", "", {
        id: "tool-1",
        is_error: true,
        content: "permission denied",
        input: { path: "src/renderer/App.tsx" }
      }),
      event("start", "command.started", "2026-05-12T15:00:01.000Z", "", {
        id: "tool-1",
        name: "Read"
      })
    ];

    expect(buildSessionToolCalls(events)[0]).toMatchObject({
      inputPreview: "src/renderer/App.tsx",
      output: "permission denied",
      status: "error",
      error: "permission denied"
    });
  });
});

describe("lastSignificantSessionEvent", () => {
  it("skips hidden transport noise and returns the newest visible event", () => {
    const events = [
      event("raw", "message.delta", "2026-05-12T15:00:05.000Z", "raw", { raw: true }),
      event("subagent", "message.completed", "2026-05-12T15:00:04.000Z", "echo", {
        parent_tool_use_id: "tool-1"
      }),
      event("truncated", "error", "2026-05-12T15:00:03.000Z", "event payload truncated", {
        truncatedEventId: "big"
      }),
      event("answer", "message.completed", "2026-05-12T15:00:02.000Z", "Done"),
      event("user", "user.message", "2026-05-12T15:00:01.000Z", "Go")
    ];

    expect(lastSignificantSessionEvent(events)?.id).toBe("answer");
  });
});
