import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCRATCH_PROJECT_ID, type DashboardSnapshot } from "../../shared/types.js";
import type { RemoteConnectionState } from "../lib/wsTransport.js";
import { LAUNCHER_TITLE, SIDE_CHAT_TITLE } from "../lib/launcherTitle.js";
import {
  archiveWorkspace,
  createCurrentWorkspace,
  createIsolatedWorkspace,
  createScratchWorkspace,
  dashboardList,
  launchProvider,
  listChangedFiles,
  listWorkspaceFiles,
  loadDiff,
  mockDashboardSnapshot,
  readWorkspaceFile,
  sessionEventsSince,
  setPriorityDismissed,
  setupAppTestMocks,
  snapshot,
  terminateProvider
} from "../../test/appTestHarness.js";
import { startedAgentName } from "../../test/agentRowName.js";
import { MobileApp } from "./MobileApp.js";
import { SESSION_VIEWED_STORAGE_KEY, resetSessionUnreadForTests } from "../lib/sessionUnread.js";

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

// A repo-less side chat: the hidden "Side chats" project, a scratch workspace
// and its session, and nothing git-backed — so the section a side chat lands
// in is unambiguous.
function sideChatSnapshot(): DashboardSnapshot {
  return {
    ...snapshot,
    projects: [
      {
        ...snapshot.projects[0],
        id: SCRATCH_PROJECT_ID,
        name: "Side chats",
        repoPath: "/tmp/argmax-data/side-chats"
      }
    ],
    workspaces: [
      {
        ...snapshot.workspaces[0],
        id: "workspace-chat",
        projectId: SCRATCH_PROJECT_ID,
        taskLabel: "Explain event sourcing",
        kind: "scratch",
        sharedWorkspace: true,
        state: "complete",
        dirty: false,
        changedFiles: 0
      }
    ],
    sessions: [
      {
        ...snapshot.sessions[0],
        id: "session-chat",
        workspaceId: "workspace-chat",
        state: "complete",
        attention: "normal"
      }
    ]
  };
}

function installObjectUrl(url: string): () => void {
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => url)
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });
  return () => {
    if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
  };
}

