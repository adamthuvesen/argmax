import type { ArgmaxApi, DashboardSnapshot } from "../../shared/types.js";

/** Default dashboard fixture for App integration tests. */
export const defaultDashboardSnapshot: DashboardSnapshot = {
  projects: [
    {
      id: "project-1",
      name: "Argmax",
      repoPath: "/tmp/argmax",
      currentBranch: "main",
      defaultBranch: "main",
      settings: {
        defaultProvider: "codex",
        defaultModelLabel: "GPT-5.3 Codex",
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
      branch: "argmax/dashboard",
      baseRef: "main",
      path: "/tmp/worktrees/dashboard",
      state: "running",
      sharedWorkspace: false,
      dirty: true,
      changedFiles: 3,
      lastActivityAt: "2026-05-08T15:54:00.000Z",
      pinned: false
    }
  ],
  sessions: [
    {
      id: "session-1",
      workspaceId: "workspace-1",
      provider: "codex",
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "medium",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "Build dashboard",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T15:54:00.000Z",
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

export function dashboardListSnapshot(
  data: DashboardSnapshot
): Awaited<ReturnType<ArgmaxApi["dashboard"]["list"]>> {
  return {
    projects: data.projects,
    workspaces: data.workspaces,
    sessions: data.sessions,
    checks: data.checks,
    checkpoints: data.checkpoints
  };
}

export function workspaceStatusSnapshot(
  data: DashboardSnapshot
): Awaited<ReturnType<ArgmaxApi["workspaces"]["status"]>> {
  return {
    workspaces: data.workspaces,
    sessions: data.sessions,
    checks: data.checks,
    checkpoints: data.checkpoints
  };
}

export function primaryProject(snapshot: DashboardSnapshot = defaultDashboardSnapshot) {
  const project = snapshot.projects[0];
  if (!project) {
    throw new Error("Test snapshot must include a project");
  }
  return project;
}

export function secondProject(): DashboardSnapshot["projects"][number] {
  return {
    id: "project-2",
    name: "Dotfiles",
    repoPath: "/tmp/dotfiles",
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      defaultProvider: "codex",
      defaultModelLabel: "GPT-5.3 Codex",
      worktreeLocation: "/tmp/dotfiles-worktrees",
      setupCommand: "",
      checkCommands: []
    },
    counts: {
      active: 0,
      blocked: 0,
      failed: 0,
      reviewReady: 0
    },
    latestActivityAt: "2026-05-08T16:30:00.000Z"
  };
}

export function missingWorkspace(): never {
  throw new Error("Test snapshot must include a workspace");
}

export function missingSession(): never {
  throw new Error("Test snapshot must include a session");
}

export function missingCheck(): never {
  throw new Error("Test snapshot must include a check");
}
