import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { DashboardSnapshot } from "../shared/types.js";

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
        defaultModelLabel: "GPT-5 Codex",
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
      modelLabel: "GPT-5 Codex",
      prompt: "Build dashboard",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T15:54:00.000Z"
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
  approvals: [],
  checks: [],
  checkpoints: []
};

describe("App", () => {
  beforeEach(() => {
    window.maestro = {
      dashboard: {
        load: () => Promise.resolve(snapshot)
      },
      projects: {
        list: () => Promise.resolve(snapshot.projects),
        register: () => Promise.resolve(primaryProject()),
        updateSettings: () => Promise.resolve(primaryProject())
      },
      workspaces: {
        createIsolated: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        createCurrent: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        refreshStatus: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        keep: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        archive: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace())
      },
      providers: {
        discover: () => Promise.resolve([])
      },
      health: {
        ping: () => Promise.resolve({ ok: true, timestamp: "2026-05-08T15:54:00.000Z" })
      }
    };
  });

  it("renders the local project dashboard from IPC data", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Project dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Maestro" })).toBeInTheDocument();
    expect(screen.getByText("/tmp/maestro")).toBeInTheDocument();
    expect(screen.getByText("Dashboard ready.")).toBeInTheDocument();
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
