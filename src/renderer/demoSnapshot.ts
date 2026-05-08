import type { DashboardSnapshot } from "../shared/types.js";

export const demoSnapshot: DashboardSnapshot = {
  projects: [
    {
      id: "project-maestro",
      name: "Maestro",
      repoPath: "/Users/user/dev/maestro",
      currentBranch: "main",
      defaultBranch: "main",
      settings: {
        defaultProvider: "codex",
        defaultModelLabel: "GPT-5 Codex",
        worktreeLocation: "/Users/user/dev/.maestro/worktrees",
        setupCommand: "npm install",
        checkCommands: ["npm run lint", "npm test", "npm run build"]
      },
      counts: {
        active: 2,
        blocked: 0,
        failed: 1,
        reviewReady: 1
      },
      latestActivityAt: "2026-05-08T15:54:00.000Z"
    }
  ],
  workspaces: [
    {
      id: "workspace-ui-board",
      projectId: "project-maestro",
      taskLabel: "Design parallel agent board",
      branch: "maestro/agent-board",
      baseRef: "main",
      path: "/Users/user/dev/.maestro/worktrees/maestro-agent-board",
      state: "running",
      sharedWorkspace: false,
      dirty: true,
      changedFiles: 8,
      lastActivityAt: "2026-05-08T15:54:00.000Z"
    },
    {
      id: "workspace-review-studio",
      projectId: "project-maestro",
      taskLabel: "Build review studio shell",
      branch: "maestro/review-studio",
      baseRef: "main",
      path: "/Users/user/dev/.maestro/worktrees/maestro-review-studio",
      state: "complete",
      sharedWorkspace: false,
      dirty: true,
      changedFiles: 14,
      lastActivityAt: "2026-05-08T15:48:00.000Z"
    },
    {
      id: "workspace-approval-gate",
      projectId: "project-maestro",
      taskLabel: "Gate destructive shell commands",
      branch: "maestro/approval-gate",
      baseRef: "main",
      path: "/Users/user/dev/.maestro/worktrees/maestro-approval-gate",
      state: "waiting",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 2,
      lastActivityAt: "2026-05-08T15:42:00.000Z"
    }
  ],
  sessions: [
    {
      id: "session-ui-board",
      workspaceId: "workspace-ui-board",
      provider: "codex",
      modelLabel: "GPT-5 Codex",
      prompt: "Create compact session lanes for parallel monitoring.",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T15:54:00.000Z",
      preferred: false
    },
    {
      id: "session-review-studio",
      workspaceId: "workspace-review-studio",
      provider: "claude",
      modelLabel: "Claude Sonnet",
      prompt: "Build the first review studio shell.",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: "2026-05-08T15:48:00.000Z",
      lastActivityAt: "2026-05-08T15:48:00.000Z",
      preferred: true
    },
    {
      id: "session-approval-gate",
      workspaceId: "workspace-approval-gate",
      provider: "codex",
      modelLabel: "GPT-5 Codex",
      prompt: "Add deterministic dangerous-action detection.",
      state: "waiting",
      attention: "approval-needed",
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T15:42:00.000Z",
      preferred: false
    }
  ],
  events: [
    {
      id: "event-board-message",
      sessionId: "session-ui-board",
      type: "message.completed",
      message: "Agent board skeleton is rendering; tuning density and attention markers.",
      payload: { surface: "agent-board" },
      createdAt: "2026-05-08T15:54:00.000Z"
    },
    {
      id: "event-review-complete",
      sessionId: "session-review-studio",
      type: "session.completed",
      message: "Review studio shell is ready for local diff wiring.",
      payload: { exitCode: 0 },
      createdAt: "2026-05-08T15:48:00.000Z"
    },
    {
      id: "event-approval-needed",
      sessionId: "session-approval-gate",
      type: "approval.requested",
      message: "Approval needed before deleting a generated worktree.",
      payload: { riskLevel: "high" },
      createdAt: "2026-05-08T15:42:00.000Z"
    }
  ],
  rawOutputs: [
    {
      id: "raw-board-output",
      sessionId: "session-ui-board",
      stream: "pty",
      content: "Running layout pass...\n",
      createdAt: "2026-05-08T15:54:00.000Z"
    }
  ],
  approvals: [
    {
      id: "approval-delete-worktree",
      sessionId: "session-approval-gate",
      command: "git worktree remove /Users/user/dev/.maestro/worktrees/old-attempt",
      cwd: "/Users/user/dev/maestro",
      provider: "codex",
      riskLevel: "high",
      status: "pending",
      createdAt: "2026-05-08T15:42:00.000Z",
      resolvedAt: null
    }
  ],
  checks: [
    {
      id: "check-review-build",
      workspaceId: "workspace-review-studio",
      command: "npm run build",
      status: "passed",
      exitCode: 0,
      summary: "Renderer and main process compiled successfully.",
      startedAt: "2026-05-08T15:45:00.000Z",
      completedAt: "2026-05-08T15:46:00.000Z"
    }
  ],
  checkpoints: []
};
