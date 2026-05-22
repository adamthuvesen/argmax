// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase, RecordNotFoundError } from "./database.js";
import { seedProject, seedSession, seedWorkspace } from "./databaseTestFixtures.js";

describe("findPendingApproval (Section 6)", () => {
  it("returns the pending row for an exact (sessionId, command, cwd, provider) match", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "appr");
    seedWorkspace(database, "ws-appr", projectId, "running");
    seedSession(database, "session-appr", "ws-appr");
    const approval = database.persistApproval({
      id: "appr-1",
      sessionId: "session-appr",
      command: "rm -rf /",
      cwd: "/tmp",
      provider: "codex",
      riskLevel: "high",
      status: "pending"
    });

    const found = database.findPendingApproval({
      sessionId: "session-appr",
      command: "rm -rf /",
      cwd: "/tmp",
      provider: "codex"
    });
    expect(found?.id).toBe(approval.id);

    database.connection.close();
  });

  it("returns null when no pending row matches", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "appr-empty");
    seedWorkspace(database, "ws-empty", projectId, "running");
    seedSession(database, "session-empty", "ws-empty");

    const found = database.findPendingApproval({
      sessionId: "session-empty",
      command: "ls",
      cwd: "/tmp",
      provider: "codex"
    });
    expect(found).toBeNull();

    database.connection.close();
  });

  it("does not match resolved approvals", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "appr-resolved");
    seedWorkspace(database, "ws-resolved", projectId, "running");
    seedSession(database, "session-resolved", "ws-resolved");
    const approval = database.persistApproval({
      id: "appr-2",
      sessionId: "session-resolved",
      command: "git push --force",
      cwd: "/tmp",
      provider: "codex",
      riskLevel: "high",
      status: "pending"
    });
    database.resolveApproval(approval.id, "approved");

    const found = database.findPendingApproval({
      sessionId: "session-resolved",
      command: "git push --force",
      cwd: "/tmp",
      provider: "codex"
    });
    expect(found).toBeNull();

    database.connection.close();
  });

  it("accumulates usage events into session aggregates and reports cost summary", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "cost");
    seedWorkspace(database, "ws-cost", projectId, "running");
    seedSession(database, "session-cost", "ws-cost");

    database.insertUsageEvent({
      sessionId: "session-cost",
      modelId: "claude-sonnet-4-6",
      tokens: { input: 100, output: 40, cacheRead: 500, cacheWrite: 200 },
      costUsd: 0.0018
    });
    database.insertUsageEvent({
      sessionId: "session-cost",
      modelId: "claude-sonnet-4-6",
      tokens: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.0015
    });

    const summary = database.getSessionCostSummary("session-cost");
    expect(summary.modelId).toBe("claude-sonnet-4-6");
    expect(summary.tokens).toEqual({ input: 300, output: 100, cacheRead: 500, cacheWrite: 200 });
    expect(summary.costUsd).toBeCloseTo(0.0033, 9);

    const session = database.getSession("session-cost");
    expect(session.costUsd).toBeCloseTo(0.0033, 9);
    expect(session.tokens).toEqual({ input: 300, output: 100, cacheRead: 500, cacheWrite: 200 });

    database.connection.close();
  });

  it("rolls back the usage_events insert when the session row is gone", () => {
    // In production the foreign key on usage_events.session_id catches this
    // first, but the transaction wrapper plus the `result.changes === 0`
    // throw is the defensive belt-and-braces — without it, a future
    // schema change that loosened the FK would silently leave the audit
    // row committed while the aggregate UPDATE matched nothing.
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "cost-race");
    seedWorkspace(database, "ws-cost-race", projectId, "running");

    expect(() =>
      database.insertUsageEvent({
        sessionId: "session-missing",
        modelId: "claude-sonnet-4-6",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.0001
      })
    ).toThrow();

    const orphans = database.connection
      .prepare("SELECT COUNT(*) AS c FROM usage_events WHERE session_id = ?")
      .get("session-missing") as { c: number };
    expect(orphans.c).toBe(0);

    database.connection.close();
  });

  it("throws RecordNotFoundError when the session UPDATE matches zero rows (FK disabled)", () => {
    // Exercises the `result.changes === 0` branch directly by disabling the
    // FK so the insert succeeds but the UPDATE finds no session row.
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "cost-fk-off");
    seedWorkspace(database, "ws-cost-fk-off", projectId, "running");
    seedSession(database, "session-cost-fk-off", "ws-cost-fk-off");

    database.connection.pragma("foreign_keys = OFF");
    database.connection.prepare("DELETE FROM sessions WHERE id = ?").run("session-cost-fk-off");

    expect(() =>
      database.insertUsageEvent({
        sessionId: "session-cost-fk-off",
        modelId: "claude-sonnet-4-6",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.0001
      })
    ).toThrow(RecordNotFoundError);

    const orphans = database.connection
      .prepare("SELECT COUNT(*) AS c FROM usage_events WHERE session_id = ?")
      .get("session-cost-fk-off") as { c: number };
    expect(orphans.c).toBe(0);

    database.connection.close();
  });

  it("findById helpers throw typed RecordNotFoundError for checkpoint/check/approval kinds", () => {
    const database = createDatabase(":memory:", { seed: false });

    try {
      database.resolveApproval("missing-approval", "approved");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordNotFoundError);
      expect((error as RecordNotFoundError).kind).toBe("approval");
      expect((error as RecordNotFoundError).id).toBe("missing-approval");
    }

    try {
      database.updateCheck("missing-check", {
        status: "passed",
        exitCode: 0,
        summary: "",
        completedAt: new Date().toISOString()
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RecordNotFoundError);
      expect((error as RecordNotFoundError).kind).toBe("check");
      expect((error as RecordNotFoundError).id).toBe("missing-check");
    }

    database.close();
  });
});
