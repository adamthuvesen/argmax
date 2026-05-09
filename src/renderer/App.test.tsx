import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { DashboardSnapshot, MaestroApi } from "../shared/types.js";

const snapshot: DashboardSnapshot = {
  projects: [
    {
      id: "project-1",
      name: "Maestro",
      repoPath: "/tmp/maestro",
      currentBranch: "main",
      defaultBranch: "main",
      settings: {
        defaultProvider: "codex",
        defaultModelLabel: "GPT-5.5 Medium",
        worktreeLocation: "/tmp/worktrees",
        setupCommand: "npm install",
        checkCommands: ["npm test"]
      },
      counts: {
        active: 1,
        blocked: 0,
        failed: 0,
        reviewReady: 1
      },
      latestActivityAt: "2026-05-08T15:54:00.000Z"
    }
  ],
  workspaces: [
    {
      id: "workspace-1",
      projectId: "project-1",
      taskLabel: "Build dashboard",
      branch: "maestro/dashboard",
      baseRef: "main",
      path: "/tmp/worktrees/dashboard",
      state: "running",
      sharedWorkspace: false,
      dirty: true,
      changedFiles: 3,
      lastActivityAt: "2026-05-08T15:54:00.000Z"
    }
  ],
  sessions: [
    {
      id: "session-1",
      workspaceId: "workspace-1",
      provider: "codex",
      modelLabel: "GPT-5.5 Medium",
      prompt: "Build dashboard",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T15:54:00.000Z",
      preferred: false
    }
  ],
  events: [
    {
      id: "event-1",
      sessionId: "session-1",
      type: "message.completed",
      message: "Dashboard ready.",
      payload: {},
      createdAt: "2026-05-08T15:54:00.000Z"
    }
  ],
  rawOutputs: [],
  approvals: [],
  checks: [],
  checkpoints: []
};

