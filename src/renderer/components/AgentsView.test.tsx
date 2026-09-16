import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventType, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import { useAgentTabs, type AgentTabsState } from "../hooks/useAgentTabs.js";
import { SessionTimelineProvider } from "../hooks/useSessionTimeline.js";
import type { MultitaskChild } from "../lib/multitask.js";
import { SessionTimelines } from "../lib/sessionTimelines.js";
import { AgentsView } from "./AgentsView.js";

function event(
  id: string,
  type: EventType,
  createdAt: string,
  message = id,
  payload: Record<string, unknown> = {}
): TimelineEvent {
  return { id, sessionId: "s1", type, message, payload, createdAt };
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
  prMergedAt: null,
  prCheckState: null,
  prActivityAt: null
};

function launch(id: string, description: string): TimelineEvent {
  return event(`start-${id}`, "command.started", "2026-05-12T15:00:01.000Z", "Task", {
    id,
    name: "Task",
    input: { description, prompt: `Do ${description}.` }
  });
}

function agentTabs(overrides: Partial<AgentTabsState> = {}): AgentTabsState {
  return {
    tabIds: [],
    activeTabId: null,
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    closeAllTabs: vi.fn(),
    replaceTab: vi.fn(),
    ...overrides
  };
}

function renderView(
  state: AgentTabsState,
  events: TimelineEvent[],
  multitasks?: MultitaskChild[]
): void {
  render(
    <AgentsView
      events={events}
      parentSession={session}
      agentTabs={state}
      multitasks={multitasks}
      workspace={workspace}
    />
  );
}

