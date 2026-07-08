import { describe, expect, it } from "vitest";
import { parseQuestionsFromToolInput } from "./questions.js";
import { foldTurnToolItems, visibleTurnToolItem } from "./turnToolItems.js";
import { buildToolCallGroup, type ToolCall } from "./toolCalls.js";

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
    error: overrides.error ?? null,
    parentToolUseId: overrides.parentToolUseId ?? null
  };
}

describe("turnToolItems", () => {
  it("folds bash-like tools into groups without crossing non-bash tools", () => {
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
    expect(folded[2]?.kind).toBe("tool-group");
    expect(folded[2]?.kind === "tool-group" ? folded[2].group.tools.map((t) => t.id) : []).toEqual(["t4"]);
  });

  it("keeps single bash-like tools as groups so they render with the summary header", () => {
    const command = tool({ id: "t1", name: "Bash", inputPreview: "ls -la" });

    const [folded] = foldTurnToolItems([{ kind: "tool", tool: command }]);
    expect(folded?.kind).toBe("tool-group");
    expect(folded?.kind === "tool-group" ? folded.group.tools : []).toEqual([command]);

    if (!folded) throw new Error("expected folded tool item");
    const visible = visibleTurnToolItem(folded, new Set());
    expect(visible?.kind).toBe("tool-group");
  });

  it("does not merge existing bash groups across assistant-message boundaries", () => {
    const first = tool({ id: "t1", name: "Bash", inputPreview: "sed -n '1,80p' src/a.ts" });
    const second = tool({ id: "t2", name: "Bash", inputPreview: "sed -n '1,80p' src/b.ts" });
    const later = tool({
      id: "t3",
      name: "Bash",
      inputPreview: "sed -n '1,80p' src/c.ts",
      createdAt: "2026-05-21T10:01:00.000Z"
    });
    const existingGroup = buildToolCallGroup([first, second]);

    const folded = foldTurnToolItems([
      { kind: "tool-group", group: existingGroup },
      { kind: "tool", tool: later }
    ]);

    expect(folded).toHaveLength(2);
    expect(folded[0]).toEqual({ kind: "tool-group", group: existingGroup });
    expect(folded[1]?.kind).toBe("tool-group");
    expect(folded[1]?.kind === "tool-group" ? folded[1].group.tools.map((t) => t.id) : []).toEqual(["t3"]);
  });

  it("attaches sub-agent child tools to the standalone agent row", () => {
    const agent = tool({ id: "agent", toolUseId: "tu-agent", name: "Agent" });
    const childRead = tool({
      id: "child-read",
      name: "Read",
      inputPreview: "src/child.ts",
      parentToolUseId: "tu-agent"
    });
    const childBash = tool({
      id: "child-bash",
      name: "Bash",
      inputPreview: "npm test",
      parentToolUseId: "tu-agent"
    });
    const topLevelBash = tool({ id: "top-bash", name: "Bash", inputPreview: "git status" });

    const folded = foldTurnToolItems([
      { kind: "tool", tool: agent },
      { kind: "tool", tool: childRead },
      { kind: "tool", tool: childBash },
      { kind: "tool", tool: topLevelBash }
    ]);

    expect(folded).toHaveLength(2);
    expect(folded[0]).toEqual({ kind: "tool", tool: agent, children: [childRead, childBash] });
    expect(folded[1]?.kind).toBe("tool-group");
    expect(folded[1]?.kind === "tool-group" ? folded[1].group.tools.map((t) => t.id) : []).toEqual([
      "top-bash"
    ]);
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
