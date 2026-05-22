import { describe, expect, it } from "vitest";
import { parseQuestionsFromToolInput } from "./questions.js";
import {
  foldTurnToolItems,
  toolsNamed,
  visibleTurnToolItem
} from "./turnToolItems.js";
import { buildToolCallGroup, type ToolCall } from "./toolCalls.js";
import type { TurnToolItem } from "./toolCalls.js";

function tool(overrides: Partial<ToolCall> & Pick<ToolCall, "id" | "name">): ToolCall {
  return {
    id: overrides.id,
    toolUseId: overrides.toolUseId ?? overrides.id,
    name: overrides.name,
    inputPreview: overrides.inputPreview ?? "",
    inputFull: overrides.inputFull ?? {},
    output: overrides.output ?? null,
    status: overrides.status ?? "done",
    createdAt: overrides.createdAt ?? "2026-05-21T10:00:00.000Z",
    completedAt: overrides.completedAt ?? "2026-05-21T10:00:01.000Z",
    error: overrides.error ?? null
  };
}

describe("turnToolItems", () => {
  it("folds consecutive bash-like tools into one group without crossing non-bash tools", () => {
    const first = tool({ id: "t1", name: "Bash" });
    const second = tool({ id: "t2", name: "Shell", createdAt: "2026-05-21T10:00:00.050Z" });
    const read = tool({ id: "t3", name: "Read" });
    const third = tool({ id: "t4", name: "Bash" });

    const folded = foldTurnToolItems([
      { kind: "tool", tool: first },
      { kind: "tool", tool: second },
      { kind: "tool", tool: read },
      { kind: "tool", tool: third }
    ]);

    expect(folded).toHaveLength(3);
    expect(folded[0]?.kind).toBe("tool-group");
    expect(folded[0]?.kind === "tool-group" ? folded[0].group.tools.map((t) => t.id) : []).toEqual(["t1", "t2"]);
    expect(folded[1]).toEqual({ kind: "tool", tool: read });
    expect(folded[2]).toEqual({ kind: "tool", tool: third });
  });

  it("finds named tools inside individual tools and groups", () => {
    const ask = tool({ id: "ask", name: "AskUserQuestion" });
    const plan = tool({ id: "plan", name: "ExitPlanMode" });
    const read = tool({ id: "read", name: "Read" });
    const items: TurnToolItem[] = [
      { kind: "tool", tool: ask },
      { kind: "tool-group", group: buildToolCallGroup([plan, read]) }
    ];

    expect(toolsNamed(items, "AskUserQuestion")).toEqual([ask]);
    expect(toolsNamed(items, "ExitPlanMode")).toEqual([plan]);
  });

  it("parses valid AskUserQuestion input and rejects oversized option sets", () => {
    const parsed = parseQuestionsFromToolInput(
      tool({
        id: "ask",
        name: "AskUserQuestion",
        inputFull: {
          questions: [
            {
              question: "Pick one",
              header: "Choice",
              multiSelect: true,
              options: [
                { label: "A", description: "Alpha" },
                { label: "B" }
              ]
            }
          ]
        }
      })
    );

    expect(parsed).toEqual([
      {
        question: "Pick one",
        header: "Choice",
        multiSelect: true,
        options: [{ label: "A", description: "Alpha" }, { label: "B" }]
      }
    ]);

    const invalid = parseQuestionsFromToolInput(
      tool({
        id: "ask-invalid",
        name: "AskUserQuestion",
        inputFull: {
          questions: [
            {
              question: "Too many",
              options: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }, { label: "5" }]
            }
          ]
        }
      })
    );
    expect(invalid).toBeNull();
  });

  it("filters hidden tool ids out of individual tools and mixed groups", () => {
    const hidden = tool({ id: "hidden", name: "AskUserQuestion" });
    const visible = tool({ id: "visible", name: "Read" });
    const hiddenIds = new Set(["hidden"]);

    expect(visibleTurnToolItem({ kind: "tool", tool: hidden }, hiddenIds)).toBeNull();

    const filtered = visibleTurnToolItem(
      { kind: "tool-group", group: buildToolCallGroup([hidden, visible]) },
      hiddenIds
    );
    expect(filtered).toEqual({ kind: "tool", tool: visible });
  });
});
