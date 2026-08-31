import { describe, expect, it } from "vitest";
import type { EventType, TimelineEvent } from "../../shared/types.js";
import {
  buildConversationEvents,
  buildSessionToolCalls,
  hasRenderableSessionContent,
  lastAgentResponseEvent,
  lastSignificantSessionEvent,
  subAgentToolUseIds
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

function codexSpawnEvents(children: readonly string[]): TimelineEvent[] {
  return children.flatMap((child, index) => {
    const second = index + 1;
    return [
      event(`spawn-${child}-end`, "command.completed", `2026-05-12T15:00:0${second}.500Z`, "spawn_agent", {
        id: `spawn-${child}`,
        name: "spawn_agent",
        status: "completed",
        input: {
          prompt: `Inspect ${child}.`,
          receiver_thread_ids: [`thread-${child}`],
          sender_thread_id: "thread-parent"
        }
      }),
      event(`spawn-${child}-start`, "command.started", `2026-05-12T15:00:0${second}.000Z`, "spawn_agent", {
        id: `spawn-${child}`,
        name: "spawn_agent",
        input: {
          prompt: `Inspect ${child}.`,
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      })
    ];
  });
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

  it("keeps two invocations that reuse a provider tool id as separate tool calls", () => {
    // Claude restarts numbering at `toolu_1` on every run. Without the
    // invocation id both runs collapsed onto one row with one output.
    const events = [
      event("second-end", "command.completed", "2026-05-12T15:10:02.000Z", "tool_result", {
        tool_use_id: "toolu_1",
        content: "second",
        providerInvocationId: "inv-2"
      }),
      event("second-start", "command.started", "2026-05-12T15:10:01.000Z", "Read", {
        id: "toolu_1",
        name: "Read",
        input: { file_path: "b.ts" },
        providerInvocationId: "inv-2"
      }),
      event("first-end", "command.completed", "2026-05-12T15:00:02.000Z", "tool_result", {
        tool_use_id: "toolu_1",
        content: "first",
        providerInvocationId: "inv-1"
      }),
      event("first-start", "command.started", "2026-05-12T15:00:01.000Z", "Read", {
        id: "toolu_1",
        name: "Read",
        input: { file_path: "a.ts" },
        providerInvocationId: "inv-1"
      })
    ];

    const tools = buildSessionToolCalls(events, false);

    expect(tools.map((tool) => tool.id)).toEqual(["first-start", "second-start"]);
    expect(tools.map((tool) => tool.toolUseId)).toEqual(["toolu_1", "toolu_1"]);
    expect(tools.map((tool) => tool.output)).toEqual(["first", "second"]);
    expect(tools.map((tool) => tool.inputPreview)).toEqual(["a.ts", "b.ts"]);
  });

  it("leaves a start whose completion was lost running when a later invocation reuses its id", () => {
    const events = [
      event("second-end", "command.completed", "2026-05-12T15:10:02.000Z", "", {
        id: "item_1",
        content: "second",
        providerInvocationId: "inv-2"
      }),
      event("second-start", "command.started", "2026-05-12T15:10:01.000Z", "", {
        id: "item_1",
        name: "Bash",
        input: { command: "npm test" },
        providerInvocationId: "inv-2"
      }),
      event("first-start", "command.started", "2026-05-12T15:00:01.000Z", "", {
        id: "item_1",
        name: "Bash",
        input: { command: "npm run lint" },
        providerInvocationId: "inv-1"
      })
    ];

    const tools = buildSessionToolCalls(events, true);

    expect(tools.map((tool) => tool.status)).toEqual(["running", "done"]);
    expect(tools.map((tool) => tool.output)).toEqual([null, "second"]);
  });

  it("pairs legacy rows with no invocation id against the latest unmatched start", () => {
    // Cursor and OpenCode both key on `call_id`, and rows persisted before the
    // invocation stamp carry none — each completion still has to land on its
    // own turn's start.
    const events = [
      event("second-end", "command.completed", "2026-05-12T15:10:02.000Z", "", {
        call_id: "call_1",
        content: "second"
      }),
      event("second-start", "command.started", "2026-05-12T15:10:01.000Z", "", {
        call_id: "call_1",
        name: "read",
        input: { filePath: "b.ts" }
      }),
      event("first-end", "command.completed", "2026-05-12T15:00:02.000Z", "", {
        call_id: "call_1",
        content: "first"
      }),
      event("first-start", "command.started", "2026-05-12T15:00:01.000Z", "", {
        call_id: "call_1",
        name: "read",
        input: { filePath: "a.ts" }
      })
    ];

    const tools = buildSessionToolCalls(events, false);

    expect(tools.map((tool) => tool.id)).toEqual(["first-start", "second-start"]);
    expect(tools.map((tool) => tool.output)).toEqual(["first", "second"]);
  });

  it("does not cross-pair stamped and legacy rows that reuse an id", () => {
    const events = [
      event("legacy-end", "command.completed", "2026-05-12T15:00:04.000Z", "", {
        id: "item_1",
        content: "legacy"
      }),
      event("stamped-end", "command.completed", "2026-05-12T15:00:03.000Z", "", {
        id: "item_1",
        content: "stamped",
        providerInvocationId: "inv-1"
      }),
      event("legacy-start", "command.started", "2026-05-12T15:00:02.000Z", "", {
        id: "item_1",
        name: "Bash"
      }),
      event("stamped-start", "command.started", "2026-05-12T15:00:01.000Z", "", {
        id: "item_1",
        name: "Bash",
        providerInvocationId: "inv-1"
      })
    ];

    const tools = buildSessionToolCalls(events, false);

    expect(tools.map((tool) => tool.output)).toEqual(["stamped", "legacy"]);
  });

  it("orders same-timestamp rows by rowCursor when joining", () => {
    const at = "2026-05-12T15:00:01.000Z";
    const rows: TimelineEvent[] = [
      { ...event("second-end", "command.completed", at, "", { call_id: "call_1", content: "second" }), rowCursor: 4 },
      { ...event("first-end", "command.completed", at, "", { call_id: "call_1", content: "first" }), rowCursor: 2 },
      {
        ...event("first-start", "command.started", at, "", { call_id: "call_1", name: "read" }),
        rowCursor: 1
      },
      {
        ...event("second-start", "command.started", at, "", { call_id: "call_1", name: "read" }),
        rowCursor: 3
      }
    ];

    const tools = buildSessionToolCalls(rows, false);

    expect(tools.map((tool) => tool.id)).toEqual(["first-start", "second-start"]);
    expect(tools.map((tool) => tool.output)).toEqual(["first", "second"]);
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

  it("settles a synthetic Codex launch when the child trace completes", () => {
    const tools = buildSessionToolCalls([
      event("spawn-end", "command.completed", "2026-05-12T15:00:02.000Z", "spawn_agent", {
        id: "trace-spawn-child",
        name: "spawn_agent",
        traceSyntheticLaunch: true,
        providerChildSessionId: "child"
      }),
      event("spawn-start", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
        id: "trace-spawn-child",
        name: "spawn_agent",
        traceSyntheticLaunch: true,
        providerChildSessionId: "child",
        input: { receiver_thread_ids: ["child"] }
      })
    ], true);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolUseId: "trace-spawn-child",
      status: "done",
      completedAt: "2026-05-12T15:00:02.000Z"
    });
  });

  it("hides a superseded synthetic launch after the real launch takes over", () => {
    const tools = buildSessionToolCalls([
      event("real-start", "command.started", "2026-05-12T15:00:03.000Z", "spawn_agent", {
        id: "real-spawn",
        name: "spawn_agent",
        input: { receiver_thread_ids: ["child"] }
      }),
      event("synthetic-end", "command.completed", "2026-05-12T15:00:02.000Z", "spawn_agent", {
        id: "trace-spawn-child",
        name: "spawn_agent",
        traceSyntheticSuperseded: true,
        traceSupersededBy: "real-spawn"
      }),
      event("synthetic-start", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
        id: "trace-spawn-child",
        name: "spawn_agent",
        traceSyntheticSuperseded: true,
        traceSupersededBy: "real-spawn"
      })
    ], true);

    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolUseId).toBe("real-spawn");
  });

  it("keeps a Claude Task row running when it completed with async launch metadata and the session is running", () => {
    const tools = buildSessionToolCalls([
      event("task-end", "command.completed", "2026-05-12T15:00:02.000Z", "tool_result", {
        tool_use_id: "task-1",
        content: "Async agent launched successfully. output_file: /tmp/agent.txt. This tool result is internal metadata."
      }),
      event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
        id: "task-1",
        name: "Task",
        input: {
          description: "Map renderer",
          prompt: "Explore the repo.",
          subagent_type: "explorer"
        }
      })
    ], true);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolUseId: "task-1",
      name: "Task",
      status: "running",
      completedAt: null
    });
  });

  it("marks an async subagent launch done when the session stops", () => {
    const tools = buildSessionToolCalls([
      event("task-end", "command.completed", "2026-05-12T15:00:02.000Z", "tool_result", {
        tool_use_id: "task-1",
        content: "Async agent launched successfully. output_file: /tmp/agent.txt. This tool result is internal metadata."
      }),
      event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
        id: "task-1",
        name: "Task",
        input: {
          description: "Map renderer",
          prompt: "Explore the repo.",
          subagent_type: "explorer"
        }
      })
    ], false);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolUseId: "task-1",
      name: "Task",
      status: "done",
      completedAt: "2026-05-12T15:00:02.000Z"
    });
  });

  it("keeps a subagent launch with run_in_background running while the session is running", () => {
    const tools = buildSessionToolCalls([
      event("task-end", "command.completed", "2026-05-12T15:00:02.000Z", "tool_result", {
        tool_use_id: "task-bg",
        content: "Agent dispatched."
      }),
      event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
        id: "task-bg",
        name: "Task",
        input: {
          description: "Background worker",
          prompt: "Run tests.",
          run_in_background: true
        }
      })
    ], true);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolUseId: "task-bg",
      name: "Task",
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

  it("keeps an agent launch that completed with a provider error payload", () => {
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
      event("failed-end", "command.completed", "2026-05-12T15:00:01.500Z", "tool_result", {
        tool_use_id: "toolu_1",
        is_error: true,
        content: "permission denied"
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

    expect(tools.map((tool) => tool.toolUseId)).toEqual(["toolu_1", "toolu_2"]);
    expect(tools[0]).toMatchObject({
      toolUseId: "toolu_1",
      status: "error",
      error: "permission denied"
    });
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

  it("hides discovery and bookkeeping while preserving the real external call", () => {
    const tools = buildSessionToolCalls([
      event("search", "command.started", "2026-05-12T15:00:01.000Z", "ToolSearch", {
        id: "search",
        name: "ToolSearch",
        input: { query: "notion fetch" }
      }),
      event("todo", "command.started", "2026-05-12T15:00:02.000Z", "TodoWrite", {
        id: "todo",
        name: "TodoWrite",
        input: { todos: [{ content: "Read page", status: "in_progress" }] }
      }),
      event("discover", "command.started", "2026-05-12T15:00:03.000Z", "getMcpToolsToolCall", {
        call_id: "discover",
        name: "getMcpToolsToolCall",
        input: {
          server: "plugin-notion-workspace-notion",
          toolName: "notion-fetch"
        }
      }),
      event("fetch", "command.started", "2026-05-12T15:00:04.000Z", "mcpToolCall", {
        call_id: "fetch",
        name: "mcpToolCall",
        input: {
          args: { id: "page-1" },
          serverIdentifier: "plugin-notion-workspace-notion",
          toolCallId: "fetch",
          toolName: "notion-fetch"
        }
      })
    ], false);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "mcp__plugin-notion-workspace-notion__notion-fetch",
      inputFull: { id: "page-1" }
    });
  });

  it("turns Cursor's other wrapper back into an agent launch", () => {
    const tools = buildSessionToolCalls([
      event("task", "command.started", "2026-05-12T15:00:01.000Z", "other", {
        call_id: "task",
        name: "other",
        input: {
          _toolName: "task",
          description: "Review code",
          prompt: "Review the current changes."
        }
      })
    ], true);

    expect(tools[0]).toMatchObject({
      name: "task",
      inputPreview: "Review code",
      status: "running"
    });
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

  it("hides Codex transport rows even when no spawn row exists to fold them into", () => {
    // Codex can omit `spawn_agent` from structured stdout. The leftover `wait`
    // used to be the turn's only visible activity, labelled with its raw tool
    // name over two internal thread ids.
    const tools = buildSessionToolCalls([
      event("read-start", "command.started", "2026-05-12T15:00:01.000Z", "Read", {
        id: "read-1",
        name: "Read",
        input: { file_path: "/repo/a.ts" }
      }),
      event("wait-start", "command.started", "2026-05-12T15:00:02.000Z", "wait", {
        id: "wait-1",
        name: "wait",
        input: {
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      }),
      event("close-start", "command.started", "2026-05-12T15:00:03.000Z", "close_agent", {
        id: "close-1",
        name: "close_agent",
        input: { receiver_thread_ids: ["thread-child"] }
      })
    ], true);

    expect(tools.map((tool) => tool.name)).toEqual(["Read"]);
  });

  it("keeps a tool merely named wait when it carries no Codex thread plumbing", () => {
    const tools = buildSessionToolCalls([
      event("wait-start", "command.started", "2026-05-12T15:00:01.000Z", "wait", {
        id: "wait-1",
        name: "wait",
        input: { seconds: 30 }
      })
    ], true);

    expect(tools.map((tool) => tool.name)).toEqual(["wait"]);
  });

  it("keeps every Codex child running during an aggregate wait", () => {
    const events = codexSpawnEvents(["alpha", "beta", "gamma"]);
    events.push(event("wait-start", "command.started", "2026-05-12T15:00:04.000Z", "wait", {
      id: "wait-1",
      name: "wait",
      input: {
        receiver_thread_ids: ["thread-alpha", "thread-beta", "thread-gamma"],
        sender_thread_id: "thread-parent"
      }
    }));

    const tools = buildSessionToolCalls(events, true);

    expect(tools.map((tool) => tool.toolUseId)).toEqual([
      "spawn-alpha",
      "spawn-beta",
      "spawn-gamma"
    ]);
    expect(tools.map((tool) => tool.status)).toEqual(["running", "running", "running"]);
  });

  it("retires only completed Codex children and ignores an empty wait timeout", () => {
    const spawnEvents = codexSpawnEvents(["alpha", "beta", "gamma"]);
    const timeoutEvents = [
      event("wait-timeout-end", "command.completed", "2026-05-12T15:00:06.000Z", "wait", {
        id: "wait-timeout",
        input: {
          receiver_thread_ids: [],
          sender_thread_id: "thread-parent"
        }
      }),
      event("wait-timeout-start", "command.started", "2026-05-12T15:00:05.000Z", "wait", {
        id: "wait-timeout",
        name: "wait",
        input: {
          receiver_thread_ids: ["thread-alpha", "thread-beta", "thread-gamma"],
          sender_thread_id: "thread-parent"
        }
      })
    ];

    expect(buildSessionToolCalls([...spawnEvents, ...timeoutEvents], true).map((tool) => tool.status))
      .toEqual(["running", "running", "running"]);

    const gammaDoneEvents = [
      event("wait-gamma-end", "command.completed", "2026-05-12T15:00:08.000Z", "wait", {
        id: "wait-gamma",
        input: {
          receiver_thread_ids: ["thread-gamma"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("wait-gamma-start", "command.started", "2026-05-12T15:00:07.000Z", "wait", {
        id: "wait-gamma",
        name: "wait",
        input: {
          receiver_thread_ids: ["thread-alpha", "thread-beta", "thread-gamma"],
          sender_thread_id: "thread-parent"
        }
      })
    ];

    expect(buildSessionToolCalls([...spawnEvents, ...timeoutEvents, ...gammaDoneEvents], true).map((tool) => tool.status))
      .toEqual(["running", "running", "done"]);

    const betaDoneEvents = [
      event("wait-beta-end", "command.completed", "2026-05-12T15:00:10.000Z", "wait", {
        id: "wait-beta",
        input: {
          receiver_thread_ids: ["thread-beta"],
          sender_thread_id: "thread-parent"
        }
      }),
      event("wait-beta-start", "command.started", "2026-05-12T15:00:09.000Z", "wait", {
        id: "wait-beta",
        name: "wait",
        input: {
          receiver_thread_ids: ["thread-alpha", "thread-beta"],
          sender_thread_id: "thread-parent"
        }
      })
    ];

    expect(buildSessionToolCalls([
      ...spawnEvents,
      ...timeoutEvents,
      ...gammaDoneEvents,
      ...betaDoneEvents
    ], true).map((tool) => tool.status)).toEqual(["running", "done", "done"]);
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

  it("skips subagent tool boundaries so a child heartbeat is not parent progress", () => {
    // Child rows never render in the parent chat. Counting them would make the
    // parent's post-answer grace period restart on every child tool call.
    const events = [
      event("child-end", "command.completed", "2026-05-12T15:00:05.000Z", "tool_result", {
        tool_use_id: "toolu_child"
      }),
      event("child-start", "command.started", "2026-05-12T15:00:04.000Z", "Grep", {
        id: "toolu_child",
        name: "Grep",
        input: { pattern: "x" },
        parent_tool_use_id: "toolu_task"
      }),
      event("answer", "message.completed", "2026-05-12T15:00:03.000Z", "Waiting on the agent."),
      event("task", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
        id: "toolu_task",
        name: "Task",
        input: { prompt: "explore" }
      }),
      event("user", "user.message", "2026-05-12T15:00:00.000Z", "Go")
    ];
    const childToolUseIds = subAgentToolUseIds(buildSessionToolCalls(events));

    expect(childToolUseIds.has("toolu_child")).toBe(true);
    expect(lastSignificantSessionEvent(events, childToolUseIds)?.id).toBe("answer");
  });
});

describe("lastAgentResponseEvent", () => {
  it("ignores the user's own message so a just-sent turn has no agent response yet", () => {
    const events = [
      event("follow-up", "user.message", "2026-05-12T15:00:03.000Z", "And now the tests"),
      event("answer", "message.completed", "2026-05-12T15:00:02.000Z", "Done"),
      event("user", "user.message", "2026-05-12T15:00:01.000Z", "Go")
    ];

    expect(lastAgentResponseEvent(events)?.id).toBe("answer");
  });

  it("counts a failure as the agent responding", () => {
    const events = [
      event("boom", "error", "2026-05-12T15:00:04.000Z", "Provider exited"),
      event("follow-up", "user.message", "2026-05-12T15:00:03.000Z", "And now the tests")
    ];

    expect(lastAgentResponseEvent(events)?.id).toBe("boom");
  });

  it("skips subagent rows, raw transport, and truncation markers", () => {
    const events = [
      event("raw", "message.delta", "2026-05-12T15:00:06.000Z", "raw", { raw: true }),
      event("truncated", "error", "2026-05-12T15:00:05.000Z", "event payload truncated", {
        truncatedEventId: "big"
      }),
      event("child", "message.completed", "2026-05-12T15:00:04.000Z", "echo", {
        parent_tool_use_id: "toolu_task"
      }),
      event("answer", "message.completed", "2026-05-12T15:00:03.000Z", "Parent answer")
    ];

    expect(lastAgentResponseEvent(events)?.id).toBe("answer");
  });
});
