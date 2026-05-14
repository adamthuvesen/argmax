import type { DashboardSnapshot } from "../shared/types.js";
import { PROVIDER_MODEL_DEFAULTS } from "../shared/providerModels.js";

export const demoSnapshot: DashboardSnapshot = {
  projects: [
    {
      id: "project-argmax",
      name: "Argmax",
      repoPath: "~/code/sample-project",
      currentBranch: "main",
      defaultBranch: "main",
      settings: {
        defaultProvider: "codex",
        defaultModelLabel: PROVIDER_MODEL_DEFAULTS.codex.label,
        worktreeLocation: "~/code/.argmax/worktrees",
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
      projectId: "project-argmax",
      taskLabel: "Design parallel agent board",
      branch: "argmax/agent-board",
      baseRef: "main",
      path: "~/code/.argmax/worktrees/argmax-agent-board",
      state: "running",
      sharedWorkspace: false,
      dirty: true,
      changedFiles: 8,
      lastActivityAt: "2026-05-08T15:54:00.000Z",
      pinned: false
    },
    {
      id: "workspace-review-studio",
      projectId: "project-argmax",
      taskLabel: "Build review studio shell",
      branch: "argmax/review-studio",
      baseRef: "main",
      path: "~/code/.argmax/worktrees/argmax-review-studio",
      state: "complete",
      sharedWorkspace: false,
      dirty: true,
      changedFiles: 14,
      lastActivityAt: "2026-05-08T15:48:00.000Z",
      pinned: false
    },
    {
      id: "workspace-approval-gate",
      projectId: "project-argmax",
      taskLabel: "Gate destructive shell commands",
      branch: "argmax/approval-gate",
      baseRef: "main",
      path: "~/code/.argmax/worktrees/argmax-approval-gate",
      state: "waiting",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 2,
      lastActivityAt: "2026-05-08T15:42:00.000Z",
      pinned: false
    }
  ],
  sessions: [
    {
      id: "session-ui-board",
      workspaceId: "workspace-ui-board",
      provider: "codex",
      modelLabel: PROVIDER_MODEL_DEFAULTS.codex.label,
      modelId: PROVIDER_MODEL_DEFAULTS.codex.modelId,
      reasoningEffort: PROVIDER_MODEL_DEFAULTS.codex.reasoningEffort,
      permissionMode: "auto-approve",
      providerConversationId: null,
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
      modelLabel: PROVIDER_MODEL_DEFAULTS.claude.label,
      modelId: PROVIDER_MODEL_DEFAULTS.claude.modelId,
      permissionMode: "auto-approve",
      providerConversationId: "session-review-studio",
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
      modelLabel: PROVIDER_MODEL_DEFAULTS.codex.label,
      modelId: PROVIDER_MODEL_DEFAULTS.codex.modelId,
      reasoningEffort: PROVIDER_MODEL_DEFAULTS.codex.reasoningEffort,
      permissionMode: "auto-approve",
      providerConversationId: null,
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
      id: "event-board-user",
      sessionId: "session-ui-board",
      type: "user.message",
      message: "Read the layout files and tell me how density is handled.",
      payload: {},
      createdAt: "2026-05-08T15:53:40.000Z"
    },
    {
      id: "event-board-announce",
      sessionId: "session-ui-board",
      type: "message.completed",
      message: "On it — let me read a few files first.",
      payload: {},
      createdAt: "2026-05-08T15:53:45.000Z"
    },
    {
      id: "event-board-tool-1-s",
      sessionId: "session-ui-board",
      type: "command.started",
      message: "Read",
      payload: { id: "tu_board_1", name: "Read", input: { file_path: "src/renderer/board/layout.ts" } },
      createdAt: "2026-05-08T15:53:46.000Z"
    },
    {
      id: "event-board-tool-1-c",
      sessionId: "session-ui-board",
      type: "command.completed",
      message: "tool_result",
      payload: { tool_use_id: "tu_board_1", content: "// layout pass\nexport function layout() { /* ... */ }" },
      createdAt: "2026-05-08T15:53:47.000Z"
    },
    {
      id: "event-board-tool-2-s",
      sessionId: "session-ui-board",
      type: "command.started",
      message: "Glob",
      payload: { id: "tu_board_2", name: "Glob", input: { pattern: "src/renderer/board/*.ts" } },
      createdAt: "2026-05-08T15:53:47.000Z"
    },
    {
      id: "event-board-tool-2-c",
      sessionId: "session-ui-board",
      type: "command.completed",
      message: "tool_result",
      payload: { tool_use_id: "tu_board_2", content: "src/renderer/board/layout.ts\nsrc/renderer/board/density.ts\nsrc/renderer/board/markers.ts" },
      createdAt: "2026-05-08T15:53:48.000Z"
    },
    {
      id: "event-board-tool-3-s",
      sessionId: "session-ui-board",
      type: "command.started",
      message: "Read",
      payload: { id: "tu_board_3", name: "Read", input: { file_path: "src/renderer/board" } },
      createdAt: "2026-05-08T15:53:49.000Z"
    },
    {
      id: "event-board-tool-3-c",
      sessionId: "session-ui-board",
      type: "command.completed",
      message: "tool_result",
      payload: { tool_use_id: "tu_board_3", is_error: true, content: "EISDIR: illegal operation on a directory" },
      createdAt: "2026-05-08T15:53:50.000Z"
    },
    {
      id: "event-board-tool-4-s",
      sessionId: "session-ui-board",
      type: "command.started",
      message: "Bash",
      payload: { id: "tu_board_4", name: "Bash", input: { command: "wc -l src/renderer/board/*.ts" } },
      createdAt: "2026-05-08T15:53:51.000Z"
    },
    {
      id: "event-board-tool-4-c",
      sessionId: "session-ui-board",
      type: "command.completed",
      message: "tool_result",
      payload: { tool_use_id: "tu_board_4", content: " 142 src/renderer/board/layout.ts\n  88 src/renderer/board/density.ts\n  56 src/renderer/board/markers.ts\n 286 total" },
      createdAt: "2026-05-08T15:53:53.000Z"
    },
    {
      id: "event-board-message",
      sessionId: "session-ui-board",
      type: "message.completed",
      message: "Agent board skeleton is rendering; tuning density and attention markers.\n\n- **layout.ts** owns the column grid (12-col, snap to 8px).\n- **density.ts** maps attention level → row height.\n- **markers.ts** paints the gutter indicators.",
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
      command: "git worktree remove ~/code/.argmax/worktrees/old-attempt",
      cwd: "~/code/sample-project",
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
