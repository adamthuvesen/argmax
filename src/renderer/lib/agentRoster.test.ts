import { describe, expect, it } from "vitest";
import type { ToolCall } from "./toolCalls.js";
import { buildAgentRoster } from "./agentRoster.js";

function run(overrides: Partial<ToolCall> & Pick<ToolCall, "toolUseId" | "createdAt">): ToolCall {
  return {
    id: overrides.toolUseId,
    name: "Agent",
    inputPreview: "",
    inputFull: {},
    output: null,
    status: "running",
    completionObserved: false,
    cancelled: false,
    completedAt: null,
    error: null,
    backgroundLaunch: false,
    parentToolUseId: null,
    ...overrides
  };
}

describe("buildAgentRoster", () => {
  it("moves a completed native child back to running without creating another entry", () => {
    const identity = {
      providerParentConversationId: "parent",
      providerChildSessionId: "child",
      agentRootToolUseId: "spawn"
    };
    const roster = buildAgentRoster([
      run({ toolUseId: "spawn", createdAt: "2026-09-13T10:00:00Z", completedAt: "2026-09-13T10:01:00Z", status: "done", inputFull: { description: "Initial review" }, ...identity }),
      run({ toolUseId: "follow-up", createdAt: "2026-09-13T10:02:00Z", status: "running", inputFull: { description: "Check the fix" }, parentToolUseId: "spawn", ...identity })
    ], new Map([[`spawn\u0000parent\u0000child`, "Gauss"]]));

    expect(roster.entries).toHaveLength(1);
    expect(roster.entries[0]).toMatchObject({
      codename: "Gauss",
      title: "Check the fix",
      status: "running",
      rootToolUseId: "spawn",
      latestTransitionAt: "2026-09-13T10:02:00Z"
    });
    expect(roster).toMatchObject({ running: 1, completed: 0, failed: 0 });
  });

  it("uses the latest terminal assignment while retaining earlier history as one identity", () => {
    const identity = {
      providerParentConversationId: "parent",
      providerChildSessionId: "child",
      agentRootToolUseId: "spawn"
    };
    const roster = buildAgentRoster([
      run({ toolUseId: "spawn", createdAt: "2026-09-13T10:00:00Z", completedAt: "2026-09-13T10:01:00Z", status: "done", ...identity }),
      run({ toolUseId: "follow-up", createdAt: "2026-09-13T10:02:00Z", completedAt: "2026-09-13T10:03:00Z", status: "error", parentToolUseId: "spawn", ...identity })
    ], new Map());

    expect(roster.entries).toHaveLength(1);
    expect(roster.entries[0]?.status).toBe("error");
    expect(roster.entries[0]?.latestTransitionAt).toBe("2026-09-13T10:03:00Z");
    expect(roster).toMatchObject({ running: 0, completed: 0, failed: 1 });
  });

  it("keeps native children with a reused raw tool id distinct", () => {
    const tools = ["child-a", "child-b"].map((child, index) => run({
      toolUseId: "task-reused",
      createdAt: `2026-09-13T10:0${index}:00Z`,
      providerParentConversationId: "parent",
      providerChildSessionId: child,
      agentRootToolUseId: "task-reused"
    }));

    const roster = buildAgentRoster(tools, new Map());

    expect(roster.entries.map((entry) => entry.id)).toEqual([
      "native-agent:task-reused:parent:child-a",
      "native-agent:task-reused:parent:child-b"
    ]);
  });
});
