/**
 * Seed data for tests and demo snapshots only. NEVER call from production
 * code — `createDatabase` defaults `seed: false` so the developer's real
 * local SQLite file is never overwritten with demo rows on launch
 * (audit H4, H5). Test callers opt in with `{ seed: true }`.
 *
 * Paths in this file are placeholders, not the maintainer's machine paths
 * (the previous seed leaked `/Users/user/...`).
 */
import type Database from "better-sqlite3";
import { PROVIDER_MODEL_DEFAULTS } from "../../shared/providerModels.js";

const now = "2026-05-08T15:30:00.000Z";
const SAMPLE_REPO_PATH = "/tmp/maestro-seed/sample-project";
const SAMPLE_WORKTREE_ROOT = "/tmp/maestro-seed/worktrees";

export function seedDemoData(database: Database.Database): void {
  const projectCount = (database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count;
  if (projectCount > 0) {
    return;
  }

  const insertProject = database.prepare(`
    INSERT INTO projects (
      id, name, repo_path, current_branch, default_branch, default_provider,
      default_model_label, worktree_location, setup_command, check_commands_json,
      ui_preferences_json, created_at, updated_at
    ) VALUES (
      @id, @name, @repoPath, @currentBranch, @defaultBranch, @defaultProvider,
      @defaultModelLabel, @worktreeLocation, @setupCommand, @checkCommandsJson,
      @uiPreferencesJson, @createdAt, @updatedAt
    )
  `);

  const insertWorkspace = database.prepare(`
    INSERT INTO workspaces (
      id, project_id, task_label, branch, base_ref, path, state, shared_workspace,
      dirty, changed_files, last_activity_at, created_at, updated_at
    ) VALUES (
      @id, @projectId, @taskLabel, @branch, @baseRef, @path, @state, @sharedWorkspace,
      @dirty, @changedFiles, @lastActivityAt, @createdAt, @updatedAt
    )
  `);

  const insertSession = database.prepare(`
    INSERT INTO sessions (
      id, workspace_id, provider, model_label, prompt, state, attention,
      started_at, completed_at, last_activity_at
    ) VALUES (
      @id, @workspaceId, @provider, @modelLabel, @prompt, @state, @attention,
      @startedAt, @completedAt, @lastActivityAt
    )
  `);

  const insertEvent = database.prepare(`
    INSERT INTO events (id, session_id, type, message, payload_json, created_at)
    VALUES (@id, @sessionId, @type, @message, @payloadJson, @createdAt)
  `);

  const insertApproval = database.prepare(`
    INSERT INTO approvals (
      id, session_id, command, cwd, provider, risk_level, status, created_at, resolved_at
    ) VALUES (
      @id, @sessionId, @command, @cwd, @provider, @riskLevel, @status, @createdAt, @resolvedAt
    )
  `);

  const insertCheck = database.prepare(`
    INSERT INTO checks (
      id, workspace_id, command, status, exit_code, summary, started_at, completed_at
    ) VALUES (
      @id, @workspaceId, @command, @status, @exitCode, @summary, @startedAt, @completedAt
    )
  `);

  const insertCheckpoint = database.prepare(`
    INSERT INTO checkpoints (id, workspace_id, label, branch, git_ref, patch_path, created_at)
    VALUES (@id, @workspaceId, @label, @branch, @gitRef, @patchPath, @createdAt)
  `);

  const seed = database.transaction(() => {
    insertProject.run({
      id: "project-maestro",
      name: "Maestro",
      repoPath: SAMPLE_REPO_PATH,
      currentBranch: "main",
      defaultBranch: "main",
      defaultProvider: "codex",
      defaultModelLabel: PROVIDER_MODEL_DEFAULTS.codex.label,
      worktreeLocation: SAMPLE_WORKTREE_ROOT,
      setupCommand: "npm install",
      checkCommandsJson: JSON.stringify(["npm run lint", "npm test", "npm run build"]),
      uiPreferencesJson: JSON.stringify({ density: "comfortable", accent: "mint" }),
      createdAt: now,
      updatedAt: now
    });

    const workspaces = [
      {
        id: "workspace-ui-board",
        taskLabel: "Design parallel agent board",
        branch: "maestro/agent-board",
        state: "running",
        dirty: 1,
        changedFiles: 8,
        lastActivityAt: "2026-05-08T15:54:00.000Z"
      },
      {
        id: "workspace-review-studio",
        taskLabel: "Build review studio shell",
        branch: "maestro/review-studio",
        state: "complete",
        dirty: 1,
        changedFiles: 14,
        lastActivityAt: "2026-05-08T15:48:00.000Z"
      },
      {
        id: "workspace-approval-gate",
        taskLabel: "Gate destructive shell commands",
        branch: "maestro/approval-gate",
        state: "waiting",
        dirty: 0,
        changedFiles: 2,
        lastActivityAt: "2026-05-08T15:42:00.000Z"
      },
      {
        id: "workspace-provider-probe",
        taskLabel: "Probe Codex structured mode",
        branch: "maestro/codex-probe",
        state: "failed",
        dirty: 0,
        changedFiles: 0,
        lastActivityAt: "2026-05-08T15:35:00.000Z"
      }
    ];

    for (const workspace of workspaces) {
      insertWorkspace.run({
        id: workspace.id,
        projectId: "project-maestro",
        taskLabel: workspace.taskLabel,
        branch: workspace.branch,
        baseRef: "main",
        path: `${SAMPLE_WORKTREE_ROOT}/${workspace.branch.replace(/\//g, "-")}`,
        state: workspace.state,
        sharedWorkspace: 0,
        dirty: workspace.dirty,
        changedFiles: workspace.changedFiles,
        lastActivityAt: workspace.lastActivityAt,
        createdAt: now,
        updatedAt: workspace.lastActivityAt
      });
    }

    const sessions = [
      {
        id: "session-ui-board",
        workspaceId: "workspace-ui-board",
        provider: "codex",
        modelLabel: PROVIDER_MODEL_DEFAULTS.codex.label,
        prompt: "Create compact session lanes for parallel monitoring.",
        state: "running",
        attention: "normal",
        completedAt: null,
        lastActivityAt: "2026-05-08T15:54:00.000Z"
      },
      {
        id: "session-review-studio",
        workspaceId: "workspace-review-studio",
        provider: "claude",
        modelLabel: PROVIDER_MODEL_DEFAULTS.claude.label,
        prompt: "Build the first review studio shell.",
        state: "complete",
        attention: "review-ready",
        completedAt: "2026-05-08T15:48:00.000Z",
        lastActivityAt: "2026-05-08T15:48:00.000Z"
      },
      {
        id: "session-approval-gate",
        workspaceId: "workspace-approval-gate",
        provider: "codex",
        modelLabel: PROVIDER_MODEL_DEFAULTS.codex.label,
        prompt: "Add deterministic dangerous-action detection.",
        state: "waiting",
        attention: "approval-needed",
        completedAt: null,
        lastActivityAt: "2026-05-08T15:42:00.000Z"
      },
      {
        id: "session-provider-probe",
        workspaceId: "workspace-provider-probe",
        provider: "claude",
        modelLabel: PROVIDER_MODEL_DEFAULTS.claude.label,
        prompt: "Evaluate provider structured-mode launch probes.",
        state: "failed",
        attention: "failed",
        completedAt: "2026-05-08T15:35:00.000Z",
        lastActivityAt: "2026-05-08T15:35:00.000Z"
      }
    ];

    for (const session of sessions) {
      insertSession.run({
        ...session,
        startedAt: "2026-05-08T15:30:00.000Z"
      });
    }

    insertEvent.run({
      id: "event-board-message",
      sessionId: "session-ui-board",
      type: "message.completed",
      message: "Agent board skeleton is rendering; tuning density and attention markers.",
      payloadJson: JSON.stringify({ surface: "agent-board" }),
      createdAt: "2026-05-08T15:54:00.000Z"
    });
    insertEvent.run({
      id: "event-review-complete",
      sessionId: "session-review-studio",
      type: "session.completed",
      message: "Review studio shell is ready for local diff wiring.",
      payloadJson: JSON.stringify({ exitCode: 0 }),
      createdAt: "2026-05-08T15:48:00.000Z"
    });
    insertEvent.run({
      id: "event-approval-needed",
      sessionId: "session-approval-gate",
      type: "approval.requested",
      message: "Approval needed before deleting a generated worktree.",
      payloadJson: JSON.stringify({ riskLevel: "high" }),
      createdAt: "2026-05-08T15:42:00.000Z"
    });
    insertEvent.run({
      id: "event-probe-failed",
      sessionId: "session-provider-probe",
      type: "error",
      message: "Structured probe exited before emitting JSON.",
      payloadJson: JSON.stringify({ exitCode: 2 }),
      createdAt: "2026-05-08T15:35:00.000Z"
    });

    insertApproval.run({
      id: "approval-delete-worktree",
      sessionId: "session-approval-gate",
      command: `git worktree remove ${SAMPLE_WORKTREE_ROOT}/old-attempt`,
      cwd: SAMPLE_REPO_PATH,
      provider: "codex",
      riskLevel: "high",
      status: "pending",
      createdAt: "2026-05-08T15:42:00.000Z",
      resolvedAt: null
    });

    insertCheck.run({
      id: "check-review-build",
      workspaceId: "workspace-review-studio",
      command: "npm run build",
      status: "passed",
      exitCode: 0,
      summary: "Renderer and main process compiled successfully.",
      startedAt: "2026-05-08T15:45:00.000Z",
      completedAt: "2026-05-08T15:46:00.000Z"
    });

    insertCheckpoint.run({
      id: "checkpoint-review-baseline",
      workspaceId: "workspace-review-studio",
      label: "Before diff wiring",
      branch: "maestro/review-studio",
      gitRef: "maestro/review-studio",
      patchPath: null,
      createdAt: "2026-05-08T15:47:00.000Z"
    });
  });

  seed();
}
