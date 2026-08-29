import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "../../shared/types.js";
import type { RemoteConnectionState } from "../lib/wsTransport.js";
import {
  createCurrentWorkspace,
  createIsolatedWorkspace,
  launchProvider,
  listChangedFiles,
  listWorkspaceFiles,
  loadDiff,
  mockDashboardSnapshot,
  readWorkspaceFile,
  setPriorityDismissed,
  setupAppTestMocks,
  snapshot,
  workspaceStatus
} from "../../test/appTestHarness.js";
import { MobileApp } from "./MobileApp.js";

// The remote transport is a page singleton the component only observes, so the
// test drives its state directly instead of standing up a socket.
const remote = vi.hoisted(() => {
  const listeners = new Set<(state: RemoteConnectionState) => void>();
  let state: RemoteConnectionState = { status: "connected", resync: false };
  return {
    listeners,
    reset: () => {
      listeners.clear();
      state = { status: "connected", resync: false };
    },
    publish: (next: RemoteConnectionState) => {
      state = next;
      for (const listener of [...listeners]) listener(next);
    },
    subscribe: (listener: (next: RemoteConnectionState) => void) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    }
  };
});

vi.mock("../lib/wsTransport.js", () => ({
  createWsTransport: vi.fn(),
  subscribeRemoteConnection: remote.subscribe
}));

