import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { DashboardSnapshot } from "../shared/types.js";
import { launcherDraftKey, readDraft } from "./lib/composerDrafts.js";
import {
  mockDashboardSnapshot,
  setupAppTestMocks,
  snapshot,
  terminateProvider
} from "../test/appTestHarness.js";

const childWorkspace: DashboardSnapshot["workspaces"][number] = {
  id: "workspace-multitask",
  projectId: "project-1",
  taskLabel: "Fix the changelog date",
  branch: "argmax/dashboard",
  baseRef: "main",
  path: "/tmp/worktrees/dashboard",
  state: "complete",
  sharedWorkspace: true,
  kind: "git",
  dirty: true,
  changedFiles: 1,
  lastActivityAt: "2026-05-08T15:56:00.000Z",
  pinned: false,
  priorityDismissedAt: null,
  priorityAddedAt: null
};

const childSession: DashboardSnapshot["sessions"][number] = {
  id: "session-multitask",
  workspaceId: "workspace-multitask",
  provider: "codex",
  modelLabel: "GPT-5.6 Terra",
  modelId: "gpt-5.6-terra",
  reasoningEffort: "medium",
  permissionMode: "auto-approve",
  providerConversationId: null,
  prompt: "The changelog says 2025 for the 0.4 entry.",
  state: "complete",
  attention: "normal",
  startedAt: "2026-05-08T15:55:00.000Z",
  completedAt: "2026-05-08T15:56:00.000Z",
  lastActivityAt: "2026-05-08T15:56:00.000Z",
  launchedBySessionId: "session-1",
  launchKind: "multitask"
};

const events: DashboardSnapshot["events"] = [
  {
    id: "child-answer",
    sessionId: "session-multitask",
    type: "message.completed",
    message: "Corrected the 0.4 heading to 2026.",
    payload: {},
    createdAt: "2026-05-08T15:56:00.000Z"
  },
  {
    id: "child-prompt",
    sessionId: "session-multitask",
    type: "user.message",
    message: "The changelog says 2025 for the 0.4 entry.",
    payload: {},
    createdAt: "2026-05-08T15:55:00.000Z"
  },
  {
    id: "multitask-launched",
    sessionId: "session-1",
    type: "multitask.launched",
    message: "Running alongside: Fix the changelog date",
    payload: {
      childSessionId: "session-multitask",
      childWorkspaceId: "workspace-multitask",
      taskLabel: "Fix the changelog date",
      prompt: "The changelog says 2025 for the 0.4 entry.",
      worktree: false
    },
    createdAt: "2026-05-08T15:55:00.000Z"
  },
  {
    id: "parent-prompt",
    sessionId: "session-1",
    type: "user.message",
    message: "Build dashboard",
    payload: {},
    createdAt: "2026-05-08T15:54:00.000Z"
  }
];

function mountWithMultitask(childOverrides: Partial<typeof childSession> = {}): void {
  mockDashboardSnapshot({
    ...snapshot,
    workspaces: [...snapshot.workspaces, childWorkspace],
    sessions: [...snapshot.sessions, { ...childSession, ...childOverrides }],
    events
  });
}

describe("multitask in the chat that dispatched it", () => {
  afterEach(cleanup);
  beforeEach(setupAppTestMocks);

  it("keeps the multitask out of the sidebar", async () => {
    mountWithMultitask();
    render(<App />);

    // The chat that dispatched it is a sidebar row; the multitask is not one of
    // its own — it belongs to that chat, which hosts it in its dock.
    await screen.findByRole("button", { name: "Build dashboard" });
    expect(screen.queryByRole("button", { name: "Fix the changelog date" })).toBeNull();
  });

  it("draws the row inside the turn it was dispatched from", async () => {
    // Not a stray item under the finished turn: it belongs among that turn's
    // tool rows, where a subagent launch sits, because that is what it is to
    // the reader.
    mountWithMultitask();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const row = await screen.findByRole("button", { name: "Open multitask: Fix the changelog date" });

    expect(row.closest(".turn-block-body")).not.toBeNull();
  });

  it("opens the multitask's chat as a tab in the dock, not as another chat", async () => {
    mountWithMultitask();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open multitask: Fix the changelog date" })
    );

    const tablist = await screen.findByRole("tablist", { name: "Subagents and multitasks" });
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Fix the changelog date"
    ]);
    // Its own transcript, in the dock — the parent chat is still the one on the
    // left, and nothing navigated away from it.
    expect(await screen.findByText("Corrected the 0.4 heading to 2026.")).toBeInTheDocument();
  });

  it("stops only the multitask, leaving the chat that dispatched it where it was", async () => {
    // Stopping a chat seconds after launching it reads as "wrong prompt" and
    // hands the pane back to the launcher. A multitask has no pane of its own,
    // so that must not fire for one: the chat it was dispatched from stays on
    // screen, and its launcher draft never picks up the multitask's prompt.
    mountWithMultitask({ state: "running", completedAt: null, startedAt: new Date().toISOString() });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop multitask: Fix the changelog date" })
    );

    await waitFor(() => expect(terminateProvider).toHaveBeenCalledWith("session-multitask"));
    expect(
      await screen.findByRole("button", { name: "Open multitask: Fix the changelog date" })
    ).toBeInTheDocument();
    expect(readDraft(launcherDraftKey("project-1")).text).toBe("");
  });
});
