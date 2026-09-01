import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { persistLaunchModel } from "./lib/launchModelPreference.js";
import { SESSION_ICON_COLORS, SESSION_ICON_NAMES } from "./lib/sessionIcons.js";
import { attachmentProtocolUrl } from "../shared/attachmentProtocol.js";
import type { ArgmaxApi, DashboardSnapshot } from "../shared/types.js";
import {
  archiveWorkspace,
  autotitleWorkspace,
  createCurrentWorkspace,
  createIsolatedWorkspace,
  dashboardDeltaListener,
  dashboardDeltaUnsubscribe,
  dashboardList,
  dashboardListSnapshot,
  launchProvider,
  listBranches,
  listProjectFiles,
  mockDashboardSnapshot,
  pickProjectFolder,
  primaryProject,
  providersDiscover,
  secondProject,
  sessionEventsSince,
  setWorkspaceIcon,
  setupAppTestMocks,
  snapshot,
  terminateProvider
} from "../test/appTestHarness.js";

/** Paste of a screenshot: a clipboard carrying one path-less image file. */
function pasteScreenshot(target: HTMLElement): void {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
  fireEvent.paste(target, {
    clipboardData: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }]
    }
  });
}

function attachedScreenshots(): string[] {
  const region = screen.queryByLabelText("Attached images");
  if (!region) return [];
  return Array.from(region.querySelectorAll("img")).map((image) => image.getAttribute("src") ?? "");
}

