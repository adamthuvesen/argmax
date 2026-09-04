import { describe, expect, it } from "vitest";
import { SCIENTIST_NAMES, assignAgentCodenames } from "./agentNames.js";
import { SESSION_ICON_COLORS } from "./sessionIcons.js";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import type { MultitaskChild } from "./multitask.js";
import type { ToolCall } from "./toolCalls.js";
import { buildSubagentCluster } from "./subagentSummary.js";

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "t1",
    toolUseId: "t1",
    name: "Task",
    inputPreview: "Map the renderer",
    inputFull: { description: "Map the renderer", subagent_type: "explore" },
    output: null,
    status: "done",
    createdAt: "2026-05-12T15:00:00.000Z",
    completedAt: "2026-05-12T15:00:01.000Z",
    error: null,
    ...overrides
  };
}

function multitask(state: string, taskLabel = "Fix the changelog date"): MultitaskChild {
  return {
    session: { id: `child-${state}`, state } as SessionSummary,
    workspace: { taskLabel } as WorkspaceSummary
  };
}

describe("buildSubagentCluster", () => {
  it("returns null when the session has nothing running alongside it", () => {
    const tools = [tool({ name: "Bash", inputFull: {} }), tool({ name: "Read", inputFull: {} })];
    expect(buildSubagentCluster(tools, assignAgentCodenames(tools))).toBeNull();
    expect(buildSubagentCluster([], new Map())).toBeNull();
  });

  it("counts multitasks too, because the dock's tabs do", () => {
    // The card sits beside the tab strip; leaving multitasks out made the two
    // disagree about how much work is running.
    const cluster = buildSubagentCluster([], new Map(), [multitask("running"), multitask("cancelled")]);
    expect(cluster?.hasMultitask).toBe(true);
    expect(cluster?.running).toBe(1);
    expect(cluster?.failed).toBe(1);
    expect(cluster?.entries.map((entry) => entry.codename)).toEqual([
      "Fix the changelog date",
      "Fix the changelog date"
    ]);
  });

  it("is a plain subagent cluster when no multitask is in it", () => {
    const tools = [tool({ toolUseId: "spawn-1" })];
    expect(buildSubagentCluster(tools, assignAgentCodenames(tools))?.hasMultitask).toBe(false);
  });

  it("counts statuses and names each spawn with its codename and title", () => {
    const tools = [
      tool({ toolUseId: "spawn-1", id: "row-1", status: "done" }),
      tool({ toolUseId: "spawn-2", id: "row-2", status: "running", inputFull: { subagent_type: "general" } }),
      tool({ toolUseId: "spawn-3", id: "row-3", status: "error", inputFull: {} }),
      // Non-agent tools must not join the cluster.
      tool({ toolUseId: "bash-1", id: "row-4", name: "Bash", inputFull: {} })
    ];
    const cluster = buildSubagentCluster(tools, assignAgentCodenames(tools));
    expect(cluster).not.toBeNull();
    expect(cluster?.running).toBe(1);
    expect(cluster?.done).toBe(1);
    expect(cluster?.failed).toBe(1);
    expect(cluster?.entries.map((entry) => entry.toolUseId)).toEqual(["spawn-1", "spawn-2", "spawn-3"]);
    expect(cluster?.entries.every((entry) => SCIENTIST_NAMES.includes(entry.codename))).toBe(true);
    // Title prefers the description, then the subagent type, then the preview.
    expect(cluster?.entries[0]?.title).toBe("Map the renderer");
    expect(cluster?.entries[1]?.title).toBe("general");
    expect(cluster?.entries[2]?.title).toBe("Map the renderer");
  });

  it("tints each avatar from a stable palette entry keyed by the spawn id", () => {
    const tools = [tool({ toolUseId: "spawn-1" }), tool({ toolUseId: "spawn-2" })];
    const cluster = buildSubagentCluster(tools, new Map());
    const first = cluster?.entries[0];
    const again = buildSubagentCluster(tools, new Map())?.entries[0];
    expect(first?.iconColor).toBe(again?.iconColor);
    for (const entry of cluster?.entries ?? []) {
      expect(SESSION_ICON_COLORS).toContain(entry.iconColor);
    }
  });
});
