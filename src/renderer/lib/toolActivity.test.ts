import { describe, expect, it } from "vitest";
import { buildSessionToolCalls } from "./sessionConversationModel.js";
import type { TimelineEvent } from "../../shared/types.js";
import {
  decodeToolActivity,
  mergeToolActivity
} from "./toolActivity.js";
import {
  describeToolAction,
  summarizeToolGroup,
  type ToolCall
} from "./toolCalls.js";

function tool(overrides: Partial<ToolCall> & Pick<ToolCall, "name">): ToolCall {
  return {
    id: overrides.id ?? `id-${overrides.name}`,
    toolUseId: overrides.toolUseId ?? `tu-${overrides.name}`,
    name: overrides.name,
    inputPreview: overrides.inputPreview ?? "",
    inputFull: overrides.inputFull ?? {},
    output: overrides.output ?? null,
    status: overrides.status ?? "done",
    createdAt: overrides.createdAt ?? "2026-05-12T15:00:00.000Z",
    completedAt: overrides.completedAt ?? "2026-05-12T15:00:01.000Z",
    completionObserved: overrides.completionObserved ?? true,
    error: overrides.error ?? null,
    parentToolUseId: overrides.parentToolUseId ?? null,
    activity:
      overrides.activity ??
      ({ version: 1, kind: "read", evidence: "tool", targets: ["/repo/a.ts"] } as const)
  };
}

describe("decodeToolActivity", () => {
  it("rejects invalid versions, kinds, counts, and paths", () => {
    expect(decodeToolActivity(null)).toBeNull();
    expect(decodeToolActivity({ version: 2, kind: "read", evidence: "tool" })).toBeNull();
    expect(decodeToolActivity({ version: 1, kind: "nope", evidence: "tool" })).toBeNull();
    expect(
      decodeToolActivity({ version: 1, kind: "discovery", evidence: "tool", targets: [], toolCount: -1 })
    ).toBeNull();
    expect(
      decodeToolActivity({ version: 1, kind: "read", evidence: "tool", targets: [""] })
    ).toBeNull();
  });
});

describe("mergeToolActivity", () => {
  const readStart = {
    version: 1 as const,
    kind: "read" as const,
    evidence: "tool" as const,
    targets: ["/repo/a.ts"]
  };

  it("keeps a read start when completion is generic", () => {
    expect(
      mergeToolActivity(readStart, { version: 1, kind: "tool", evidence: "tool", targets: [] })
    ).toEqual(readStart);
  });

  it("upgrades read to image and keeps targets", () => {
    expect(
      mergeToolActivity(readStart, {
        version: 1,
        kind: "image",
        evidence: "tool",
        targets: []
      })
    ).toEqual({
      version: 1,
      kind: "image",
      evidence: "tool",
      targets: ["/repo/a.ts"]
    });
  });

  it("preserves capture intent and discovery results from anonymous completions", () => {
    expect(mergeToolActivity({ ...readStart, kind: "image-capture" }, { ...readStart, kind: "image" })?.kind).toBe("image-capture");
    expect(mergeToolActivity({ ...readStart, kind: "computer" }, { ...readStart, kind: "image" })?.kind).toBe("computer");
    expect(mergeToolActivity({ ...readStart, kind: "discovery", targets: [] }, { ...readStart, kind: "tool", toolCount: 2 }))
      .toMatchObject({ kind: "discovery", toolCount: 2 });
  });
});

