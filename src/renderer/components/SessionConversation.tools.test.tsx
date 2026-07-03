import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  baseSession,
  event,
  renderConversation
} from "../../test/sessionConversationTestHarness.js";

describe("SessionConversation — tools & chrome", () => {
  afterEach(() => {
    cleanup();
  });
  it("routes a backticked file chip click to onOpenFile (right panel)", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "See `src/foo.ts:42` for details.",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    fireEvent.click(screen.getByLabelText("Open src/foo.ts at line 42"));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("src/foo.ts", { line: 42, preferIde: false });
  });

  it("routes a markdown link to a local path through onOpenFile", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "Open [foo](src/bar.ts) please.",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    fireEvent.click(screen.getByLabelText("Open src/bar.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/bar.ts", { line: null, preferIde: false });
  });

  it("flags ⌘-click on a file chip with preferIde so the parent routes to the external IDE", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "See `src/foo.ts` for details.",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    fireEvent.click(screen.getByLabelText("Open src/foo.ts"), { metaKey: true });
    expect(onOpenFile).toHaveBeenCalledWith("src/foo.ts", { line: null, preferIde: true });
  });

  it("keeps normal turn headers to time and duration, not the selected model name", () => {
    renderConversation(
      baseSession({ provider: "claude", modelLabel: "Opus 4.8", state: "complete" }),
      [
        event("u1", "user.message", "summarize", "2026-05-12T15:00:00.000Z"),
        event("m1", "message.completed", "Here is the summary.", "2026-05-12T15:00:01.000Z")
      ]
    );

    expect(screen.getByText("Here is the summary.")).toBeInTheDocument();
    expect(screen.getByText("Worked for 1s")).toBeInTheDocument();
    expect(screen.queryByText("Opus 4.8")).toBeNull();
  });

  it("collapses a single MCP tool row when the turn chip is toggled", () => {
    renderConversation(
      baseSession({ provider: "claude", modelLabel: "Haiku 4.5", state: "complete" }),
      [
        event("u1", "user.message", "check memory", "2026-05-12T15:00:00.000Z"),
        event("mcp-start", "command.started", "mcp__engram__recall", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "toolu_mcp_recall",
          name: "mcp__engram__recall",
          input: { query: "Argmax project state" }
        }),
        event("mcp-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "toolu_mcp_recall",
          content: "{\"status\":\"ok\",\"data\":{\"answer\":\"stored fact\"}}"
        })
      ],
      { defaultToolCallsExpanded: true }
    );

    expect(screen.getByRole("button", { name: /mcp__engram__recall/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));

    expect(screen.getByRole("button", { name: /mcp__engram__recall/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("renders agent launches as standalone icon rows outside tool groups", () => {
    renderConversation(
      baseSession({ provider: "claude", modelLabel: "Opus 4.8", state: "complete" }),
      [
        event("u1", "user.message", "send an agent", "2026-05-12T15:00:00.000Z"),
        event("read-start", "command.started", "Read", "2026-05-12T15:00:01.000Z", {
          id: "read",
          name: "Read",
          input: { file_path: "README.md" }
        }),
        event("read-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "read",
          content: "readme"
        }),
        event("task-start", "command.started", "Task", "2026-05-12T15:00:03.000Z", {
          id: "task",
          name: "Task",
          input: {
            description: "Audit renderer tools",
            prompt: "Audit renderer tool-call grouping."
          }
        }),
        event("task-end", "command.completed", "tool_result", "2026-05-12T15:00:04.000Z", {
          tool_use_id: "task",
          content: "done"
        }),
        event("child-read-start", "command.started", "Read", "2026-05-12T15:00:04.200Z", {
          id: "child-read",
          name: "Read",
          parent_tool_use_id: "task",
          input: { file_path: "src/renderer/lib/toolCalls.tsx" }
        }),
        event("child-read-end", "command.completed", "tool_result", "2026-05-12T15:00:04.500Z", {
          tool_use_id: "child-read",
          content: "tool calls"
        }),
        event("bash-start", "command.started", "Bash", "2026-05-12T15:00:05.000Z", {
          id: "bash",
          name: "Bash",
          input: { command: "git status --short" }
        }),
        event("bash-end", "command.completed", "tool_result", "2026-05-12T15:00:06.000Z", {
          tool_use_id: "bash",
          content: ""
        })
      ]
    );

    expect(screen.getByRole("button", { name: "Read README.md" })).toBeInTheDocument();
    const agentRow = screen.getByRole("button", { name: "Started agent Audit renderer tools" });
    expect(agentRow.querySelector("svg")).not.toBeNull();
    expect(agentRow).not.toHaveTextContent("🤖");
    expect(screen.queryByRole("button", { name: "Read toolCalls.tsx" })).toBeNull();
    fireEvent.click(agentRow);
    expect(screen.queryByText("Activity")).not.toBeInTheDocument();
    const childRow = screen.getByRole("button", { name: "Read toolCalls.tsx" });
    expect(childRow).toBeInTheDocument();
    expect(childRow.closest(".tool-call-agent-child-list")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Ran a command/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Read a file, started an agent/ })).toBeNull();
  });

  it("keeps live agent activity collapsed while showing the running agent row", () => {
    renderConversation(
      baseSession({ provider: "claude", modelLabel: "Sonnet 5", state: "running" }),
      [
        event("u1", "user.message", "explore repo with a subagent", "2026-05-12T15:00:00.000Z"),
        event("task-start", "command.started", "Task", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "task",
          name: "Task",
          input: {
            description: "Explore repo structure",
            prompt: "Map the repo."
          }
        }),
        event("child-read-start", "command.started", "Read", "2026-05-12T15:00:02.000Z", {
          type: "tool_use",
          id: "child-read",
          name: "Read",
          parent_tool_use_id: "task",
          input: { file_path: "README.md" }
        })
      ],
      { defaultToolCallsExpanded: false, defaultToolCallGroupsExpanded: false }
    );

    const agentRow = screen.getByRole("button", { name: "Started agent Explore repo structure" });
    expect(agentRow).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Activity")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read README.md" })).not.toBeInTheDocument();
  });

  it("expands Codex spawned-agent rows to show spawn metadata", () => {
    renderConversation(
      baseSession({ provider: "codex", modelLabel: "GPT-5.5", state: "complete" }),
      [
        event("u1", "user.message", "spawn an agent", "2026-05-12T15:00:00.000Z"),
        event("agent-start", "command.started", "spawn_agent", "2026-05-12T15:00:01.000Z", {
          id: "item_2",
          name: "spawn_agent",
          input: {
            prompt: "Explore repo quickly and report key files.",
            receiver_thread_ids: [],
            sender_thread_id: "sender-thread"
          }
        }),
        event("agent-end", "command.completed", "spawn_agent", "2026-05-12T15:00:02.000Z", {
          id: "item_2",
          name: "spawn_agent",
          input: {
            prompt: "Explore repo quickly and report key files.",
            receiver_thread_ids: ["receiver-thread"],
            sender_thread_id: "sender-thread"
          }
        })
      ]
    );

    const agentRow = screen.getByRole("button", { name: "Started agent Explore repo quickly and report key files." });
    expect(screen.queryByText("Input")).not.toBeInTheDocument();

    fireEvent.click(agentRow);

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText(/receiver-thread/)).toBeInTheDocument();
  });

  it("turn chip expands every tool group even after one group was toggled locally", () => {
    renderConversation(
      baseSession({ provider: "claude", modelLabel: "Opus 4.8", state: "complete" }),
      [
        event("u1", "user.message", "explore this", "2026-05-12T15:00:00.000Z"),
        event("m1", "message.completed", "I'll explore.", "2026-05-12T15:00:01.000Z"),
        event("g1-read-start", "command.started", "Read", "2026-05-12T15:00:02.000Z", {
          id: "g1-read",
          name: "Read",
          input: { file_path: "README.md" }
        }),
        event("g1-read-end", "command.completed", "tool_result", "2026-05-12T15:00:03.000Z", {
          tool_use_id: "g1-read",
          content: "readme"
        }),
        event("g1-bash-start", "command.started", "Bash", "2026-05-12T15:00:04.000Z", {
          id: "g1-bash",
          name: "Bash",
          input: { command: "echo first" }
        }),
        event("g1-bash-end", "command.completed", "tool_result", "2026-05-12T15:00:05.000Z", {
          tool_use_id: "g1-bash",
          content: "first"
        }),
        event("m2", "message.completed", "I'll keep going.", "2026-05-12T15:00:06.000Z"),
        event("g2-read-start", "command.started", "Read", "2026-05-12T15:00:07.000Z", {
          id: "g2-read",
          name: "Read",
          input: { file_path: "package.json" }
        }),
        event("g2-read-end", "command.completed", "tool_result", "2026-05-12T15:00:08.000Z", {
          tool_use_id: "g2-read",
          content: "package"
        }),
        event("g2-bash-start", "command.started", "Bash", "2026-05-12T15:00:09.000Z", {
          id: "g2-bash",
          name: "Bash",
          input: { command: "echo second" }
        }),
        event("g2-bash-end", "command.completed", "tool_result", "2026-05-12T15:00:10.000Z", {
          tool_use_id: "g2-bash",
          content: "second"
        })
      ],
      { defaultToolCallGroupsExpanded: false }
    );

    const groups = screen.getAllByRole("button", { name: /Read a file, ran a command/ });
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group).toHaveAttribute("aria-expanded", "false");
      expect(group).not.toHaveTextContent("✓");
      expect(group).not.toHaveTextContent(/\d(?:\.\d)?s/);
      expect(group).not.toHaveTextContent("+");
      expect(group).not.toHaveTextContent("−");
    }

    fireEvent.click(groups[0]);
    expect(groups[0]).toHaveAttribute("aria-expanded", "true");
    expect(groups[1]).toHaveAttribute("aria-expanded", "false");
    expect(groups[0]).not.toHaveTextContent("−");

    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));

    expect(groups[0]).toHaveAttribute("aria-expanded", "true");
    expect(groups[1]).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Read README.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read package.json" })).toBeInTheDocument();
  });

  it("renders Codex file_change edit rows between assistant updates", () => {
    const modelSelectorPath =
      "/Users/adamthuvesen/dev/menti/argmax/src/renderer/components/ModelSelector.tsx";
    const cssPath =
      "/Users/adamthuvesen/dev/menti/argmax/src/renderer/styles/chat-chrome.css";
    renderConversation(
      baseSession({ provider: "codex", modelLabel: "GPT-5.5", state: "running" }),
      [
        event(
          "m1",
          "message.completed",
          "Agreed, that’s a fair read.",
          "2026-07-01T08:12:21.551Z"
        ),
        event(
          "m2",
          "message.completed",
          "The screenshot makes it clear: the main picker row is fine.",
          "2026-07-01T08:12:30.999Z"
        ),
        event("fc1-start", "command.started", "file_change", "2026-07-01T08:12:34.010Z", {
          id: "item_4",
          name: "file_change",
          input: { changes: [{ kind: "update", path: modelSelectorPath }] }
        }),
        event("fc1-end", "command.completed", "file_change", "2026-07-01T08:12:34.010Z", {
          id: "item_4",
          name: "file_change",
          input: { changes: [{ kind: "update", path: modelSelectorPath }] }
        }),
        event(
          "m3",
          "message.completed",
          "The submenu rows are now plain.",
          "2026-07-01T08:12:37.522Z"
        ),
        event("fc2-start", "command.started", "file_change", "2026-07-01T08:12:39.515Z", {
          id: "item_6",
          name: "file_change",
          input: { changes: [{ kind: "update", path: cssPath }] }
        }),
        event("fc2-end", "command.completed", "file_change", "2026-07-01T08:12:39.516Z", {
          id: "item_6",
          name: "file_change",
          input: { changes: [{ kind: "update", path: cssPath }] }
        }),
        event(
          "m4",
          "message.completed",
          "Tests still expect the old descriptive copy.",
          "2026-07-01T08:12:41.851Z"
        )
      ]
    );

    expect(screen.getByRole("button", { name: "Edited ModelSelector.tsx" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edited chat-chrome.css" })).toBeInTheDocument();
  });

  it("keeps command bursts separated by assistant prose as separate groups", () => {
    const commandEvents = (
      id: string,
      command: string,
      startedAt: string,
      completedAt: string
    ) => [
      event(`${id}-start`, "command.started", "command_execution", startedAt, {
        id,
        name: "command_execution",
        input: { command }
      }),
      event(`${id}-end`, "command.completed", "command_execution", completedAt, {
        id,
        name: "command_execution",
        input: { command }
      })
    ];
    renderConversation(
      baseSession({ provider: "codex", modelLabel: "GPT-5.5", state: "complete" }),
      [
        event("m1", "message.completed", "Pass 1A.", "2026-07-01T08:32:00.000Z"),
        ...commandEvents(
          "cmd-1",
          "/bin/zsh -lc \"sed -n '1,80p' src/a.ts\"",
          "2026-07-01T08:32:01.000Z",
          "2026-07-01T08:32:01.500Z"
        ),
        ...commandEvents(
          "cmd-2",
          "/bin/zsh -lc \"sed -n '1,80p' src/b.ts\"",
          "2026-07-01T08:32:02.000Z",
          "2026-07-01T08:32:02.500Z"
        ),
        event("m2", "message.completed", "Pass 1B.", "2026-07-01T08:32:03.000Z"),
        ...commandEvents(
          "cmd-3",
          "/bin/zsh -lc \"sed -n '1,80p' src/c.ts\"",
          "2026-07-01T08:32:04.000Z",
          "2026-07-01T08:32:04.500Z"
        ),
        event("m3", "message.completed", "Pass 2A.", "2026-07-01T08:32:05.000Z")
      ]
    );

    expect(screen.getByRole("button", { name: /Ran 2 commands/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ran a command/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ran 3 commands/ })).toBeNull();
  });

  it("leaves external markdown links as anchors (does not call onOpenFile)", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "Docs at [example](https://example.com).",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    const link = screen.getByRole("link", { name: "example" });
    expect(link).toHaveAttribute("href", "https://example.com");
    fireEvent.click(link);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it.each(["claude", "cursor", "codex"] as const)(
    "renders an assistant message produced in custom plan mode as a PlanCard for %s",
    (provider) => {
      const plan = [
        "# Plan: Tidy chat header",
        "",
        "Make the header lighter and clearer.",
        "",
        "## Key Changes",
        "",
        "- Update the badge color",
        "- Shrink the avatar"
      ].join("\n");

      renderConversation(baseSession({ provider, state: "complete" }), [
        event("u1", "user.message", "draft a plan", "2026-05-12T15:00:00.000Z", { agentMode: "plan" }),
        event("m1", "message.completed", plan, "2026-05-12T15:00:01.000Z")
      ]);

      expect(screen.getByRole("article", { name: /Plan: Tidy chat header/ })).toBeInTheDocument();
      expect(screen.getByRole("listbox", { name: "Plan response" })).toBeInTheDocument();
      expect(screen.getByText("Key Changes")).toBeInTheDocument();
    }
  );

  it("renders the same content as a ChatBubble when the turn was sent in edit mode", () => {
    const plan = [
      "# Plan: Tidy chat header",
      "",
      "Make the header lighter and clearer.",
      "",
      "## Key Changes",
      "",
      "- Update the badge color"
    ].join("\n");

    renderConversation(baseSession({ state: "complete" }), [
      event("u1", "user.message", "draft a plan", "2026-05-12T15:00:00.000Z", { agentMode: "auto" }),
      event("m1", "message.completed", plan, "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.queryByRole("listbox", { name: "Plan response" })).toBeNull();
    expect(screen.queryByRole("article", { name: /Plan: Tidy chat header/ })).toBeNull();
    // Title still shows, but as plain markdown inside a ChatBubble
    expect(screen.getByRole("heading", { name: "Plan: Tidy chat header" })).toBeInTheDocument();
  });

  it("falls back to a ChatBubble when a plan-mode reply has no parseable plan structure", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event("u1", "user.message", "what time is it?", "2026-05-12T15:00:00.000Z", { agentMode: "plan" }),
      event("m1", "message.completed", "It's about 3:30 PM here.", "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.queryByRole("listbox", { name: "Plan response" })).toBeNull();
    expect(screen.getByText("It's about 3:30 PM here.")).toBeInTheDocument();
  });

  it("hides the per-session toolbar actions behind a Session actions picker", () => {
    renderConversation(baseSession({ state: "complete" }));

    // None of the consolidated actions are visible until the picker is opened.
    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Save checkpoint" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Git actions" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Toggle debug log" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));

    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();
    // The default workspace stub is clean, so the checkpoint row is disabled.
    expect(screen.getByRole("menuitem", { name: "Save checkpoint" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Git actions" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Toggle debug log" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
  });

  it("dismisses the session actions popover on a mousedown outside the popover", () => {
    renderConversation(baseSession({ state: "complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
  });

  it("dismisses the session actions popover when clicking inside the conversation area", () => {
    renderConversation(baseSession({ state: "complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();

    const repositoryHeading = screen.getByRole("heading", { level: 2 });
    fireEvent.mouseDown(repositoryHeading);

    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
  });

  it("dismisses the session actions popover after toggling the debug log", () => {
    renderConversation(baseSession({ state: "complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Toggle debug log" }));

    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
  });

  it("swaps the picker contents in place when Git actions is selected", () => {
    renderConversation(baseSession({ state: "complete" }));

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Git actions" }));

    // Main menu items are no longer in the DOM; git actions take their place.
    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Toggle debug log" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Push" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Create pull request|View pull request/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create branch" })).toBeInTheDocument();

    // Back returns to the main menu.
    fireEvent.click(screen.getByRole("button", { name: "Back to session actions" }));
    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Push" })).toBeNull();
  });

});
