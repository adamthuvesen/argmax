// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase, type MaestroDatabase } from "../persistence/database.js";
import { ApprovalService } from "./approvalService.js";
import type { ApprovalRequest, ProviderId } from "../../shared/types.js";

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

  it("deduplicates concurrent approval requests for the same command", () => {
    // 10.4: When the foundations-owned `findPendingApproval` helper is wired
    // into MaestroDatabase, two concurrent requests with the same tuple
    // produce exactly one pending row. We stub the helper here so the test
    // is independent of the foundations agent's merge order.
    const database = createDatabase(":memory:", { seed: false });
    installFindPendingApprovalStub(database);
    const sessionId = persistSessionFixture(database);
    const service = new ApprovalService(database);

    const command = "git reset --hard HEAD~1";
    const cwd = "/repo";
    const provider: ProviderId = "claude";

    const first = service.requestCommandApproval({ sessionId, command, cwd, provider });
    const second = service.requestCommandApproval({ sessionId, command, cwd, provider });
    const third = service.requestCommandApproval({ sessionId, command, cwd, provider });

    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    expect(third.allowed).toBe(false);

    // The follow-up calls return the *same* row; only one INSERT actually
    // ran. Without the SELECT-then-INSERT dedup inside the transaction the
    // approvals list would contain three pending duplicates.
    const snapshot = database.loadDashboard();
    const pendingForSession = snapshot.approvals.filter(
      (approval) => approval.sessionId === sessionId && approval.status === "pending"
    );
    expect(pendingForSession).toHaveLength(1);
    expect(second.approval?.id).toBe(first.approval?.id);
    expect(third.approval?.id).toBe(first.approval?.id);

    database.connection.close();
  });

  it("falls back to non-deduplicated behavior when findPendingApproval is unavailable", () => {
    // Foundation agent is responsible for adding `findPendingApproval` to
    // MaestroDatabase. This test exercises the bridge: the service must
    // remain usable even before the helper lands. Once the helper is
    // present this assertion can be tightened to require dedup.
    const database = createDatabase(":memory:", { seed: false });
    const sessionId = persistSessionFixture(database);
    // Strip the helper if foundations already added it, so we exercise the
    // legacy path explicitly.
    delete (database as unknown as { findPendingApproval?: unknown }).findPendingApproval;
    const service = new ApprovalService(database);

    const decision = service.requestCommandApproval({
      sessionId,
      command: "git reset --hard HEAD~1",
      cwd: "/repo",
      provider: "claude"
    });

    expect(decision.allowed).toBe(false);
    expect(decision.approval).not.toBeNull();

    database.connection.close();
  });

  it("returns the existing pending row when foundations findPendingApproval is wired", () => {
    // 10.8: validates the contract the foundations agent is adding to
    // MaestroDatabase. We stub the helper here so the test is self-
    // contained; the production helper will replace this stub.
    const database = createDatabase(":memory:", { seed: false });
    const sessionId = persistSessionFixture(database);
    const service = new ApprovalService(database);

    const command = "git reset --hard HEAD~1";
    const cwd = "/repo";
    const provider: ProviderId = "claude";

    const first = service.requestCommandApproval({ sessionId, command, cwd, provider });
    expect(first.approval).not.toBeNull();
    const firstId = first.approval!.id;

    // Stub the foundations-owned helper so the second call's transaction
    // sees the existing pending row.
    installFindPendingApprovalStub(database);

    const second = service.requestCommandApproval({ sessionId, command, cwd, provider });
    expect(second.approval?.id).toBe(firstId);
    expect(database.loadDashboard().approvals.filter((a) => a.status === "pending")).toHaveLength(1);

    database.connection.close();
  });

  it("transitions session state when an approval is resolved", () => {
    const database = createDatabase(":memory:", { seed: false });
    const sessionId = persistSessionFixture(database);
    const service = new ApprovalService(database);

    const decision = service.requestCommandApproval({
      sessionId,
      command: "git reset --hard HEAD~1",
      cwd: "/repo",
      provider: "claude"
    });
    expect(decision.approval).not.toBeNull();

    const resolved = service.resolveApproval(decision.approval!.id, "approved");
    expect(resolved.status).toBe("approved");

    const snapshot = database.loadDashboard();
    expect(snapshot.sessions[0]).toMatchObject({
      state: "running",
      attention: "normal"
    });
    const resolvedEvent = snapshot.events.find((event) => event.type === "approval.resolved");
    expect(resolvedEvent).toBeDefined();
    expect(resolvedEvent!.payload).toMatchObject({ status: "approved" });

    database.connection.close();
  });
});

/**
 * Test stub for the foundations-owned `findPendingApproval` helper. Mirrors
 * the contract: single-row SELECT keyed on (sessionId, command, cwd,
 * provider, status='pending'), returns null on miss. Once the foundations
 * agent ships the real helper this stub becomes a no-op.
 */
function installFindPendingApprovalStub(database: MaestroDatabase): void {
  (database as unknown as {
    findPendingApproval: (q: {
      sessionId: string;
      command: string;
      cwd: string;
      provider: ProviderId;
    }) => ApprovalRequest | null;
  }).findPendingApproval = (q) => {
    const snapshot = database.loadDashboard();
    return (
      snapshot.approvals.find(
        (approval) =>
          approval.sessionId === q.sessionId &&
          approval.command === q.command &&
          approval.cwd === q.cwd &&
          approval.provider === q.provider &&
          approval.status === "pending"
      ) ?? null
    );
  };
}

function persistSessionFixture(database: MaestroDatabase): string {
  database.persistProject({
    id: "project-1",
    name: "Fixture",
    repoPath: "/repo",
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      defaultProvider: "codex",
      defaultModelLabel: "GPT-5.5 Medium",
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
    modelLabel: "GPT-5.5 Medium",
    prompt: "Run commands",
    state: "running",
    attention: "normal"
  });

  return session.id;
}
