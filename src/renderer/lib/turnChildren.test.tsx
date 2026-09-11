import { describe, expect, it } from "vitest";
import type { ToolCall } from "./toolCalls.js";
import { foldActivityRunsToSummaries, type TurnBodyChild } from "./turnChildren.js";

function tool(id: string): ToolCall {
  return {
    id,
    toolUseId: id,
    name: "Bash",
    inputPreview: id,
    inputFull: { command: id },
    output: null,
    status: "done",
    createdAt: "2026-09-12T10:00:00.000Z",
    completedAt: "2026-09-12T10:00:01.000Z",
    error: null
  };
}

function thought(id: string): TurnBodyChild {
  return {
    kind: "assistant",
    id,
    node: null,
    activityMember: { kind: "thought", id, node: null }
  };
}

function toolChild(id: string): TurnBodyChild & { runTools: ToolCall[] } {
  return {
    kind: "tool",
    id,
    node: null,
    runTools: [tool(id)]
  };
}

describe("foldActivityRunsToSummaries", () => {
  it("groups thoughts and routine tools until visible prose", () => {
    const runs: Array<{ tools: ToolCall[]; members: string[] }> = [];
    const folded = foldActivityRunsToSummaries(
      [
        thought("thought-1"),
        toolChild("command-1"),
        thought("thought-2"),
        toolChild("command-2"),
        { kind: "assistant", id: "prose", node: "Progress update" },
        thought("thought-3"),
        toolChild("command-3")
      ],
      ({ tools, members }) => {
        runs.push({
          tools,
          members: members.map((member) => member.id)
        });
        return null;
      }
    );

    expect(runs.map((run) => run.members)).toEqual([
      ["thought-1", "command-1", "thought-2", "command-2"],
      ["thought-3", "command-3"]
    ]);
    expect(runs.map((run) => run.tools.map((item) => item.id))).toEqual([
      ["command-1", "command-2"],
      ["command-3"]
    ]);
    expect(folded.map((child) => child.id)).toEqual([
      "activity-thought-1",
      "prose",
      "activity-thought-3"
    ]);
  });

  it("keeps the first thought as the stable anchor when a tool arrives", () => {
    const renderRun = (): null => null;
    const before = foldActivityRunsToSummaries([thought("thought-1")], renderRun);
    const after = foldActivityRunsToSummaries(
      [thought("thought-1"), toolChild("command-1")],
      renderRun
    );

    expect(after[0]?.id).toBe(before[0]?.id);
  });
});
