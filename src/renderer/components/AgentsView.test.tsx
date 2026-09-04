import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventType, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import type { AgentTabsState } from "../hooks/useAgentTabs.js";
import type { MultitaskChild } from "../lib/multitask.js";
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
  lastActivityAt: "2026-05-12T15:00:02.000Z"
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
  priorityAddedAt: null
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

  it("shows the subagent model and effort in the dock metadata strip", () => {
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

    expect(screen.getByRole("status", { name: "Agent model" })).toHaveTextContent(/Opus 5\s*·\s*Extra High/);
    expect(screen.getByRole("region", { name: "Agent instructions" })).not.toHaveTextContent("Opus 5");
  });

  it("shows the active multitask model and effort in the same strip", () => {
    const child: MultitaskChild = {
      session: {
        ...session,
        id: "child-1",
        workspaceId: "child-workspace",
        modelLabel: "Sonnet 5",
        modelId: "claude-sonnet-5",
        reasoningEffort: "high",
        launchKind: "multitask",
        launchedBySessionId: session.id,
        prompt: "Review the implementation"
      },
      workspace
    };

    renderView(
      agentTabs({ tabIds: ["multitask:child-1"], activeTabId: "multitask:child-1" }),
      [],
      [child]
    );

    expect(screen.getByRole("status", { name: "Agent model" })).toHaveTextContent(/Sonnet 5\s*·\s*High/);
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
