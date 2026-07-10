import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import {
  MOON_NAMES,
  assignAgentCodenames,
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

describe("MOON_NAMES", () => {
  it("holds exactly 100 unique names", () => {
    expect(MOON_NAMES).toHaveLength(100);
    expect(new Set(MOON_NAMES).size).toBe(100);
  });
});

describe("fallbackCodename", () => {
  it("returns a member of MOON_NAMES", () => {
    for (const id of ["task", "item_2", "abc", "", "🌙"]) {
      expect(MOON_NAMES).toContain(fallbackCodename(id));
    }
  });

  it("is deterministic for the same id", () => {
    expect(fallbackCodename("task")).toBe(fallbackCodename("task"));
  });
});

describe("assignAgentCodenames", () => {
  it("is deterministic — the same events produce the same map", () => {
    const events = spawnEvents(["a", "b", "c"]);
    const first = assignAgentCodenames(events, false);
    const second = assignAgentCodenames(events, false);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("assigns a distinct name to every spawn in a session", () => {
    const events = spawnEvents(["a", "b", "c", "d", "e", "f"]);
    const map = assignAgentCodenames(events, false);
    const names = [...map.values()];
    expect(map.size).toBe(6);
    expect(new Set(names).size).toBe(6);
    for (const name of names) expect(MOON_NAMES).toContain(name);
  });

  it("keeps earlier agents' names stable when a later spawn is appended", () => {
    const before = assignAgentCodenames(spawnEvents(["a", "b", "c"]), false);
    const after = assignAgentCodenames(spawnEvents(["a", "b", "c", "d"]), false);
    for (const id of ["a", "b", "c"]) {
      expect(after.get(id)).toBe(before.get(id));
    }
    expect(after.has("d")).toBe(true);
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
    const map = assignAgentCodenames(events, false);
    expect([...map.keys()]).toEqual(["task"]);
  });
});
