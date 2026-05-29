import { describe, expect, it } from "vitest";
import {
  buildGroupRows,
  describeToolAction,
  extractCompletionCorrelationId,
  extractToolInputPreview,
  extractToolUseId,
  getToolTypeBucket,
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
    error: overrides.error ?? null,
    parentToolUseId: overrides.parentToolUseId ?? null
  };
}

describe("extractCompletionCorrelationId", () => {
  it("prefers tool_use_id (Claude)", () => {
    expect(extractCompletionCorrelationId({ tool_use_id: "toolu_x", id: "should-not-win" })).toBe("toolu_x");
  });

  it("falls back to id (Codex)", () => {
    expect(extractCompletionCorrelationId({ id: "codex-1" })).toBe("codex-1");
  });

  it("falls back to call_id (Cursor)", () => {
    // Without this, cursor tool calls render forever as 'running' because
    // command.completed never pairs back to command.started.
    expect(extractCompletionCorrelationId({ call_id: "tool_abc" })).toBe("tool_abc");
  });

  it("returns null when no correlation field is present", () => {
    expect(extractCompletionCorrelationId({})).toBeNull();
  });

  it("ignores non-string values", () => {
    expect(extractCompletionCorrelationId({ id: 42, call_id: null })).toBeNull();
  });
});

describe("extractToolUseId", () => {
  it("returns id when present (Claude/Codex started)", () => {
    expect(extractToolUseId({ id: "toolu_x" })).toBe("toolu_x");
  });

  it("falls back to call_id (Cursor started)", () => {
    expect(extractToolUseId({ call_id: "tool_abc" })).toBe("tool_abc");
  });
});

describe("Task / sub-agent tools", () => {
  it("classifies the Task tool into the agent bucket (case-insensitive)", () => {
    expect(getToolTypeBucket("Task")).toBe("agent");
    expect(getToolTypeBucket("task")).toBe("agent");
    expect(getToolTypeBucket("subagent")).toBe("agent");
    expect(getToolTypeBucket("explore_sub_agent")).toBe("agent");
  });

  it("does not sweep up unrelated names containing 'task'", () => {
    expect(getToolTypeBucket("TaskList")).not.toBe("agent");
    expect(getToolTypeBucket("agent_id")).not.toBe("agent");
  });

  it("previews from the `description` field, not the long prompt body", () => {
    expect(
      extractToolInputPreview("Task", {
        description: "Audit shared + scripts",
        prompt: "A very long prompt body that should not surface in the row header...",
        subagent_type: "general-purpose"
      })
    ).toBe("Audit shared + scripts");
  });

  it("describeToolAction renders the Agent verb so the row reads as 'Agent <description>'", () => {
    const t = tool({
      name: "Task",
      inputPreview: "Audit shared + scripts",
      inputFull: { description: "Audit shared + scripts" }
    });
    expect(describeToolAction(t)).toBe("Agent Audit shared + scripts");
  });

  it("group headline uses the 'Spawned' verb", () => {
    const out = summarizeToolGroup([
      tool({ name: "Task", id: "1" }),
      tool({ name: "Task", id: "2" })
    ]);
    expect(out.headline).toBe("Spawned 2 agents");
  });
});

describe("file_change tools", () => {
  it("previews changed file paths", () => {
    expect(
      extractToolInputPreview("file_change", {
        changes: [
          { path: "/repo/src/a.ts", kind: "update" },
          { path: "/repo/src/b.ts", kind: "create" }
        ]
      })
    ).toBe("/repo/src/a.ts +1");
  });

  it("uses the edit bucket", () => {
    expect(getToolTypeBucket("file_change")).toBe("edit");
  });
});

describe("summarizeToolGroup — single-bucket headlines", () => {
  it("reads-only → Explored N files", () => {
    const out = summarizeToolGroup([tool({ name: "Read" }), tool({ name: "read", id: "id-2" })]);
    expect(out.headline).toBe("Explored 2 files");
  });

  it("bash-only → Ran N commands", () => {
    const out = summarizeToolGroup([
      tool({ name: "Bash" }),
      tool({ name: "shell", id: "id-2" }),
      tool({ name: "exec", id: "id-3" })
    ]);
    expect(out.headline).toBe("Ran 3 commands");
  });

  it("edit-only → Edited N files", () => {
    const out = summarizeToolGroup([tool({ name: "Write" }), tool({ name: "Edit", id: "id-2" })]);
    expect(out.headline).toBe("Edited 2 files");
  });

  it("singular pluralization", () => {
    expect(summarizeToolGroup([tool({ name: "Read" })]).headline).toBe("Explored 1 file");
    expect(summarizeToolGroup([tool({ name: "Bash" })]).headline).toBe("Ran 1 command");
  });
});

