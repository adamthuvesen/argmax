import { describe, expect, it } from "vitest";
import {
  buildGroupRows,
  cleanToolInput,
  describeToolAction,
  extractCompletionCorrelationId,
  extractOpenablePath,
  extractToolName,
  extractToolInputPreview,
  extractToolUseId,
  formatToolOutput,
  getToolTypeBucket,
  isAgentToolName,
  isHiddenToolName,
  mcpToolLabel,
  parseMcpToolName,
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

describe("MCP tool names", () => {
  it("parses the Claude/Cursor prefix and drops the client from the server", () => {
    expect(parseMcpToolName("mcp__claude_ai_Notion__notion-fetch")).toEqual({
      server: "Notion",
      tool: "fetch"
    });
    expect(parseMcpToolName("mcp__engram__recall")).toEqual({ server: "engram", tool: "recall" });
    expect(parseMcpToolName("mcp__linear__list_issues")).toEqual({
      server: "linear",
      tool: "list issues"
    });
  });

  it("parses OpenCode's repeated server without swallowing snake_case names", () => {
    expect(parseMcpToolName("notion_notion-fetch")).toEqual({ server: "notion", tool: "fetch" });
    expect(parseMcpToolName("send_message_to_thread")).toBeNull();
    expect(parseMcpToolName("file_change")).toBeNull();
    expect(parseMcpToolName("WebFetch")).toBeNull();
  });

  it("parses Codex app names and Cursor plugin identifiers", () => {
    expect(parseMcpToolName("linear.list_issues")).toEqual({
      server: "linear",
      tool: "list issues"
    });
    expect(parseMcpToolName("mcp__plugin-google-drive-google-drive__list_recent_files")).toEqual({
      server: "google drive",
      tool: "list recent files"
    });
    expect(parseMcpToolName("mcp__plugin-notion-workspace-notion__notion-fetch")).toEqual({
      server: "notion",
      tool: "fetch"
    });
    expect(parseMcpToolName("mcp__browser_use__browser_exec")).toEqual({
      server: "browser use",
      tool: "browser exec"
    });
    expect(parseMcpToolName("google-drive_google-drive-list_recent_files")).toEqual({
      server: "google drive",
      tool: "list recent files"
    });
  });

  it("labels the tool by its own identity instead of a hijacked bucket verb", () => {
    // `mcp__claude_ai_Notion__notion-fetch` contains "fetch", so substring
    // bucketing used to render it as "Fetched URL" — a URL it never fetched.
    expect(describeToolAction(tool({ name: "mcp__claude_ai_Notion__notion-fetch" }))).toBe("Notion fetch");
    expect(mcpToolLabel("mcp__engram__recall")).toBe("Engram recall");
    expect(mcpToolLabel("Read")).toBeNull();
  });

  it("keeps MCP tools out of the web and agent buckets", () => {
    expect(getToolTypeBucket("mcp__claude_ai_Notion__notion-fetch")).toBe("other");
    expect(getToolTypeBucket("mcp__linear__save_agent")).toBe("other");
    expect(getToolTypeBucket("WebFetch")).toBe("web");
  });

  it("resolves Cursor and Codex wrappers before the UI sees them", () => {
    expect(extractToolName({
      name: "mcpToolCall",
      input: {
        serverIdentifier: "plugin-google-drive-google-drive",
        toolName: "list_recent_files"
      }
    })).toBe("mcp__plugin-google-drive-google-drive__list_recent_files");
    expect(extractToolName({
      name: "recall",
      server: "engram",
      tool: "recall"
    })).toBe("mcp__engram__recall");
    expect(extractToolName({
      name: "mcp_tool_call",
      server: "codex_apps",
      tool: "linear.list_issues"
    })).toBe("linear.list_issues");
    expect(extractToolName({
      name: "other",
      input: { _toolName: "task", description: "Review code" }
    })).toBe("task");
  });

  it("removes Cursor wrapper metadata from the expandable input", () => {
    expect(cleanToolInput("mcp__engram__recall", {
      args: { query: "Argmax" },
      providerIdentifier: "engram",
      toolCallId: "tool-1",
      toolName: "recall"
    }, "mcpToolCall")).toEqual({ query: "Argmax" });
  });

  it("does not erase a direct MCP tool's legitimate metadata-shaped arguments", () => {
    const input = { toolName: "child", serverIdentifier: "chosen-by-user" };
    expect(cleanToolInput("mcp__custom__configure", input, "mcp__custom__configure")).toEqual(input);
  });

  it("humanizes direct provider aliases instead of leaking raw identifiers", () => {
    expect(describeToolAction(tool({ name: "engram_remember" }))).toBe("Engram remember");
    expect(describeToolAction(tool({ name: "trace_get_document" }))).toBe("Trace get document");
    expect(describeToolAction(tool({ name: "linear.list_issues" }))).toBe("Linear list issues");
  });

  it("marks discovery and task bookkeeping as hidden transport", () => {
    for (const name of [
      "ToolSearch",
      "getMcpToolsToolCall",
      "TodoWrite",
      "TaskCreate",
      "TaskUpdate",
      "get_command_or_subagent_output"
    ]) {
      expect(isHiddenToolName(name)).toBe(true);
    }
    expect(isHiddenToolName("mcpToolCall")).toBe(false);
    expect(isHiddenToolName("task")).toBe(false);
  });
});

describe("formatToolOutput", () => {
  it("lifts the payload out of an MCP envelope so newlines are real", () => {
    const envelope = JSON.stringify({
      metadata: { type: "page" },
      title: "Todo",
      url: "https://app.notion.com/p/28df6da7",
      text: "Prio\n- [ ] mpa\n- [x] docs"
    });

    expect(formatToolOutput(envelope)).toEqual({
      body: "Prio\n- [ ] mpa\n- [x] docs",
      title: "Todo"
    });
  });

  it("pretty-prints JSON that carries no single text field", () => {
    expect(formatToolOutput('{"a":1,"b":[2]}')).toEqual({
      body: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
      title: null
    });
    expect(formatToolOutput('{"text":"a","result":"b"}').title).toBeNull();
    expect(formatToolOutput('{"text":"a","result":"b"}').body).toContain('"text": "a"');
  });

  it("keeps structured result metadata instead of treating data as an envelope", () => {
    const result = formatToolOutput('{"result":"page 1","next_cursor":"cursor-2","has_more":true}');
    expect(result.title).toBeNull();
    expect(result.body).toContain('"result": "page 1"');
    expect(result.body).toContain('"next_cursor": "cursor-2"');
    expect(result.body).toContain('"has_more": true');
  });

  it("leaves anything that is not JSON exactly as it arrived", () => {
    expect(formatToolOutput("total 8\ndrwxr-xr-x")).toEqual({
      body: "total 8\ndrwxr-xr-x",
      title: null
    });
    expect(formatToolOutput("{not json")).toEqual({ body: "{not json", title: null });
  });
});

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
    expect(getToolTypeBucket("close_agent")).not.toBe("agent");
  });

  it("classifies Cursor `taskToolCall` and Codex `collab_tool_call` as agents", () => {
    // Neither provider streams the sub-agent's internal steps, but the launch
    // still reads as "an agent did this" (Bot icon + "Spawned N agents").
    expect(getToolTypeBucket("taskToolCall")).toBe("agent");
    expect(getToolTypeBucket("collab_tool_call")).toBe("agent");
  });

  it("classifies the launch tool every provider actually emits", () => {
    // The names each CLI puts on the wire today: Claude's `Agent`, Codex's
    // `spawn_agent`, OpenCode's `task`, and Cursor's `taskToolCall` (one-shot
    // stream) or `task` (ACP, taken from `rawInput._toolName` because ACP's
    // own `kind` for a sub-agent launch is the useless `other`).
    for (const name of ["Agent", "spawn_agent", "task", "taskToolCall"]) {
      expect(getToolTypeBucket(name)).toBe("agent");
    }
  });

  it("exposes the shared agent classifier for grouping decisions", () => {
    expect(isAgentToolName("Task")).toBe(true);
    expect(isAgentToolName("taskToolCall")).toBe(true);
    expect(isAgentToolName("collab_tool_call")).toBe(true);
    expect(isAgentToolName("TaskList")).toBe(false);
  });

  it("renders Cursor `taskToolCall` as 'Started agent <description>' from its args", () => {
    const t = tool({
      name: "taskToolCall",
      inputPreview: "Map renderer surface",
      inputFull: { description: "Map renderer surface", subagentType: { unspecified: {} } }
    });
    expect(describeToolAction(t)).toBe("Started agent Map renderer surface");
  });

  it("renders Codex `collab_tool_call` as a clean started-agent action when it carries no description", () => {
    expect(describeToolAction(tool({ name: "collab_tool_call" }))).toBe("Started agent");
  });

  it("previews Codex `collab_tool_call` from the spawn prompt when no description exists", () => {
    expect(
      extractToolInputPreview("collab_tool_call", {
        prompt: "Explore the repo quickly and report the key files."
      })
    ).toBe("Explore the repo quickly and report the key files.");
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

  it("describeToolAction renders a launch action so the row reads as 'Started agent <description>'", () => {
    const t = tool({
      name: "Task",
      inputPreview: "Audit shared + scripts",
      inputFull: { description: "Audit shared + scripts" }
    });
    expect(describeToolAction(t)).toBe("Started agent Audit shared + scripts");
  });

  it("group headline uses a quiet started-agent phrase", () => {
    const out = summarizeToolGroup([
      tool({ name: "Task", id: "1" }),
      tool({ name: "Task", id: "2" })
    ]);
    expect(out.headline).toBe("Started 2 agents");
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

describe("opencode camelCase inputs", () => {
  it("previews the filePath so edit rows name the file", () => {
    expect(extractToolInputPreview("edit", { filePath: "/repo/src/a.ts" })).toBe("/repo/src/a.ts");
  });

  it("exposes filePath as openable", () => {
    expect(extractOpenablePath("edit", { filePath: "/repo/src/a.ts" })).toBe("/repo/src/a.ts");
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

  it("unwraps shell launchers from command previews", () => {
    const out = summarizeToolGroup([
      tool({
        name: "command_execution",
        id: "cmd-1",
        inputPreview: "/bin/zsh -lc \"sed -n '1,80p' src/a.ts\""
      }),
      tool({
        name: "command_execution",
        id: "cmd-2",
        inputPreview: "/bin/zsh -lc \"rg -n useReviewState src\""
      }),
      tool({
        name: "command_execution",
        id: "cmd-3",
        inputPreview: "/bin/zsh -lc \"npm run lint\""
      })
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
    expect(out.headline).toBe("Searched once, 1 edit, ran 1 command");
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

  it("bash strips /bin/zsh launch wrappers from action text", () => {
    expect(
      describeToolAction(tool({ name: "command_execution", inputPreview: "/bin/zsh -lc \"npm run lint\"" }))
    ).toBe("Ran npm run lint");
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

  it("skill → 'Activated skill <name>'", () => {
    expect(describeToolAction(tool({ name: "Skill", inputPreview: "brain-curate" }))).toBe(
      "Activated skill brain-curate"
    );
    expect(extractToolInputPreview("Skill", { skill: "brain-curate" })).toBe("brain-curate");
  });

  it("web → 'Fetched <url>'", () => {
    expect(
      describeToolAction(tool({ name: "WebFetch", inputPreview: "https://example.com" }))
    ).toBe("Fetched https://example.com");
  });

  it("humanizes the tool name + preview for unknown buckets", () => {
    expect(describeToolAction(tool({ name: "custom_mcp_tool", inputPreview: "foo" }))).toBe(
      "Custom mcp tool foo"
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

describe("Grok Build tool names", () => {
  // Grok's built-in tools are snake_case and don't share Claude's spellings.
  // `search_replace` is the trap: it is Grok's primary EDIT tool, and the
  // `search` matcher used to claim it, so every file edit rendered as a search.
  it("buckets each built-in tool by what it actually does", () => {
    expect(getToolTypeBucket("search_replace")).toBe("edit");
    expect(getToolTypeBucket("write")).toBe("edit");
    expect(getToolTypeBucket("run_terminal_command")).toBe("bash");
    expect(getToolTypeBucket("read_file")).toBe("read");
    expect(getToolTypeBucket("list_dir")).toBe("read");
    expect(getToolTypeBucket("grep")).toBe("search");
    expect(getToolTypeBucket("web_fetch")).toBe("web");
    expect(getToolTypeBucket("spawn_subagent")).toBe("agent");
  });

  // The user-visible consequence of the bucket, through the public label.
  it("describes a search_replace as an edit, not a search", () => {
    expect(describeToolAction(tool({ name: "search_replace", inputPreview: "src/app.ts" })))
      .toBe("Edited app.ts");
    expect(describeToolAction(tool({ name: "read_file", inputPreview: "src/app.ts" })))
      .toBe("Read app.ts");
  });
});
