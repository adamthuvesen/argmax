import { describe, expect, it } from "vitest";
import type { EventType, TimelineEvent } from "../../shared/types.js";
import { buildAgentActivity, persistentAgentRuns } from "./agentActivity.js";
import { buildSessionToolCalls } from "./sessionConversationModel.js";

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
  it("settles unfinished native work on parent exit without reviving it on resume", () => {
    const identity = { agentRootToolUseId: "spawn", agentRunId: "spawn" };
    const events = [
      event("spawn", "command.started", "2026-05-12T15:00:01.000Z", "Agent", {
        id: "spawn", name: "Agent", input: { description: "Review" }
      }),
      event("receipt", "command.completed", "2026-05-12T15:00:02.000Z", "tool_result", {
        tool_use_id: "spawn", content: "Async agent launched successfully."
      }),
      event("start", "agent.started", "2026-05-12T15:00:02.100Z", "Agent started", identity)
    ];
    const statuses = (rows: TimelineEvent[], sessionRunning: boolean) => [
      buildSessionToolCalls(rows, sessionRunning)[0]?.status,
      buildAgentActivity({ events: rows, parentToolUseId: "spawn", sessionRunning }).status
    ];
    // Waiting for approval does not terminate the provider or its child.
    expect(statuses(events, false)).toEqual(["running", "running"]);
    const exited = [...events,
      event("exit", "session.completed", "2026-05-12T15:00:03.000Z")
    ];
    expect(statuses(exited, false)).toEqual(["error", "error"]);
    expect(statuses(exited, true)).toEqual(["error", "error"]);
    expect(buildSessionToolCalls(exited, false)[0]).toMatchObject({
      completedAt: "2026-05-12T15:00:03.000Z",
      error: "Session ended before the agent reported completion."
    });
    const completed = [...exited,
      event("done", "agent.completed", "2026-05-12T15:00:02.500Z", "Reviewed", {
        ...identity, status: "completed"
      })
    ];
    expect(statuses(completed, false)).toEqual(["done", "done"]);
    const resumed = [...completed,
      event("restart", "agent.started", "2026-05-12T15:00:05.000Z", "Agent started", identity)
    ];
    expect(statuses(resumed, true)).toEqual(["running", "running"]);
  });

  it("uses row cursors so same-time completed lifecycle rows win newest-first reads", () => {
    const identity = {
      providerParentConversationId: "parent-native",
      providerChildSessionId: "child-native",
      agentRootToolUseId: "task-root",
      status: "completed"
    };
    const activity = buildAgentActivity({
      parentToolUseId: "task-root",
      events: [
        { ...event("completed", "agent.completed", "2026-05-12T15:00:01.000Z", "OpenCode task result", identity), rowCursor: 12 },
        { ...event("started", "agent.started", "2026-05-12T15:00:01.000Z", "Agent started", identity), rowCursor: 11 },
        { ...event("parent", "command.completed", "2026-05-12T15:00:01.000Z", "task", {
          id: "task-root", name: "task", providerChildSessionId: "child-native", providerParentConversationId: "parent-native",
          agentRootToolUseId: "task-root", agentRunId: "task-root", providerInvocationId: "invoke-1", status: "completed",
          input: { description: "Inspect" }
        }), rowCursor: 10 }
      ],
      sessionRunning: false,
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-native" }
    });

    expect(activity.status).toBe("done");
    expect(activity.finalOutput).toContain("OpenCode task result");
  });

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

  it("hides Claude async launch receipts from the result", () => {
    const activity = buildAgentActivity({
      parentToolUseId: "toolu_parent",
      events: [
        event("task-end", "command.completed", "2026-05-12T15:00:04.000Z", "tool_result", {
          tool_use_id: "toolu_parent",
          content: "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.) agentId: abc123. Use SendMessage with to: 'abc123'. Do NOT Read or tail this file via shell tool."
        }),
        event("child", "command.started", "2026-05-12T15:00:03.000Z", "Read", {
          id: "toolu_child",
          name: "Read",
          parent_tool_use_id: "toolu_parent",
          input: { file_path: "README.md" }
        }),
        event("parent", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
          id: "toolu_parent",
          name: "Task",
          input: { description: "Explore repo", prompt: "Read the docs." }
        })
      ],
      sessionRunning: true
    });

    expect(activity.finalOutput).toBeNull();
    expect(activity.items.map((item) => item.kind)).toEqual(["tool"]);
    expect(activity.limited).toBe(false);
  });

  it("hides Claude SendMessage resume receipts from the result", () => {
    const activity = buildAgentActivity({
      parentToolUseId: "task-root",
      agentRunId: "send-2",
      events: [
        event("resume", "command.completed", "2026-05-12T15:00:03.000Z", "tool_result", {
          tool_use_id: "send-2",
          content:
            '{"success":true,"message":"Resuming agent a5c5b27","resumedAgentId":"a5c5b27a1557fa19e","pin":{"id":"a5c5b27a1557fa19e","name":"a5c5b27a1557fa19e","ref":"eeee52"}}'
        }),
        event("start", "agent.started", "2026-05-12T15:00:02.100Z", "Agent started", {
          providerInvocationId: "invoke-2",
          providerChildSessionId: "a5c5b27a1557fa19e",
          providerParentConversationId: "parent-native",
          agentRunId: "send-2",
          agentRootToolUseId: "task-root",
          description: "Build /next/brain Ask on live stream"
        }),
        event("send", "command.started", "2026-05-12T15:00:02.000Z", "SendMessage", {
          id: "send-2",
          name: "SendMessage",
          providerInvocationId: "invoke-2",
          input: { to: "a5c5b27a1557fa19e", message: "Continue." }
        })
      ],
      sessionRunning: true
    });

    expect(activity.finalOutput).toBeNull();
    expect(activity.status).toBe("running");
  });

  it("keeps real agent final output visible", () => {
    const activity = buildAgentActivity({
      parentToolUseId: "toolu_parent",
      events: [
        event("task-end", "command.completed", "2026-05-12T15:00:02.000Z", "tool_result", {
          tool_use_id: "toolu_parent",
          content: "The repo is a local Tauri app for orchestrating agents."
        }),
        event("parent", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
          id: "toolu_parent",
          name: "Task",
          input: { description: "Explore repo", prompt: "Read the docs." }
        })
      ],
      sessionRunning: false
    });

    expect(activity.finalOutput).toBe("The repo is a local Tauri app for orchestrating agents.");
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

  it("hides Grok spawn_subagent launch receipts from the result", () => {
    const activity = buildAgentActivity({
      parentToolUseId: "call-spawn",
      events: [
        event("spawn-end", "command.completed", "2026-05-12T15:00:02.000Z", "tool_result", {
          tool_use_id: "call-spawn",
          content: JSON.stringify({
            type: "Text",
            text: "Subagent started in background.\nsubagent_id: child-1\ntype: reviewer\ndescription: Review screenshot drop fix"
          })
        }),
        event("spawn-start", "command.started", "2026-05-12T15:00:01.000Z", "spawn_subagent", {
          id: "call-spawn",
          name: "spawn_subagent",
          input: { description: "Review screenshot drop fix", subagent_type: "reviewer" }
        })
      ],
      sessionRunning: true
    });

    expect(activity.title).toBe("Review screenshot drop fix");
    expect(activity.subagentType).toBe("reviewer");
    expect(activity.finalOutput).toBeNull();
    expect(activity.status).toBe("running");
    expect(activity.items).toEqual([]);
    expect(activity.limited).toBe(true);
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

  it("keeps native continuation activity and results in separate runs", () => {
    const events = [
      event("continued-result", "agent.completed", "2026-05-12T15:01:03.000Z", "Tests pass.", {
        providerChildSessionId: "child-native", agentRootToolUseId: "task-root",
        agentRunId: "send-2", status: "completed"
      }),
      event("continued-text", "message.completed", "2026-05-12T15:01:02.000Z", "Running the tests.", {
        parent_tool_use_id: "task-root", providerChildSessionId: "child-native", agentRunId: "send-2"
      }),
      event("continued-start", "agent.started", "2026-05-12T15:01:01.000Z", "Agent started", {
        providerChildSessionId: "child-native", agentRootToolUseId: "task-root", agentRunId: "send-2"
      }),
      event("initial-start", "agent.started", "2026-05-12T15:00:01.000Z", "Agent started", {
        providerChildSessionId: "child-native", agentRootToolUseId: "task-root", agentRunId: "task-root"
      })
    ];

    expect(persistentAgentRuns(events, "task-root").map((run) => run.agentRunId))
      .toEqual(["task-root", "send-2"]);
    const continued = buildAgentActivity({
      parentToolUseId: "task-root", agentRunId: "send-2", events, sessionRunning: false
    });
    expect(continued.items.map((item) => item.kind === "message" ? item.event.message : null))
      .toEqual(["Running the tests."]);
    expect(continued.finalOutput).toBe("Tests pass.");
    expect(continued.status).toBe("done");
  });

  it("does not mix child activity when invocation and run ids disagree", () => {
    const events = [
      event("leaked-tool", "command.started", "2026-05-12T15:00:02.500Z", "Read", {
        id: "child-leaked", name: "Read", parent_tool_use_id: "task-root",
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-native", agentRunId: "send-2",
        input: { file_path: "should-not-appear.ts" }
      }),
      event("leaked-text", "message.completed", "2026-05-12T15:00:02.000Z", "Wrong run", {
        parent_tool_use_id: "task-root", providerInvocationId: "invocation-a",
        providerParentConversationId: "parent-native", providerChildSessionId: "child-native",
        agentRunId: "send-2"
      }),
      event("done", "agent.completed", "2026-05-12T15:00:03.000Z", "Run A result", {
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-native", agentRootToolUseId: "task-root",
        agentRunId: "task-root", status: "completed"
      }),
      event("start", "agent.started", "2026-05-12T15:00:01.000Z", "Agent started", {
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-native", agentRootToolUseId: "task-root",
        agentRunId: "task-root"
      })
    ];

    const activity = buildAgentActivity({
      parentToolUseId: "task-root", agentRunId: "task-root", providerInvocationId: "invocation-a",
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-native" },
      events, sessionRunning: false
    });

    expect(activity.items).toEqual([]);
    expect(activity.finalOutput).toBe("Run A result");
  });

  it("suppresses an exact lifecycle-summary duplicate of the visible child answer", () => {
    const events = [
      event("answer", "message.completed", "2026-05-12T15:00:02.000Z", "The tests pass.\n", {
        parent_tool_use_id: "task-root", providerInvocationId: "invocation-a",
        providerParentConversationId: "parent-native", providerChildSessionId: "child-a",
        agentRunId: "task-root"
      }),
      event("done", "agent.completed", "2026-05-12T15:00:03.000Z", "The tests pass.", {
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-a", agentRootToolUseId: "task-root",
        agentRunId: "task-root", status: "completed"
      })
    ];
    const activity = buildAgentActivity({
      parentToolUseId: "task-root", agentRunId: "task-root", providerInvocationId: "invocation-a",
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-a" },
      events, sessionRunning: false
    });

    expect(activity.items).toHaveLength(1);
    expect(activity.finalOutput).toBeNull();
  });

  it("preserves a lifecycle summary that differs from the visible child answer", () => {
    const events = [
      event("answer", "message.completed", "2026-05-12T15:00:02.000Z", "Detailed findings.", {
        parent_tool_use_id: "task-root", providerInvocationId: "invocation-a",
        providerParentConversationId: "parent-native", providerChildSessionId: "child-a",
        agentRunId: "task-root"
      }),
      event("done", "agent.completed", "2026-05-12T15:00:03.000Z", "Audit completed successfully.", {
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-a", agentRootToolUseId: "task-root",
        agentRunId: "task-root", status: "completed"
      })
    ];
    const activity = buildAgentActivity({
      parentToolUseId: "task-root", agentRunId: "task-root", providerInvocationId: "invocation-a",
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-a" },
      events, sessionRunning: false
    });

    expect(activity.finalOutput).toBe("Audit completed successfully.");
  });

  it("separates native children that reused the same raw Task id", () => {
    const events = [
      event("b-text", "message.completed", "2026-05-12T15:01:02.000Z", "Child B body", {
        parent_tool_use_id: "task-reused", providerInvocationId: "invocation-b",
        providerParentConversationId: "parent-native", providerChildSessionId: "child-b",
        agentRunId: "task-reused"
      }),
      event("b-done", "agent.completed", "2026-05-12T15:01:03.000Z", "Child B result", {
        providerInvocationId: "invocation-b", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-b", agentRootToolUseId: "task-reused",
        agentRunId: "task-reused", status: "completed"
      }),
      event("b-start", "agent.started", "2026-05-12T15:01:01.000Z", "Agent started", {
        providerInvocationId: "invocation-b", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-b", agentRootToolUseId: "task-reused", agentRunId: "task-reused"
      }),
      event("a-text", "message.completed", "2026-05-12T15:00:02.000Z", "Child A body", {
        parent_tool_use_id: "task-reused", providerInvocationId: "invocation-a",
        providerParentConversationId: "parent-native", providerChildSessionId: "child-a",
        agentRunId: "task-reused"
      }),
      event("a-done", "agent.completed", "2026-05-12T15:00:03.000Z", "Child A result", {
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-a", agentRootToolUseId: "task-reused",
        agentRunId: "task-reused", status: "completed"
      }),
      event("a-start", "agent.started", "2026-05-12T15:00:01.000Z", "Agent started", {
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-a", agentRootToolUseId: "task-reused", agentRunId: "task-reused"
      })
    ];
    const childA = buildAgentActivity({
      parentToolUseId: "task-reused", agentRunId: "task-reused", providerInvocationId: "invocation-a",
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-a" },
      events, sessionRunning: false
    });
    const childB = buildAgentActivity({
      parentToolUseId: "task-reused", agentRunId: "task-reused", providerInvocationId: "invocation-b",
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-b" },
      events, sessionRunning: false
    });

    expect(childA.items.map((item) => item.kind === "message" ? item.event.message : null)).toEqual(["Child A body"]);
    expect(childA.finalOutput).toBe("Child A result");
    expect(childB.items.map((item) => item.kind === "message" ? item.event.message : null)).toEqual(["Child B body"]);
    expect(childB.finalOutput).toBe("Child B result");
  });

  it("keeps lifecycle-reported models scoped to each persistent run", () => {
    const events = [
      event("initial-start", "agent.started", "2026-05-12T15:00:01.000Z", "Agent started", {
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-native", agentRootToolUseId: "task-root",
        agentRunId: "task-root", agentModelId: "claude-opus-5", agentReasoningEffort: "high"
      }),
      event("continued-start", "agent.started", "2026-05-12T15:01:01.000Z", "Agent started", {
        providerInvocationId: "invocation-b", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-native", agentRootToolUseId: "task-root",
        agentRunId: "send-2", agentModelId: "claude-sonnet-5", agentReasoningEffort: "medium"
      })
    ];

    const initial = buildAgentActivity({
      parentToolUseId: "task-root", agentRunId: "task-root", providerInvocationId: "invocation-a",
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-native" },
      events, sessionRunning: false, provider: "claude"
    });
    const continued = buildAgentActivity({
      parentToolUseId: "task-root", agentRunId: "send-2", providerInvocationId: "invocation-b",
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-native" },
      events, sessionRunning: false, provider: "claude"
    });

    expect(initial.model).toEqual({ label: "Opus 5", effort: "High" });
    expect(continued.model).toEqual({ label: "Sonnet 5", effort: "Medium" });
  });

  it("chooses the newest matching model regardless of event storage order", () => {
    const older = event("older", "message.completed", "2026-05-12T15:00:01.000Z", "Starting", {
      parent_tool_use_id: "task-root", agentRunId: "task-root",
      agentModelId: "claude-opus-5", agentReasoningEffort: "high"
    });
    const newer = event("newer", "message.completed", "2026-05-12T15:00:02.000Z", "Continuing", {
      parent_tool_use_id: "task-root", agentRunId: "task-root",
      agentModelId: "claude-sonnet-5", agentReasoningEffort: "medium"
    });
    const modelFor = (events: TimelineEvent[]) => buildAgentActivity({
      parentToolUseId: "task-root", agentRunId: "task-root", events,
      sessionRunning: false, provider: "claude"
    }).model;

    expect(modelFor([newer, older])).toEqual({ label: "Sonnet 5", effort: "Medium" });
    expect(modelFor([older, newer])).toEqual({ label: "Sonnet 5", effort: "Medium" });

    const equalCursorOlder = { ...older, rowCursor: 0 };
    const equalCursorNewer = { ...newer, rowCursor: 0 };
    expect(modelFor([equalCursorNewer, equalCursorOlder])).toEqual({ label: "Sonnet 5", effort: "Medium" });
    expect(modelFor([equalCursorOlder, equalCursorNewer])).toEqual({ label: "Sonnet 5", effort: "Medium" });

    const sameTimeOlder = { ...older, createdAt: newer.createdAt, rowCursor: 10 };
    const sameTimeNewer = { ...newer, rowCursor: 11 };
    expect(modelFor([sameTimeNewer, sameTimeOlder])).toEqual({ label: "Sonnet 5", effort: "Medium" });
    expect(modelFor([sameTimeOlder, sameTimeNewer])).toEqual({ label: "Sonnet 5", effort: "Medium" });
  });

  it("keeps tool-reported models scoped to native children sharing a raw root", () => {
    const events = [
      event("a-tool", "command.started", "2026-05-12T15:00:02.000Z", "Read", {
        id: "a-read", name: "Read", parent_tool_use_id: "task-reused",
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-a", agentRunId: "task-reused",
        agentModelId: "claude-opus-5", agentReasoningEffort: "high",
        input: { file_path: "a.ts" }
      }),
      event("b-tool", "command.started", "2026-05-12T15:01:02.000Z", "Read", {
        id: "b-read", name: "Read", parent_tool_use_id: "task-reused",
        providerInvocationId: "invocation-b", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-b", agentRunId: "task-reused",
        agentModelId: "claude-sonnet-5", agentReasoningEffort: "medium",
        input: { file_path: "b.ts" }
      })
    ];

    const childA = buildAgentActivity({
      parentToolUseId: "task-reused", agentRunId: "task-reused", providerInvocationId: "invocation-a",
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-a" },
      events, sessionRunning: false, provider: "claude"
    });
    const childB = buildAgentActivity({
      parentToolUseId: "task-reused", agentRunId: "task-reused", providerInvocationId: "invocation-b",
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-b" },
      events, sessionRunning: false, provider: "claude"
    });

    expect(childA.model).toEqual({ label: "Opus 5", effort: "High" });
    expect(childB.model).toEqual({ label: "Sonnet 5", effort: "Medium" });
  });

  it("marks an unfinished native child interrupted when its parent failed", () => {
    const activity = buildAgentActivity({
      parentToolUseId: "task-root",
      agentRunId: "task-root",
      providerInvocationId: "invocation-a",
      nativeIdentity: { providerParentConversationId: "parent-native", providerChildSessionId: "child-a" },
      events: [event("start", "agent.started", "2026-05-12T15:00:01.000Z", "Agent started", {
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-a", agentRootToolUseId: "task-root", agentRunId: "task-root"
      })],
      sessionRunning: false,
      sessionInterrupted: true
    });

    expect(activity.status).toBe("error");
  });
});
