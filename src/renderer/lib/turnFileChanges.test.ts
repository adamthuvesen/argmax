import { describe, expect, it } from "vitest";
import type { ToolCall, TurnToolItem } from "./toolCalls.js";
import { collectTurnFileChanges, summarizeTurnFileChanges } from "./turnFileChanges.js";

function tool(name: string, input: Record<string, unknown>, id = name): ToolCall {
  return {
    id,
    toolUseId: id,
    name,
    inputPreview: "",
    inputFull: input,
    output: null,
    status: "done",
    createdAt: "2026-08-31T10:00:00.000Z",
    completedAt: "2026-08-31T10:00:01.000Z",
    error: null
  };
}

function turnOf(tools: ToolCall[]): TurnToolItem[] {
  return tools.map((t) => ({ kind: "tool" as const, tool: t }));
}

describe("collectTurnFileChanges", () => {
  it("folds repeated writes to one path into a single row", () => {
    const changes = collectTurnFileChanges(
      turnOf([
        tool("Edit", { file_path: "/repo/src/a.ts", old_string: "one", new_string: "uno" }, "t1"),
        tool("Edit", { file_path: "/repo/src/a.ts", old_string: "two", new_string: "dos" }, "t2")
      ])
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe("/repo/src/a.ts");
    expect(changes[0]?.writes).toBe(2);
    expect(changes[0]?.adds).toBe(2);
    expect(changes[0]?.dels).toBe(2);
  });

  it("keeps a created file a create even after later edits", () => {
    const changes = collectTurnFileChanges(
      turnOf([
        tool("Write", { file_path: "/repo/src/new.ts", content: "a\nb" }, "t1"),
        tool("Edit", { file_path: "/repo/src/new.ts", old_string: "a", new_string: "c" }, "t2")
      ])
    );
    expect(changes[0]?.kind).toBe("create");
  });

  it("lets a delete decide the turn's verdict on the file", () => {
    const changes = collectTurnFileChanges(
      turnOf([
        tool("Edit", { file_path: "/repo/src/gone.ts", old_string: "a", new_string: "b" }, "t1"),
        tool("delete_file", { file_path: "/repo/src/gone.ts" }, "t2")
      ])
    );
    expect(changes[0]?.kind).toBe("delete");
  });

  it("orders rows by first touch and ignores tools that write nothing", () => {
    const changes = collectTurnFileChanges(
      turnOf([
        tool("Bash", { command: "ls" }, "t0"),
        tool("Write", { file_path: "/repo/b.md", content: "x" }, "t1"),
        tool("Write", { file_path: "/repo/a.md", content: "y" }, "t2")
      ])
    );
    expect(changes.map((change) => change.path)).toEqual(["/repo/b.md", "/repo/a.md"]);
  });

  // Codex reports a written path with no diff, so the stat on these rows is the
  // one the backend measured from git and wrote onto the tool row
  // (providers/measured_diffs.rs). Two writes to one file carry one diff each,
  // so the row still sums to the turn's own lines.
  it("stats a Codex file change from the diff Argmax measured", () => {
    const hunk = (line: string) => `@@ -2,1 +2,2 @@\n one\n-two\n+${line}\n`;
    const changes = collectTurnFileChanges(
      turnOf([
        tool("file_change", {
          changes: [{ kind: "update", path: "/repo/model.sql", unified_diff: hunk("two CHANGED") }]
        }, "t1"),
        tool("file_change", {
          changes: [{ kind: "update", path: "/repo/model.sql", unified_diff: hunk("two AGAIN") }]
        }, "t2")
      ])
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.writes).toBe(2);
    expect(changes[0]?.adds).toBe(2);
    expect(changes[0]?.dels).toBe(2);
  });

  it("leaves a Codex file change with no measured diff without a stat", () => {
    const changes = collectTurnFileChanges(
      turnOf([tool("file_change", { changes: [{ kind: "update", path: "/repo/model.sql" }] }, "t1")])
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.adds).toBe(0);
    expect(changes[0]?.dels).toBe(0);
  });

  it("reads tools nested in a group", () => {
    const group: TurnToolItem = {
      kind: "tool-group",
      group: {
        id: "g1",
        tools: [tool("Write", { file_path: "/repo/a.ts", content: "x\ny" }, "t1")],
        parallelPositions: new Map(),
        parallelGroupId: new Map()
      }
    };
    expect(collectTurnFileChanges([group])).toHaveLength(1);
  });
});

describe("summarizeTurnFileChanges", () => {
  it("counts a deleted file without inventing a line stat for it", () => {
    const totals = summarizeTurnFileChanges([
      { path: "a.ts", kind: "edit", adds: 4, dels: 2, writes: 1 },
      { path: "b.ts", kind: "delete", adds: 0, dels: 0, writes: 1 }
    ]);
    expect(totals).toEqual({ files: 2, adds: 4, dels: 2 });
  });
});
