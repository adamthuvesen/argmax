// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase, type MaestroDatabase } from "../persistence/database.js";
import { ApprovalService } from "./approvalService.js";

describe("ApprovalService", () => {
  it("allows low-risk commands without creating approvals", () => {
    const database = createDatabase(":memory:", { seed: false });
    const sessionId = persistSessionFixture(database);
    const service = new ApprovalService(database);

    const decision = service.requestCommandApproval({
      sessionId,
      command: "git status --short",
      cwd: "/repo",
      provider: "codex"
    });

    expect(decision.allowed).toBe(true);
    expect(decision.approval).toBeNull();
    expect(database.loadDashboard().approvals).toHaveLength(0);

    database.connection.close();
  });

  it("blocks dangerous commands behind a persisted approval request", () => {
    const database = createDatabase(":memory:", { seed: false });
    const sessionId = persistSessionFixture(database);
    const service = new ApprovalService(database);

    const decision = service.requestCommandApproval({
      sessionId,
      command: "git reset --hard HEAD~1",
      cwd: "/repo",
      provider: "claude"
    });

    const snapshot = database.loadDashboard();
    expect(decision.allowed).toBe(false);
    expect(decision.approval).toMatchObject({
      command: "git reset --hard HEAD~1",
      riskLevel: "high",
      status: "pending"
    });
    expect(snapshot.sessions[0]).toMatchObject({
      state: "waiting",
      attention: "approval-needed"
    });
    expect(snapshot.events[0]).toMatchObject({
      type: "approval.requested",
      message: "Hard git reset"
    });

    database.connection.close();
  });
});

function persistSessionFixture(database: MaestroDatabase): string {
  database.persistProject({
    id: "project-1",
    name: "Fixture",
    repoPath: "/repo",
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      defaultProvider: "codex",
      defaultModelLabel: "GPT-5 Codex",
      worktreeLocation: "/repo/.worktrees",
      setupCommand: "",
      checkCommands: []
    }
  });
  database.persistWorkspace({
    id: "workspace-1",
    projectId: "project-1",
    taskLabel: "Approval",
    branch: "maestro/approval",
    baseRef: "main",
    path: "/repo/.worktrees/approval",
    state: "running",
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0
  });
  const session = database.persistSession({
    id: "session-1",
    workspaceId: "workspace-1",
    provider: "codex",
    modelLabel: "GPT-5 Codex",
    prompt: "Run commands",
    state: "running",
    attention: "normal"
  });

  return session.id;
}
