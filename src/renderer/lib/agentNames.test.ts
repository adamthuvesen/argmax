import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import { buildSessionToolCalls } from "./sessionConversationModel.js";
import {
  HEADLINE_COUNT,
  SCIENTIST_NAMES,
  assignAgentCodenames,
  nativeAgentReferences,
  codenameForTool,
  fallbackCodename
} from "./agentNames.js";

function agentSpawn(id: string, createdAt: string): TimelineEvent {
  return {
    id: `${id}-start`,
    sessionId: "session-a",
    type: "command.started",
    message: "Task",
    payload: { type: "tool_use", id, name: "Task", input: { description: `task ${id}` } },
    createdAt
  };
}

function spawnEvents(ids: string[]): TimelineEvent[] {
  return ids.map((id, index) =>
    agentSpawn(id, `2026-05-12T15:00:${String(index).padStart(2, "0")}.000Z`)
  );
}

describe("SCIENTIST_NAMES", () => {
  it("holds exactly 100 unique names", () => {
    expect(SCIENTIST_NAMES).toHaveLength(100);
    expect(new Set(SCIENTIST_NAMES).size).toBe(100);
  });
});

describe("fallbackCodename", () => {
  it("returns a member of SCIENTIST_NAMES", () => {
    for (const id of ["task", "item_2", "abc", "", "🌙"]) {
      expect(SCIENTIST_NAMES).toContain(fallbackCodename(id));
    }
  });

  it("is deterministic for the same id", () => {
    expect(fallbackCodename("task")).toBe(fallbackCodename("task"));
  });
});

describe("assignAgentCodenames", () => {
  it("is deterministic — the same events produce the same map", () => {
    const events = spawnEvents(["a", "b", "c"]);
    const first = assignAgentCodenames(buildSessionToolCalls(events, false));
    const second = assignAgentCodenames(buildSessionToolCalls(events, false));
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("assigns a distinct name to every spawn in a session", () => {
    const events = spawnEvents(["a", "b", "c", "d", "e", "f"]);
    const map = assignAgentCodenames(buildSessionToolCalls(events, false));
    const names = [...map.values()];
    expect(map.size).toBe(6);
    expect(new Set(names).size).toBe(6);
    for (const name of names) expect(SCIENTIST_NAMES).toContain(name);
  });

  it("keeps earlier agents' names stable when a later spawn is appended", () => {
    const before = assignAgentCodenames(buildSessionToolCalls(spawnEvents(["a", "b", "c"]), false));
    const after = assignAgentCodenames(buildSessionToolCalls(spawnEvents(["a", "b", "c", "d"]), false));
    for (const id of ["a", "b", "c"]) {
      expect(after.get(id)).toBe(before.get(id));
    }
    expect(after.has("d")).toBe(true);
  });

  it("draws a session's first spawn from the headline names", () => {
    const headline = SCIENTIST_NAMES.slice(0, HEADLINE_COUNT);
    for (const id of ["a", "task", "toolu_01", "🔬"]) {
      const map = assignAgentCodenames(buildSessionToolCalls(spawnEvents([id]), false));
      expect(headline).toContain(map.get(id));
    }
  });

  it("ignores non-agent tools", () => {
    const events: TimelineEvent[] = [
      agentSpawn("task", "2026-05-12T15:00:00.000Z"),
      {
        id: "read-start",
        sessionId: "session-a",
        type: "command.started",
        message: "Read",
        payload: { type: "tool_use", id: "read", name: "Read", input: { file_path: "x.ts" } },
        createdAt: "2026-05-12T15:00:01.000Z"
      }
    ];
    const map = assignAgentCodenames(buildSessionToolCalls(events, false));
    expect([...map.keys()]).toEqual(["task"]);
  });

  it("keeps a continuation on the first spawn's codename and exports it for native providers", () => {
    const initial = {
      id: "initial", toolUseId: "task-root", name: "Agent", inputPreview: "",
      inputFull: {}, output: null, status: "done" as const,
      createdAt: "2026-05-12T15:00:00.000Z", completedAt: null, error: null,
      providerChildSessionId: "child-native", agentRunId: "task-root",
      agentRootToolUseId: "task-root", providerParentConversationId: "parent-native"
    };
    const continuation = {
      ...initial,
      id: "continued", toolUseId: "send-2", agentRunId: "send-2",
      createdAt: "2026-05-12T15:01:00.000Z"
    };
    const names = assignAgentCodenames([initial, continuation]);

    expect(names).toHaveLength(1);
    expect(codenameForTool(continuation, names)).toBe(codenameForTool(initial, names));
    expect(nativeAgentReferences([initial, continuation], names, "parent-native"))
      .toEqual([{
        name: codenameForTool(initial, names),
        providerChildSessionId: "child-native",
        providerParentConversationId: "parent-native"
      }]);
    expect(nativeAgentReferences([initial], names, "different-parent")).toEqual([]);
  });

  it("exports only named children belonging to the current native parent", () => {
    const current = {
      id: "current", toolUseId: "task-current", name: "Agent", inputPreview: "",
      inputFull: {}, output: null, status: "done" as const,
      createdAt: "2026-05-12T15:00:00.000Z", completedAt: null, error: null,
      providerChildSessionId: "child-current", providerParentConversationId: "parent-current",
      agentRootToolUseId: "task-current", agentRunId: "task-current", agentCodename: "Curie"
    };
    const otherParent = {
      ...current,
      id: "other-parent", toolUseId: "task-other-parent", agentRootToolUseId: "task-other-parent",
      agentRunId: "task-other-parent", providerChildSessionId: "child-other",
      providerParentConversationId: "parent-other", agentCodename: "Newton"
    };
    const noParent = {
      ...current,
      id: "no-parent", toolUseId: "task-no-parent", agentRootToolUseId: "task-no-parent",
      agentRunId: "task-no-parent", providerChildSessionId: null,
      providerParentConversationId: null, agentCodename: "Euler"
    };
    const names = assignAgentCodenames([current, otherParent, noParent]);

    expect(nativeAgentReferences([current, otherParent, noParent], names, "parent-current"))
      .toEqual([{
        name: "Curie",
        providerChildSessionId: "child-current",
        providerParentConversationId: "parent-current"
      }]);
    expect(nativeAgentReferences([current, otherParent], names, null)).toEqual([]);
  });

  it("uses the persisted native codename when earlier launches aged out of the tail", () => {
    const native = {
      id: "native", toolUseId: "task-reused", name: "Agent", inputPreview: "",
      inputFull: {}, output: null, status: "done" as const,
      createdAt: "2026-05-12T15:00:00.000Z", completedAt: null, error: null,
      providerChildSessionId: "child-b", providerParentConversationId: "parent-native",
      agentRootToolUseId: "task-reused", agentRunId: "task-reused", agentCodename: "Curie"
    };

    expect(codenameForTool(native, assignAgentCodenames([native]))).toBe("Curie");
  });
});
