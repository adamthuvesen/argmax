import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { DashboardSnapshot } from "../shared/types.js";
import {
  dashboardDeltaListener,
  listChangedFiles,
  listWorkspaceFiles,
  sessionEventsSince,
  setupAppTestMocks,
  snapshot
} from "../test/appTestHarness.js";

describe("App workspace follow", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  beforeEach(() => {
    setupAppTestMocks();
  });

  it("updates the workspace card and composer when the selected workspace branch changes via delta", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });

    const updatedWorkspace: DashboardSnapshot["workspaces"][number] = {
      ...snapshot.workspaces[0],
      branch: "adam/updated-checkout"
    };

    await act(async () => {
      dashboardDeltaListener?.({ workspaces: [updatedWorkspace] });
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("button", { name: "Copy branch name adam/updated-checkout" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Workspace details: branch adam/updated-checkout"
      })
    ).toBeInTheDocument();
  });

  it("follows a session move to the destination workspace and routes actions to the destination ids", async () => {
    const viewOrCreatePr = vi
      .spyOn(window.argmax!.git, "viewOrCreatePr")
      .mockResolvedValue({ action: "opened", url: "https://x", prNumber: 1 });
    listChangedFiles.mockResolvedValue([
      { path: "src/renderer/App.tsx", status: "M", additions: 1, deletions: 0, staged: false }
    ]);
    listWorkspaceFiles.mockResolvedValue([{ path: "src/renderer/App.tsx" }]);
    sessionEventsSince.mockImplementation((input) => {
      if (input.sessionId === "session-moved") {
        return Promise.resolve({
          events: [],
          rawOutputs: [],
          eventCursor: 0,
          rawOutputCursor: 0,
          changeCursor: null,
          deletedEventIds: [],
          deletedRawOutputIds: [],
          resetRequired: false,
          hasMore: false
        });
      }
      return Promise.resolve({
        events: snapshot.events,
        rawOutputs: [],
        eventCursor: 1,
        rawOutputCursor: 0,
        changeCursor: null,
        deletedEventIds: [],
        deletedRawOutputIds: [],
        resetRequired: false,
        hasMore: false
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Build dashboard/ }));
    await screen.findByText("Dashboard ready.");

    const movedWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-moved",
      projectId: "project-1",
      taskLabel: "Build dashboard",
      branch: "adam/feature-branch",
      baseRef: "main",
      path: "/tmp/argmax-attached",
      state: "complete",
      sharedWorkspace: true,
      kind: "git",
      dirty: true,
      changedFiles: 1,
      lastActivityAt: "2026-05-08T16:00:00.000Z",
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
    const movedSession: DashboardSnapshot["sessions"][number] = {
      id: "session-moved",
      workspaceId: movedWorkspace.id,
      provider: "codex",
      modelLabel: "GPT-5.6 Terra",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "Build dashboard",
      state: "complete",
      attention: "normal",
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: "2026-05-08T16:00:00.000Z",
      lastActivityAt: "2026-05-08T16:00:00.000Z",
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 0,
      imported: false,
      launchKind: "agent"
    };

    await act(async () => {
      dashboardDeltaListener?.({
        workspaces: [movedWorkspace],
        sessions: [movedSession],
        events: [
          {
            id: "move-destination",
            sessionId: movedSession.id,
            type: "session.moved",
            message: "Moved to another Argmax checkout.",
            payload: {
              direction: "destination",
              sourceSessionId: "session-1",
              sourceWorkspaceId: "workspace-1",
              sourceProjectName: "Argmax",
              destinationSessionId: movedSession.id,
              destinationWorkspaceId: movedWorkspace.id,
              destinationProjectName: "Argmax",
              destinationPath: movedWorkspace.path,
              checkoutMode: "attached"
            },
            createdAt: "2026-05-08T16:00:00.000Z"
          }
        ]
      });
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("status", {
        name: "Moved to argmax-attached, existing checkout"
      })
    ).toBeInTheDocument();

    expect(
      await screen.findByRole("button", { name: "Copy branch name adam/feature-branch" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Workspace details: branch adam/feature-branch, 1 file changed"
      })
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        sessionEventsSince.mock.calls.some(([input]) => input.sessionId === "session-moved")
      ).toBe(true);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Files" }));

    await waitFor(() =>
      expect(listWorkspaceFiles).toHaveBeenCalledWith({ kind: "workspace", id: "workspace-moved" })
    );

    await waitFor(() =>
      expect(listChangedFiles).toHaveBeenCalledWith(
        { kind: "workspace", id: "workspace-moved" },
        "branch"
      )
    );

    fireEvent.click(await screen.findByRole("button", { name: "Create pull request" }));
    await waitFor(() =>
      expect(viewOrCreatePr).toHaveBeenCalledWith({ sessionId: "session-moved" })
    );
  });
});