describe("App", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    setupAppTestMocks();
  });

  it("renders the local project launcher from IPC data", async () => {
    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Argmax" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch model" })).toHaveTextContent("Opus 5");
    expect(screen.queryByRole("button", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Board" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cockpit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("restores the persisted launcher default model", async () => {
    persistLaunchModel({
      provider: "codex",
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high"
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Switch model" })).toHaveTextContent("GPT-5.6 Sol");
  });

  it("toggles project sessions in the sidebar and remembers collapsed projects", async () => {
    // The collapse toggle only governs project groups, so seed a finished
    // session: a running one would float into Working and out of the group.
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.id === "session-1" ? { ...session, state: "complete" } : session
      )
    });
    const { unmount } = render(<App />);

    expect(await screen.findByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    const hideProjectSessions = screen.getByRole("button", { name: "Hide Argmax sessions" });
    fireEvent.click(hideProjectSessions);

    expect(screen.queryByRole("button", { name: "Build dashboard" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Argmax sessions" })).toHaveAttribute("aria-expanded", "false");

    unmount();
    render(<App />);

    expect(await screen.findByRole("button", { name: "Show Argmax sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build dashboard" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show Argmax sessions" }));
    expect(await screen.findByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
  });

  it("renders streamed dashboard deltas without reloading the full dashboard", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
    expect(dashboardList).toHaveBeenCalledTimes(1);

    act(() => {
      dashboardDeltaListener?.({
        events: [
          {
            id: "event-streamed",
            sessionId: "session-1",
            type: "message.delta",
            message: "Streaming now.",
            payload: {},
            createdAt: "2026-05-08T15:54:01.000Z"
          }
        ]
      });
    });

    expect(await screen.findByText("Streaming now.")).toBeInTheDocument();
    expect(dashboardList).toHaveBeenCalledTimes(1);
  });

  it("preserves the user's model selection across dashboard deltas for the same session", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();

    const modelButton = await screen.findByRole("button", { name: "Session model" });
    const initialLabel = modelButton.textContent ?? "";
    expect(initialLabel).toContain("GPT-5.6 Terra");

    // Model selection is session-id scoped. Deltas for the same session must
    // not overwrite a local picker choice while the session stays selected.
    const baseSession = snapshot.sessions[0];
    if (!baseSession) throw new Error("snapshot must include session-1");
    act(() => {
      dashboardDeltaListener?.({
        sessions: [
          {
            ...baseSession,
            modelLabel: "Haiku 4.5",
            modelId: "claude-haiku-4-5",
            reasoningEffort: undefined,
            lastActivityAt: "2026-05-08T15:55:00.000Z"
          }
        ]
      });
    });

    const after = await screen.findByRole("button", { name: "Session model" });
    expect(after.textContent ?? "").toBe(initialLabel);
  });

  it("archives dirty shared-workspace sessions without confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const sharedSnapshot: DashboardSnapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({
        ...workspace,
        state: "complete",
        sharedWorkspace: true,
        kind: "git",
        path: "/tmp/argmax",
        dirty: true,
        changedFiles: 3
      })),
      sessions: snapshot.sessions.map((session) => ({ ...session, state: "complete" }))
    };
    mockDashboardSnapshot(sharedSnapshot);
    archiveWorkspace.mockResolvedValue({
      ...(sharedSnapshot.workspaces[0] ?? snapshot.workspaces[0]),
      state: "archived"
    });

    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Archive session" }));

      await waitFor(() =>
        expect(archiveWorkspace).toHaveBeenCalledWith({ workspaceId: "workspace-1", force: false })
      );
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("closes the open chat when archiving the currently active workspace", async () => {
    const activeSnapshot: DashboardSnapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({
        ...workspace,
        state: "complete",
        sharedWorkspace: true,
        kind: "git",
        dirty: false,
        changedFiles: 0
      })),
      sessions: snapshot.sessions.map((session) => ({ ...session, state: "complete" }))
    };
    mockDashboardSnapshot(activeSnapshot);
    archiveWorkspace.mockResolvedValue({
      ...(activeSnapshot.workspaces[0] ?? snapshot.workspaces[0]),
      state: "archived"
    });

    render(<App />);

    // Open the chat
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("button", { name: "Close pane" })).toBeInTheDocument();

    // Archive the active chat
    fireEvent.click(screen.getByRole("button", { name: "Archive session" }));

    await waitFor(() =>
      expect(archiveWorkspace).toHaveBeenCalledWith({ workspaceId: "workspace-1", force: false })
    );

    // Chat should now be closed and launcher should be visible
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Close pane" })).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("re-prompts and retries with force when the backend finds changes the snapshot missed", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const cleanIsolatedSnapshot: DashboardSnapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({
        ...workspace,
        state: "complete",
        sharedWorkspace: false,
        kind: "git",
        dirty: false,
        changedFiles: 0
      })),
      sessions: snapshot.sessions.map((session) => ({ ...session, state: "complete" }))
    };
    mockDashboardSnapshot(cleanIsolatedSnapshot);
    const workspace = cleanIsolatedSnapshot.workspaces[0] ?? snapshot.workspaces[0];
    archiveWorkspace
      .mockResolvedValueOnce({ ...workspace, state: "kept", dirty: true, changedFiles: 2 })
      .mockResolvedValueOnce({ ...workspace, state: "archived" });

    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Archive session" }));

      await waitFor(() => expect(archiveWorkspace).toHaveBeenCalledTimes(2));
      expect(archiveWorkspace).toHaveBeenNthCalledWith(1, { workspaceId: "workspace-1", force: false });
      expect(archiveWorkspace).toHaveBeenNthCalledWith(2, { workspaceId: "workspace-1", force: true });
      expect(confirmSpy).toHaveBeenCalledTimes(1);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("renders normalized tool calls in the conversation timeline", async () => {
    const toolStarted: DashboardSnapshot["events"][number] = {
      id: "event-tool-started",
      sessionId: "session-1",
      type: "command.started",
      message: "web_search",
      payload: {
        id: "ws_1",
        type: "web_search",
        name: "web_search",
        input: {}
      },
      createdAt: "2026-05-08T15:53:58.000Z"
    };
    const toolCompleted: DashboardSnapshot["events"][number] = {
      id: "event-tool-completed",
      sessionId: "session-1",
      type: "command.completed",
      message: "web_search",
      payload: {
        id: "ws_1",
        type: "web_search",
        name: "web_search",
        input: {
          query: "pizza recipe"
        }
      },
      createdAt: "2026-05-08T15:53:59.000Z"
    };
    mockDashboardSnapshot({
      ...snapshot,
      events: [snapshot.events[0], toolCompleted, toolStarted]
    });
    sessionEventsSince.mockResolvedValue({
      events: [snapshot.events[0], toolCompleted, toolStarted],
      rawOutputs: [],
      eventCursor: 3,
      rawOutputCursor: 0
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("button", { name: "Searched for pizza recipe" })).toBeInTheDocument();
    expect(screen.getByText("Dashboard ready.")).toBeInTheDocument();
  });

  it("keeps tool calls visible after a streaming assistant response completes", async () => {
    const toolStarted: DashboardSnapshot["events"][number] = {
      id: "event-tool-started",
      sessionId: "session-1",
      type: "command.started",
      message: "Read",
      payload: { id: "tu_1", type: "Read", name: "Read", input: { file_path: "README.md" } },
      createdAt: "2026-05-08T15:53:50.000Z"
    };
    const toolCompleted: DashboardSnapshot["events"][number] = {
      id: "event-tool-completed",
      sessionId: "session-1",
      type: "command.completed",
      message: "tool_result",
      payload: { tool_use_id: "tu_1", content: "file body" },
      createdAt: "2026-05-08T15:53:51.000Z"
    };
    const streamingDeltas: DashboardSnapshot["events"] = Array.from({ length: 120 }, (_, i) => ({
      id: `event-delta-${i}`,
      sessionId: "session-1",
      type: "message.delta" as const,
      message: `chunk ${i}`,
      payload: {},
      createdAt: new Date(Date.parse("2026-05-08T15:53:52.000Z") + i).toISOString()
    }));
    const messageCompleted: DashboardSnapshot["events"][number] = {
      id: "event-msg-completed",
      sessionId: "session-1",
      type: "message.completed",
      message: "All set.",
      payload: {},
      createdAt: "2026-05-08T15:54:00.000Z"
    };

    const firstEvent = snapshot.events[0];
    if (!firstEvent) throw new Error("test fixture missing baseline event");
    const eventsBundle = [firstEvent, toolStarted, toolCompleted, ...streamingDeltas, messageCompleted];
    mockDashboardSnapshot({ ...snapshot, events: eventsBundle });
    sessionEventsSince.mockResolvedValue({
      events: eventsBundle,
      rawOutputs: [],
      eventCursor: eventsBundle.length,
      rawOutputCursor: 0
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("button", { name: "Read README.md" })).toBeInTheDocument();
    expect(screen.getByText("All set.")).toBeInTheDocument();
  });

  it("renders a tool-call group between two assistant messages with overlapping timestamps", async () => {
    const userMessage: DashboardSnapshot["events"][number] = {
      id: "ev-user-explore",
      sessionId: "session-1",
      type: "user.message",
      message: "yes explore the codebase",
      payload: {},
      createdAt: "2026-05-08T15:56:43.000Z"
    };
    const announce: DashboardSnapshot["events"][number] = {
      id: "ev-msg-announce",
      sessionId: "session-1",
      type: "message.completed",
      message: "I'll explore the codebase.",
      payload: {},
      createdAt: "2026-05-08T15:56:49.000Z"
    };
    // First two tool starts share the announce timestamp.
    const toolEvents: DashboardSnapshot["events"] = [
      { id: "ev-glob-1-s", sessionId: "session-1", type: "command.started", message: "Glob",
        payload: { id: "tu1", name: "Glob", input: { pattern: "src/**/*.py" } },
        createdAt: "2026-05-08T15:56:49.000Z" },
      { id: "ev-glob-1-c", sessionId: "session-1", type: "command.completed", message: "tool_result",
        payload: { tool_use_id: "tu1", content: "match" }, createdAt: "2026-05-08T15:56:50.000Z" },
      { id: "ev-glob-2-s", sessionId: "session-1", type: "command.started", message: "Glob",
        payload: { id: "tu2", name: "Glob", input: { pattern: "src/**/*.ts" } },
        createdAt: "2026-05-08T15:56:50.000Z" },
      { id: "ev-glob-2-c", sessionId: "session-1", type: "command.completed", message: "tool_result",
        payload: { tool_use_id: "tu2", content: "match" }, createdAt: "2026-05-08T15:56:50.000Z" },
      { id: "ev-read-1-s", sessionId: "session-1", type: "command.started", message: "Read",
        payload: { id: "tu3", name: "Read", input: { file_path: "README.md" } },
        createdAt: "2026-05-08T15:56:50.000Z" },
      { id: "ev-read-1-c", sessionId: "session-1", type: "command.completed", message: "tool_result",
        payload: { tool_use_id: "tu3", content: "file" }, createdAt: "2026-05-08T15:56:52.000Z" }
    ];
    const finalAnswer: DashboardSnapshot["events"][number] = {
      id: "ev-msg-final",
      sessionId: "session-1",
      type: "message.completed",
      message: "I've explored.",
      payload: {},
      createdAt: "2026-05-08T15:57:25.000Z"
    };

    const eventsBundle = [userMessage, announce, ...toolEvents, finalAnswer];
    mockDashboardSnapshot({ ...snapshot, events: eventsBundle });
    sessionEventsSince.mockResolvedValue({
      events: eventsBundle,
      rawOutputs: [],
      eventCursor: eventsBundle.length,
      rawOutputCursor: 0
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    // Assistant message text is tokenized into separate <span> elements once
    // shiki's highlighter caches across tests (same module-state quirk that
    // P6.01 hit). Wait for the conversation surface to render, then assert
    // against its concatenated textContent so tokenization is invisible.
    const conversation = await screen.findByRole("region", { name: "Session conversation" });
    await waitFor(() => expect(conversation).toHaveTextContent("I'll explore the codebase."));
    expect(conversation).toHaveTextContent("I've explored.");
    expect(screen.getByRole("button", { name: /Explored 1 file, 2 searches/ })).toBeInTheDocument();
  });

  it("hides provider protocol JSON from the first-turn raw transcript fallback", async () => {
    const lifecycleSnapshot: DashboardSnapshot = {
      ...snapshot,
      events: [],
      rawOutputs: [
        {
          id: "raw-lifecycle",
          sessionId: "session-1",
          stream: "stdout",
          content:
            '{"type":"thread.started","thread_id":"019e0bd0-7694-7032-85cd-f670d78ac282"}\n{"type":"turn.started"}\n{"type":"init","cwd":"/tmp/argmax","session_id":"claude-session","tools":["Task","Bash"]}\n',
          createdAt: "2026-05-08T15:54:01.000Z"
        }
      ]
    };
    mockDashboardSnapshot(lifecycleSnapshot);
    sessionEventsSince.mockResolvedValue({
      events: [],
      rawOutputs: lifecycleSnapshot.rawOutputs,
      eventCursor: 0,
      rawOutputCursor: 1
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
    expect(screen.queryByText(/thread\.started/)).not.toBeInTheDocument();
    expect(screen.queryByText(/turn\.started/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"tools"/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("unsubscribes from dashboard deltas on unmount", async () => {
    const rendered = render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    rendered.unmount();

    expect(dashboardDeltaUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not schedule focused dashboard polling while work is active", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    try {
      render(<App />);

      expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
      expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 1200);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("starts the default provider from the composer", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: "Switch model" })).toHaveTextContent("Opus 5");
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Implement PTY launch" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(createCurrentWorkspace).toHaveBeenCalledWith({
        projectId: "project-1",
        taskLabel: "Implement PTY launch"
      })
    );
    expect(launchProvider).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      provider: "claude",
      prompt: "Implement PTY launch",
      modelLabel: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "medium",
      fastMode: false,
      agentMode: "auto",
      permissionMode: "auto-approve",
      cols: 120,
      rows: 32,
      attachments: null
    });
    await waitFor(() =>
      expect(autotitleWorkspace).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        provider: "claude",
        modelId: "claude-sonnet-5",
        prompt: "Implement PTY launch"
      })
    );
    expect(createCurrentWorkspace.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      launchProvider.mock.invocationCallOrder[0] ?? 0
    );
    expect(setWorkspaceIcon).not.toHaveBeenCalled();
    expect(launchProvider.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      autotitleWorkspace.mock.invocationCallOrder[0] ?? 0
    );
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
  });

  it("assigns a random icon and color before launching when enabled", async () => {
    window.localStorage.setItem("argmax.sessionIcon.random.enabled", "true");
    render(<App />);
    const promptBox = await screen.findByLabelText("Task prompt");
    // Spy only once the launcher is on screen, so its own random draws (the
    // rotating hero heading) don't eat the queued icon/color values.
    const random = vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999);

    try {
      fireEvent.change(promptBox, {
        target: { value: "Implement PTY launch" }
      });
      fireEvent.click(screen.getByTitle("Start agent"));

      await waitFor(() =>
        expect(setWorkspaceIcon).toHaveBeenCalledWith({
          workspaceId: "workspace-1",
          // The mocked draws pin the launch flow, not the palette: 0 takes the
          // first icon and 0.999 the last colour. Naming the entries here meant
          // appending a colour failed this test.
          icon: SESSION_ICON_NAMES[0],
          iconColor: SESSION_ICON_COLORS[SESSION_ICON_COLORS.length - 1]
        })
      );
      expect(setWorkspaceIcon.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
        launchProvider.mock.invocationCallOrder[0] ?? 0
      );
    } finally {
      random.mockRestore();
    }
  });

  it("brings an unsent launcher prompt and its screenshot back after a restart", async () => {
    const { unmount } = render(<App />);

    const promptBox = await screen.findByLabelText("Task prompt");
    fireEvent.change(promptBox, { target: { value: "why is this misaligned" } });
    pasteScreenshot(promptBox);
    await screen.findByLabelText("Attached images");
    unmount();

    render(<App />);
    expect(await screen.findByLabelText("Task prompt")).toHaveValue("why is this misaligned");
    expect(attachedScreenshots()).toEqual([attachmentProtocolUrl("/tmp/fake.png")]);
  });

  it("clears the launcher draft once the agent starts", async () => {
    const { unmount } = render(<App />);

    const promptBox = await screen.findByLabelText("Task prompt");
    fireEvent.change(promptBox, { target: { value: "Implement PTY launch" } });
    pasteScreenshot(promptBox);
    await screen.findByLabelText("Attached images");
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() => expect(launchProvider).toHaveBeenCalled());
    // The app moves to the new session, taking the launcher with it.
    await screen.findByRole("heading", { name: "Argmax" });
    unmount();

    render(<App />);
    expect(await screen.findByLabelText("Task prompt")).toHaveValue("");
    expect(attachedScreenshots()).toEqual([]);
  });

  it("does not restore a launched prompt on the next new chat", async () => {
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Implement PTY launch" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));
    await screen.findByRole("heading", { name: "Argmax" });

    fireEvent.keyDown(document, { key: "n", metaKey: true });
    expect(await screen.findByLabelText("Task prompt")).toHaveValue("");
  });

  it("returns to the new chat composer view with prompt and repo persisted when stopped within 10s of launch", async () => {
    const freshSession = {
      ...snapshot.sessions[0],
      id: "session-new",
      workspaceId: "workspace-1",
      prompt: "Fix login auth bug in wrong repo",
      startedAt: new Date().toISOString(),
      state: "running" as const
    };
    launchProvider.mockResolvedValue(freshSession);

    render(<App />);

    const promptBox = await screen.findByLabelText("Task prompt");
    fireEvent.change(promptBox, {
      target: { value: "Fix login auth bug in wrong repo" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    const stopButton = await screen.findByRole("button", { name: "Stop session" });
    expect(stopButton).toBeInTheDocument();

    fireEvent.click(stopButton);

    await waitFor(() => expect(terminateProvider).toHaveBeenCalledWith("session-new"));

    const restoredPromptBox = await screen.findByLabelText("Task prompt");
    expect(restoredPromptBox).toHaveValue("Fix login auth bug in wrong repo");
  });

  it("does not return to composer when stopped after the 10s window", async () => {
    const oldSession = {
      ...snapshot.sessions[0],
      id: "session-old",
      workspaceId: "workspace-1",
      prompt: "Build dashboard feature",
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      state: "running" as const
    };
    launchProvider.mockResolvedValue(oldSession);

    render(<App />);

    const promptBox = await screen.findByLabelText("Task prompt");
    fireEvent.change(promptBox, {
      target: { value: "Build dashboard feature" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    const stopButton = await screen.findByRole("button", { name: "Stop session" });
    fireEvent.click(stopButton);

    await waitFor(() => expect(terminateProvider).toHaveBeenCalledWith("session-old"));

    expect(screen.queryByLabelText("Task prompt")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Session prompt")).toBeInTheDocument();
  });

  it("drops the stored launcher draft as soon as start is pressed", async () => {
    createCurrentWorkspace.mockImplementation(() => new Promise(() => undefined));
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Implement PTY launch" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem("argmax.composer.drafts") ?? "{}")).toEqual({});
    });
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Implement PTY launch");
  });

  it("launches into an isolated worktree when the worktree toggle is enabled", async () => {
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Implement PTY launch" }
    });
    // Worktree is off by default (current checkout); enable it.
    const worktreeToggle = screen.getByRole("button", { name: "Worktree" });
    expect(worktreeToggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(worktreeToggle);
    expect(worktreeToggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(createIsolatedWorkspace).toHaveBeenCalledWith({
        projectId: "project-1",
        taskLabel: "Implement PTY launch",
        baseRef: "main"
      })
    );
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
    expect(launchProvider).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", prompt: "Implement PTY launch" })
    );
    expect(window.localStorage.getItem("argmax.workspaceMode")).toBe("worktree");
  });

  it("honors a persisted worktree preference without re-toggling", async () => {
    window.localStorage.setItem("argmax.workspaceMode", "worktree");

    render(<App />);

    expect(await screen.findByRole("button", { name: "Worktree" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Resume the migration" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(createIsolatedWorkspace).toHaveBeenCalledWith({
        projectId: "project-1",
        taskLabel: "Resume the migration",
        baseRef: "main"
      })
    );
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
  });

  it("toggles launcher agent mode with Tab and sends plan mode", async () => {
    render(<App />);

    const input = await screen.findByLabelText("Task prompt");
    fireEvent.change(input, { target: { value: "Plan the migration" } });
    fireEvent.keyDown(input, { key: "Tab" });

    expect(screen.getByRole("button", { name: "Agent mode" })).toHaveTextContent("Plan");
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Plan the migration",
          agentMode: "plan"
        })
      )
    );
    expect(window.localStorage.getItem("argmax.launch.agentMode")).toBeNull();
  });

  it("keeps a newly launched chat selected while the dashboard refresh catches up", async () => {
    const newWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-new",
      projectId: "project-1",
      taskLabel: "New chat",
      branch: "main",
      baseRef: "main",
      path: "/tmp/argmax",
      state: "running",
      sharedWorkspace: true,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:10:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    };
    const newSession: DashboardSnapshot["sessions"][number] = {
      id: "session-new",
      workspaceId: "workspace-new",
      provider: "codex",
      modelLabel: "GPT-5.6 Terra",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "New chat",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T16:10:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T16:10:00.000Z",
    };
    const newEvent: DashboardSnapshot["events"][number] = {
      id: "event-new",
      sessionId: "session-new",
      type: "message.completed",
      message: "New chat answer.",
      payload: {},
      createdAt: "2026-05-08T16:10:01.000Z"
    };
    mockDashboardSnapshot(snapshot);
    sessionEventsSince.mockImplementation((input) => {
      if (input.sessionId === "session-new") {
        return Promise.resolve({ events: [newEvent], rawOutputs: [], eventCursor: 2, rawOutputCursor: 0 });
      }
      return Promise.resolve({ events: snapshot.events, rawOutputs: snapshot.rawOutputs, eventCursor: 1, rawOutputCursor: 0 });
    });
    createCurrentWorkspace.mockResolvedValue(newWorkspace);
    launchProvider.mockResolvedValue(newSession);

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "New chat" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    act(() => {
      dashboardDeltaListener?.({
        workspaces: [newWorkspace],
        sessions: [newSession],
        events: [newEvent]
      });
    });

    expect(await screen.findByText("New chat answer.")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toHaveAttribute("aria-current", "true");
  });

  it("displays an @-mention-only launch prompt as the user message in the new session", async () => {
    listProjectFiles.mockResolvedValue([{ path: "AGENTS.md" }]);
    const newWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-mention",
      projectId: "project-1",
      taskLabel: "@AGENTS.md",
      branch: "main",
      baseRef: "main",
      path: "/tmp/argmax",
      state: "running",
      sharedWorkspace: true,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:10:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    };
    const newSession: DashboardSnapshot["sessions"][number] = {
      id: "session-mention",
      workspaceId: "workspace-mention",
      provider: "codex",
      modelLabel: "GPT-5.6 Terra",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "@AGENTS.md",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T16:10:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T16:10:00.000Z",
    };
    const userEvent: DashboardSnapshot["events"][number] = {
      id: "event-user-mention",
      sessionId: "session-mention",
      type: "user.message",
      message: "@AGENTS.md",
      payload: { source: "composer", agentMode: "auto" },
      createdAt: "2026-05-08T16:10:00.500Z"
    };
    mockDashboardSnapshot(snapshot);
    sessionEventsSince.mockImplementation((input) => {
      if (input.sessionId === "session-mention") {
        return Promise.resolve({ events: [userEvent], rawOutputs: [], eventCursor: 2, rawOutputCursor: 0 });
      }
      return Promise.resolve({ events: snapshot.events, rawOutputs: snapshot.rawOutputs, eventCursor: 1, rawOutputCursor: 0 });
    });
    createCurrentWorkspace.mockResolvedValue(newWorkspace);
    launchProvider.mockResolvedValue(newSession);

    render(<App />);

    const promptInput = await screen.findByLabelText("Task prompt");
    fireEvent.change(promptInput, { target: { value: "@AGENTS.md" } });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "@AGENTS.md" })
      )
    );
    act(() => {
      dashboardDeltaListener?.({
        workspaces: [newWorkspace],
        sessions: [newSession],
        events: [userEvent]
      });
    });

    const bubble = await screen.findByText("@AGENTS.md", { selector: "p" });
    expect(bubble.closest(".chat-bubble.user")).not.toBeNull();
  });

  it("starts Claude when selected in the composer", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Switch model" }));
    const launchPopover = await screen.findByRole("listbox", { name: "Switch model" });
    // The launcher defaults to Opus 5 at Medium; switching to Sonnet (also
    // effort-capable) carries that Medium over rather than resetting.
    fireEvent.click(within(launchPopover).getByText("Sonnet 5"));
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Review this change" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        provider: "claude",
        prompt: "Review this change",
        modelLabel: "Sonnet 5",
        modelId: "claude-sonnet-5",
        reasoningEffort: "medium",
        fastMode: false,
        agentMode: "auto",
        permissionMode: "auto-approve",
        cols: 120,
        rows: 32,
        attachments: null
      })
    );
  });

  it("dismisses the model picker when clicking non-option popover content", async () => {
    render(<App />);

    const modelToggle = await screen.findByRole("button", { name: "Switch model" });
    fireEvent.click(modelToggle);
    expect(modelToggle).toHaveAttribute("aria-expanded", "true");

    // Click inert popover chrome (the listbox padding, not an option button).
    fireEvent.click(await screen.findByRole("listbox", { name: "Switch model" }));
    expect(modelToggle).toHaveAttribute("aria-expanded", "false");
  });

  it("dismisses the branch picker when clicking inside the popover chrome", async () => {
    listBranches.mockResolvedValue(["main", "feature/tidy"]);
    render(<App />);

    const branchToggle = await screen.findByRole("button", { name: "Switch branch" });
    fireEvent.click(branchToggle);
    await waitFor(() => expect(branchToggle).toHaveAttribute("aria-expanded", "true"));

    fireEvent.click(await screen.findByRole("listbox", { name: "Select branch" }));
    expect(branchToggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows an empty branch picker state when there are no alternate branches", async () => {
    listBranches.mockResolvedValue(["main"]);
    render(<App />);

    const branchToggle = await screen.findByRole("button", { name: "Switch branch" });
    fireEvent.click(branchToggle);

    await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(1));
    expect(branchToggle).toHaveAttribute("aria-expanded", "true");
    // The list paints a commit after the IPC resolves, so wait for the list
    // itself — the call landing is not yet the list being on screen.
    expect(await screen.findByRole("listbox", { name: "Select branch" })).toHaveTextContent(
      "No other branches"
    );
  });

  it("keeps project and branch pickers available from compact launcher details", async () => {
    listBranches.mockResolvedValue(["main", "feature/tidy"]);
    render(<App />);

    const detailsToggle = await screen.findByRole("button", {
      name: "Project and branch: Argmax, main"
    });
    expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(detailsToggle);

    const details = screen.getByRole("dialog", { name: "Project and branch" });
    expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
    expect(within(details).getByRole("button", { name: "Switch project" })).toBeInTheDocument();

    const branchToggle = within(details).getByRole("button", { name: "Switch branch" });
    fireEvent.click(branchToggle);
    expect(await within(details).findByRole("listbox", { name: "Select branch" })).toHaveTextContent(
      "feature/tidy"
    );
    fireEvent.click(within(details).getByRole("button", { name: "feature/tidy" }));
    expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog", { name: "Project and branch" })).not.toBeInTheDocument();
  });

  it("filters an open branch picker as the user types", async () => {
    listBranches.mockResolvedValue(["main", "feature/tidy", "adam/fix-thing"]);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Switch branch" }));

    const list = await screen.findByRole("listbox", { name: "Select branch" });
    // The list holds focus while open, so typing lands here and not in the
    // prompt behind it.
    await waitFor(() => expect(document.activeElement).toBe(list));

    fireEvent.keyDown(list, { key: "f" });
    fireEvent.keyDown(list, { key: "i" });
    fireEvent.keyDown(list, { key: "x" });

    expect(within(list).getByRole("button", { name: "adam/fix-thing" })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "feature/tidy" })).not.toBeInTheDocument();
    expect(within(list).getByText("1 of 2")).toBeInTheDocument();
  });

  it("dismisses open pickers via the global dismiss layer", async () => {
    render(<App />);

    const modelToggle = await screen.findByRole("button", { name: "Switch model" });
    fireEvent.click(modelToggle);
    expect(modelToggle).toHaveAttribute("aria-expanded", "true");

    const dismissLayer = document.querySelector(".picker-dismiss-layer");
    expect(dismissLayer).toBeInTheDocument();
    fireEvent.mouseDown(dismissLayer as Element);

    expect(modelToggle).toHaveAttribute("aria-expanded", "false");
  });

  it("adds a second project, selects it, and launches from that project", async () => {
    const dotfilesProject = secondProject();
    pickProjectFolder.mockResolvedValue({ cancelled: false, project: dotfilesProject });

    render(<App />);

    // Wait for the initial dashboard load to settle so the post-mount loadState
    // transition can't race with addProject and overwrite the merged snapshot.
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.click(await screen.findByRole("button", { name: "Add Project" }));

    expect(await screen.findByRole("button", { name: "Dotfiles" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(screen.getByText("Added Dotfiles.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Update shell aliases" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(createCurrentWorkspace).toHaveBeenCalledWith({
        projectId: "project-2",
        taskLabel: "Update shell aliases"
      })
    );
  });

  it("selects the added project even while a workspace session is open", async () => {
    const dotfilesProject = secondProject();
    pickProjectFolder.mockResolvedValue({ cancelled: false, project: dotfilesProject });

    render(<App />);

    // Open the existing workspace's chat first: with a workspace selected, the
    // selection-sync effect used to snap selectedProjectId back to that
    // workspace's project, undoing the freshly added project's selection.
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    // The chat must actually be open (workspace selected) before adding.
    await screen.findByLabelText("Session conversation");
    fireEvent.click(await screen.findByRole("button", { name: "Add Project" }));

    // The launcher's own project chip — not the sidebar group — must target
    // the fresh project.
    const projectChip = await screen.findByRole("button", { name: "Switch project" });
    await waitFor(() => expect(projectChip).toHaveTextContent("Dotfiles"));
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("leaves state unchanged when folder selection is cancelled", async () => {
    pickProjectFolder.mockResolvedValue({ cancelled: true });

    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));

    await waitFor(() => expect(pickProjectFolder).toHaveBeenCalledTimes(1));
    expect(dashboardList).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("shows a clear error when folder registration fails", async () => {
    pickProjectFolder.mockRejectedValue(new Error("Argmax requires a local git repository."));

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add Project" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Argmax requires a local git repository.");
    expect(screen.getByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("renders the WelcomePane before any projects are registered and gates the CTA on provider discovery", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      projects: [],
      workspaces: [],
      sessions: [],
      events: []
    });
    // Empty discovery: the launcher CTA stays disabled until at least one
    // provider is detected — Argmax can't launch a session without a CLI.
    providersDiscover.mockResolvedValue([]);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome to Argmax" })).toBeInTheDocument();
    expect(screen.queryByTitle("Start agent")).not.toBeInTheDocument();

    // Two "Add Project" buttons exist: the sidebar's (always enabled) and the
    // launcher CTA inside WelcomePane (gated on discovery). Pick the launcher
    // one and assert it is disabled until a provider is detected.
    const launcherCta = await screen.findByTitle("Install at least one provider CLI first");
    expect(launcherCta).toHaveAttribute("aria-disabled", "true");
    expect(launcherCta).toBeDisabled();
  });

  it("enables the WelcomePane CTA once at least one provider is detected", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      projects: [],
      workspaces: [],
      sessions: [],
      events: []
    });
    providersDiscover.mockResolvedValue([
      {
        provider: "claude",
        displayName: "Claude Code",
        binaryName: "claude",
        installed: true,
        binaryPath: "/usr/local/bin/claude",
        version: "1.2.3",
        authenticated: true,
        setupGuidance: null,
        approvalSupport: "observable-only"
      }
    ]);

    render(<App />);

    await screen.findByRole("heading", { name: "Welcome to Argmax" });
    // Once discovery resolves with an installed provider, the launcher CTA
    // switches to the "Pick a local git repository" title and becomes enabled.
    const launcherCta = await screen.findByTitle("Pick a local git repository");
    expect(launcherCta).not.toBeDisabled();
  });


  it("renders the dashboard error state with a Retry button and reloads on click", async () => {
    let attempts = 0;
    dashboardList.mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error("backend-fault"));
      }
      return Promise.resolve(dashboardListSnapshot(snapshot));
    });

    render(<App />);

    expect(await screen.findByText(/backend-fault/)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);

    await waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
  });


  it("auto-dismisses info toasts after the 4s window", async () => {
    pickProjectFolder.mockResolvedValueOnce({ cancelled: false, project: primaryProject() });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

      fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
      await screen.findByText(/Added /);

      // Flush React's post-commit effect that schedules the dismiss setTimeout
      // before advancing fake timers; otherwise the timer is scheduled from a
      // later fake-clock instant and never fires within the waitFor window.
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      await waitFor(() => expect(screen.queryByText(/Added /)).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("App without Tauri bridge", () => {
  it("renders the bridge-missing banner when window.argmax is undefined", async () => {
    const previousArgmax = window.argmax;
    delete (window as { argmax?: ArgmaxApi }).argmax;

    // jsdom marks Location.prototype.hostname non-configurable, so swap the
    // entire `window.location` with a plain stub for the duration of the test.
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, hostname: "example.test", host: "example.test" }
    });

    try {
      render(<App />);
      expect(
        await screen.findByText(/Tauri bridge unavailable; running on demo data/)
      ).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation
      });
      window.argmax = previousArgmax;
    }
  });

  it("uses demo data without the bridge-missing banner in browser preview", async () => {
    const previousArgmax = window.argmax;
    delete (window as { argmax?: ArgmaxApi }).argmax;

    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, hostname: "127.0.0.1", host: "127.0.0.1:5173" }
    });

    try {
      render(<App />);

      expect(
        screen.queryByText(/Tauri bridge unavailable; running on demo data/)
      ).not.toBeInTheDocument();
      expect(await screen.findByText("Design parallel agent board")).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation
      });
      window.argmax = previousArgmax;
    }
  });
});
