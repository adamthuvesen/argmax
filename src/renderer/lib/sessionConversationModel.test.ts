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
      event("codex-agent", "message.completed", "2026-05-12T15:00:01.450Z", "child update", {
        item_type: "agent_message",
        thread_id: "thread-child"
      }),
      event("truncated", "error", "2026-05-12T15:00:01.400Z", "event payload truncated", {
        truncatedEventId: "big"
      }),
      event("turn", "message.completed", "2026-05-12T15:00:01.300Z", "turn.completed"),
      event("user", "user.message", "2026-05-12T15:00:01.000Z", "Go")
    ];

    expect(buildConversationEvents(events).map((e) => e.id)).toEqual(["user", "thinking", "done"]);
  });

  it("keeps parent Codex agent_message rows when they are not child-thread messages", () => {
    const events = [
      event("parent-final", "message.completed", "2026-05-12T15:00:03.000Z", "Parent answer", {
        item_type: "agent_message",
        item: { id: "item_6", type: "agent_message", text: "Parent answer" }
      }),
      event("child-agent", "message.completed", "2026-05-12T15:00:02.000Z", "Child answer", {
        item_type: "agent_message",
        thread_id: "thread-child",
        item: { id: "item_child", type: "agent_message", text: "Child answer" }
      }),
      event("user", "user.message", "2026-05-12T15:00:01.000Z", "Go")
    ];

    expect(buildConversationEvents(events).map((e) => e.id)).toEqual(["user", "parent-final"]);
  });

  it("keeps streaming answer deltas until a completed answer lands", () => {
    const events = [
      event("delta-2", "message.delta", "2026-05-12T15:00:03.000Z", "there"),
      event("delta-1", "message.delta", "2026-05-12T15:00:02.000Z", "Hi "),
      event("user", "user.message", "2026-05-12T15:00:01.000Z", "Go")
    ];

    expect(buildConversationEvents(events).map((e) => e.id)).toEqual(["user", "delta-1", "delta-2"]);
  });

  it("keeps pre-tool narration when a later completed answer lands", () => {
    const events = [
      event("done", "message.completed", "2026-05-12T15:00:05.000Z", "Final answer"),
      event("tool", "command.started", "2026-05-12T15:00:03.000Z", "", {
        id: "tool-1",
        name: "Read"
      }),
      event("intro", "message.delta", "2026-05-12T15:00:02.000Z", "Reading the file first."),
      event("user", "user.message", "2026-05-12T15:00:01.000Z", "Go")
    ];

    expect(buildConversationEvents(events).map((e) => e.id)).toEqual(["user", "intro", "done"]);
  });

  it("drops a pre-tool delta that is only a prefix of the completed answer", () => {
    const events = [
      event("done", "message.completed", "2026-05-12T15:00:05.000Z", "Verification agent is running."),
      event("tool", "command.started", "2026-05-12T15:00:04.000Z", "", {
        id: "tool-1",
        name: "Bash"
      }),
      event("prefix", "message.delta", "2026-05-12T15:00:03.000Z", "Ver"),
      event("user", "user.message", "2026-05-12T15:00:01.000Z", "Go")
    ];

    expect(buildConversationEvents(events).map((e) => e.id)).toEqual(["user", "done"]);
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

  it("keeps an uncorrelated tool running while the session is running", () => {
    const events = [
      event("start", "command.started", "2026-05-12T15:00:01.000Z", "", {
        id: "read-1",
        name: "Read",
        input: { file_path: "shot.png" }
      })
    ];

    expect(buildSessionToolCalls(events, true)[0]).toMatchObject({
      status: "running",
      completedAt: null
    });
  });

  it("retires an uncorrelated tool once later assistant text proves the turn moved on", () => {
    const events = [
      event("answer", "message.delta", "2026-05-12T15:00:02.000Z", "Continuing after the read."),
      event("start", "command.started", "2026-05-12T15:00:01.000Z", "", {
        id: "read-1",
        name: "Read",
        input: { file_path: "shot.png" }
      })
    ];

    expect(buildSessionToolCalls(events, true)[0]).toMatchObject({
      status: "done",
      completedAt: "2026-05-12T15:00:01.000Z",
      error: null
    });
  });

  it("keeps an uncorrelated agent tool running even after later assistant text", () => {
    const events = [
      event("answer", "message.delta", "2026-05-12T15:00:02.000Z", "Waiting for the exploration agent."),
      event("start", "command.started", "2026-05-12T15:00:01.000Z", "", {
        id: "agent-1",
        name: "Agent",
        input: {
          description: "Explore repo structure",
          prompt: "Read the repo and report back."
        }
      })
    ];

    expect(buildSessionToolCalls(events, true)[0]).toMatchObject({
      name: "Agent",
      status: "running",
      completedAt: null
    });
  });

  it("keeps a Codex spawn_agent row running while the spawned thread is in progress", () => {
    const tools = buildSessionToolCalls([
      event("spawn-end", "command.completed", "2026-05-12T15:00:02.000Z", "spawn_agent", {
        id: "spawn-1",
        name: "spawn_agent",
        status: "in_progress",
        input: {
          prompt: "Explore the repo.",
          receiver_thread_ids: ["thread-child"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("spawn-start", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
        id: "spawn-1",
        name: "spawn_agent",
        input: {
          prompt: "Explore the repo.",
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      })
    ], true);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolUseId: "spawn-1",
      name: "spawn_agent",
      status: "running",
      completedAt: null
    });
  });

  it("hides Codex no-op duplicate spawn_agent rows", () => {
    const tools = buildSessionToolCalls([
      event("real-end", "command.completed", "2026-05-12T15:00:02.000Z", "spawn_agent", {
        id: "item_1",
        name: "spawn_agent",
        status: "in_progress",
        input: {
          prompt: "Read README.md and summarize it quickly.",
          receiver_thread_ids: ["thread-child"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("real-start", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
        id: "item_1",
        name: "spawn_agent",
        input: {
          prompt: "Read README.md and summarize it quickly.",
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      }),
      event("noop-end", "command.completed", "2026-05-12T15:00:04.000Z", "spawn_agent", {
        id: "item_2",
        name: "spawn_agent",
        input: {
          prompt: "Actually, please ignore this duplicate if you receive it; no action needed.",
          receiver_thread_ids: ["thread-noop"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("noop-start", "command.started", "2026-05-12T15:00:03.000Z", "spawn_agent", {
        id: "item_2",
        name: "spawn_agent",
        input: {
          prompt: "Actually, please ignore this duplicate if you receive it; no action needed.",
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      }),
      event("noop-child", "message.completed", "2026-05-12T15:00:05.000Z", "Got it. No action taken.", {
        parent_tool_use_id: "item_2",
        providerChildSessionId: "thread-noop",
        traceImported: true
      })
    ], true);

    expect(tools.map((tool) => tool.toolUseId)).toEqual(["item_1"]);
  });

  it("keeps a running same-prompt spawn_agent while the session is still running", () => {
    // The earlier row has no launch evidence yet, but while it is running it
    // may be a legitimate parallel agent — hiding it would also force-close
    // its open activity pane. It is only pruned once it is terminal.
    const prompt = "Review the README.";
    const tools = buildSessionToolCalls([
      event("retry-end", "command.completed", "2026-05-12T15:00:03.000Z", "spawn_agent", {
        id: "item_1",
        name: "spawn_agent",
        status: "in_progress",
        input: {
          prompt,
          receiver_thread_ids: ["thread-child"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("retry-start", "command.started", "2026-05-12T15:00:02.000Z", "spawn_agent", {
        id: "item_1",
        name: "spawn_agent",
        input: {
          prompt,
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      }),
      event("failed-start", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
        id: "item_0",
        name: "spawn_agent",
        input: {
          prompt,
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      })
    ], true);

    expect(tools.map((tool) => tool.toolUseId)).toEqual(["item_0", "item_1"]);
  });

  it("keeps a running same-prompt Task when a parallel Task completes", () => {
    const prompt = "Review the README.";
    const tools = buildSessionToolCalls([
      event("second-end", "command.completed", "2026-05-12T15:00:03.000Z", "tool_result", {
        tool_use_id: "toolu_2",
        content: "Second result."
      }),
      event("second-start", "command.started", "2026-05-12T15:00:02.000Z", "Task", {
        id: "toolu_2",
        name: "Task",
        input: {
          description: "Review README",
          prompt
        }
      }),
      event("first-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
        id: "toolu_1",
        name: "Task",
        input: {
          description: "Review README",
          prompt
        }
      })
    ], true);

    expect(tools.map((tool) => tool.toolUseId)).toEqual(["toolu_1", "toolu_2"]);
    expect(tools[0]).toMatchObject({ toolUseId: "toolu_1", status: "running" });
  });

  it("hides a superseded Codex spawn_agent retry after the session stops", () => {
    const prompt = "Review the README.";
    const tools = buildSessionToolCalls([
      event("retry-end", "command.completed", "2026-05-12T15:00:03.000Z", "spawn_agent", {
        id: "item_2",
        name: "spawn_agent",
        status: "completed",
        input: {
          prompt,
          receiver_thread_ids: ["thread-child"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("retry-start", "command.started", "2026-05-12T15:00:02.000Z", "spawn_agent", {
        id: "item_2",
        name: "spawn_agent",
        input: {
          prompt,
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      }),
      event("failed-start", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
        id: "item_1",
        name: "spawn_agent",
        input: {
          prompt,
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      })
    ], false);

    expect(tools.map((tool) => tool.toolUseId)).toEqual(["item_2"]);
  });

  it("hides a superseded Cursor taskToolCall retry once a later launch completes", () => {
    const prompt = "Review the README.";
    const tools = buildSessionToolCalls([
      event("retry-end", "command.completed", "2026-05-12T15:00:03.000Z", "taskToolCall", {
        call_id: "call_2",
        name: "taskToolCall",
        result: {
          success: {
            agentId: "cursor-agent-1"
          }
        }
      }),
      event("retry-start", "command.started", "2026-05-12T15:00:02.000Z", "taskToolCall", {
        call_id: "call_2",
        name: "taskToolCall",
        input: {
          description: "Review README",
          prompt
        }
      }),
      event("failed-start", "command.started", "2026-05-12T15:00:01.000Z", "taskToolCall", {
        call_id: "call_1",
        name: "taskToolCall",
        input: {
          description: "Review README",
          prompt
        }
      })
    ], false);

    expect(tools.map((tool) => tool.toolUseId)).toEqual(["call_2"]);
  });

  it("hides a superseded Claude Task retry once a later Task returns output", () => {
    const prompt = "Review the README.";
    const tools = buildSessionToolCalls([
      event("retry-end", "command.completed", "2026-05-12T15:00:03.000Z", "tool_result", {
        tool_use_id: "toolu_2",
        content: "README is OK."
      }),
      event("retry-start", "command.started", "2026-05-12T15:00:02.000Z", "Task", {
        id: "toolu_2",
        name: "Task",
        input: {
          description: "Review README",
          prompt
        }
      }),
      event("failed-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
        id: "toolu_1",
        name: "Task",
        input: {
          description: "Review README",
          prompt
        }
      })
    ], false);

    expect(tools.map((tool) => tool.toolUseId)).toEqual(["toolu_2"]);
  });

  it("keeps two completed agent launches with the same prompt", () => {
    const prompt = "Review the README.";
    const tools = buildSessionToolCalls([
      event("second-end", "command.completed", "2026-05-12T15:00:04.000Z", "tool_result", {
        tool_use_id: "toolu_2",
        content: "Second result."
      }),
      event("second-start", "command.started", "2026-05-12T15:00:03.000Z", "Task", {
        id: "toolu_2",
        name: "Task",
        input: {
          description: "Review README",
          prompt
        }
      }),
      event("first-end", "command.completed", "2026-05-12T15:00:02.000Z", "tool_result", {
        tool_use_id: "toolu_1",
        content: "First result."
      }),
      event("first-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
        id: "toolu_1",
        name: "Task",
        input: {
          description: "Review README",
          prompt
        }
      })
    ], false);

    expect(tools.map((tool) => tool.toolUseId)).toEqual(["toolu_1", "toolu_2"]);
  });

  it("folds a linked Codex wait row into the spawn_agent row", () => {
    const tools = buildSessionToolCalls([
      event("wait-start", "command.started", "2026-05-12T15:00:03.000Z", "wait", {
        id: "wait-1",
        name: "wait",
        input: {
          receiver_thread_ids: ["thread-child"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("spawn-end", "command.completed", "2026-05-12T15:00:02.000Z", "spawn_agent", {
        id: "spawn-1",
        name: "spawn_agent",
        status: "in_progress",
        input: {
          prompt: "Explore the repo.",
          receiver_thread_ids: ["thread-child"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("spawn-start", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
        id: "spawn-1",
        name: "spawn_agent",
        input: {
          prompt: "Explore the repo.",
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      })
    ], true);

    expect(tools.map((tool) => tool.name)).toEqual(["spawn_agent"]);
    expect(tools[0]).toMatchObject({
      status: "running",
      completedAt: null
    });
  });

  it("backfills spawn receiver ids from a linked wait when the spawn completion is missing", () => {
    // Real Codex `item.started` payloads carry `receiver_thread_ids: []`; if
    // the spawn completion never lands, the wait row is the only source of
    // the ids and must overwrite the spawn's empty array.
    const tools = buildSessionToolCalls([
      event("wait-start", "command.started", "2026-05-12T15:00:02.000Z", "wait", {
        id: "wait-1",
        name: "wait",
        input: {
          receiver_thread_ids: ["thread-child"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("spawn-start", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
        id: "spawn-1",
        name: "spawn_agent",
        input: {
          prompt: "Explore the repo.",
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      })
    ], true);

    expect(tools.map((tool) => tool.name)).toEqual(["spawn_agent"]);
    expect(tools[0]?.inputFull.receiver_thread_ids).toEqual(["thread-child"]);
  });

  it("uses a linked Codex wait completion as the spawn_agent completion", () => {
    const tools = buildSessionToolCalls([
      event("wait-end", "command.completed", "2026-05-12T15:00:05.000Z", "wait", {
        id: "wait-1",
        content: "Child agent finished."
      }),
      event("wait-start", "command.started", "2026-05-12T15:00:03.000Z", "wait", {
        id: "wait-1",
        name: "wait",
        input: {
          receiver_thread_ids: ["thread-child"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("spawn-end", "command.completed", "2026-05-12T15:00:02.000Z", "spawn_agent", {
        id: "spawn-1",
        name: "spawn_agent",
        status: "in_progress",
        input: {
          prompt: "Explore the repo.",
          receiver_thread_ids: ["thread-child"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("spawn-start", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
        id: "spawn-1",
        name: "spawn_agent",
        input: {
          prompt: "Explore the repo.",
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      })
    ], true);

    expect(tools.map((tool) => tool.name)).toEqual(["spawn_agent"]);
    expect(tools[0]).toMatchObject({
      output: "Child agent finished.",
      status: "done",
      completedAt: "2026-05-12T15:00:05.000Z"
    });
  });

  it("retires an uncorrelated tool once the session has stopped (dropped completion)", () => {
    // An image Read's tool_result overflows the normalizer parse cap, so its
    // `command.completed` never arrives. Once the session is no longer running
    // the tool must render done, not a perpetual spinner.
    const events = [
      event("start", "command.started", "2026-05-12T15:00:01.000Z", "", {
        id: "read-1",
        name: "Read",
        input: { file_path: "shot.png" }
      })
    ];

    expect(buildSessionToolCalls(events, false)[0]).toMatchObject({
      status: "done",
      completedAt: "2026-05-12T15:00:01.000Z",
      error: null
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