describe("MobileApp", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    remote.reset();
    setupAppTestMocks();
  });

  it("lists sessions with project subtitle and running marker", async () => {
    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "All sessions" });
    const row = within(section).getByRole("button", { name: /Build dashboard/ });
    expect(row).toHaveTextContent("Argmax");
    expect(within(row).getByLabelText("running")).toBeInTheDocument();
  });

  it("keeps one activity-sorted list with attention chips, pinned rows on top", async () => {
    const withApproval: DashboardSnapshot = {
      ...snapshot,
      workspaces: [
        ...snapshot.workspaces,
        {
          ...snapshot.workspaces[0],
          id: "workspace-2",
          taskLabel: "Fix flaky tests",
          state: "running"
        },
        {
          ...snapshot.workspaces[0],
          id: "workspace-3",
          taskLabel: "Keep this handy",
          state: "running",
          pinned: true
        }
      ],
      sessions: [
        ...snapshot.sessions,
        {
          ...snapshot.sessions[0],
          id: "session-2",
          workspaceId: "workspace-2",
          state: "blocked",
          attention: "approval-needed",
          attentionChangedAt: new Date().toISOString()
        }
      ]
    };
    mockDashboardSnapshot(withApproval);

    render(<MobileApp />);

    const pinned = await screen.findByRole("region", { name: "Pinned" });
    within(pinned).getByRole("button", { name: /Keep this handy/ });
    const sessions = screen.getByRole("region", { name: "Sessions" });
    const row = within(sessions).getByRole("button", { name: /Fix flaky tests/ });
    expect(row).toHaveTextContent("needs approval");
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
  });

  it("opens a session on tap and returns to the list via back", async () => {
    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "All sessions" });
    fireEvent.click(within(section).getByRole("button", { name: /Build dashboard/ }));

    expect(await screen.findByRole("region", { name: "Session conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "All sessions" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    expect(await screen.findByRole("region", { name: "All sessions" })).toBeInTheDocument();
  });

  it("dismisses an attention chip after the session was opened and left", async () => {
    // Mirror of the desktop sidebar's read-clears-priority rule.
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.workspaceId === "workspace-1"
          ? {
              ...session,
              state: "complete" as const,
              attention: "review-ready" as const,
              attentionChangedAt: new Date().toISOString()
            }
          : session
      )
    });
    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "All sessions" });
    const row = within(section).getByRole("button", { name: /Build dashboard/ });
    expect(row).toHaveTextContent("review ready");
    fireEvent.click(row);
    await screen.findByRole("region", { name: "Session conversation" });

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));

    await waitFor(() =>
      expect(setPriorityDismissed).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        dismissed: true
      })
    );
  });

  it("browses changed diffs and the file tree from the session screen", async () => {
    listChangedFiles.mockResolvedValue([
      { path: "src/foo.ts", status: "modified", additions: 1, deletions: 0 }
    ]);
    loadDiff.mockResolvedValue({
      workspaceId: "workspace-1",
      filePath: "src/foo.ts",
      content: [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1,1 +1,2 @@",
        " const a = 1;",
        "+const b = 2;"
      ].join("\n")
    });
    listWorkspaceFiles.mockResolvedValue([{ path: "src/foo.ts" }, { path: "README.md" }]);
    readWorkspaceFile.mockResolvedValue({ kind: "text", content: "hello world", size: 11, mtimeMs: 1 });

    render(<MobileApp />);
    const section = await screen.findByRole("region", { name: "All sessions" });
    fireEvent.click(within(section).getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Session conversation" });

    fireEvent.click(screen.getByRole("button", { name: /Files and changes/ }));

    // Changes view: the changed file is listed with its diff expanded.
    expect(await screen.findByText("src/foo.ts")).toBeInTheDocument();
    expect(await screen.findByText(/const b = 2;/)).toBeInTheDocument();

    // Files view: the tree renders; tapping a file opens the preview and back
    // returns to the tree.
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    const tree = await screen.findByRole("tree", { name: "Workspace files" });
    fireEvent.click(within(tree).getByRole("treeitem", { name: "README.md" }));
    expect(await screen.findByLabelText("Preview of README.md")).toBeInTheDocument();
    expect(screen.getByText("hello world")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    expect(screen.getByRole("tree", { name: "Workspace files" })).toBeInTheDocument();

    // Leaving the review screen lands back on the conversation.
    fireEvent.click(screen.getByRole("button", { name: "Back to session" }));
    expect(await screen.findByRole("region", { name: "Session conversation" })).toBeInTheDocument();
  });

  it("shows a reconnect banner while the remote bridge is down", async () => {
    render(<MobileApp />);

    await screen.findByRole("region", { name: "All sessions" });
    expect(screen.queryByRole("status", { name: "Reconnecting" })).not.toBeInTheDocument();

    act(() => remote.publish({ status: "offline", resync: false }));
    expect(screen.getByRole("status", { name: "Reconnecting" })).toBeInTheDocument();
    // The list stays usable underneath — the banner is not a blocker.
    expect(screen.getByRole("region", { name: "All sessions" })).toBeInTheDocument();

    const statusCalls = workspaceStatus.mock.calls.length;
    act(() => remote.publish({ status: "connected", resync: true }));

    expect(screen.queryByRole("status", { name: "Reconnecting" })).not.toBeInTheDocument();
    // Deltas pushed while the socket was dead never arrived, so the snapshot is
    // reloaded rather than resumed.
    await waitFor(() => expect(workspaceStatus.mock.calls.length).toBeGreaterThan(statusCalls));
  });

  it("launches a new session in the current checkout from the + screen", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Fix the flaky archive test" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch session" }));

    await waitFor(() => {
      expect(createCurrentWorkspace).toHaveBeenCalledTimes(1);
    });
    const createInput = createCurrentWorkspace.mock.calls[0][0];
    expect(createInput.projectId).toBe(snapshot.projects[0].id);
    expect(createInput.taskLabel).toContain("Fix the flaky archive test");
    expect(launchProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: snapshot.workspaces[0].id,
        prompt: "Fix the flaky archive test",
        provider: snapshot.projects[0].settings.defaultProvider
      })
    );
    expect(await screen.findByRole("region", { name: "Session conversation" })).toBeInTheDocument();
  });

  it("picks a model from the bottom sheet on the + screen", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    const sheet = await screen.findByRole("dialog", { name: "Choose model" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Big Pickle" }));

    expect(screen.queryByRole("dialog", { name: "Choose model" })).not.toBeInTheDocument();
    expect(screen.getByText("OpenCode · Big Pickle")).toBeInTheDocument();
  });

  it("launches into a worktree when that mode is chosen", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "worktree" } });
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Try a risky refactor" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch session" }));

    await waitFor(() => {
      expect(createIsolatedWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: snapshot.projects[0].id })
      );
    });
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
  });

  it("toggles between dark and light themes and persists the choice", async () => {
    render(<MobileApp />);

    await screen.findByRole("region", { name: "All sessions" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("argmax.theme.mode")).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