describe("MobileApp", () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-user-bubble");
  });

  beforeEach(() => {
    remote.reset();
    setupAppTestMocks();
  });

  it("lists sessions with project subtitle and running marker", async () => {
    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "Chat list" });
    const row = within(section).getByRole("button", { name: /Build dashboard/ });
    expect(row).toHaveTextContent("Argmax");
    expect(within(row).getByLabelText("running")).toBeInTheDocument();
  });

  it("keeps the launching chat marked running while a multitask is still working", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [
        { ...snapshot.workspaces[0], state: "complete" },
        {
          ...snapshot.workspaces[0],
          id: "workspace-multitask",
          taskLabel: "Fix the changelog date",
          state: "running",
          sharedWorkspace: true
        }
      ],
      sessions: [
        { ...snapshot.sessions[0], state: "complete" },
        {
          ...snapshot.sessions[0],
          id: "session-multitask",
          workspaceId: "workspace-multitask",
          state: "running",
          launchedBySessionId: snapshot.sessions[0].id,
          launchKind: "multitask",
          prompt: "The changelog says 2025 for the 0.4 entry."
        }
      ]
    });

    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "Chat list" });
    const row = within(section).getByRole("button", { name: /Build dashboard/ });
    // The parent's own turn is over; the sibling's is not, so this row still
    // carries the nest — a multitask has no list row of its own.
    expect(within(row).getByLabelText("running")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /Fix the changelog date/ })).not.toBeInTheDocument();
  });

  it("marks a chat unread once its reply lands after the last time it was read", async () => {
    // The stamp is this device's own, so seed it directly: a workspace first
    // seen by the phone is stamped to its current activity and must stay
    // quiet, and only activity past that stamp earns the dot.
    const workspace = snapshot.workspaces.find((candidate) =>
      snapshot.sessions.some((session) => session.workspaceId === candidate.id)
    );
    if (!workspace) throw new Error("fixture has no chat to mark unread");
    window.localStorage.setItem(
      SESSION_VIEWED_STORAGE_KEY,
      JSON.stringify({ [workspace.id]: "2020-01-01T00:00:00.000Z" })
    );
    resetSessionUnreadForTests();
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: snapshot.workspaces.map((candidate) =>
        candidate.id === workspace.id
          ? { ...candidate, state: "complete" as const, lastActivityAt: new Date().toISOString() }
          : candidate
      ),
      // The nest follows session state now (plus any running multitask), not
      // the workspace row. A completed reply with a still-running session
      // would keep the nest and hide the unread dot.
      sessions: snapshot.sessions.map((candidate) =>
        candidate.workspaceId === workspace.id
          ? { ...candidate, state: "complete" as const }
          : candidate
      )
    });

    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "Chat list" });
    const row = within(section).getByRole("button", { name: new RegExp(workspace.taskLabel) });
    expect(within(row).getByLabelText("unread reply")).toBeInTheDocument();
    // A turn in flight owns the cell instead; the dot waits for it to end.
    expect(within(row).queryByLabelText("running")).not.toBeInTheDocument();
  });

  it("filters chats by title and project from the bottom search field", async () => {
    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "Chat list" });
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    fireEvent.change(search, { target: { value: "dashboard" } });

    expect(within(section).getByRole("button", { name: /Build dashboard/ })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "argmax" } });
    expect(within(section).getByRole("button", { name: /Build dashboard/ })).toBeInTheDocument();
  });

  it("floats working and attention rows into Priority, with pinned rows above it", async () => {
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
          attentionChangedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString()
        },
        {
          ...snapshot.sessions[0],
          id: "session-3",
          workspaceId: "workspace-3",
          state: "blocked",
          attention: "approval-needed",
          attentionChangedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString()
        }
      ]
    };
    mockDashboardSnapshot(withApproval);

    render(<MobileApp />);

    const pinned = await screen.findByRole("region", { name: "Pinned" });
    // A pin is a placement, not a mute: the row you cared enough to pin stays
    // in Pinned and still shows the marker that says it needs you.
    const pinnedRow = within(pinned).getByRole("button", { name: /Keep this handy/ });
    expect(within(pinnedRow).getByLabelText("needs approval")).toBeInTheDocument();
    // Attention and the running turn both belong to Priority now, not to a
    // chip on a row in the flat list.
    const priority = screen.getByRole("region", { name: "Priority" });
    expect(
      within(within(priority).getByRole("button", { name: /Fix flaky tests/ })).getByLabelText(
        "needs approval"
      )
    ).toBeInTheDocument();
    expect(within(priority).getByRole("button", { name: /Build dashboard/ })).toBeInTheDocument();
    // The marker carries it now; nothing spells the attention out in text.
    expect(priority).not.toHaveTextContent("needs approval");
  });

  // The mobile launcher's own connection-lost path leaves the workspace in
  // place with no session attached. Such a row resolves no session on tap, so
  // it opens nothing — the desktop sidebar keeps it out of every section for
  // the same reason.
  it("hides a workspace that has no session", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [
        ...snapshot.workspaces,
        {
          ...snapshot.workspaces[0],
          id: "workspace-stranded",
          taskLabel: "Stranded launch",
          state: "created"
        }
      ]
    });

    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "Chat list" });
    expect(within(section).getByRole("button", { name: /Build dashboard/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stranded launch/ })).not.toBeInTheDocument();
  });

  it("opens a session on tap and returns to the list via back", async () => {
    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(within(section).getByRole("button", { name: /Build dashboard/ }));

    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Chat list" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    expect(await screen.findByRole("region", { name: "Chat list" })).toBeInTheDocument();
  });

  it("opens a subagent's transcript in the overlay, over the chat that spawned it", async () => {
    // The phone has no dock, so the row raises a sheet over the transcript
    // instead. It stops short of the composer, so the reply the result calls
    // for is still one tap away.
    mockDashboardSnapshot({
      ...snapshot,
      events: [
        ...snapshot.events,
        {
          id: "event-agent-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "tu_agent",
            name: "Task",
            input: { description: "Audit the dashboard query", prompt: "Read it and report back." }
          },
          createdAt: "2026-05-08T15:54:01.000Z"
        },
        {
          id: "event-agent-done",
          sessionId: "session-1",
          type: "command.completed",
          message: "tool_result",
          payload: { tool_use_id: "tu_agent", content: "No issues found." },
          createdAt: "2026-05-08T15:54:02.000Z"
        }
      ]
    });
    render(<MobileApp />);

    const list = await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(within(list).getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Conversation" });

    const row = await screen.findByRole("button", {
      name: startedAgentName("Audit the dashboard query")
    });
    fireEvent.click(row);

    const overlay = await screen.findByRole("dialog", { name: "Delegated work" });
    expect(within(overlay).getByText("No issues found.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close Delegated work" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delegated work" })).not.toBeInTheDocument()
    );
  });

  it("brings the peek up over the parent's composer and multitask lane", async () => {
    // A bottom sheet, not a panel parked above the chat's floor: it reaches
    // the bottom edge and covers both the composer and the lane the row was
    // tapped in, and they come back when it closes. An earlier pass measured
    // that furniture and held it clear, which left a second composer live
    // under the sheet.
    const parent = snapshot.sessions[0];
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [
        ...snapshot.workspaces,
        {
          ...snapshot.workspaces[0],
          id: "workspace-multitask",
          taskLabel: "Fix the changelog date",
          state: "complete",
          sharedWorkspace: true
        }
      ],
      sessions: [
        ...snapshot.sessions,
        {
          ...parent,
          id: "session-multitask",
          workspaceId: "workspace-multitask",
          state: "complete",
          launchedBySessionId: parent.id,
          launchKind: "multitask",
          prompt: "The changelog says 2025 for the 0.4 entry."
        }
      ],
      events: [
        ...snapshot.events,
        {
          id: "event-multitask-launched",
          sessionId: parent.id,
          type: "multitask.launched",
          message: "Running alongside: Fix the changelog date",
          payload: {
            childSessionId: "session-multitask",
            childWorkspaceId: "workspace-multitask",
            taskLabel: "Fix the changelog date",
            prompt: "The changelog says 2025 for the 0.4 entry.",
            worktree: false
          },
          createdAt: "2026-05-08T15:54:01.000Z"
        }
      ]
    });

    // jsdom measures everything as a zero box, so the untouched branch below
    // is what it would have returned anyway.
    const box = (top: number, bottom: number): DOMRect =>
      ({ top, bottom, left: 0, right: 390, width: 390, height: bottom - top, x: 0, y: top }) as DOMRect;
    const rects = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element): DOMRect {
        if (this.classList.contains("session-main-column")) return box(0, 800);
        if (this.classList.contains("multitask-composer-lane")) return box(540, 620);
        if (this.classList.contains("session-composer-stack")) return box(620, 800);
        return box(0, 0);
      });

    try {
      render(<MobileApp />);

      const list = await screen.findByRole("region", { name: "Chat list" });
      fireEvent.click(within(list).getByRole("button", { name: /Build dashboard/ }));
      await screen.findByRole("region", { name: "Conversation" });

      fireEvent.click(
        await screen.findByRole("button", { name: "Open multitask: Fix the changelog date" })
      );

      const overlay = await screen.findByRole("dialog", { name: "Delegated work" });
      // No inline floor at all: the sheet's bottom is the screen's, in CSS.
      expect(overlay.closest(".mobile-agent-overlay")).not.toHaveAttribute("style");

      fireEvent.click(screen.getByRole("button", { name: "Close Delegated work" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Delegated work" })).not.toBeInTheDocument()
      );
      // The parent's composer is answerable again the moment the sheet goes.
      expect(screen.getByRole("textbox", { name: "Chat prompt" })).toBeInTheDocument();
    } finally {
      rects.mockRestore();
    }
  });

  // A multitask's turn footer lists the files it wrote and offers Review. On
  // the desktop both open the containing dock's Changes view; the phone has no
  // dock, so both have to reach the review screen — the same one a file
  // reference tapped in the transcript opens. They used to reach nothing: the
  // overlay handed `AgentsView` no `onOpenDiff`/`onOpenReview`, so the panel
  // fell back to its own inert review state and the taps did nothing at all.
  async function openMultitaskPeekWithChanges(): Promise<void> {
    const parent = snapshot.sessions[0];
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [
        ...snapshot.workspaces,
        {
          ...snapshot.workspaces[0],
          id: "workspace-multitask",
          taskLabel: "Fix the changelog date",
          state: "complete",
          sharedWorkspace: true
        }
      ],
      sessions: [
        ...snapshot.sessions,
        {
          ...parent,
          id: "session-multitask",
          workspaceId: "workspace-multitask",
          state: "complete",
          launchedBySessionId: parent.id,
          launchKind: "multitask",
          prompt: "The changelog says 2025 for the 0.4 entry."
        }
      ],
      events: [
        ...snapshot.events,
        {
          id: "event-multitask-launched",
          sessionId: parent.id,
          type: "multitask.launched",
          message: "Running alongside: Fix the changelog date",
          payload: {
            childSessionId: "session-multitask",
            childWorkspaceId: "workspace-multitask",
            taskLabel: "Fix the changelog date",
            prompt: "The changelog says 2025 for the 0.4 entry.",
            worktree: false
          },
          createdAt: "2026-05-08T15:54:01.000Z"
        },
        {
          id: "event-multitask-user",
          sessionId: "session-multitask",
          type: "user.message",
          message: "The changelog says 2025 for the 0.4 entry.",
          payload: { source: "multitask" },
          createdAt: "2026-05-08T15:54:01.000Z"
        },
        {
          id: "event-multitask-edit-start",
          sessionId: "session-multitask",
          type: "command.started",
          message: "Edit",
          payload: {
            id: "edit-1",
            name: "Edit",
            input: {
              file_path: "/tmp/worktrees/dashboard/CHANGELOG.md",
              old_string: "2025",
              new_string: "2026"
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        },
        {
          id: "event-multitask-edit-done",
          sessionId: "session-multitask",
          type: "command.completed",
          message: "Edit",
          payload: { id: "edit-1", name: "Edit", output: "ok" },
          createdAt: "2026-05-08T15:54:03.000Z"
        },
        {
          id: "event-multitask-answer",
          sessionId: "session-multitask",
          type: "message.completed",
          message: "Corrected the 0.4 heading to 2026.",
          payload: {},
          createdAt: "2026-05-08T15:54:04.000Z"
        }
      ]
    });

    render(<MobileApp />);
    const list = await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(within(list).getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Conversation" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Open multitask: Fix the changelog date" })
    );
    await screen.findByRole("dialog", { name: "Delegated work" });
  }

  it("opens a file a multitask wrote on the review screen, from the peek", async () => {
    listWorkspaceFiles.mockResolvedValue([{ path: "CHANGELOG.md" }]);
    readWorkspaceFile.mockResolvedValue({
      kind: "text",
      content: "## 0.4 — 2026",
      size: 13,
      mtimeMs: 1
    });

    await openMultitaskPeekWithChanges();

    // The turn's activity rows name the same file, so reach the row through
    // the changes card's own header rather than by label alone.
    const header = await screen.findByRole("button", { name: "Hide 1 file changed" });
    const card = header.closest("section");
    if (!card) throw new Error("turn changes card is not a section");
    fireEvent.click(within(card).getByRole("button", { name: "Edited CHANGELOG.md" }));

    await screen.findByRole("tablist", { name: "Review mode" });
    expect(await screen.findByLabelText("Preview of CHANGELOG.md")).toBeInTheDocument();
  });

  it("opens the review screen's changes from a multitask peek's Review button", async () => {
    listChangedFiles.mockResolvedValue([
      { path: "CHANGELOG.md", status: "modified", additions: 1, deletions: 1, staged: false }
    ]);

    await openMultitaskPeekWithChanges();

    const peek = screen.getByRole("dialog", { name: "Delegated work" });
    fireEvent.click(within(peek).getByRole("button", { name: "Review changed files" }));

    await screen.findByRole("tablist", { name: "Review mode" });
    // No file was picked, so it lands on Changes rather than a file preview.
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("Changed files")).toHaveTextContent("CHANGELOG.md");
  });

  it("closes the delegated-work overlay on a hardware back gesture, keeping the chat", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      events: [
        ...snapshot.events,
        {
          id: "event-agent-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "tu_agent",
            name: "Task",
            input: { description: "Audit the dashboard query", prompt: "Read it and report back." }
          },
          createdAt: "2026-05-08T15:54:01.000Z"
        },
        {
          id: "event-agent-done",
          sessionId: "session-1",
          type: "command.completed",
          message: "tool_result",
          payload: { tool_use_id: "tu_agent", content: "No issues found." },
          createdAt: "2026-05-08T15:54:02.000Z"
        }
      ]
    });
    render(<MobileApp />);

    const list = await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(within(list).getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Conversation" });
    fireEvent.click(
      await screen.findByRole("button", { name: startedAgentName("Audit the dashboard query") })
    );
    await screen.findByRole("dialog", { name: "Delegated work" });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delegated work" })).not.toBeInTheDocument()
    );
    expect(screen.getByRole("region", { name: "Conversation" })).toBeInTheDocument();
  });

  it("keeps the chat list scrolled where it was after opening a session", async () => {
    render(<MobileApp />);

    const section = await screen.findByRole("region", { name: "Chat list" });
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    fireEvent.change(search, { target: { value: "dashboard" } });
    section.scrollTop = 240;
    fireEvent.scroll(section);

    fireEvent.click(within(section).getByRole("button", { name: /Build dashboard/ }));
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Chat list" })).not.toBeInTheDocument();
    // The parked list still sits in the shell, so a keyboard-sized viewport
    // can clamp the scroller. Restore must ignore that and put the offset back.
    section.scrollTop = 0;

    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    const restored = await screen.findByRole("region", { name: "Chat list" });
    expect(restored).toBe(section);
    expect(restored.scrollTop).toBe(240);
    expect(screen.getByRole("searchbox", { name: "Search chats" })).toHaveValue("dashboard");
  });

  it("drops a review-ready session from Priority once it has been opened", async () => {
    // Mirror of the desktop sidebar: reading is what resolves "there is a
    // reply you have not seen", and nothing else. Seed the stamp behind the
    // reply so the row starts unread, which is the only state that earns a
    // finished turn a place in triage.
    const activity = new Date().toISOString();
    window.localStorage.setItem(
      SESSION_VIEWED_STORAGE_KEY,
      JSON.stringify({ "workspace-1": "2020-01-01T00:00:00.000Z" })
    );
    resetSessionUnreadForTests();
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) =>
        workspace.id === "workspace-1" ? { ...workspace, lastActivityAt: activity } : workspace
      ),
      sessions: snapshot.sessions.map((session) =>
        session.workspaceId === "workspace-1"
          ? {
              ...session,
              state: "complete" as const,
              attention: "review-ready" as const,
              attentionChangedAt: activity,
              lastActivityAt: activity
            }
          : session
      )
    });
    render(<MobileApp />);

    const priority = await screen.findByRole("region", { name: "Priority" });
    const row = within(priority).getByRole("button", { name: /Build dashboard/ });
    fireEvent.click(row);
    await screen.findByRole("region", { name: "Conversation" });

    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));

    // Reading it is what settled it, so it leaves on its own — no "Done"
    // needed, and none recorded.
    await screen.findByRole("region", { name: "Chat list" });
    expect(screen.queryByRole("region", { name: "Priority" })).not.toBeInTheDocument();
    expect(setPriorityDismissed).not.toHaveBeenCalled();
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

    const section = await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(within(section).getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Conversation" });

    const fork = vi.fn().mockResolvedValue({
      workspace: { id: "workspace-1" },
      session: { id: "session-fork" }
    });
    window.argmax!.session.fork = fork;

    fireEvent.click(await screen.findByRole("button", { name: "Fork chat" }));
    await waitFor(() => expect(fork).toHaveBeenCalledWith({ sessionId: "session-1" }));
  });

  it("chooses the changes scope from a sheet, like every other phone picker", async () => {
    // It was the one control on the phone still using a native select, whose
    // menu iOS anchors to the row it was opened from.
    listChangedFiles.mockResolvedValue([
      { path: "src/foo.ts", status: "modified", additions: 1, deletions: 0 , staged: false },
]);

    render(<MobileApp />);
    const section = await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(within(section).getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Conversation" });
    fireEvent.click(screen.getByRole("button", { name: /Files and changes/ }));
    await screen.findByRole("tablist", { name: "Review mode" });

    const scope = screen.getByRole("button", { name: "Changes shown" });
    expect(scope).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(scope);

    await screen.findByRole("dialog", { name: "Changes shown" });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("dialog", { name: "Changes shown" })).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Review mode" })).toBeInTheDocument();
  });

  it("browses changed diffs and the file tree from the session screen", async () => {
    listChangedFiles.mockResolvedValue([
      { path: "src/foo.ts", status: "modified", additions: 1, deletions: 0 , staged: false },
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
      , revision: "test-revision"
    });
    listWorkspaceFiles.mockResolvedValue([{ path: "src/foo.ts" }, { path: "README.md" }]);
    readWorkspaceFile.mockResolvedValue({ kind: "text", content: "hello world", size: 11, mtimeMs: 1 });

    render(<MobileApp />);
    const section = await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(within(section).getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Conversation" });

    fireEvent.click(screen.getByRole("button", { name: /Files and changes/ }));

    await screen.findByRole("tablist", { name: "Review mode" });

    // Changes view: the first changed file is selected for the reader, so its
    // diff is already open. Asserted on the list's text content, since an added
    // line is one text node while the diff is plain and several once the
    // highlighter has loaded.
    const changedFiles = await screen.findByLabelText("Changed files");
    expect(changedFiles).toHaveTextContent("src/foo.ts");
    await waitFor(() => expect(changedFiles).toHaveTextContent("const b = 2;"));

    // Collapsing it puts the diff away again, which is the control the reader
    // has on a screen this size.
    fireEvent.click(await screen.findByRole("button", { name: "Collapse src/foo.ts diff" }));
    await waitFor(() => expect(changedFiles).not.toHaveTextContent("const b = 2;"));

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
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
  });

  it("keeps the open chat mounted under the review screen", async () => {
    listChangedFiles.mockResolvedValue([]);
    render(<MobileApp />);
    const section = await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(within(section).getByRole("button", { name: /Build dashboard/ }));
    const conversation = await screen.findByRole("region", { name: "Conversation" });

    fireEvent.click(screen.getByRole("button", { name: /Files and changes/ }));
    await screen.findByRole("tablist", { name: "Review mode" });
    expect(screen.queryByRole("region", { name: "Conversation" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.getByRole("region", { name: "Conversation" })).toBe(conversation);
  });

  it("shows a reconnect banner while the remote bridge is down", async () => {
    render(<MobileApp />);

    await screen.findByRole("region", { name: "Chat list" });
    expect(screen.queryByRole("status", { name: "Reconnecting" })).not.toBeInTheDocument();

    act(() => remote.publish({ status: "offline", resync: false }));
    expect(screen.getByRole("status", { name: "Reconnecting" })).toBeInTheDocument();
    // The list stays usable underneath — the banner is not a blocker.
    expect(screen.getByRole("region", { name: "Chat list" })).toBeInTheDocument();

    const statusCalls = dashboardList.mock.calls.length;
    act(() => remote.publish({ status: "connected", resync: true }));

    expect(screen.queryByRole("status", { name: "Reconnecting" })).not.toBeInTheDocument();
    // Deltas pushed while the socket was dead never arrived, so the snapshot is
    // reloaded rather than resumed.
    await waitFor(() => expect(dashboardList.mock.calls.length).toBeGreaterThan(statusCalls));
  });

  it("pulls the open session's transcript tail after a resync, not just rows", async () => {
    // The socket dropped mid-turn and the turn finished offline. `refresh`
    // brings the session back as `complete`, which stops the running-only
    // event tick — so if the resync doesn't pull events too, the tail of the
    // transcript never lands. Idle fixture so no poll can supply the pull.
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [{ ...snapshot.workspaces[0], state: "complete" }],
      sessions: [{ ...snapshot.sessions[0], state: "complete" }]
    });

    render(<MobileApp />);
    const section = await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(within(section).getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Conversation" });
    await waitFor(() => expect(sessionEventsSince).toHaveBeenCalled());

    const before = sessionEventsSince.mock.calls.length;
    act(() => remote.publish({ status: "connected", resync: true }));

    await waitFor(() => expect(sessionEventsSince.mock.calls.length).toBeGreaterThan(before));
    expect(sessionEventsSince).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "session-1" })
    );
  });

  it("launches a new session in the current checkout from the + screen", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Fix the flaky archive test" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

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
    expect(launchProvider.mock.calls[0][0]).not.toHaveProperty("permissionMode");
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
  });

  it("goes straight from the new-chat screen into the launched chat", async () => {
    const launchedWorkspace = { ...snapshot.workspaces[0], id: "workspace-new", taskLabel: "Fresh chat" };
    const launchedSession = { ...snapshot.sessions[0], id: "session-new", workspaceId: "workspace-new" };
    createCurrentWorkspace.mockResolvedValue(launchedWorkspace);
    launchProvider.mockResolvedValue(launchedSession);

    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    // The shell's screen attribute is the navigation itself: a "list" reading
    // between "new" and "session" is the flash this guards against.
    const shell = document.querySelector(".mobile-shell") as HTMLElement;
    const screens: string[] = [];
    const observer = new MutationObserver(() => {
      const current = shell.dataset.screen ?? "";
      if (screens[screens.length - 1] !== current) screens.push(current);
    });
    observer.observe(shell, { attributes: true, attributeFilter: ["data-screen"] });

    try {
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Start something new" } });
      fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

      expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
      expect(screens).toEqual(["new", "session"]);
    } finally {
      observer.disconnect();
    }
  });

  it("archives a chat stopped within 10s of launch and returns to the list", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        state: "running" as const,
        startedAt: new Date().toISOString(),
        completedAt: null
      }))
    });

    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(screen.getByRole("button", { name: /Build dashboard/ }));
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop chat" }));

    await waitFor(() => expect(terminateProvider).toHaveBeenCalledWith("session-1"));
    await waitFor(() =>
      expect(archiveWorkspace).toHaveBeenCalledWith({ workspaceId: "workspace-1", force: true })
    );
    expect(await screen.findByRole("region", { name: "Chat list" })).toBeInTheDocument();
  });

  it("shows the shared fixed new-chat title on the + screen", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(LAUNCHER_TITLE);
    expect(screen.getByRole("img", { name: "Fox mascot" })).toBeInTheDocument();
  });

  it("attaches a screenshot from the new-chat composer and sends it with the launch", async () => {
    const restoreObjectUrl = installObjectUrl("blob:mobile-screenshot");
    try {
      render(<MobileApp />);
      await screen.findByRole("region", { name: "Chat list" });

      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      const screenshot = new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png", {
        type: "image/png"
      });
      const input = document.querySelector('input[type="file"]');
      expect(input).not.toBeNull();
      fireEvent.change(input as HTMLInputElement, { target: { files: [screenshot] } });

      // The thumbnail is the whole chip — the image is its own label, so the
      // only text to assert on is the button that opens it.
      expect(await screen.findByLabelText("Attached images")).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("button", { name: "View image 1" }));
      expect(screen.getByRole("dialog", { name: "Attached image" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
      expect(screen.queryByRole("dialog", { name: "Attached image" })).toBeNull();
      fireEvent.change(screen.getByLabelText("Task"), {
        target: { value: "Review this screenshot" }
      });
      fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

      await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
      expect(launchProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Review this screenshot @/tmp/fake.png",
          attachments: [{ filePath: "/tmp/fake.png", mimeType: "image/png", sizeBytes: 0 }]
        })
      );
    } finally {
      restoreObjectUrl();
    }
  });

  it("picks a model from the new-session composer", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));

    const picker = await screen.findByRole("listbox", { name: "Chat model" });
    fireEvent.click(within(picker).getByRole("button", { name: "Big Pickle" }));

    expect(screen.queryByRole("listbox", { name: "Chat model" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat model" })).toHaveTextContent("Big Pickle");
  });

  it("changes reasoning effort from the new-session composer", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    const effortButton = screen.getByRole("button", { name: "Chat model effort" });
    expect(effortButton).toHaveTextContent("Medium");
    fireEvent.click(effortButton);

    const dialog = await screen.findByRole("dialog", { name: "Chat model effort" });
    const slider = within(dialog).getByRole("slider", { name: "Reasoning effort" });
    fireEvent.keyDown(slider, { key: "End" });
    expect(slider).toHaveAttribute("aria-valuetext", "Ultra");
    fireEvent.click(effortButton);

    expect(screen.getByRole("button", { name: "Chat model effort" })).toHaveTextContent("Ultra");
  });

  it("picks the project from a bottom sheet on the + screen", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Project" }));

    const sheet = await screen.findByRole("dialog", { name: "Choose project" });
    fireEvent.click(within(sheet).getByRole("button", { name: snapshot.projects[0].name }));
    expect(screen.queryByRole("dialog", { name: "Choose project" })).not.toBeInTheDocument();
  });

  it("launches into a worktree when that mode is chosen", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const sheet = await screen.findByRole("dialog", { name: "Choose workspace" });
    fireEvent.click(within(sheet).getByRole("button", { name: "New worktree" }));
    expect(screen.queryByRole("dialog", { name: "Choose workspace" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Try a risky refactor" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() => {
      expect(createIsolatedWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: snapshot.projects[0].id })
      );
    });
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
  });

  it("starts a new chat branched from a worktree, from that chat's row menu", async () => {
    // The header carries changes alone now; starting a chat lives in the row
    // menu, which is where it was always reachable from the list.
    render(<MobileApp />);
    const list = await screen.findByRole("region", { name: "Chat list" });

    const row = within(list)
      .getByRole("button", { name: /Build dashboard/ })
      .closest(".mobile-session-item");
    if (!row) throw new Error("no row");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Chat actions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^New chat here/ }));

    // Workspace picker reflects that the new chat branches from that worktree
    const workspaceBtn = screen.getByRole("button", { name: "Workspace" });
    expect(workspaceBtn.closest(".mobile-new-row")).toHaveTextContent("New worktree · from Build dashboard");

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Continue building feature" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() => {
      expect(createIsolatedWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: snapshot.projects[0].id,
          baseRef: "argmax/dashboard"
        })
      );
    });
  });

  it("starts a new chat from a worktree via the chat actions menu", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    const row = screen.getByRole("button", { name: /Build dashboard/ }).closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Chat actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Chat actions" });

    fireEvent.click(within(sheet).getByRole("button", { name: "New chat here" }));

    const workspaceBtn = screen.getByRole("button", { name: "Workspace" });
    expect(workspaceBtn.closest(".mobile-new-row")).toHaveTextContent("New worktree · from Build dashboard");

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Follow up work" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() => {
      expect(createIsolatedWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: snapshot.projects[0].id,
          baseRef: "argmax/dashboard"
        })
      );
    });
  });

  it("branches from an existing worktree when picked from the workspace sheet", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const sheet = await screen.findByRole("dialog", { name: "Choose workspace" });

    fireEvent.click(
      // The row is a ledger entry now: the worktree's title leads and its
      // branch sits underneath, so the accessible name is the two joined.
      within(sheet).getByRole("button", { name: "Build dashboard argmax/dashboard" })
    );
    expect(screen.queryByRole("dialog", { name: "Choose workspace" })).not.toBeInTheDocument();

    const workspaceBtn = screen.getByRole("button", { name: "Workspace" });
    expect(workspaceBtn.closest(".mobile-new-row")).toHaveTextContent("New worktree · from Build dashboard");

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Branch from dashboard" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() => {
      expect(createIsolatedWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: snapshot.projects[0].id,
          baseRef: "argmax/dashboard"
        })
      );
    });
  });

  it("lists a side chat under the Side chats project, outside Priority", async () => {
    mockDashboardSnapshot(sideChatSnapshot());

    render(<MobileApp />);

    // Side chats never escalate into triage, so the row belongs to the plain
    // activity section even while its session is the only one on the phone.
    const section = await screen.findByRole("region", { name: "All chats" });
    const row = within(section).getByRole("button", { name: /Explain event sourcing/ });
    expect(row).toHaveTextContent("Side chats");
    expect(screen.queryByRole("region", { name: "Priority" })).not.toBeInTheDocument();
  });

  it("opens a side chat transcript without offering the repo review screen", async () => {
    mockDashboardSnapshot(sideChatSnapshot());

    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(screen.getByRole("button", { name: /Explain event sourcing/ }));

    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    // The scratch directory is app-owned and holds one empty commit, so the
    // standing Changes/Files entry point would only ever open an empty diff.
    expect(screen.queryByRole("button", { name: /Files and changes/ })).not.toBeInTheDocument();
    // The header still rendered — it just has nothing to offer a side chat.
    expect(screen.getByRole("button", { name: "Back to chats" })).toBeInTheDocument();
  });

  it("starts a side chat from the + screen", async () => {
    const chat = sideChatSnapshot();
    createScratchWorkspace.mockResolvedValue(chat.workspaces[0]);
    launchProvider.mockResolvedValue(chat.sessions[0]);

    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const sheet = await screen.findByRole("dialog", { name: "Choose workspace" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Side chat" }));

    // No repository is involved, so the project row goes with it and the
    // screen adopts the desktop side-chat title.
    expect(screen.queryByRole("button", { name: "Project" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(SIDE_CHAT_TITLE);

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Explain event sourcing" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() => expect(createScratchWorkspace).toHaveBeenCalledTimes(1));
    const createInput = createScratchWorkspace.mock.calls[0][0];
    expect(createInput.kind).toBeNull();
    expect(createInput.taskLabel).toContain("Explain event sourcing");
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
    expect(createIsolatedWorkspace).not.toHaveBeenCalled();
    // Same model default as every other launch from this screen.
    expect(launchProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-chat",
        prompt: "Explain event sourcing",
        provider: "claude",
        modelId: "claude-opus-5"
      })
    );
  });

  it("offers only a side chat when no project is registered", async () => {
    mockDashboardSnapshot({ ...snapshot, projects: [], workspaces: [], sessions: [] });

    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    // The old empty state made this screen a dead end on a phone that has
    // never had a repo added; a side chat needs no repository.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(SIDE_CHAT_TITLE);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const sheet = await screen.findByRole("dialog", { name: "Choose workspace" });
    expect(within(sheet).getByRole("button", { name: "Side chat" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Current branch/ })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "New worktree" })).not.toBeInTheDocument();
  });

  it("archives a chat from its row menu, confirming the dirty worktree", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MobileApp />);
    const list = await screen.findByRole("region", { name: "Chat list" });

    const row = within(list)
      .getByRole("button", { name: /Build dashboard/ })
      .closest(".mobile-session-item");
    if (!row) throw new Error("no row");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Chat actions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Archive/ }));

    // Workspace 0 is dirty and not shared, so the confirm runs and force goes out.
    await waitFor(() =>
      expect(archiveWorkspace).toHaveBeenCalledWith({ workspaceId: snapshot.workspaces[0].id, force: true })
    );
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("region", { name: "Chat list" })).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("opens the session a push notification linked to", async () => {
    const linked = snapshot.sessions[0];
    window.history.replaceState(null, "", `/mobile.html?session=${linked.id}`);

    render(<MobileApp />);

    // Straight into the transcript that raised the push, not the list.
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
    window.history.replaceState(null, "", "/mobile.html");
  });

  it("stays on the list when the linked session is not in the snapshot", async () => {
    window.history.replaceState(null, "", "/mobile.html?session=session-gone");

    render(<MobileApp />);

    expect(await screen.findByRole("region", { name: "Chat list" })).toBeInTheDocument();
    window.history.replaceState(null, "", "/mobile.html");
  });

  it("pins a session from the row actions sheet", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });
    const setPinned = vi.spyOn(window.argmax!.workspaces, "setPinned");

    const row = screen.getByRole("button", { name: /Build dashboard/ }).closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Chat actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Chat actions" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Pin to top" }));

    expect(screen.queryByRole("dialog", { name: "Chat actions" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(setPinned).toHaveBeenCalledWith({ workspaceId: snapshot.workspaces[0].id, pinned: true })
    );
  });

  it("forks a chat from the row actions sheet", async () => {
    // The list is the phone's other way in: the transcript footer sits inside
    // the chat, so a fork you want before opening one has to live here.
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.workspaceId === "workspace-1"
          ? { ...session, provider: "claude" as const, state: "complete" as const }
          : session
      )
    });
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    const fork = vi.fn().mockResolvedValue({
      workspace: { id: "workspace-1" },
      session: { id: "session-fork" }
    });
    window.argmax!.session.fork = fork;

    const row = screen.getByRole("button", { name: /Build dashboard/ }).closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Chat actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Chat actions" });
    fireEvent.click(within(sheet).getByRole("button", { name: /^Fork chat/ }));

    expect(screen.queryByRole("dialog", { name: "Chat actions" })).not.toBeInTheDocument();
    await waitFor(() => expect(fork).toHaveBeenCalledWith({ sessionId: "session-1" }));
  });

  it("hides Fork chat while the chat is mid-turn", async () => {
    // Same gate as the transcript footer: `fork_session` refuses a running or
    // waiting session, so offering it here could only end in an error toast.
    // The fixture's chat runs on codex, which forks — the state is the block.
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    const row = screen.getByRole("button", { name: /Build dashboard/ }).closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Chat actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Chat actions" });

    expect(within(sheet).queryByRole("button", { name: /^Fork chat/ })).not.toBeInTheDocument();
  });

  it("closes the open session on a hardware back gesture", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    fireEvent.click(screen.getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Conversation" });

    // The phone's back button pops the entry the session screen pushed.
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(await screen.findByRole("region", { name: "Chat list" })).toBeInTheDocument();
  });

  it("pops the file preview on a back gesture, keeping the review screen open", async () => {
    listWorkspaceFiles.mockResolvedValue([{ path: "README.md" }]);
    readWorkspaceFile.mockResolvedValue({ kind: "text", content: "hello world", size: 11, mtimeMs: 1 });

    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });
    fireEvent.click(screen.getByRole("button", { name: /Build dashboard/ }));
    await screen.findByRole("region", { name: "Conversation" });
    fireEvent.click(screen.getByRole("button", { name: /Files and changes/ }));
    await screen.findByRole("tablist", { name: "Review mode" });

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    const tree = await screen.findByRole("tree", { name: "Workspace files" });
    fireEvent.click(within(tree).getByRole("treeitem", { name: "README.md" }));
    await screen.findByLabelText("Preview of README.md");

    // The drill-down is a screen of its own: back lands on the tree, not on
    // the conversation the way it would if only the review screen counted.
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("tree", { name: "Workspace files" })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
  });

  it("closes the row actions sheet on a back gesture instead of leaving the list", async () => {
    render(<MobileApp />);
    const item = await screen.findByRole("button", { name: /Build dashboard/ });
    const row = item.closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Chat actions" }));
    await screen.findByRole("dialog", { name: "Chat actions" });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.queryByRole("dialog", { name: "Chat actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Chat list" })).toBeInTheDocument();
  });

  it("closes a picker sheet on back without discarding the typed prompt", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Half-written idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));
    await screen.findByRole("listbox", { name: "Chat model" });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.queryByRole("listbox", { name: "Chat model" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Task")).toHaveValue("Half-written idea");
  });

  it("dismisses a sheet with Escape", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    const row = screen.getByRole("button", { name: /Build dashboard/ }).closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Chat actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Chat actions" });
    expect(sheet).toHaveAttribute("aria-modal", "true");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Chat actions" })).not.toBeInTheDocument();
  });

  /** Appearance moved out of the ⋯ sheet onto its own screen; the sheet now
   *  carries a row that opens it. */
  function openAppearance(): void {
    fireEvent.click(screen.getByRole("button", { name: "Remote options" }));
    fireEvent.click(screen.getByRole("button", { name: /^Appearance/ }));
  }

  it("toggles between dark and light themes and persists the choice", async () => {
    render(<MobileApp />);

    await screen.findByRole("region", { name: "Chat list" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    openAppearance();
    const themePicker = screen.getByRole("radiogroup", { name: "Theme" });
    fireEvent.click(within(themePicker).getByRole("radio", { name: "Light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("argmax.theme.mode")).toBe("light");
    expect(within(themePicker).getByRole("radio", { name: "Light" })).toHaveAttribute(
      "aria-checked",
      "true"
    );

    fireEvent.click(within(themePicker).getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // Still on the Appearance screen: changing one preference must not throw
    // you back to the list mid-adjustment.
    expect(screen.getByRole("radiogroup", { name: "Accent" })).toBeInTheDocument();
  });

  it("applies a stored accent and bubble tint on launch", async () => {
    window.localStorage.setItem("argmax.accent.tint", "coral");
    window.localStorage.setItem("argmax.chat.bubbleTint", "neutral");

    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    expect(document.documentElement.getAttribute("data-accent")).toBe("coral");
    expect(document.documentElement.getAttribute("data-user-bubble")).toBe("neutral");
  });

  it("picks an accent and takes user bubbles off it from the Remote menu", async () => {
    render(<MobileApp />);
    await screen.findByRole("region", { name: "Chat list" });

    openAppearance();
    const accentPicker = screen.getByRole("radiogroup", { name: "Accent" });
    expect(within(accentPicker).getByRole("radio", { name: "Green" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(within(accentPicker).getByRole("radio", { name: "Black" })).toBeTruthy();

    fireEvent.click(within(accentPicker).getByRole("radio", { name: "Orange" }));
    expect(document.documentElement.getAttribute("data-accent")).toBe("orange");
    expect(window.localStorage.getItem("argmax.accent.tint")).toBe("orange");
    expect(within(accentPicker).getByRole("radio", { name: "Orange" })).toHaveAttribute(
      "aria-checked",
      "true"
    );

    const bubblePicker = screen.getByRole("radiogroup", { name: "Your message bubbles" });
    expect(within(bubblePicker).getByRole("radio", { name: "Accent" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    fireEvent.click(within(bubblePicker).getByRole("radio", { name: "Neutral" }));
    expect(document.documentElement.getAttribute("data-user-bubble")).toBe("neutral");
    expect(window.localStorage.getItem("argmax.chat.bubbleTint")).toBe("neutral");
    // Still on the Appearance screen: changing one preference must not throw
    // you back to the list mid-adjustment.
    expect(screen.getByRole("radiogroup", { name: "Accent" })).toBeInTheDocument();
  });
});
