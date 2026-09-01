import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventType, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import type { SubagentTabsState } from "../hooks/useSubagentTabs.js";
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

function subagents(overrides: Partial<SubagentTabsState> = {}): SubagentTabsState {
  return {
    toolUseIds: [],
    activeToolUseId: null,
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    ...overrides
  };
}

function renderView(state: SubagentTabsState, events: TimelineEvent[]): void {
  render(
    <AgentsView
      events={events}
      parentSession={session}
      subagents={state}
      workspace={workspace}
    />
  );
}

describe("AgentsView", () => {
  afterEach(() => {
    cleanup();
  });

  it("points at the transcript when nothing is open", () => {
    renderView(subagents(), [launch("task-1", "Explore repo")]);

    expect(screen.getByText(/No subagents open/)).toBeInTheDocument();
  });

  it("names each open subagent in the tab strip and shows the active one", () => {
    renderView(
      subagents({ toolUseIds: ["task-1", "task-2"], activeToolUseId: "task-2" }),
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

  it("reads the active subagent's state and model in the status bar", () => {
    renderView(
      subagents({ toolUseIds: ["task-1"], activeToolUseId: "task-1" }),
      [
        launch("task-1", "Explore repo"),
        event("child", "message.completed", "2026-05-12T15:00:02.000Z", "Mapped it.", {
          parent_tool_use_id: "task-1",
          agentModelId: "claude-opus-5",
          agentReasoningEffort: "xhigh"
        })
      ]
    );

    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByTitle("Opus 5 · Extra High reasoning effort")).toHaveTextContent(
      "Opus 5 · Extra High"
    );
  });

  it("closes a subagent from its tab", () => {
    const closeTab = vi.fn();
    renderView(
      subagents({ toolUseIds: ["task-1"], activeToolUseId: "task-1", closeTab }),
      [launch("task-1", "Explore repo")]
    );

    const close = screen.getByRole("button", { name: /^Close / });
    close.click();

    expect(closeTab).toHaveBeenCalledWith("task-1");
  });
});