describe("summarizeToolGroup — mixed-bucket headlines", () => {
  it("Codex pattern: 1 file + 2 lists + 1 command", () => {
    const out = summarizeToolGroup([
      tool({ name: "Read", id: "1" }),
      tool({ name: "list_dir", id: "2" }),
      tool({ name: "list_dir", id: "3" }),
      tool({ name: "Bash", id: "4" })
    ]);
    expect(out.headline).toBe("Explored 1 file, 2 lists, ran 1 command");
  });

  it("first clause is capitalized, subsequent clauses lowercase", () => {
    const out = summarizeToolGroup([
      tool({ name: "Bash", id: "1" }),
      tool({ name: "Read", id: "2" })
    ]);
    // read-files comes first in fixed order, so "Explored ..." leads.
    expect(out.headline).toBe("Explored 1 file, ran 1 command");
  });

  it("preserves bucket ordering regardless of input order", () => {
    const out = summarizeToolGroup([
      tool({ name: "Bash", id: "1" }),
      tool({ name: "Edit", id: "2" }),
      tool({ name: "Grep", id: "3" })
    ]);
    expect(out.headline).toBe("Searched 1 time, 1 edit, ran 1 command");
  });
});

describe("summarizeToolGroup — currentAction while running", () => {
  it("surfaces the latest running tool's action", () => {
    const out = summarizeToolGroup([
      tool({ name: "Read", id: "1", status: "done", inputPreview: "/repo/a.ts" }),
      tool({
        name: "Read",
        id: "2",
        status: "running",
        inputPreview: "/repo/pyproject.toml",
        completedAt: ""
      })
    ]);
    expect(out.status).toBe("running");
    expect(out.currentAction).toBe("Read pyproject.toml");
  });

  it("returns null when nothing is running", () => {
    const out = summarizeToolGroup([
      tool({ name: "Read", id: "1", status: "done" }),
      tool({ name: "Bash", id: "2", status: "done" })
    ]);
    expect(out.currentAction).toBeNull();
  });

  it("does not mark a mixed-success group as error when one child failed", () => {
    const out = summarizeToolGroup([
      tool({ name: "Read", id: "1", status: "done" }),
      tool({ name: "Read", id: "2", status: "error", error: "EISDIR" })
    ]);
    expect(out.status).toBe("done");
    expect(out.hasErrors).toBe(true);
  });

  it("marks the group as error when every child failed", () => {
    const out = summarizeToolGroup([
      tool({ name: "Read", id: "1", status: "error", error: "ENOENT" }),
      tool({ name: "Bash", id: "2", status: "error", error: "exit 1" })
    ]);
    expect(out.status).toBe("error");
    expect(out.hasErrors).toBe(true);
  });
});

describe("describeToolAction", () => {
  it("reads → 'Read <basename>'", () => {
    expect(describeToolAction(tool({ name: "Read", inputPreview: "/repo/src/foo.ts" }))).toBe("Read foo.ts");
  });

  it("list_dir → 'Listed files in <basename>'", () => {
    expect(describeToolAction(tool({ name: "list_dir", inputPreview: "src-tauri/src" }))).toBe(
      "Listed files in src"
    );
  });

  it("bash → 'Ran <command>'", () => {
    expect(describeToolAction(tool({ name: "Bash", inputPreview: "git status --short" }))).toBe(
      "Ran git status --short"
    );
  });

  it("edit → 'Edited <basename>'", () => {
    expect(describeToolAction(tool({ name: "Write", inputPreview: "/repo/src/foo.ts" }))).toBe(
      "Edited foo.ts"
    );
  });

  it("search → 'Searched for <query>'", () => {
    expect(describeToolAction(tool({ name: "Grep", inputPreview: "parsePlan" }))).toBe(
      "Searched for parsePlan"
    );
  });

  it("web → 'Fetched <url>'", () => {
    expect(
      describeToolAction(tool({ name: "WebFetch", inputPreview: "https://example.com" }))
    ).toBe("Fetched https://example.com");
  });

  it("falls back to tool name + preview for unknown buckets", () => {
    expect(describeToolAction(tool({ name: "custom_mcp_tool", inputPreview: "foo" }))).toBe(
      "custom_mcp_tool foo"
    );
  });
});

describe("buildGroupRows — sub-agent nesting", () => {
  it("keeps everything top-level when there are no parent links", () => {
    const rows = buildGroupRows([
      tool({ name: "Read", id: "a", toolUseId: "tu-a" }),
      tool({ name: "Bash", id: "b", toolUseId: "tu-b" })
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.children.length === 0)).toBe(true);
  });

  it("nests a sub-agent's calls under the Task that spawned them", () => {
    const rows = buildGroupRows([
      tool({ name: "Task", id: "task", toolUseId: "tu-task" }),
      tool({ name: "find", id: "c1", toolUseId: "tu-c1", parentToolUseId: "tu-task" }),
      tool({ name: "Read", id: "c2", toolUseId: "tu-c2", parentToolUseId: "tu-task" }),
      tool({ name: "Bash", id: "top", toolUseId: "tu-top" })
    ]);
    expect(rows.map((r) => r.tool.id)).toEqual(["task", "top"]);
    expect(rows[0]?.children.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(rows[1]?.children).toHaveLength(0);
  });

  it("treats a child as top-level when its parent is not in the group", () => {
    const rows = buildGroupRows([
      tool({ name: "Read", id: "orphan", toolUseId: "tu-orphan", parentToolUseId: "tu-missing" })
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool.id).toBe("orphan");
    expect(rows[0]?.children).toHaveLength(0);
  });
});
