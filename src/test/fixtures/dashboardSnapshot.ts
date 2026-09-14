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
        archiveOnMerge: false,
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
      kind: "git",
      dirty: true,
      changedFiles: 3,
      lastActivityAt: "2026-05-08T15:54:00.000Z",
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
    }
  ],
  sessions: [
    {
      id: "session-1",
      workspaceId: "workspace-1",
      provider: "codex",
      // A current, non-default catalog model: the picker resolves labels from
      // the catalog, so a retired id here would render as the provider default
      // and mask what these tests actually check.
      modelLabel: "GPT-5.6 Terra",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "Build dashboard",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T15:54:00.000Z",
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 0,
      imported: false,
      launchKind: "agent",
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
  checks: []
};

export function dashboardListSnapshot(
  data: DashboardSnapshot
): Awaited<ReturnType<ArgmaxApi["dashboard"]["list"]>> {
  return {
    projects: data.projects,
    workspaces: data.workspaces,
    sessions: data.sessions,
    checks: data.checks
  };
}

export function workspaceStatusSnapshot(
  data: DashboardSnapshot
): Awaited<ReturnType<ArgmaxApi["workspaces"]["status"]>> {
  return {
    workspaces: data.workspaces,
    sessions: data.sessions,
    checks: data.checks
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
      archiveOnMerge: false,
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

/**
 * A full workspace row, so a test spells out only the fields it is about.
 * Defaults are the padding every hand-written fixture agreed on: a finished,
 * clean, unpinned isolated worktree in the primary project.
 */
export function workspaceRow(
  overrides: Partial<DashboardSnapshot["workspaces"][number]> = {}
): DashboardSnapshot["workspaces"][number] {
  return {
    id: "workspace-2",
    projectId: "project-1",
    taskLabel: "Second chat",
    branch: "argmax/second-chat",
    baseRef: "main",
    path: "/tmp/worktrees/second-chat",
    state: "complete",
    sharedWorkspace: false,
    kind: "git",
    dirty: false,
    changedFiles: 0,
    lastActivityAt: "2026-05-08T16:04:00.000Z",
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
    prActivityAt: null,
    ...overrides
  };
}

/** The session counterpart of {@link workspaceRow}: a finished Claude turn. */
export function sessionRow(
  overrides: Partial<DashboardSnapshot["sessions"][number]> = {}
): DashboardSnapshot["sessions"][number] {
  return {
    id: "session-2",
    workspaceId: "workspace-2",
    provider: "claude",
    modelLabel: "Sonnet 5",
    modelId: "claude-sonnet-5",
    permissionMode: "auto-approve",
    providerConversationId: "session-2",
    prompt: "Second chat",
    state: "complete",
    attention: "review-ready",
    startedAt: "2026-05-08T16:00:00.000Z",
    completedAt: "2026-05-08T16:04:00.000Z",
    lastActivityAt: "2026-05-08T16:04:00.000Z",
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextTokens: 0,
    imported: false,
    launchKind: "agent",
    ...overrides
  };
}
