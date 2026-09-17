import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import type { ToolCall } from "./toolCalls.js";
import {
  collectAskUserQuestionState,
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

  it("keeps a blocking Codex question live only while its request is running", () => {
    const blocking = (status: ToolCall["status"]): TurnToolItem[] => [
      {
        kind: "tool",
        tool: tool({
          id: "blocking-q",
          status,
          inputFull: {
            delivery: "blocking",
            requestId: "request-1",
            questions: [{ id: "scope", question: "Pick one?", header: "Scope", options: [{ label: "A" }] }]
          }
        })
      }
    ];

    expect(collectAskUserQuestionState(blocking("running")).tool).toMatchObject({
      id: "blocking-q",
      delivery: "blocking",
      requestId: "request-1"
    });
    expect(collectAskUserQuestionState(blocking("done")).tool).toBeNull();
    expect(collectAskUserQuestionState(blocking("done")).hiddenToolIds).toEqual(new Set(["blocking-q"]));
  });

  it("hides malformed AskUserQuestion attempts even when no card can render", () => {
    const items: TurnToolItem[] = [
      {
        kind: "tool",
        tool: tool({
          id: "bad",
          inputFull: {
            questions: [{ question: "Too many?", header: "Bad", options: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }, { label: "5" }] }]
          }
        })
      }
    ];

    const { tool: resolved, hiddenToolIds } = collectAskUserQuestionState(items);

    expect(resolved).toBeNull();
    expect(hiddenToolIds).toEqual(new Set(["bad"]));
  });

  it("hides raw SendUserMessage tool rows when they cannot render a picker", () => {
    const items: TurnToolItem[] = [
      {
        kind: "tool",
        tool: tool({
          id: "send-message",
          name: "SendUserMessage",
          inputFull: { message: "Which path should I take?" }
        })
      }
    ];

    const { tool: resolved, hiddenToolIds } = collectAskUserQuestionState(items);

    expect(resolved).toBeNull();
    expect(hiddenToolIds).toEqual(new Set(["send-message"]));
  });

  it("accepts provider-style aliases for interactive tool names", () => {
    const items: TurnToolItem[] = [
      {
        kind: "tool",
        tool: tool({
          id: "q-alias",
          name: "ask_user_question",
          inputFull: {
            questions: [{ question: "Pick one?", header: "Q", options: [{ label: "A" }] }]
          }
        })
      },
      {
        kind: "tool",
        tool: tool({
          id: "cursor-q",
          name: "askQuestionToolCall",
          inputFull: {
            questions: [{ question: "Pick from Cursor?", header: "Cursor", options: [{ label: "C" }] }]
          }
        })
      }
    ];

    expect(collectAskUserQuestionState(items).tool?.id).toBe("q-alias");
    expect(collectAskUserQuestionState(items).hiddenToolIds).toEqual(
      new Set(["q-alias", "cursor-q"])
    );
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
        name: "AskUserQuestion",
        createdAt: "2026-01-01T00:00:02.000Z",
        inputFull: {
          questions: [{ question: "Pick one?", header: "Q", options: [{ label: "A" }] }]
        }
      })
    ];

    expect(hasOutstandingCardAsk(events, toolCalls)).toBe(true);
    expect(
      hasOutstandingCardAsk(events, [
        tool({
          name: "AskUserQuestion",
          createdAt: "2025-12-31T00:00:00.000Z",
          inputFull: {
            questions: [{ question: "Pick one?", header: "Q", options: [{ label: "A" }] }]
          }
        })
      ])
    ).toBe(false);
  });
});
