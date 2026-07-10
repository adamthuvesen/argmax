import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventType, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import type { AgentGridCell } from "../lib/gridState.js";
import { AgentTabsPane } from "./AgentTabsPane.js";

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
  dirty: false,
  changedFiles: 0,
  lastActivityAt: "2026-05-12T15:00:02.000Z",
  pinned: false
};

// task-1 is still running (started, no completion, session running); task-2 has
// completed. Their titles come from the Task description.
const twoTabEvents: TimelineEvent[] = [
  event("task-2-done", "command.completed", "2026-05-12T15:00:03.000Z", "tool_result", {
    tool_use_id: "task-2",
    content: "Done."
  }),
  event("task-2", "command.started", "2026-05-12T15:00:02.000Z", "Task", {
    id: "task-2",
    name: "Task",
    input: { description: "Write tests", prompt: "Add coverage." }
  }),
  event("task-1", "command.started", "2026-05-12T15:00:01.000Z", "Task", {
    id: "task-1",
    name: "Task",
    input: { description: "Map renderer", prompt: "Map the repo." }
  })
];

function twoTabCell(active = "task-1"): AgentGridCell {
  return {
    kind: "agent",
    parentSessionId: "s1",
    workspaceId: "w1",
    parentToolUseIds: ["task-1", "task-2"],
    activeParentToolUseId: active
  };
}

function renderPane(
  cell: AgentGridCell,
  overrides: Partial<{
    onCloseCell: () => void;
    onActivateTab: (id: string) => void;
    onCloseTab: (id: string) => void;
  }> = {}
): { onCloseCell: () => void; onActivateTab: (id: string) => void; onCloseTab: (id: string) => void } {
  const handlers = {
    onCloseCell: overrides.onCloseCell ?? vi.fn(),
    onActivateTab: overrides.onActivateTab ?? vi.fn(),
    onCloseTab: overrides.onCloseTab ?? vi.fn()
  };
  render(
    <AgentTabsPane
      cell={cell}
      events={twoTabEvents}
      parentSession={session}
      workspace={workspace}
      onCloseCell={handlers.onCloseCell}
      onActivateTab={handlers.onActivateTab}
      onCloseTab={handlers.onCloseTab}
    />
  );
  return handlers;
}

describe("AgentTabsPane", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders no tab bar for a single subagent", () => {
    render(
      <AgentTabsPane
        cell={{
          kind: "agent",
          parentSessionId: "s1",
          workspaceId: "w1",
          parentToolUseIds: ["task-1"],
          activeParentToolUseId: "task-1"
        }}
        events={twoTabEvents}
        parentSession={session}
        workspace={workspace}
        onCloseCell={vi.fn()}
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />
    );

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("region", { name: "Agent activity: Triton — Map renderer" })).toBeInTheDocument();
  });

  it("renders a tab per subagent with a codename label, title tooltip, and status", () => {
    renderPane(twoTabCell());

    expect(screen.getByRole("tablist", { name: "Subagent tabs" })).toBeInTheDocument();
    const running = screen.getByRole("tab", { name: "Triton" });
    const done = screen.getByRole("tab", { name: "Tethys" });
    // Each spawn gets a distinct moon-name codename; the task description moves
    // to the hover tooltip.
    expect(running.textContent).not.toBe(done.textContent);
    expect(running).toHaveAttribute("title", "Map renderer");
    expect(done).toHaveAttribute("title", "Write tests");
    // task-1 is still running → spinner; task-2 finished → static dot.
    expect(running.querySelector(".tool-call-spinner")).not.toBeNull();
    expect(done.querySelector(".agent-tab-status-dot")).not.toBeNull();
  });

  it("marks the active tab selected and keeps every panel mounted", () => {
    renderPane(twoTabCell("task-1"));

    expect(screen.getByRole("tab", { name: "Triton" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Tethys" })).toHaveAttribute("aria-selected", "false");

    const active = document.getElementById("agent-tabpanel-task-1");
    const inactive = document.getElementById("agent-tabpanel-task-2");
    expect(active).not.toBeNull();
    expect(inactive).not.toBeNull();
    expect(active).not.toHaveAttribute("aria-hidden");
    expect(inactive).toHaveAttribute("aria-hidden", "true");
  });

  it("uses roving tabindex so only the active tab is in the tab order", () => {
    renderPane(twoTabCell("task-1"));
    expect(screen.getByRole("tab", { name: "Triton" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Tethys" })).toHaveAttribute("tabindex", "-1");
  });

  it("calls onActivateTab when a tab is clicked", () => {
    const onActivateTab = vi.fn();
    renderPane(twoTabCell("task-1"), { onActivateTab });
    fireEvent.click(screen.getByRole("tab", { name: "Tethys" }));
    expect(onActivateTab).toHaveBeenCalledWith("task-2");
  });

  it("moves activation with ArrowRight/ArrowLeft and wraps", () => {
    const onActivateTab = vi.fn();
    renderPane(twoTabCell("task-1"), { onActivateTab });
    const first = screen.getByRole("tab", { name: "Triton" });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onActivateTab).toHaveBeenLastCalledWith("task-2");
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(onActivateTab).toHaveBeenLastCalledWith("task-2");
  });

  it("jumps to first/last with Home and End", () => {
    const onActivateTab = vi.fn();
    renderPane(twoTabCell("task-2"), { onActivateTab });
    const second = screen.getByRole("tab", { name: "Tethys" });
    fireEvent.keyDown(second, { key: "Home" });
    expect(onActivateTab).toHaveBeenLastCalledWith("task-1");
    fireEvent.keyDown(second, { key: "End" });
    expect(onActivateTab).toHaveBeenLastCalledWith("task-2");
  });

  it("closes the focused tab on Delete", () => {
    const onCloseTab = vi.fn();
    renderPane(twoTabCell("task-1"), { onCloseTab });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Triton" }), { key: "Delete" });
    expect(onCloseTab).toHaveBeenCalledWith("task-1");
  });

  it("closes a tab via its × without closing the cell", () => {
    const onCloseTab = vi.fn();
    const onCloseCell = vi.fn();
    renderPane(twoTabCell("task-1"), { onCloseTab, onCloseCell });
    fireEvent.click(screen.getByRole("button", { name: "Close Tethys" }));
    expect(onCloseTab).toHaveBeenCalledWith("task-2");
    expect(onCloseCell).not.toHaveBeenCalled();
  });

  it("closes the whole cell from a pane header X", () => {
    const onCloseCell = vi.fn();
    const onCloseTab = vi.fn();
    renderPane(twoTabCell("task-1"), { onCloseCell, onCloseTab });
    fireEvent.click(screen.getAllByRole("button", { name: "Close pane" })[0]);
    expect(onCloseCell).toHaveBeenCalledTimes(1);
    expect(onCloseTab).not.toHaveBeenCalled();
  });
});