describe("activity-aware summaries", () => {
  it("describes computer use with its actual completion state", () => {
    const call = tool({ name: "mcp__cua_repl__js", activity: { version: 1, kind: "computer", evidence: "tool", targets: [] } });
    expect(describeToolAction(call)).toBe("Used a computer");
    expect(describeToolAction({ ...call, status: "running" })).toBe("Using a computer");
    expect(describeToolAction({ ...call, status: "error" })).toBe("Computer use failed");
    expect(describeToolAction({ ...call, completionObserved: false })).toBe("Computer use (unconfirmed)");
  });
  it("dedupes duplicate tool ids in a group", () => {
    const a = tool({ name: "Read", id: "dup", toolUseId: "tu-dup" });
    expect(summarizeToolGroup([a, { ...a }])).toEqual(summarizeToolGroup([a]));
  });

  it("collapses repeated reads on one path to Read a file", () => {
    const path = "/repo/a.ts";
    const activity = { version: 1 as const, kind: "read" as const, evidence: "tool" as const, targets: [path] };
    expect(
      summarizeToolGroup([
        tool({ name: "Read", id: "1", inputPreview: path, activity }),
        tool({ name: "Read", id: "2", inputPreview: path, activity })
      ]).headline
    ).toBe("Read a file");
  });

  it("labels running read, unconfirmed done read, and failed edit precisely", () => {
    const readActivity = { version: 1 as const, kind: "read" as const, evidence: "tool" as const, targets: ["/repo/a.ts"] };
    expect(
      describeToolAction(
        tool({ name: "Read", status: "running", inputPreview: "/repo/a.ts", activity: readActivity })
      )
    ).toBe("Reading a.ts");
    expect(
      describeToolAction(
        tool({
          name: "Read",
          status: "done",
          completionObserved: false,
          inputPreview: "/repo/a.ts",
          activity: readActivity
        })
      )
    ).toBe("File read (unconfirmed)");
    expect(
      describeToolAction(
        tool({
          name: "Edit",
          status: "error",
          inputPreview: "/repo/a.ts",
          activity: { version: 1, kind: "edit", evidence: "tool", targets: ["/repo/a.ts"] }
        })
      )
    ).not.toMatch(/^Edited /);
  });

  it("labels discovery, image, image-capture, create, and delete", () => {
    expect(
      describeToolAction(
        tool({
          name: "ToolSearch",
          activity: { version: 1, kind: "discovery", evidence: "tool", targets: [], toolCount: 1 }
        })
      )
    ).toBe("Loaded a tool");
    expect(
      describeToolAction(
        tool({
          name: "ToolSearch",
          activity: { version: 1, kind: "discovery", evidence: "tool", targets: [], toolCount: 0 }
        })
      )
    ).toBe("Searched tools");
    expect(
      describeToolAction(
        tool({ name: "Read", activity: { version: 1, kind: "image", evidence: "tool", targets: ["/x.png"] } })
      )
    ).toBe("Viewed x.png");
    expect(
      describeToolAction(
        tool({
          name: "Read",
          activity: { version: 1, kind: "image-capture", evidence: "tool", targets: ["/x.png"] }
        })
      )
    ).toMatch(/capture/i);
    expect(
      describeToolAction(
        tool({ name: "Write", activity: { version: 1, kind: "edit", operation: "create", evidence: "tool", targets: ["/new.ts"] } })
      )
    ).toMatch(/creat/i);
    expect(
      describeToolAction(
        tool({
          name: "delete_file",
          activity: { version: 1, kind: "edit", operation: "delete", evidence: "tool", targets: ["/gone.ts"] }
        })
      )
    ).toMatch(/delet/i);
  });
});

describe("buildSessionToolCalls integration", () => {
  const activity = { version: 1, kind: "read", evidence: "tool", targets: ["/repo/a.ts"] };
  const start: TimelineEvent = {
    id: "start", sessionId: "s1", type: "command.started", createdAt: "2026-09-12T10:00:00Z",
    message: "Read", payload: { id: "call-1", name: "Read", input: { file_path: "/repo/a.ts" }, activity }
  };
  it("retains specific start evidence when the result has no identity", () => {
    const end: TimelineEvent = {
      id: "end", sessionId: "s1", type: "command.completed", createdAt: "2026-09-12T10:00:01Z",
      message: "", payload: { tool_use_id: "call-1", activity: { version: 1, kind: "tool", evidence: "tool", targets: [] } }
    };
    const calls = buildSessionToolCalls([start, end], false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.activity).toEqual(activity);
    expect(describeToolAction(calls[0])).toBe("Read a.ts");
  });
  it("does not infer a successful read from the session stopping", () => {
    const calls = buildSessionToolCalls([start], false);
    expect(calls[0]?.completionObserved).toBe(false);
    expect(describeToolAction(calls[0])).toBe("File read (unconfirmed)");
  });

  it.each([{ status: "cancelled" }, { cancelled: true }, { canceled: true }])("keeps cancelled results out of successful activity: %j", (cancellation) => {
    const calls = buildSessionToolCalls([start, {
      id: "cancel", sessionId: "s1", type: "command.completed", createdAt: "2026-09-12T10:00:01Z",
      message: "", payload: { tool_use_id: "call-1", ...cancellation }
    }], false);
    expect(describeToolAction(calls[0])).toBe("File read cancelled");
  });

  it("retains the actual command in the expanded row label", () => {
    const command = tool({ name: "Bash", inputPreview: "npm test", activity: { version: 1, kind: "command", evidence: "tool", targets: [] } });
    expect(describeToolAction(command)).toBe("Ran npm test");
    expect(summarizeToolGroup([command]).headline).toBe("Ran a command");
  });
});
