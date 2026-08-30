import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangedFileSummary, DashboardSnapshot } from "../../shared/types.js";
import type { RemoteConnectionState } from "../lib/wsTransport.js";
import {
  archiveWorkspace,
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
        },
        {
          ...snapshot.sessions[0],
          id: "session-3",
          workspaceId: "workspace-3",
          state: "blocked",
          attention: "approval-needed",
          attentionChangedAt: new Date().toISOString()
        }
      ]
    };
    mockDashboardSnapshot(withApproval);

    render(<MobileApp />);

    const pinned = await screen.findByRole("region", { name: "Pinned" });
    // A pin is a placement, not a mute: the row you cared enough to pin still
    // says it needs you.
    expect(within(pinned).getByRole("button", { name: /Keep this handy/ })).toHaveTextContent(
      "needs approval"
    );
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

  it("forks a Claude session from the turn footer and opens the fork", async () => {
    // The fork button is provider-gated to Claude and only renders on a
    // finished turn's hover footer.
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.workspaceId === "workspace-1"
          ? { ...session, provider: "claude" as const, state: "complete" as const }
          : session
      )
    });
    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "All sessions" });
    fireEvent.click(within(section).getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Session conversation" });

    const fork = vi.fn().mockResolvedValue({
      workspace: { id: "workspace-1" },
      session: { id: "session-fork" }
    });
    window.argmax!.session.fork = fork;

    fireEvent.click(await screen.findByRole("button", { name: "Fork session" }));
    await waitFor(() => expect(fork).toHaveBeenCalledWith({ sessionId: "session-1" }));
  });

  it("browses changed diffs and the file tree from the session screen", async () => {
    // The changed-file list is released by hand rather than resolved up front:
    // the review screen opens its changes panel from a mount effect, and the
    // first file only auto-expands when the list lands with the panel already
    // open. A WS round trip always loses that race in the app; an instantly
    // resolved mock wins it and leaves every file collapsed.
    let releaseChangedFiles: (() => void) | null = null;
    listChangedFiles.mockImplementation(
      () =>
        new Promise<ChangedFileSummary[]>((resolveFiles) => {
          releaseChangedFiles = () =>
            resolveFiles([{ path: "src/foo.ts", status: "modified", additions: 1, deletions: 0 }]);
        })
    );
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

    // Let the (lazily loaded) review screen mount and open its changes panel
    // before the file list arrives.
    await screen.findByRole("tablist", { name: "Review mode" });
    await act(async () => {});
    await act(async () => {
      releaseChangedFiles?.();
      await Promise.resolve();
    });

    // Changes view: the changed file is listed with its diff expanded. Asserted
    // on the list's text content, since an added line is one text node while
    // the diff is plain and several once the highlighter has loaded.
    const changedFiles = await screen.findByLabelText("Changed files");
    expect(changedFiles).toHaveTextContent("src/foo.ts");
    await waitFor(() => expect(changedFiles).toHaveTextContent("const b = 2;"));

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
    // The launch model mirrors the desktop launcher default (factory pick:
    // Claude Opus 5), not the project's configured provider.
    expect(launchProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: snapshot.workspaces[0].id,
        prompt: "Fix the flaky archive test",
        provider: "claude",
        modelId: "claude-opus-5",
        fastMode: false
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

  it("picks the project from a bottom sheet on the + screen", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: "Project" }));

    const sheet = await screen.findByRole("dialog", { name: "Choose project" });
    fireEvent.click(within(sheet).getByRole("button", { name: snapshot.projects[0].name }));
    expect(screen.queryByRole("dialog", { name: "Choose project" })).not.toBeInTheDocument();
  });

  it("launches into a worktree when that mode is chosen", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const sheet = await screen.findByRole("dialog", { name: "Choose workspace" });
    fireEvent.click(within(sheet).getByRole("button", { name: "New worktree" }));
    expect(screen.queryByRole("dialog", { name: "Choose workspace" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Try a risky refactor" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch session" }));

    await waitFor(() => {
      expect(createIsolatedWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: snapshot.projects[0].id })
      );
    });
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
  });

  it("archives the open session from the header, confirming the dirty worktree", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });

    fireEvent.click(screen.getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Session conversation" });
    fireEvent.click(screen.getByRole("button", { name: "Archive session" }));

    // Workspace 0 is dirty and not shared, so the confirm runs and force goes out.
    await waitFor(() =>
      expect(archiveWorkspace).toHaveBeenCalledWith({ workspaceId: snapshot.workspaces[0].id, force: true })
    );
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("region", { name: "All sessions" })).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("opens the session a push notification linked to", async () => {
    const linked = snapshot.sessions[0];
    window.history.replaceState(null, "", `/mobile.html?session=${linked.id}`);

    render(<MobileApp />);

    // Straight into the transcript that raised the push, not the list.
    expect(await screen.findByRole("region", { name: "Session conversation" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
    window.history.replaceState(null, "", "/mobile.html");
  });

  it("stays on the list when the linked session is not in the snapshot", async () => {
    window.history.replaceState(null, "", "/mobile.html?session=session-gone");

    render(<MobileApp />);

    expect(await screen.findByRole("region", { name: "All sessions" })).toBeInTheDocument();
    window.history.replaceState(null, "", "/mobile.html");
  });

  it("pins a session from the row actions sheet", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });
    const setPinned = vi.spyOn(window.argmax!.workspaces, "setPinned");

    const row = screen.getByRole("button", { name: /Build dashboard/ }).closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Session actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Session actions" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Pin to top" }));

    expect(screen.queryByRole("dialog", { name: "Session actions" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(setPinned).toHaveBeenCalledWith({ workspaceId: snapshot.workspaces[0].id, pinned: true })
    );
  });

  it("closes the open session on a hardware back gesture", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });

    fireEvent.click(screen.getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Session conversation" });

    // The phone's back button pops the entry the session screen pushed.
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(await screen.findByRole("region", { name: "All sessions" })).toBeInTheDocument();
  });

  it("closes the row actions sheet on a back gesture instead of leaving the list", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });

    const row = screen.getByRole("button", { name: /Build dashboard/ }).closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Session actions" }));
    await screen.findByRole("dialog", { name: "Session actions" });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.queryByRole("dialog", { name: "Session actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "All sessions" })).toBeInTheDocument();
  });

  it("closes a picker sheet on back without discarding the typed prompt", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Half-written idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await screen.findByRole("dialog", { name: "Choose model" });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.queryByRole("dialog", { name: "Choose model" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Task")).toHaveValue("Half-written idea");
  });

  it("dismisses a sheet with Escape", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "All sessions" });

    const row = screen.getByRole("button", { name: /Build dashboard/ }).closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Session actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Session actions" });
    expect(sheet).toHaveAttribute("aria-modal", "true");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Session actions" })).not.toBeInTheDocument();
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
