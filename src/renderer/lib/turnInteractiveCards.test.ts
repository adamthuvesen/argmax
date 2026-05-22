import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import type { ToolCall } from "./toolCalls.js";
import {
  collectAskUserQuestionState,
  collectExitPlanState,
  hasOutstandingCardAsk
} from "./turnInteractiveCards.js";
import type { TurnToolItem } from "./toolCalls.js";

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tool-1",
    toolUseId: "use-1",
    name: "AskUserQuestion",
    inputPreview: "",
    inputFull: {},
    output: null,
    status: "error",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    error: "denied",
    ...overrides
  };
}

describe("turnInteractiveCards", () => {
  it("pins the first valid AskUserQuestion and hides every attempt", () => {
    const items: TurnToolItem[] = [
      {
        kind: "tool",
        tool: tool({
          id: "q1",
          inputFull: {
            questions: [{ question: "Pick one?", header: "Q", options: [{ label: "A" }] }]
          }
        })
      },
      {
        kind: "tool",
        tool: tool({
          id: "q2",
          inputFull: {
            questions: [{ question: "Pick two?", header: "Q2", options: [{ label: "B" }] }]
          }
        })
      }
    ];

    const { tool: resolved, hiddenToolIds } = collectAskUserQuestionState(items);

    expect(resolved?.id).toBe("q1");
    expect(hiddenToolIds).toEqual(new Set(["q1", "q2"]));
  });

  it("collects the first completed ExitPlanMode plan", () => {
    const items: TurnToolItem[] = [
      {
        kind: "tool",
        tool: tool({
          id: "plan-1",
          name: "ExitPlanMode",
          status: "running",
          inputFull: { plan: "# Plan\n" }
        })
      },
      {
        kind: "tool",
        tool: tool({
          id: "plan-2",
          name: "ExitPlanMode",
          status: "error",
          inputFull: { plan: "# Final plan\n" }
        })
      }
    ];

    const { tool: resolved, hiddenToolIds } = collectExitPlanState(items);

    expect(resolved?.id).toBe("plan-2");
    expect(resolved?.markdown).toBe("# Final plan\n");
    expect(hiddenToolIds).toEqual(new Set(["plan-1", "plan-2"]));
  });

  it("treats outstanding card asks as after the latest user message", () => {
    const events: TimelineEvent[] = [
      {
        id: "u1",
        sessionId: "s1",
        type: "user.message",
        message: "go",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {}
      }
    ];
    const toolCalls: ToolCall[] = [
      tool({
        name: "ExitPlanMode",
        createdAt: "2026-01-01T00:00:02.000Z",
        inputFull: { plan: "# Plan\n" }
      })
    ];

    expect(hasOutstandingCardAsk(events, toolCalls)).toBe(true);
    expect(
      hasOutstandingCardAsk(events, [
        tool({ name: "ExitPlanMode", createdAt: "2025-12-31T00:00:00.000Z", inputFull: { plan: "# Plan\n" } })
      ])
    ).toBe(false);
  });
});