describe("App", () => {
  let createCurrentWorkspace: ReturnType<typeof vi.fn<MaestroApi["workspaces"]["createCurrent"]>>;
  let dashboardLoad: ReturnType<typeof vi.fn<MaestroApi["dashboard"]["load"]>>;
  let launchProvider: ReturnType<typeof vi.fn<MaestroApi["providers"]["launch"]>>;
  let sendProviderInput: ReturnType<typeof vi.fn<MaestroApi["providers"]["sendInput"]>>;

  beforeEach(() => {
    createCurrentWorkspace = vi.fn<MaestroApi["workspaces"]["createCurrent"]>().mockResolvedValue(
      snapshot.workspaces[0] ?? missingWorkspace()
    );
    dashboardLoad = vi.fn<MaestroApi["dashboard"]["load"]>().mockResolvedValue(snapshot);
    launchProvider = vi.fn<MaestroApi["providers"]["launch"]>().mockResolvedValue(snapshot.sessions[0] ?? missingSession());
    sendProviderInput = vi.fn<MaestroApi["providers"]["sendInput"]>().mockResolvedValue({ ok: true });

    window.maestro = {
      dashboard: {
        load: dashboardLoad
      },
      projects: {
        list: () => Promise.resolve(snapshot.projects),
        register: () => Promise.resolve(primaryProject()),
        updateSettings: () => Promise.resolve(primaryProject())
      },
      workspaces: {
        createIsolated: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        createCurrent: createCurrentWorkspace,
        refreshStatus: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        keep: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        archive: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace())
      },
      providers: {
        discover: () => Promise.resolve([]),
        launch: launchProvider,
        sendInput: sendProviderInput,
        resize: () => Promise.resolve({ ok: true }),
        terminate: () => Promise.resolve({ ok: true })
      },
      approvals: {
        resolve: () => Promise.resolve(missingApproval())
      },
      review: {
        listChangedFiles: () => Promise.resolve([]),
        loadDiff: () => Promise.resolve({ workspaceId: "workspace-1", filePath: null, content: "" })
      },
      checks: {
        run: () => Promise.resolve(missingCheck())
      },
      checkpoints: {
        create: () => Promise.resolve(missingCheckpoint())
      },
      attempts: {
        selectPreferred: () => Promise.resolve(snapshot.sessions[0] ?? missingSession())
      },
      commits: {
        prepare: () =>
          Promise.resolve({
            workspaceId: "workspace-1",
            branch: "maestro/dashboard",
            selectedFiles: ["src/renderer/App.tsx"],
            message: "feat: test",
            commands: ["git add -- 'src/renderer/App.tsx'", "git commit -m 'feat: test'"]
          })
      },
      health: {
        ping: () => Promise.resolve({ ok: true, timestamp: "2026-05-08T15:54:00.000Z" })
      }
    };
  });

  it("renders the local project launcher from IPC data", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maestro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Codex" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Board" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cockpit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("starts the default provider from the composer", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: "Codex" })).toHaveAttribute("aria-pressed", "true");
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
      provider: "codex",
      prompt: "Implement PTY launch",
      modelLabel: "GPT-5.5 Medium",
      modelId: "gpt-5.5",
      reasoningEffort: "medium",
      cols: 120,
      rows: 32
    });
    expect(await screen.findByRole("heading", { name: "Build dashboard" })).toBeInTheDocument();
  });

  it("keeps a newly launched chat selected while the dashboard refresh catches up", async () => {
    const newWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-new",
      projectId: "project-1",
      taskLabel: "New chat",
      branch: "main",
      baseRef: "main",
      path: "/tmp/maestro",
      state: "running",
      sharedWorkspace: true,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:10:00.000Z"
    };
    const newSession: DashboardSnapshot["sessions"][number] = {
      id: "session-new",
      workspaceId: "workspace-new",
      provider: "codex",
      modelLabel: "GPT-5.5 Medium",
      prompt: "New chat",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T16:10:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T16:10:00.000Z",
      preferred: false
    };
    const refreshedSnapshot: DashboardSnapshot = {
      ...snapshot,
      workspaces: [snapshot.workspaces[0] ?? missingWorkspace(), newWorkspace],
      sessions: [snapshot.sessions[0] ?? missingSession(), newSession],
      events: [
        snapshot.events[0] ?? missingEvent(),
        {
          id: "event-new",
          sessionId: "session-new",
          type: "message.completed",
          message: "New chat answer.",
          payload: {},
          createdAt: "2026-05-08T16:10:01.000Z"
        }
      ]
    };

    let resolveRefresh: ((data: DashboardSnapshot) => void) | null = null;
    let loadCount = 0;
    dashboardLoad.mockImplementation(() => {
      loadCount += 1;
      if (loadCount === 1) {
        return Promise.resolve(snapshot);
      }
      return new Promise<DashboardSnapshot>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    createCurrentWorkspace.mockResolvedValue(newWorkspace);
    launchProvider.mockResolvedValue(newSession);

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "New chat" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() => expect(loadCount).toBe(2));
    (resolveRefresh as ((data: DashboardSnapshot) => void) | null)?.(refreshedSnapshot);

    expect(await screen.findByText("New chat answer.")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toHaveAttribute("aria-pressed", "true");
  });

  it("starts Claude when selected in the composer", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Claude" }));
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Review this change" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        provider: "claude",
        prompt: "Review this change",
        modelLabel: "Claude Sonnet 4.6",
        modelId: "claude-sonnet-4-6",
        cols: 120,
        rows: 32
      })
    );
  });

  it("opens a sidebar session", async () => {
    dashboardLoad.mockResolvedValue({
      ...snapshot,
      workspaces: [
        ...(snapshot.workspaces[0] ? [snapshot.workspaces[0]] : []),
        {
          id: "workspace-2",
          projectId: "project-1",
          taskLabel: "Second chat",
          branch: "maestro/second-chat",
          baseRef: "main",
          path: "/tmp/worktrees/second-chat",
          state: "complete",
          sharedWorkspace: false,
          dirty: false,
          changedFiles: 0,
          lastActivityAt: "2026-05-08T16:04:00.000Z"
        }
      ],
      sessions: [
        ...(snapshot.sessions[0] ? [snapshot.sessions[0]] : []),
        {
          id: "session-2",
          workspaceId: "workspace-2",
          provider: "claude",
          modelLabel: "Claude Sonnet 4.6",
          prompt: "Second chat",
          state: "complete",
          attention: "review-ready",
          startedAt: "2026-05-08T16:00:00.000Z",
          completedAt: "2026-05-08T16:04:00.000Z",
          lastActivityAt: "2026-05-08T16:04:00.000Z",
          preferred: false
        }
      ],
      events: [
        ...(snapshot.events[0] ? [snapshot.events[0]] : []),
        {
          id: "event-2",
          sessionId: "session-2",
          type: "message.completed",
          message: "Second answer.",
          payload: {},
          createdAt: "2026-05-08T16:04:00.000Z"
        }
      ]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Second chat" }));

    expect(await screen.findByRole("heading", { name: "Second chat" })).toBeInTheDocument();
    expect(screen.getByText("Second answer.")).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument();
    expect(screen.queryByText("review-ready")).not.toBeInTheDocument();
    expect(screen.queryByText("complete")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second chat" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("shows a thinking indicator while a session is running", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByLabelText("Thinking")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Waiting for agent")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Send a follow-up")).not.toBeInTheDocument();
  });

  it("sends follow-up prompts to the selected live session", async () => {
    dashboardLoad.mockResolvedValue({
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({ ...session, state: "complete" }))
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Build dashboard" })).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Session prompt"), {
      target: { value: "continue with tests" }
    });
    fireEvent.click(screen.getByTitle("Send follow-up"));

    await waitFor(() =>
      expect(sendProviderInput).toHaveBeenCalledWith({
        sessionId: "session-1",
        input: "continue with tests\r"
      })
    );
  });

  it("submits the composer on Enter without reloading the page", async () => {
    render(<App />);

    const input = await screen.findByLabelText("Task prompt");
    fireEvent.change(input, { target: { value: "Implement PTY launch" } });

    const form = input.closest("form");
    if (!form) {
      throw new Error("Composer form not found");
    }

    // Dispatch a real submit event so we can read defaultPrevented after the
    // React onSubmit handler runs (a target-phase listener would observe the
    // pre-React state).
    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    act(() => {
      form.dispatchEvent(submitEvent);
    });

    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    expect(launchProvider).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Implement PTY launch", provider: "codex" })
    );
    expect(submitEvent.defaultPrevented).toBe(true);
  });

  it("returns to the composer from an open session via the project row", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Build dashboard" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Maestro" }));

    expect(await screen.findByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("discards a stale dashboard load when a newer load completes first", async () => {
    let resolveSlow: ((data: DashboardSnapshot) => void) | null = null;
    const slowSnapshot: DashboardSnapshot = {
      ...snapshot,
      projects: [
        {
          ...primaryProject(),
          name: "Stale-Project"
        }
      ]
    };
    const fastSnapshot: DashboardSnapshot = {
      ...snapshot,
      projects: [
        {
          ...primaryProject(),
          name: "Fresh-Project"
        }
      ]
    };

    let callCount = 0;
    dashboardLoad.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<DashboardSnapshot>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve(fastSnapshot);
    });

    render(<App />);

    // Wait for the first invocation to be in flight.
    await waitFor(() => expect(callCount).toBe(1));

    // Trigger a second load via visibility change.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2));

    // Now resolve the first (slow) load with stale data.
    (resolveSlow as ((data: DashboardSnapshot) => void) | null)?.(slowSnapshot);

    // Snapshot should reflect the second (fast) load result, not the stale first.
    expect(await screen.findByRole("button", { name: "Fresh-Project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stale-Project" })).not.toBeInTheDocument();
  });

  it("renders the dashboard error state with a Retry button and reloads on click", async () => {
    let attempts = 0;
    dashboardLoad.mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error("backend-fault"));
      }
      return Promise.resolve(snapshot);
    });

    render(<App />);

    expect(await screen.findByText(/backend-fault/)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);

    await waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
    expect(await screen.findByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
  });
});

describe("App without preload bridge", () => {
  it("renders the bridge-missing banner when window.maestro is undefined", async () => {
    const previousMaestro = window.maestro;
    delete (window as { maestro?: MaestroApi }).maestro;

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
        await screen.findByText(/Preload bridge unavailable; running on demo data/)
      ).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation
      });
      window.maestro = previousMaestro;
    }
  });
});

function primaryProject() {
  const project = snapshot.projects[0];
  if (!project) {
    throw new Error("Test snapshot must include a project");
  }
  return project;
}

function missingWorkspace(): never {
  throw new Error("Test snapshot must include a workspace");
}

function missingSession(): never {
  throw new Error("Test snapshot must include a session");
}

function missingEvent(): never {
  throw new Error("Test snapshot must include an event");
}

function missingApproval(): never {
  throw new Error("Test snapshot must include an approval");
}

function missingCheck(): never {
  throw new Error("Test snapshot must include a check");
}

function missingCheckpoint(): never {
  throw new Error("Test snapshot must include a checkpoint");
}
