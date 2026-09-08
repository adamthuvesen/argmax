import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";
import type { EventType, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import { AgentActivity } from "./AgentActivity.js";
import { __liveTimerTickForTest } from "../lib/liveTimer.js";

function event(
  id: string,
  type: EventType,
  createdAt: string,
  message = id,
  payload: Record<string, unknown> = {}
): TimelineEvent {
  return {
    id,
    sessionId: "s1",
    type,
    message,
    payload,
    createdAt
  };
}

const session: SessionSummary = {
  id: "s1",
  workspaceId: "w1",
  provider: "claude",
  modelLabel: "Sonnet 5",
  modelId: "claude-sonnet-5",
  permissionMode: "auto-approve",
  providerConversationId: "provider-s1",
  prompt: "Explore repo",
  state: "running",
  attention: "normal",
  startedAt: "2026-05-12T15:00:00.000Z",
  completedAt: null,
  lastActivityAt: "2026-05-12T15:00:02.000Z",
  costUsd: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextTokens: 0,
  imported: false,
  launchKind: "agent"
};

const workspace: WorkspaceSummary = {
  id: "w1",
  projectId: "p1",
  taskLabel: "Explore repo",
  branch: "adam/explore-repo",
  baseRef: "main",
  path: "/tmp/repo",
  state: "running",
  sharedWorkspace: false,
  kind: "git",
  dirty: false,
  changedFiles: 0,
  lastActivityAt: "2026-05-12T15:00:02.000Z",
  pinned: false,
  priorityDismissedAt: null,
  priorityAddedAt: null,
  prState: null,
  prNumber: null,
  icon: null,
  iconColor: null,
  prCreatedAt: null,
  prMergedAt: null
};

describe("AgentActivity", () => {
  it("ticks through a silent reasoning stretch after narration without waiting for trace updates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T15:00:55.000Z"));
    const events = [
      event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
        id: "task-1", name: "Task", input: { description: "Explore repo" }
      }),
      event("note", "message.completed", "2026-05-12T15:00:02.000Z", "I'll inspect the data.", {
        parent_tool_use_id: "task-1"
      }),
      event("thought", "message.delta", "2026-05-12T15:00:10.000Z", "Checking the evidence.", {
        parent_tool_use_id: "task-1", thinking: true
      })
    ];
    const pane = (rows: TimelineEvent[]) => (
      <AgentActivity events={rows} parentSession={session} parentToolUseId="task-1" workspace={workspace} />
    );
    const { rerender } = render(pane(events.slice(0, 2)));
    expect(screen.getByRole("article", { name: "Thinking" })).toHaveTextContent("53s");
    rerender(pane(events));
    const thinking = screen.getByRole("article", { name: "Thinking" });
    expect(thinking).toHaveTextContent("45s");
    for (let second = 46; second <= 61; second += 1) {
      act(() => {
        vi.setSystemTime(new Date(Date.parse("2026-05-12T15:00:10.000Z") + second * 1000));
        __liveTimerTickForTest();
      });
      expect(thinking).toHaveTextContent(second < 60 ? `${second}s` : `1m ${second - 60}s`);
    }
    const label = thinking.textContent;
    rerender(pane([...events, event("thought-more", "message.delta", "2026-05-12T15:01:11.000Z", "Still checking.", {
      parent_tool_use_id: "task-1", thinking: true
    })]));
    expect(screen.getByRole("article", { name: "Thinking" }).textContent).toBe(label);
    const toolStarted = event("child-tool", "command.started", "2026-05-12T15:01:12.000Z", "Bash", {
      id: "child-tool", name: "Bash", parent_tool_use_id: "task-1", input: { command: "git status" }
    });
    rerender(pane([...events, toolStarted]));
    expect(screen.queryByRole("article", { name: "Thinking" })).toBeNull();
    act(() => {
      vi.setSystemTime(new Date("2026-05-12T15:01:20.000Z"));
    });
    rerender(pane([...events, toolStarted, event("child-tool-done", "command.completed", "2026-05-12T15:01:16.000Z", "Bash", {
      tool_use_id: "child-tool", output: "clean"
    })]));
    expect(screen.getByRole("article", { name: "Thinking" })).toHaveTextContent("4s");
    rerender(pane([...events, event("answer", "message.delta", "2026-05-12T15:01:12.000Z", "Here is the result.", {
      parent_tool_use_id: "task-1"
    })]));
    expect(screen.queryByRole("article", { name: "Thinking" })).toBeNull();
  });

  it("keeps a resumed native agent's thinking interval with its new send_input run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T15:01:45.000Z"));
    const firstRun = [
      event("spawn", "command.started", "2026-05-12T15:00:01.000Z", "spawn_agent", {
        id: "task-1", name: "spawn_agent", providerInvocationId: "invoke-1",
        input: { sender_thread_id: "parent", receiver_thread_ids: ["child-native"], prompt: "Inspect the repo." }
      }),
      event("first-start", "agent.started", "2026-05-12T15:00:01.100Z", "Agent started", {
        providerInvocationId: "invoke-1", providerChildSessionId: "child-native",
        providerParentConversationId: "parent", agentRootToolUseId: "task-1", agentRunId: "task-1"
      }),
      event("first-done", "agent.completed", "2026-05-12T15:00:03.000Z", "First result", {
        providerInvocationId: "invoke-1", providerChildSessionId: "child-native",
        providerParentConversationId: "parent", agentRootToolUseId: "task-1", agentRunId: "task-1", status: "completed"
      })
    ];
    const resumedRun = [
      ...firstRun,
      event("resume", "command.completed", "2026-05-12T15:00:59.000Z", "resume_agent", {
        id: "resume", name: "resume_agent", providerInvocationId: "invoke-2",
        input: { sender_thread_id: "parent", receiver_thread_ids: ["child-native"] }
      }),
      event("send", "command.started", "2026-05-12T15:01:00.000Z", "send_input", {
        id: "send-2", name: "send_input", providerInvocationId: "invoke-2",
        input: { sender_thread_id: "parent", receiver_thread_ids: ["child-native"], prompt: "Continue the inspection." }
      }),
      event("second-start", "agent.started", "2026-05-12T15:01:00.100Z", "Agent started", {
        providerInvocationId: "invoke-2", providerChildSessionId: "child-native",
        providerParentConversationId: "parent", agentRootToolUseId: "task-1", agentRunId: "send-2"
      })
    ];
    const pane = (rows: TimelineEvent[]) => (
      <AgentActivity events={rows} parentSession={session} parentToolUseId="task-1" workspace={workspace} />
    );
    const { rerender } = render(pane(resumedRun));

    // The original invocation is complete. The visible clock belongs to the
    // resumed send_input invocation, not the initial spawn 104 seconds ago.
    expect(screen.getAllByRole("article", { name: "Thinking" })).toHaveLength(1);
    expect(screen.getByRole("article", { name: "Thinking" })).toHaveTextContent("45s");

    const reasoning = [
      ...resumedRun,
      event("second-note", "message.completed", "2026-05-12T15:01:02.000Z", "I found the relevant files.", {
        parent_tool_use_id: "task-1", providerInvocationId: "invoke-2", agentRunId: "send-2",
        providerChildSessionId: "child-native"
      }),
      event("second-thought", "message.delta", "2026-05-12T15:01:10.000Z", "Checking the lifecycle path.", {
        parent_tool_use_id: "task-1", providerInvocationId: "invoke-2", agentRunId: "send-2",
        providerChildSessionId: "child-native", thinking: true
      })
    ];
    rerender(pane(reasoning));
    const thinking = screen.getByRole("article", { name: "Thinking" });
    expect(thinking).toHaveTextContent("35s");
    act(() => {
      vi.setSystemTime(new Date("2026-05-12T15:01:46.000Z"));
      __liveTimerTickForTest();
    });
    expect(thinking).toHaveTextContent("36s");
    const label = thinking.textContent;
    rerender(pane([...reasoning, event("second-thought-more", "message.delta", "2026-05-12T15:01:46.000Z", "Tracing the resumed run.", {
      parent_tool_use_id: "task-1", providerInvocationId: "invoke-2", agentRunId: "send-2",
      providerChildSessionId: "child-native", thinking: true
    })]));
    expect(screen.getByRole("article", { name: "Thinking" }).textContent).toBe(label);

    rerender(pane([...reasoning, event("second-done", "agent.completed", "2026-05-12T15:01:47.000Z", "Second result", {
      providerInvocationId: "invoke-2", providerChildSessionId: "child-native",
      providerParentConversationId: "parent", agentRootToolUseId: "task-1", agentRunId: "send-2", status: "completed"
    })]));
    expect(screen.queryByRole("article", { name: "Thinking" })).toBeNull();
  });

  it("renders each persistent native invocation as its own run in one dock pane", () => {
    render(
      <AgentActivity
        events={[
          event("second-done", "agent.completed", "2026-05-12T15:01:03.000Z", "Second result", {
            providerChildSessionId: "child-native", agentRootToolUseId: "task-1",
            agentRunId: "send-2", status: "completed"
          }),
          event("second-start", "agent.started", "2026-05-12T15:01:01.000Z", "Agent started", {
            providerChildSessionId: "child-native", agentRootToolUseId: "task-1", agentRunId: "send-2"
          }),
          event("first-done", "agent.completed", "2026-05-12T15:00:03.000Z", "First result", {
            providerChildSessionId: "child-native", agentRootToolUseId: "task-1",
            agentRunId: "task-1", status: "completed"
          }),
          event("first-start", "agent.started", "2026-05-12T15:00:01.000Z", "Agent started", {
            providerChildSessionId: "child-native", agentRootToolUseId: "task-1", agentRunId: "task-1"
          })
        ]}
        codename="Curie"
        parentSession={{ ...session, state: "complete" }}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    expect(screen.getAllByRole("region", { name: /Agent result/ })).toHaveLength(2);
    expect(screen.getByText("First result")).toBeInTheDocument();
    expect(screen.getByText("Second result")).toBeInTheDocument();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("does not retype a run whose trace arrives after the pane has mounted", async () => {
    // The same race the chat pane had: a run's trace only exists once
    // `loadAgentEvents` has answered, so a restore window timed from mount
    // expires first and the whole run types itself out from nothing as if it
    // had just happened.
    const narration =
      "I'll map the repo layout first, then read the provider adapters and the IPC surface they register.";
    const taskStart = event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
      id: "task-1",
      name: "Task",
      input: { description: "Explore repo", prompt: "Map the repo." }
    });
    let settleLoad = (): void => {};
    const agentEventsLoad = new Promise<void>((resolve) => {
      settleLoad = resolve;
    });
    const onLoadAgentEvents = vi.fn(() => agentEventsLoad);
    const pane = (events: TimelineEvent[]): JSX.Element => (
      <AgentActivity
        events={events}
        parentSession={session}
        parentToolUseId="task-1"
        workspace={workspace}
        onLoadAgentEvents={onLoadAgentEvents}
      />
    );

    vi.useFakeTimers();
    const { rerender } = render(pane([taskStart]));

    // Longer than RESTORE_MS: a mount-anchored window is long gone by now.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    await act(async () => {
      settleLoad();
      await agentEventsLoad;
    });
    rerender(
      pane([
        taskStart,
        event("child-note", "message.completed", "2026-05-12T15:00:02.000Z", narration, {
          parent_tool_use_id: "task-1"
        })
      ])
    );

    expect(screen.getByText(narration)).toBeInTheDocument();
  });

  it("keeps every persistent run in restore mode until their shared backfill settles", async () => {
    const taskStart = event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
      id: "task-1",
      name: "Task",
      input: { description: "Explore repo", prompt: "Map the repo." }
    });
    let settleLoad = (): void => {};
    const agentEventsLoad = new Promise<void>((resolve) => {
      settleLoad = resolve;
    });
    const onLoadAgentEvents = vi.fn(() => agentEventsLoad);
    const runShells = [
      taskStart,
      event("first-done", "agent.completed", "2026-05-12T15:00:03.000Z", "First result", {
        providerChildSessionId: "child-native", agentRootToolUseId: "task-1",
        agentRunId: "task-1", status: "completed"
      }),
      event("first-start", "agent.started", "2026-05-12T15:00:01.000Z", "Agent started", {
        providerChildSessionId: "child-native", agentRootToolUseId: "task-1", agentRunId: "task-1"
      }),
      event("second-done", "agent.completed", "2026-05-12T15:01:03.000Z", "Second result", {
        providerChildSessionId: "child-native", agentRootToolUseId: "task-1",
        agentRunId: "send-2", status: "completed"
      }),
      event("second-start", "agent.started", "2026-05-12T15:01:01.000Z", "Agent started", {
        providerChildSessionId: "child-native", agentRootToolUseId: "task-1", agentRunId: "send-2"
      })
    ];
    const pane = (events: TimelineEvent[]): JSX.Element => (
      <AgentActivity
        events={events}
        parentSession={session}
        parentToolUseId="task-1"
        workspace={workspace}
        onLoadAgentEvents={onLoadAgentEvents}
      />
    );

    vi.useFakeTimers();
    const { rerender } = render(pane(runShells));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    await act(async () => {
      settleLoad();
      await agentEventsLoad;
    });
    rerender(pane([
      ...runShells,
      event("first-note", "message.completed", "2026-05-12T15:00:02.000Z", "First history", {
        parent_tool_use_id: "task-1", agentRunId: "task-1"
      }),
      event("second-note", "message.completed", "2026-05-12T15:01:02.000Z", "Second history", {
        parent_tool_use_id: "task-1", agentRunId: "send-2"
      })
    ]));

    expect(onLoadAgentEvents).toHaveBeenCalledTimes(1);
    const runRegions = screen.getAllByRole("region", { name: /Agent activity/ });
    expect(runRegions).toHaveLength(2);
    for (const region of runRegions) {
      expect(region.querySelector('[data-restoring="true"]')).not.toBeNull();
    }
    act(() => {
      vi.advanceTimersByTime(320);
    });
    for (const region of runRegions) {
      expect(region.querySelector('[data-restoring="true"]')).toBeNull();
    }
  });

  it("shows a running agent load failure and clears it after a successful retry", async () => {
    vi.useFakeTimers();
    const onLoadAgentEvents = vi.fn()
      .mockRejectedValueOnce(new Error("trace unavailable"))
      .mockResolvedValue(undefined);

    render(
      <AgentActivity
        events={[
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: { description: "Explore repo", prompt: "Map the repo." }
          })
        ]}
        onLoadAgentEvents={onLoadAgentEvents}
        parentSession={session}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Agent activity could not be loaded");

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });
    expect(onLoadAgentEvents).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("article", { name: "Thinking" })).toBeInTheDocument();
  });

  it("folds a run into collapsed group headers, the same shape as the chat", () => {
    render(
      <AgentActivity
        events={[
          event("child-bash", "command.started", "2026-05-12T15:00:02.000Z", "Bash", {
            id: "child-bash",
            name: "Bash",
            parent_tool_use_id: "task-1",
            input: { command: "git status --short" }
          }),
          event("child-bash-2", "command.started", "2026-05-12T15:00:03.000Z", "Bash", {
            id: "child-bash-2",
            name: "Bash",
            parent_tool_use_id: "task-1",
            input: { command: "git log --oneline" }
          }),
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: { description: "Explore repo", prompt: "Map the repo." }
          })
        ]}
        parentSession={session}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    const pane = screen.getByRole("region", { name: "Agent activity: Explore repo" });
    expect(within(pane).getByRole("button", { name: /^Ran commands/ })).toBeInTheDocument();
    // Collapsed: neither the per-tool rows nor their expanded detail are here.
    expect(within(pane).queryByText("git log --oneline")).toBeNull();
    expect(within(pane).queryByText("Command")).toBeNull();
  });

  it.each(["collapsed", "inline"] as const)("folds tools independently of %s thoughts from the run's chip", (thinkingDisplay) => {
    render(
      <AgentActivity
        events={[
          event("child-think", "message.delta", "2026-05-12T15:00:02.000Z", "Weighing options.", {
            parent_tool_use_id: "task-1",
            thinking: true
          }),
          event("child-bash", "command.started", "2026-05-12T15:00:03.000Z", "Bash", {
            id: "child-bash",
            name: "Bash",
            parent_tool_use_id: "task-1",
            input: { command: "git status --short" }
          }),
          event("child-bash-done", "command.completed", "2026-05-12T15:00:04.000Z", "Bash", {
            tool_use_id: "child-bash",
            output: "clean"
          }),
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: { description: "Explore repo", prompt: "Map the repo." }
          })
        ]}
        parentSession={{ ...session, state: "complete" }}
        parentToolUseId="task-1"
        workspace={workspace}
        thinkingDisplay={thinkingDisplay}
      />
    );

    const pane = screen.getByRole("region", { name: "Agent activity: Explore repo" });
    const chip = within(pane).getByRole("button", { name: /^Worked/ });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(within(pane).getByRole("button", { name: "Ran git status --short" })).toBeInTheDocument();
    expect(within(pane).queryByText("clean")).toBeNull();
    if (thinkingDisplay === "inline") {
      expect(within(pane).getByText("Weighing options.")).toBeInTheDocument();
      expect(within(pane).queryByRole("button", { name: "Thought" })).not.toBeInTheDocument();
    } else {
      expect(within(pane).queryByText("Weighing options.")).toBeNull();
    }

    fireEvent.click(chip);

    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(within(pane).getByText("clean")).toBeInTheDocument();
    expect(within(pane).getByText("Weighing options.")).toBeInTheDocument();

    fireEvent.click(chip);

    expect(within(pane).getByRole("button", { name: "Ran git status --short" })).toBeInTheDocument();
    expect(within(pane).queryByText("clean")).toBeNull();
    if (thinkingDisplay === "inline") {
      expect(within(pane).getByText("Weighing options.")).toBeInTheDocument();
    } else {
      expect(within(pane).queryByText("Weighing options.")).toBeNull();
    }
  });

  it("keeps prose and nested agent launches between regular tool runs", () => {
    render(
      <AgentActivity
        events={[
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: { description: "Explore repo", prompt: "Map the repo." }
          }),
          event("read-start", "command.started", "2026-05-12T15:00:02.000Z", "Read", {
            id: "read",
            name: "Read",
            parent_tool_use_id: "task-1",
            input: { file_path: "README.md" }
          }),
          event("read-end", "command.completed", "2026-05-12T15:00:02.500Z", "tool_result", {
            tool_use_id: "read",
            content: "readme"
          }),
          event("note", "message.completed", "2026-05-12T15:00:03.000Z", "Checked the first file.", {
            parent_tool_use_id: "task-1"
          }),
          event("nested-start", "command.started", "2026-05-12T15:00:04.000Z", "Task", {
            id: "nested-task",
            name: "Task",
            parent_tool_use_id: "task-1",
            input: { description: "Nested audit", prompt: "Audit the result." }
          }),
          event("nested-end", "command.completed", "2026-05-12T15:00:04.500Z", "tool_result", {
            tool_use_id: "nested-task",
            content: "done"
          }),
          event("bash-start", "command.started", "2026-05-12T15:00:05.000Z", "Bash", {
            id: "bash",
            name: "Bash",
            parent_tool_use_id: "task-1",
            input: { command: "git status --short" }
          }),
          event("bash-end", "command.completed", "2026-05-12T15:00:05.500Z", "tool_result", {
            tool_use_id: "bash",
            content: ""
          }),
          event("task-end", "command.completed", "2026-05-12T15:00:06.000Z", "tool_result", {
            tool_use_id: "task-1",
            content: "Mapped the repo."
          })
        ]}
        onOpenAgent={vi.fn()}
        parentSession={{ ...session, state: "complete" }}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    const pane = screen.getByRole("region", { name: "Agent activity: Explore repo" });
    const read = within(pane).getByRole("button", { name: "Read README.md" });
    const note = within(pane).getByText("Checked the first file.");
    const nestedAgent = within(pane).getByRole("button", { name: "Started agent Nested audit" });
    const command = within(pane).getByText("git status --short");
    expect(read.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(note.compareDocumentPosition(nestedAgent) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(nestedAgent.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(within(pane).queryByRole("button", { name: /Read a file, started an agent|started an agent, ran/ }))
      .toBeNull();
  });

  it("keeps a Compact nested launch out of the summaries the routine work folds into", () => {
    render(
      <AgentActivity
        events={[
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: { description: "Explore repo", prompt: "Map the repo." }
          }),
          event("read-start", "command.started", "2026-05-12T15:00:02.000Z", "Read", {
            id: "read",
            name: "Read",
            parent_tool_use_id: "task-1",
            input: { file_path: "README.md" }
          }),
          event("read-end", "command.completed", "2026-05-12T15:00:03.000Z", "tool_result", {
            tool_use_id: "read",
            content: "readme"
          }),
          event("nested-start", "command.started", "2026-05-12T15:00:04.000Z", "Task", {
            id: "nested-task",
            name: "Task",
            parent_tool_use_id: "task-1",
            input: { description: "Nested audit", prompt: "Audit the result." }
          }),
          event("nested-end", "command.completed", "2026-05-12T15:00:05.000Z", "tool_result", {
            tool_use_id: "nested-task",
            content: "done"
          }),
          event("bash-start", "command.started", "2026-05-12T15:00:06.000Z", "Bash", {
            id: "bash",
            name: "Bash",
            parent_tool_use_id: "task-1",
            input: { command: "git status --short" }
          }),
          event("bash-end", "command.completed", "2026-05-12T15:00:07.000Z", "tool_result", {
            tool_use_id: "bash",
            content: ""
          }),
          event("task-done", "command.completed", "2026-05-12T15:00:08.000Z", "tool_result", {
            tool_use_id: "task-1",
            content: "The audit is complete."
          })
        ]}
        defaultToolCallsDisplay="collapsed"
        defaultToolCallGroupsExpanded={false}
        onOpenAgent={vi.fn()}
        parentSession={{ ...session, state: "complete" }}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    const pane = screen.getByRole("region", { name: "Agent activity: Explore repo" });
    const readGroup = within(pane).getByRole("button", { name: "Read a file" });
    const agent = within(pane).getByRole("button", { name: "Started agent Nested audit" });
    const commandGroup = within(pane).getByRole("button", { name: "Ran a command" });
    expect(within(pane).queryByRole("button", { name: "Read README.md" })).toBeNull();
    expect(within(pane).queryByText("git status --short")).toBeNull();
    expect(readGroup.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(agent.compareDocumentPosition(commandGroup) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    fireEvent.click(readGroup);
    expect(within(pane).getByRole("button", { name: "Read README.md" })).toBeInTheDocument();
  });

  it("keeps a finished run to one chip and its result at minimal verbosity", () => {
    render(
      <AgentActivity
        events={[
          event("child-narration", "message.completed", "2026-05-12T15:00:02.000Z", "Reading the repo now.", {
            parent_tool_use_id: "task-1"
          }),
          event("child-bash", "command.started", "2026-05-12T15:00:03.000Z", "Bash", {
            id: "child-bash",
            name: "Bash",
            parent_tool_use_id: "task-1",
            input: { command: "git status --short" }
          }),
          event("child-bash-done", "command.completed", "2026-05-12T15:00:04.000Z", "Bash", {
            tool_use_id: "child-bash",
            output: "clean"
          }),
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: { description: "Explore repo", prompt: "Map the repo." }
          }),
          event("task-done", "command.completed", "2026-05-12T15:00:05.000Z", "Task", {
            tool_use_id: "task-1",
            output: "The repo has one crate."
          })
        ]}
        defaultToolCallsDisplay="single-line"
        onOpenAgent={vi.fn()}
        parentSession={{ ...session, state: "complete" }}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    const pane = screen.getByRole("region", { name: "Agent activity: Explore repo" });
    expect(within(pane).getByRole("button", { name: /^Worked/ })).toBeInTheDocument();
    // The work and the prose that narrated it are behind the chip; the result
    // is what a finished run is read for.
    expect(within(pane).queryByRole("button", { name: "Ran git status --short" })).toBeNull();
    expect(within(pane).queryByText("Reading the repo now.")).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Agent result" })).getByText("The repo has one crate.")
    ).toBeInTheDocument();
  });

  it.each([
    ["Minimal", "single-line"],
    ["Compact", "collapsed"]
  ] as const)("keeps a failed nested agent visible in a finished %s run", (_label, defaultToolCallsDisplay) => {
    render(
      <AgentActivity
        events={[
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: { description: "Explore repo", prompt: "Map the repo." }
          }),
          event("nested-start", "command.started", "2026-05-12T15:00:02.000Z", "Task", {
            id: "nested-task",
            name: "Task",
            parent_tool_use_id: "task-1",
            input: { description: "Nested audit", prompt: "Audit the result." }
          }),
          event("nested-end", "command.completed", "2026-05-12T15:00:03.000Z", "tool_result", {
            tool_use_id: "nested-task",
            content: "The nested agent could not start.",
            is_error: true
          }),
          event("task-done", "command.completed", "2026-05-12T15:00:04.000Z", "tool_result", {
            tool_use_id: "task-1",
            content: "The nested audit failed."
          })
        ]}
        defaultToolCallsDisplay={defaultToolCallsDisplay}
        defaultToolCallGroupsExpanded={false}
        onOpenAgent={vi.fn()}
        parentSession={{ ...session, state: "complete" }}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    const pane = screen.getByRole("region", { name: "Agent activity: Explore repo" });
    const nestedAgent = within(pane).getByRole("button", { name: "Started agent Nested audit" });
    expect(nestedAgent.closest("[data-status]")).toHaveAttribute("data-status", "error");
    expect(within(pane).queryByText("The nested agent could not start.")).toBeNull();
    // The row itself opens the nested run in its own tab, so the failure text
    // is behind the disclosure beside it.
    fireEvent.click(
      within(pane).getByRole("button", { name: "Toggle details for Started agent Nested audit" })
    );
    expect(within(pane).getByText("The nested agent could not start.")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Agent result" })).getByText("The nested audit failed.")
    ).toBeInTheDocument();
  });

  it("names the agent in the region label so the panel's tab and body agree", () => {
    render(
      <AgentActivity
        events={[
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: { description: "Explore repo", prompt: "Map the repo." }
          })
        ]}
        codename="Curie"
        parentSession={session}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    expect(
      screen.getByRole("region", { name: "Agent activity: Curie — Explore repo" })
    ).toBeInTheDocument();
  });

  it("labels the region without a codename when none is assigned", () => {
    render(
      <AgentActivity
        events={[
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: { description: "Explore repo", prompt: "Map the repo." }
          })
        ]}
        parentSession={session}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    expect(screen.getByRole("region", { name: "Agent activity: Explore repo" })).toBeInTheDocument();
  });

  it("keeps the agent role on the instructions line", () => {
    render(
      <AgentActivity
        events={[
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: {
              description: "Explore repo",
              prompt: "Map the repo.",
              subagent_type: "implementer",
              model: "claude-opus-5",
              reasoning_effort: "xhigh"
            }
          })
        ]}
        parentSession={session}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    const details = screen.getByLabelText("Agent details");
    expect(details).toHaveTextContent(/Implementer\s*·\s*Opus 5\s*·\s*Extra High/);
    const instructions = screen.getByRole("region", { name: "Agent instructions" });
    expect(within(instructions).queryByText(/Opus 5/)).toBeNull();
  });

  it("opens a finished run's changed file in the Changes view", () => {
    const onOpenDiff = vi.fn();
    render(
      <AgentActivity
        events={[
          event("task-start", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
            id: "task-1",
            name: "Task",
            input: { description: "Edit app", prompt: "Update the app." }
          }),
          event("child-edit", "command.started", "2026-05-12T15:00:02.000Z", "Edit", {
            id: "child-edit",
            name: "Edit",
            parent_tool_use_id: "task-1",
            input: {
              file_path: "/tmp/repo/src/app.ts",
              old_string: "old",
              new_string: "new"
            }
          }),
          event("child-edit-done", "command.completed", "2026-05-12T15:00:03.000Z", "Edit", {
            tool_use_id: "child-edit"
          }),
          event("task-done", "command.completed", "2026-05-12T15:00:04.000Z", "Task", {
            tool_use_id: "task-1",
            output: "Updated the app."
          })
        ]}
        onOpenDiff={onOpenDiff}
        parentSession={{ ...session, state: "complete" }}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edited src/app.ts" }));

    expect(onOpenDiff).toHaveBeenCalledWith("src/app.ts");
  });
});