describe("AgentsView", () => {
  it("discovers existing and later agents without a transcript click and preserves selection", () => {
    function Dock({ events }: { events: TimelineEvent[] }) {
      const tabs = useAgentTabs();
      return <AgentsView events={events} parentSession={session} workspace={workspace}
        agentTabs={tabs} onDiscoverTabs={tabs.openTabs} />;
    }
    const events = [launch("a", "Explore"), launch("b", "Review")];
    const { rerender } = render(<Dock events={[]} />);
    rerender(<Dock events={events} />);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    const selected = screen.getAllByRole("tab")[1];
    fireEvent.click(selected);

    const moreEvents = [...events, launch("c", "Implement")];
    rerender(<Dock events={moreEvents} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(selected).toHaveAttribute("aria-selected", "true");
  });

  it("upgrades a provisional Claude tab without changing the selected agent", () => {
    const replaceTab = vi.fn();
    renderView(
      agentTabs({ tabIds: ["task-root"], activeTabId: "task-root", replaceTab }),
      [
        event("native-start", "agent.started", "2026-05-12T15:00:02.000Z", "Agent started", {
          providerInvocationId: "invocation-1",
          providerChildSessionId: "child-native",
          providerParentConversationId: "parent-native",
          agentRootToolUseId: "task-root",
          agentRunId: "task-root"
        }),
        event("task", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
          id: "task-root", name: "Task", providerInvocationId: "invocation-1",
          input: { description: "Explore repo" }
        })
      ]
    );

    expect(replaceTab).toHaveBeenCalledWith(
      "task-root",
      "native-agent:task-root:parent-native:child-native"
    );
  });

  it("upgrades a provisional identity in place and keeps a reused raw id distinct", () => {
    function Dock({ events }: { events: TimelineEvent[] }) {
      const tabs = useAgentTabs();
      return <AgentsView events={events} parentSession={session} workspace={workspace}
        agentTabs={tabs} onDiscoverTabs={tabs.openTabs} />;
    }
    const start = event("task", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
      id: "task-root", name: "Task", providerInvocationId: "invocation-1",
      input: { description: "Explore repo" }
    });
    const { rerender } = render(<Dock events={[start]} />);
    const native = event("native-start", "agent.started", "2026-05-12T15:00:02.000Z", "Agent started", {
      providerInvocationId: "invocation-1", providerChildSessionId: "child-native",
      providerParentConversationId: "parent-native", agentRootToolUseId: "task-root", agentRunId: "task-root"
    });
    rerender(<Dock events={[native, start]} />);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(document.getElementById("review-agent-native-agent:task-root:parent-native:child-native")).not.toBeNull();

    rerender(<Dock events={[
      event("second-start", "agent.started", "2026-05-12T15:00:04.000Z", "Agent started", {
        providerInvocationId: "invocation-2", providerChildSessionId: "child-second",
        providerParentConversationId: "parent-native", agentRootToolUseId: "task-root", agentRunId: "task-root"
      }),
      event("second-task", "command.started", "2026-05-12T15:00:03.000Z", "Task", {
        id: "task-root", name: "Task", providerInvocationId: "invocation-2",
        input: { description: "Review repo" }
      }), native, start
    ]} />);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Explore repo" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Khwarizmi" }));
    expect(screen.getByRole("heading", { name: "Review repo" })).toBeInTheDocument();
  });

  it("keeps two native children with the same raw Task id in distinct panes", () => {
    const firstTab = "native-agent:task-reused:parent-native:child-a";
    const secondTab = "native-agent:task-reused:parent-native:child-b";
    renderView(agentTabs({ tabIds: [firstTab, secondTab], activeTabId: firstTab }), [
      event("b-done", "agent.completed", "2026-05-12T15:01:03.000Z", "Child B answer", {
        providerInvocationId: "invocation-b", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-b", agentRootToolUseId: "task-reused",
        agentRunId: "task-reused", status: "completed", agentCodename: "Curie"
      }),
      event("b-start", "agent.started", "2026-05-12T15:01:01.000Z", "Agent started", {
        providerInvocationId: "invocation-b", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-b", agentRootToolUseId: "task-reused",
        agentRunId: "task-reused", status: "running", agentCodename: "Curie"
      }),
      event("a-done", "agent.completed", "2026-05-12T15:00:03.000Z", "Child A answer", {
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-a", agentRootToolUseId: "task-reused",
        agentRunId: "task-reused", status: "completed", agentCodename: "Turing"
      }),
      event("a-start", "agent.started", "2026-05-12T15:00:01.000Z", "Agent started", {
        providerInvocationId: "invocation-a", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-a", agentRootToolUseId: "task-reused",
        agentRunId: "task-reused", status: "running", agentCodename: "Turing"
      })
    ]);

    const firstPane = document.getElementById(`review-agent-${firstTab}`);
    const secondPane = document.getElementById(`review-agent-${secondTab}`);
    expect(firstPane).not.toBeNull();
    expect(secondPane).not.toBeNull();
    expect(within(firstPane as HTMLElement).getByText("Child A answer")).toBeInTheDocument();
    expect(within(firstPane as HTMLElement).queryByText("Child B answer")).toBeNull();
    expect(within(secondPane as HTMLElement).getByText("Child B answer")).toBeInTheDocument();
    expect(within(secondPane as HTMLElement).queryByText("Child A answer")).toBeNull();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls only the shown subagent and reloads a tab the moment it is shown", async () => {
    vi.useFakeTimers();
    const onLoadAgentEvents = vi.fn(() => Promise.resolve());
    const events = [launch("task-1", "Explore repo"), launch("task-2", "Write tests")];
    const dock = (activeTabId: string) => (
      <AgentsView
        events={events}
        parentSession={session}
        agentTabs={agentTabs({ tabIds: ["task-1", "task-2"], activeTabId })}
        workspace={workspace}
        onLoadAgentEvents={onLoadAgentEvents}
      />
    );
    const loadsFor = (toolUseId: string): number =>
      onLoadAgentEvents.mock.calls.filter((call: unknown[]) => call[1] === toolUseId).length;
    const settle = async (): Promise<void> => {
      await act(async () => {
        await Promise.resolve();
      });
    };

    const { rerender } = render(dock("task-2"));
    await settle();
    // Every pane still loads once on mount.
    expect(loadsFor("task-1")).toBe(1);
    expect(loadsFor("task-2")).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500 * 3);
    });
    expect(loadsFor("task-1")).toBe(1);
    expect(loadsFor("task-2")).toBe(4);

    // Shown again: no wait for the next tick.
    rerender(dock("task-1"));
    await settle();
    expect(loadsFor("task-1")).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(loadsFor("task-1")).toBe(3);
    expect(loadsFor("task-2")).toBe(4);
  });

  it("reloads a subagent that finished while its tab was hidden", async () => {
    const onLoadAgentEvents = vi.fn(() => Promise.resolve());
    const events = [launch("task-1", "Explore repo"), launch("task-2", "Write tests")];
    const dock = (activeTabId: string, parentSession: SessionSummary) => (
      <AgentsView
        events={events}
        parentSession={parentSession}
        agentTabs={agentTabs({ tabIds: ["task-1", "task-2"], activeTabId })}
        workspace={workspace}
        onLoadAgentEvents={onLoadAgentEvents}
      />
    );
    const loadsFor = (toolUseId: string): number =>
      onLoadAgentEvents.mock.calls.filter((call: unknown[]) => call[1] === toolUseId).length;
    const completed: SessionSummary = { ...session, state: "complete" };

    const { rerender } = render(dock("task-2", session));
    await act(async () => {
      await Promise.resolve();
    });
    rerender(dock("task-2", completed));
    expect(loadsFor("task-1")).toBe(1);

    // Nothing polls a finished run, but its last trace may never have loaded.
    rerender(dock("task-1", completed));
    expect(loadsFor("task-1")).toBe(2);

    // A tab that never missed a live poll does not reload on every switch.
    await act(async () => {
      await Promise.resolve();
    });
    rerender(dock("task-2", completed));
    rerender(dock("task-1", completed));
    expect(loadsFor("task-1")).toBe(2);
  });

  it("points at the transcript when nothing is open", () => {
    renderView(agentTabs(), [launch("task-1", "Explore repo")]);

    expect(screen.getByText(/Nothing open here/)).toBeInTheDocument();
  });

  it("names each open subagent in the tab strip and shows the active one", () => {
    renderView(
      agentTabs({ tabIds: ["task-1", "task-2"], activeTabId: "task-2" }),
      [launch("task-1", "Explore repo"), launch("task-2", "Write tests")]
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    // The newer launch sits leftmost.
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    // Both stay mounted so switching back is instant; only the active one is shown.
    expect(document.getElementById("review-agent-task-1")).toHaveAttribute("aria-hidden", "true");
    expect(document.getElementById("review-agent-task-2")).not.toHaveAttribute("aria-hidden");
  });

  it("puts running subagents first and the newest launch leftmost", () => {
    const finished = (id: string) => event(`done-${id}`, "command.completed", "2026-05-12T15:00:05.000Z", "Task", {
      id, name: "Task", status: "completed"
    });
    renderView(
      agentTabs({ tabIds: ["task-1", "task-2", "task-3", "task-4"], activeTabId: "task-1" }),
      [
        launch("task-1", "Explore repo"), finished("task-1"),
        launch("task-2", "Write tests"),
        launch("task-3", "Review diff"), finished("task-3"),
        launch("task-4", "Fix lint")
      ]
    );

    // The selected completed agent stays available; the other completed agent
    // moves into the roster. Running work follows the selection.
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("title")))
      .toEqual(["Explore repo", "Fix lint", "Write tests"]);
  });

  it("moves the same native child back to running for a follow-up assignment", () => {
    const tabId = "native-agent:spawn:parent-native:child-native";
    renderView(agentTabs({ tabIds: [tabId], activeTabId: tabId }), [
      event("spawn", "command.started", "2026-05-12T15:00:00.000Z", "spawn_agent", {
        id: "spawn", name: "spawn_agent", providerInvocationId: "invoke-1",
        input: { description: "Initial review" }
      }),
      event("first-start", "agent.started", "2026-05-12T15:00:01.000Z", "Agent started", {
        providerInvocationId: "invoke-1", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-native", agentRootToolUseId: "spawn", agentRunId: "spawn"
      }),
      event("first-done", "agent.completed", "2026-05-12T15:00:02.000Z", "Initial result", {
        providerInvocationId: "invoke-1", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-native", agentRootToolUseId: "spawn", agentRunId: "spawn",
        status: "completed"
      }),
      event("follow-up", "command.started", "2026-05-12T15:01:00.000Z", "send_input", {
        id: "follow-up", name: "send_input", providerInvocationId: "invoke-2",
        input: { prompt: "Check the fix" }
      }),
      event("second-start", "agent.started", "2026-05-12T15:01:01.000Z", "Agent started", {
        providerInvocationId: "invoke-2", providerParentConversationId: "parent-native",
        providerChildSessionId: "child-native", agentRootToolUseId: "spawn", agentRunId: "follow-up",
        description: "Check the fix"
      })
    ]);

    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab")).toHaveAttribute("title", "Check the fix");
    fireEvent.click(screen.getByRole("button", { name: "All agents 1" }));
    expect(screen.getByRole("listbox", { name: "All agents" })).toHaveTextContent("Running1");
  });

  it("caps the active strip and exposes excess running agents through the roster", () => {
    const events = Array.from({ length: 6 }, (_, index) => launch(`task-${index + 1}`, `Task ${index + 1}`));
    renderView(agentTabs({
      tabIds: events.map((_, index) => `task-${index + 1}`),
      activeTabId: "task-1"
    }), events);

    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "+2 active" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All agents 6" })).toBeInTheDocument();
  });

  it("names the active subagent, its role, and its model in the pane header", () => {
    renderView(
      agentTabs({ tabIds: ["task-1"], activeTabId: "task-1" }),
      [
        launch("task-1", "Explore repo"),
        event("child", "message.completed", "2026-05-12T15:00:02.000Z", "Mapped it.", {
          parent_tool_use_id: "task-1",
          agentModelId: "claude-opus-5",
          agentReasoningEffort: "xhigh"
        })
      ]
    );

    expect(screen.getByRole("heading", { name: "Explore repo" })).toBeInTheDocument();
    const details = screen.getByLabelText("Agent details");
    expect(details).toHaveTextContent(/Gauss\s*·\s*Opus 5\s*·\s*Extra High/);
    expect(screen.queryByRole("status", { name: "Agent model" })).toBeNull();
  });

  it("reads a multitask transcript from the child session timeline", () => {
    const child: MultitaskChild = {
      session: {
        ...session,
        id: "child-1",
        workspaceId: "child-workspace",
        launchKind: "multitask",
        launchedBySessionId: session.id,
        prompt: "Review the implementation"
      },
      workspace
    };
    const timelines = new SessionTimelines();
    timelines.merge(
      [
        {
          ...event("child-answer", "message.completed", "2026-05-12T15:00:03.000Z", "Child result"),
          sessionId: child.session.id
        },
        event("parent-answer", "message.completed", "2026-05-12T15:00:02.000Z", "Parent result")
      ],
      []
    );

    render(
      <SessionTimelineProvider store={timelines}>
        <AgentsView
          events={[]}
          parentSession={session}
          agentTabs={agentTabs({
            tabIds: ["multitask:child-1"],
            activeTabId: "multitask:child-1"
          })}
          multitasks={[child]}
          workspace={workspace}
        />
      </SessionTimelineProvider>
    );

    expect(screen.getByText("Child result")).toBeInTheDocument();
    expect(screen.queryByText("Parent result")).not.toBeInTheDocument();
  });

  it("forwards Minimal verbosity to a multitask transcript", () => {
    const child: MultitaskChild = {
      session: {
        ...session,
        id: "child-1",
        workspaceId: "child-workspace",
        state: "complete",
        completedAt: "2026-05-12T15:00:04.000Z",
        lastActivityAt: "2026-05-12T15:00:04.000Z",
        launchKind: "multitask",
        launchedBySessionId: session.id,
        prompt: "Review the implementation"
      },
      workspace
    };
    const childEvent = (eventValue: TimelineEvent): TimelineEvent => ({
      ...eventValue,
      sessionId: child.session.id
    });
    const timelines = new SessionTimelines();
    timelines.merge(
      [
        childEvent(event("child-answer", "message.completed", "2026-05-12T15:00:04.000Z", "Child result")),
        childEvent(event("command-2-done", "command.completed", "2026-05-12T15:00:03.000Z", "tool_result", {
          tool_use_id: "command-2",
          content: "ok"
        })),
        childEvent(event("command-2-start", "command.started", "2026-05-12T15:00:02.000Z", "Bash", {
          id: "command-2",
          name: "Bash",
          input: { command: "echo two" }
        })),
        childEvent(event("command-1-done", "command.completed", "2026-05-12T15:00:01.000Z", "tool_result", {
          tool_use_id: "command-1",
          content: "ok"
        })),
        childEvent(event("command-1-start", "command.started", "2026-05-12T15:00:00.000Z", "Bash", {
          id: "command-1",
          name: "Bash",
          input: { command: "echo one" }
        }))
      ],
      []
    );

    render(
      <SessionTimelineProvider store={timelines}>
        <AgentsView
          defaultToolCallsDisplay="single-line"
          defaultToolCallGroupsExpanded={false}
          thinkingDisplay="collapsed"
          events={[]}
          parentSession={session}
          agentTabs={agentTabs({
            tabIds: ["multitask:child-1"],
            activeTabId: "multitask:child-1"
          })}
          multitasks={[child]}
          workspace={workspace}
        />
      </SessionTimelineProvider>
    );

    expect(screen.getByText("Child result")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ran commands" })).toBeNull();
  });

  it("opens a completed agent from the grouped roster", () => {
    const selectTab = vi.fn();
    renderView(
      agentTabs({ tabIds: ["task-1", "task-2"], activeTabId: "task-2", selectTab }),
      [
        launch("task-1", "Explore repo"),
        event("done-task-1", "command.completed", "2026-05-12T15:00:02.000Z", "Task", {
          id: "task-1", name: "Task", status: "completed"
        }),
        launch("task-2", "Write tests")
      ]
    );

    expect(screen.getAllByRole("tab")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "All agents 2" }));
    const roster = screen.getByRole("listbox", { name: "All agents" });
    expect(within(roster).getByText("Running")).toBeInTheDocument();
    expect(within(roster).getByText("Completed")).toBeInTheDocument();
    fireEvent.click(within(roster).getByRole("button", { name: /Explore repo/ }));

    expect(selectTab).toHaveBeenCalledWith("task-1");
  });
});
