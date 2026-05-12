import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../../shared/types.js";
import { extractLearningCandidates } from "../learningExtractor.js";

function makeEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    id: overrides.id ?? `event-${Math.random()}`,
    sessionId: "session-1",
    type: "command.completed",
    message: "tool_result",
    payload: { is_error: true, tool_name: "npm test" },
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

describe("extractLearningCandidates", () => {
  it("returns nothing for an empty event list", () => {
    expect(extractLearningCandidates([])).toEqual([]);
  });

  it("ignores a single failure (needs at least 2)", () => {
    expect(
      extractLearningCandidates([makeEvent({ id: "e1" })])
    ).toEqual([]);
  });

  it("emits one pitfall for 2+ repeated failing tools", () => {
    const candidates = extractLearningCandidates([
      makeEvent({ id: "e1" }),
      makeEvent({ id: "e2" })
    ]);
    expect(candidates).toHaveLength(1);
    const first = candidates[0];
    expect(first?.kind).toBe("pitfall");
    expect(first?.summary).toContain("npm test");
    expect(first?.evidenceSessionId).toBe("session-1");
    expect(first?.evidenceEventId).toBe("e1");
  });

  it("ignores successful command.completed events", () => {
    const candidates = extractLearningCandidates([
      makeEvent({ id: "e1", payload: { is_error: false, tool_name: "npm test" } }),
      makeEvent({ id: "e2", payload: { is_error: false, tool_name: "npm test" } })
    ]);
    expect(candidates).toEqual([]);
  });

  it("caps at 3 candidates per session", () => {
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent({ id: `t${i}-a`, payload: { is_error: true, tool_name: `tool-${i}` } }));
      events.push(makeEvent({ id: `t${i}-b`, payload: { is_error: true, tool_name: `tool-${i}` } }));
    }
    expect(extractLearningCandidates(events)).toHaveLength(3);
  });

  it("detects errors via exitCode != 0 even when is_error is absent", () => {
    const candidates = extractLearningCandidates([
      makeEvent({ id: "e1", payload: { exitCode: 1, tool_name: "pytest" } }),
      makeEvent({ id: "e2", payload: { exitCode: 2, tool_name: "pytest" } })
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.summary).toContain("pytest");
  });
});
