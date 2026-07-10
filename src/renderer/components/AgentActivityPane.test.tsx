import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EventType, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import { AgentActivityPane } from "./AgentActivityPane.js";

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

describe("AgentActivityPane", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps running child tool rows compact instead of flashing expanded details", () => {
    render(
      <AgentActivityPane
        events={[
          event("child-bash", "command.started", "2026-05-12T15:00:02.000Z", "Bash", {
            id: "child-bash",
            name: "Bash",
            parent_tool_use_id: "task-1",
            input: { command: "git status --short" }
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
    const row = within(pane).getByRole("button", { name: "Ran git status --short" });

    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(pane).queryByText("Command")).toBeNull();
  });
});
