import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventType, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import type { AgentTabsState } from "../hooks/useAgentTabs.js";
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
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    // Both stay mounted so each keeps polling; only the active one is shown.
    expect(document.getElementById("review-agent-task-1")).toHaveAttribute("aria-hidden", "true");
    expect(document.getElementById("review-agent-task-2")).not.toHaveAttribute("aria-hidden");
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

  it("closes a subagent from its tab", () => {
    const closeTab = vi.fn();
    renderView(
      agentTabs({ tabIds: ["task-1"], activeTabId: "task-1", closeTab }),
      [launch("task-1", "Explore repo")]
    );

    const close = screen.getByRole("button", { name: /^Close / });
    close.click();

    expect(closeTab).toHaveBeenCalledWith("task-1");
  });
});
