import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventType, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import { AgentActivity } from "./AgentActivity.js";

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
  kind: "git",
  dirty: false,
  changedFiles: 0,
  lastActivityAt: "2026-05-12T15:00:02.000Z",
  pinned: false,
  priorityDismissedAt: null,
  priorityAddedAt: null
};

describe("AgentActivity", () => {
  afterEach(() => {
    cleanup();
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
    expect(within(pane).getByRole("button", { name: /Ran 2 commands/ })).toBeInTheDocument();
    // Collapsed: neither the per-tool rows nor their expanded detail are here.
    expect(within(pane).queryByText("git log --oneline")).toBeNull();
    expect(within(pane).queryByText("Command")).toBeNull();
  });

  it("expands every group and thought from the run's own chip", () => {
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
      />
    );

    const pane = screen.getByRole("region", { name: "Agent activity: Explore repo" });
    const chip = within(pane).getByRole("button", { name: /^Worked/ });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(within(pane).queryByText("git status --short")).toBeNull();

    fireEvent.click(chip);

    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(within(pane).getByText("git status --short")).toBeInTheDocument();
    expect(within(pane).getByText("Weighing options.")).toBeInTheDocument();

    fireEvent.click(chip);

    expect(within(pane).queryByText("git status --short")).toBeNull();
    expect(within(pane).queryByText("Weighing options.")).toBeNull();
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
        parentSession={{ ...session, state: "complete" }}
        parentToolUseId="task-1"
        workspace={workspace}
      />
    );

    const pane = screen.getByRole("region", { name: "Agent activity: Explore repo" });
    expect(within(pane).getByRole("button", { name: /^Worked/ })).toBeInTheDocument();
    // The work and the prose that narrated it are behind the chip; the result
    // is what a finished run is read for.
    expect(within(pane).queryByRole("button", { name: /Ran 1 command/ })).toBeNull();
    expect(within(pane).queryByText("Reading the repo now.")).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Agent result" })).getByText("The repo has one crate.")
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

  it("reads the agent and its model as one eyebrow on the instructions line", () => {
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

    const instructions = screen.getByRole("region", { name: "Agent instructions" });
    expect(within(instructions).getByText("implementer · Opus 5").textContent).toBe(
      "implementer · Opus 5 · Extra High"
    );
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
