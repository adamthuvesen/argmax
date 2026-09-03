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
        worktreeLocation: "~/code/.argmax/worktrees",
        setupCommand: "npm install",
        checkCommands: ["npm run lint", "npm test", "npm run tauri:build"]
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
      kind: "git",
      dirty: true,
      changedFiles: 8,
      lastActivityAt: "2026-05-08T15:54:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
    },
    {
      // The multitask dispatched from the review-studio chat: same checkout,
      // no sidebar row of its own — it lives in that chat's dock.
      id: "workspace-multitask-changelog",
      projectId: "project-argmax",
      taskLabel: "Fix the changelog date",
      branch: "argmax/review-studio",
      baseRef: "main",
      path: "~/code/argmax",
      state: "complete",
      sharedWorkspace: true,
      kind: "git",
      dirty: true,
      changedFiles: 1,
      lastActivityAt: "2026-05-08T15:54:02.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
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
      kind: "git",
      dirty: true,
      changedFiles: 14,
      lastActivityAt: "2026-05-08T15:48:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
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
      kind: "git",
      dirty: false,
      changedFiles: 2,
      lastActivityAt: "2026-05-08T15:42:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null
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
    },
    {
      id: "session-multitask-changelog",
      workspaceId: "workspace-multitask-changelog",
      provider: "claude",
      modelLabel: PROVIDER_MODEL_DEFAULTS.claude.label,
      modelId: PROVIDER_MODEL_DEFAULTS.claude.modelId,
      permissionMode: "auto-approve",
      providerConversationId: "session-multitask-changelog",
      prompt: "The changelog says 2025 for the 0.4 entry — fix it.",
      state: "complete",
      attention: "normal",
      startedAt: "2026-05-08T15:53:58.000Z",
      completedAt: "2026-05-08T15:54:02.000Z",
      lastActivityAt: "2026-05-08T15:54:02.000Z",
      launchedBySessionId: "session-review-studio",
      launchKind: "multitask",
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
      // Fresh stamp (module-load relative) so the demo shows the Priority
      // section — a fixed date would fall past the 24h staleness gate.
      attentionChangedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: "2026-05-08T15:48:00.000Z",
      lastActivityAt: "2026-05-08T15:48:00.000Z",
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
      attentionChangedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T15:42:00.000Z",
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
      id: "event-board-tool-5-s",
      sessionId: "session-ui-board",
      type: "command.started",
      message: "Task",
      payload: {
        id: "tu_board_5",
        name: "Task",
        input: {
          description: "Audit board density heuristics",
          prompt:
            "Read src/renderer/board/density.ts and check whether the attention-level → row-height mapping handles the edge cases: 0 sessions, single session, and >12 sessions. Report findings with file:line refs. Don't modify code.",
          subagent_type: "general-purpose"
        }
      },
      createdAt: "2026-05-08T15:53:54.000Z"
    },
    {
      id: "ev-sub-think",
      sessionId: "session-ui-board",
      type: "message.delta",
      message: "The mapping lives in density.ts. I should read it first, then check the three edge cases the prompt names.",
      payload: { parent_tool_use_id: "tu_board_5", thinking: true },
      createdAt: "2026-05-08T15:53:54.200Z"
    },
    {
      id: "ev-sub-narr-1",
      sessionId: "session-ui-board",
      type: "message.completed",
      message: "Reading the density heuristics now.",
      payload: { parent_tool_use_id: "tu_board_5" },
      createdAt: "2026-05-08T15:53:54.400Z"
    },
    {
      id: "ev-sub-t1-s",
      sessionId: "session-ui-board",
      type: "command.started",
      message: "Read",
      payload: { id: "tu_sub_1", name: "Read", parent_tool_use_id: "tu_board_5", input: { file_path: "src/renderer/board/density.ts" } },
      createdAt: "2026-05-08T15:53:54.500Z"
    },
    {
      id: "ev-sub-t1-c",
      sessionId: "session-ui-board",
      type: "command.completed",
      message: "tool_result",
      payload: { tool_use_id: "tu_sub_1", content: "export function rowHeight(count: number): number { ... }" },
      createdAt: "2026-05-08T15:53:54.900Z"
    },
    {
      id: "ev-sub-t2-s",
      sessionId: "session-ui-board",
      type: "command.started",
      message: "Grep",
      payload: { id: "tu_sub_2", name: "Grep", parent_tool_use_id: "tu_board_5", input: { pattern: "rowHeight", path: "src/renderer" } },
      createdAt: "2026-05-08T15:53:55.000Z"
    },
    {
      id: "ev-sub-t2-c",
      sessionId: "session-ui-board",
      type: "command.completed",
      message: "tool_result",
      payload: { tool_use_id: "tu_sub_2", content: "density.ts:18\ndensity.ts:32\nlayout.ts:71" },
      createdAt: "2026-05-08T15:53:55.400Z"
    },
    {
      id: "ev-sub-narr-2",
      sessionId: "session-ui-board",
      type: "message.completed",
      message: "Now checking how the cap behaves above twelve sessions.",
      payload: { parent_tool_use_id: "tu_board_5" },
      createdAt: "2026-05-08T15:53:55.500Z"
    },
    {
      id: "ev-sub-t3-s",
      sessionId: "session-ui-board",
      type: "command.started",
      message: "Bash",
      payload: { id: "tu_sub_3", name: "Bash", parent_tool_use_id: "tu_board_5", input: { command: "rg -n 'MAX_ROWS' src/renderer/board" } },
      createdAt: "2026-05-08T15:53:55.600Z"
    },
    {
      id: "ev-sub-t3-c",
      sessionId: "session-ui-board",
      type: "command.completed",
      message: "tool_result",
      payload: { tool_use_id: "tu_sub_3", content: "density.ts:32:const MAX_ROWS = 12;" },
      createdAt: "2026-05-08T15:53:56.000Z"
    },
    {
      id: "ev-sub-t4-s",
      sessionId: "session-ui-board",
      type: "command.started",
      message: "Bash",
      payload: { id: "tu_sub_4", name: "Bash", parent_tool_use_id: "tu_board_5", input: { command: "npx vitest run src/renderer/board" } },
      createdAt: "2026-05-08T15:53:56.100Z"
    },
    {
      id: "ev-sub-t4-c",
      sessionId: "session-ui-board",
      type: "command.completed",
      message: "tool_result",
      payload: { tool_use_id: "tu_sub_4", content: "3 passed" },
      createdAt: "2026-05-08T15:53:56.600Z"
    },
    {
      id: "event-board-tool-5-c",
      sessionId: "session-ui-board",
      type: "command.completed",
      message: "tool_result",
      payload: {
        tool_use_id: "tu_board_5",
        content:
          "density.ts:18 handles 0 sessions by returning the default row height (good); :32 caps at 12 sessions but the cap is silent — flag in UI when truncated."
      },
      createdAt: "2026-05-08T15:53:58.000Z"
    },
    {
      id: "event-board-tool-6-s",
      sessionId: "session-ui-board",
      type: "command.started",
      message: "mcp__claude_ai_Slack__slack_search_public",
      payload: {
        id: "tu_board_6",
        name: "mcp__claude_ai_Slack__slack_search_public",
        input: { query: "attention markers density" }
      },
      createdAt: "2026-05-08T15:53:58.500Z"
    },
    {
      id: "event-board-tool-6-c",
      sessionId: "session-ui-board",
      type: "command.completed",
      message: "tool_result",
      payload: {
        tool_use_id: "tu_board_6",
        content: "2 results in #design-system: the gutter markers were agreed at 3 levels (calm, attention, urgent)."
      },
      createdAt: "2026-05-08T15:53:59.000Z"
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
      id: "event-board-multitask-launched",
      sessionId: "session-review-studio",
      type: "multitask.launched",
      message: "Running alongside: Fix the changelog date",
      payload: {
        childSessionId: "session-multitask-changelog",
        childWorkspaceId: "workspace-multitask-changelog",
        taskLabel: "Fix the changelog date",
        prompt: "The changelog says 2025 for the 0.4 entry — fix it.",
        worktree: false
      },
      createdAt: "2026-05-08T15:53:58.000Z"
    },
    {
      id: "event-multitask-child-user",
      sessionId: "session-multitask-changelog",
      type: "user.message",
      message: "The changelog says 2025 for the 0.4 entry — fix it.",
      payload: { source: "multitask" },
      createdAt: "2026-05-08T15:53:58.000Z"
    },
    {
      id: "event-multitask-child-answer",
      sessionId: "session-multitask-changelog",
      type: "message.completed",
      message: "Corrected the 0.4 heading to 2026 in CHANGELOG.md.",
      payload: {},
      createdAt: "2026-05-08T15:54:02.000Z"
    },
    {
      id: "event-board-multitask-finished",
      sessionId: "session-review-studio",
      type: "multitask.finished",
      message: "Fix the changelog date finished alongside",
      payload: {
        childSessionId: "session-multitask-changelog",
        taskLabel: "Fix the changelog date",
        state: "complete",
        answer: "Corrected the 0.4 heading to 2026 in CHANGELOG.md."
      },
      createdAt: "2026-05-08T15:54:02.000Z"
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
      command: "git worktree remove ~/code/.argmax/worktrees/draft-attempt",
      cwd: "~/code/sample-project",
      provider: "codex",
      providerInvocationId: null,
      providerRequestId: null,
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
      command: "npm run tauri:build",
      status: "passed",
      exitCode: 0,
      summary: "Renderer and main process compiled successfully.",
      startedAt: "2026-05-08T15:45:00.000Z",
      completedAt: "2026-05-08T15:46:00.000Z"
    }
  ]
};
