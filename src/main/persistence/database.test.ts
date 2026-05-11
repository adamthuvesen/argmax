// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase, RecordNotFoundError, type ArgmaxDatabase } from "./database.js";
import type { ProjectSettings, WorkspaceState } from "../../shared/types.js";

const settings: ProjectSettings = {
  defaultProvider: "codex",
  defaultModelLabel: "GPT-5.3 Codex Spark Low",
  worktreeLocation: "/tmp/wt",
  setupCommand: "",
  checkCommands: []
};

function seedProject(database: ArgmaxDatabase, projectId = "p-1"): string {
  database.persistProject({
    id: projectId,
    name: `proj-${projectId}`,
    repoPath: `/tmp/repo-${projectId}`,
    currentBranch: "main",
    defaultBranch: "main",
    settings
  });
  return projectId;
}

function seedWorkspace(
  database: ArgmaxDatabase,
  workspaceId: string,
  projectId: string,
  state: WorkspaceState,
  taskLabel = workspaceId
): void {
  database.persistWorkspace({
    id: workspaceId,
    projectId,
    taskLabel,
    branch: `branch-${workspaceId}`,
    baseRef: "main",
    path: `/tmp/${workspaceId}`,
    state,
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0
  });
}

function seedSession(
  database: ArgmaxDatabase,
  sessionId: string,
  workspaceId: string,
  attention: "normal" | "approval-needed" | "blocked" | "failed" | "review-ready" = "normal"
): void {
  database.persistSession({
    id: sessionId,
    workspaceId,
    provider: "codex",
    modelLabel: "x",
    modelId: "gpt-5.3-codex",
    reasoningEffort: "medium",
    prompt: "p",
    state: "running",
    attention
  });
}

describe("createDatabase", () => {
  it("runs migrations and seeds a useful local demo snapshot", () => {
    const database = createDatabase(":memory:", { seed: true });

    const snapshot = database.loadDashboard();

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.workspaces).toHaveLength(4);
    expect(snapshot.sessions.some((session) => session.attention === "approval-needed")).toBe(true);
    expect(snapshot.approvals[0]?.status).toBe("pending");
    expect(snapshot.checks[0]?.status).toBe("passed");

    database.connection.close();
  });

  it("resolves approval requests without deleting the audit record", () => {
    const database = createDatabase(":memory:", { seed: true });
    const approval = database.loadDashboard().approvals[0];
    if (!approval) {
      throw new Error("Seed data must include an approval");
    }

    const resolved = database.resolveApproval(approval.id, "approved");

    expect(resolved.status).toBe("approved");
    expect(resolved.resolvedAt).not.toBeNull();
    expect(database.loadDashboard().approvals[0]?.id).toBe(approval.id);

    database.connection.close();
  });

  it("marks one attempt as preferred without deleting sibling sessions", () => {
    const database = createDatabase(":memory:", { seed: true });
    const session = database.loadDashboard().sessions[0];
    if (!session) {
      throw new Error("Seed data must include sessions");
    }

    const preferred = database.selectPreferredAttempt(session.id);
    const snapshot = database.loadDashboard();

    expect(preferred.preferred).toBe(true);
    expect(snapshot.sessions).toHaveLength(4);
    expect(snapshot.sessions.find((item) => item.id === session.id)?.preferred).toBe(true);

    database.connection.close();
  });

  it("bounds cursor-based session event and raw output pages", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "cursor-limit");
    seedWorkspace(database, "ws-cursor-limit", projectId, "running");
    seedSession(database, "session-cursor-limit", "ws-cursor-limit");

    for (let i = 1; i <= 505; i += 1) {
      database.persistTimelineEvent({
        id: `event-limit-${i}`,
        sessionId: "session-cursor-limit",
        type: "message.delta",
        message: `event ${i}`,
        payload: {}
      });
    }
    for (let i = 1; i <= 105; i += 1) {
      database.persistRawOutput({
        id: `raw-limit-${i}`,
        sessionId: "session-cursor-limit",
        stream: "stdout",
        content: `raw ${i}`
      });
    }

    const first = database.listSessionEventsSince({
      sessionId: "session-cursor-limit",
      eventCursor: 0,
      rawOutputCursor: 0
    });
    const second = database.listSessionEventsSince({
      sessionId: "session-cursor-limit",
      eventCursor: first.eventCursor,
      rawOutputCursor: first.rawOutputCursor
    });

    expect(first.events).toHaveLength(500);
    expect(first.rawOutputs).toHaveLength(100);
    expect(first.events[0]?.id).toBe("event-limit-1");
    expect(first.events.at(-1)?.id).toBe("event-limit-500");
    expect(second.events.map((event) => event.id)).toEqual([
      "event-limit-501",
      "event-limit-502",
      "event-limit-503",
      "event-limit-504",
      "event-limit-505"
    ]);
    expect(second.rawOutputs.map((output) => output.id)).toEqual([
      "raw-limit-101",
      "raw-limit-102",
      "raw-limit-103",
      "raw-limit-104",
      "raw-limit-105"
    ]);

    database.connection.close();
  });
});

describe("focused dashboard reads", () => {
  it("lists dashboard chrome without session events, raw outputs, or approvals", () => {
    const database = createDatabase(":memory:", { seed: true });

    const snapshot = database.listDashboard();

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.workspaces.length).toBeGreaterThan(0);
    expect(snapshot.sessions.length).toBeGreaterThan(0);
    expect(snapshot.checks.length).toBeGreaterThan(0);
    expect(snapshot.checkpoints.length).toBeGreaterThan(0);
    expect("events" in snapshot).toBe(false);
    expect("rawOutputs" in snapshot).toBe(false);
    expect("approvals" in snapshot).toBe(false);

    database.connection.close();
  });

  it("returns only pending approvals from the focused approvals read", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "pending");
    seedWorkspace(database, "ws-pending", projectId, "running");
    seedSession(database, "session-pending", "ws-pending");
    const resolved = database.persistApproval({
      id: "approval-resolved",
      sessionId: "session-pending",
      command: "git push",
      cwd: "/tmp",
      provider: "codex",
      riskLevel: "medium",
      status: "pending"
    });
    database.persistApproval({
      id: "approval-pending",
      sessionId: "session-pending",
      command: "rm -rf dist",
      cwd: "/tmp",
      provider: "codex",
      riskLevel: "high",
      status: "pending"
    });
    database.resolveApproval(resolved.id, "approved");

    const approvals = database.listPendingApprovals();

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.id).toBe("approval-pending");

    database.connection.close();
  });

  it("loads a workspace status slice when workspace ids are provided", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "status");
    seedWorkspace(database, "ws-a", projectId, "running");
    seedWorkspace(database, "ws-b", projectId, "complete");
    seedSession(database, "session-a", "ws-a");
    seedSession(database, "session-b", "ws-b");
    database.persistCheck({ id: "check-a", workspaceId: "ws-a", command: "npm test", status: "running" });
    database.persistCheck({ id: "check-b", workspaceId: "ws-b", command: "npm lint", status: "passed" });

    const status = database.listWorkspaceStatus({ workspaceIds: ["ws-b"] });

    expect(status.workspaces.map((workspace) => workspace.id)).toEqual(["ws-b"]);
    expect(status.sessions.map((session) => session.id)).toEqual(["session-b"]);
    expect(status.checks.map((check) => check.id)).toEqual(["check-b"]);

    database.connection.close();
  });

  it("uses rowid cursors for session events and raw outputs", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "cursor");
    seedWorkspace(database, "ws-cursor", projectId, "running");
    seedSession(database, "session-cursor", "ws-cursor");
    database.persistTimelineEvent({
      id: "event-1",
      sessionId: "session-cursor",
      type: "message.delta",
      message: "one",
      payload: {}
    });
    database.persistRawOutput({
      id: "raw-1",
      sessionId: "session-cursor",
      stream: "stdout",
      content: "one"
    });

    const initial = database.listSessionEventsSince({ sessionId: "session-cursor" });
    database.persistTimelineEvent({
      id: "event-2",
      sessionId: "session-cursor",
      type: "message.delta",
      message: "two",
      payload: {}
    });
    database.persistRawOutput({
      id: "raw-2",
      sessionId: "session-cursor",
      stream: "stderr",
      content: "two"
    });

    const next = database.listSessionEventsSince({
      sessionId: "session-cursor",
      eventCursor: initial.eventCursor,
      rawOutputCursor: initial.rawOutputCursor
    });
    const empty = database.listSessionEventsSince({
      sessionId: "session-cursor",
      eventCursor: next.eventCursor,
      rawOutputCursor: next.rawOutputCursor
    });

    expect(initial.events.map((event) => event.id)).toEqual(["event-1"]);
    expect(initial.rawOutputs.map((output) => output.id)).toEqual(["raw-1"]);
    expect(next.events.map((event) => event.id)).toEqual(["event-2"]);
    expect(next.rawOutputs.map((output) => output.id)).toEqual(["raw-2"]);
    expect(empty.events).toEqual([]);
    expect(empty.rawOutputs).toEqual([]);
    expect(empty.eventCursor).toBe(next.eventCursor);
    expect(empty.rawOutputCursor).toBe(next.rawOutputCursor);

    database.connection.close();
  });
});

describe("listProjects aggregation (audit H9)", () => {
  it("returns all-zero counts for an empty project", () => {
    const database = createDatabase(":memory:", { seed: false });
    seedProject(database, "empty");

    const [project] = database.listProjects();
    expect(project.id).toBe("empty");
    expect(project.counts).toEqual({ active: 0, blocked: 0, failed: 0, reviewReady: 0 });

    database.connection.close();
  });

  it("does not multiply workspace counts by sibling sessions", () => {
    // One blocked workspace + three sessions on it should yield blocked=1
    // (not 3, which the prior aggregation would produce due to the
    // workspace×session double-count).
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "multi");
    seedWorkspace(database, "ws-blocked", projectId, "blocked");
    seedSession(database, "s1", "ws-blocked");
    seedSession(database, "s2", "ws-blocked");
    seedSession(database, "s3", "ws-blocked");

    const [project] = database.listProjects();
    // Workspace count contributes 1; no session attention=blocked.
    expect(project.counts.blocked).toBe(1);

    database.connection.close();
  });

  it("counts failed/review-ready independently across workspaces and session attention", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "mixed");
    seedWorkspace(database, "ws-failed-a", projectId, "failed");
    seedWorkspace(database, "ws-failed-b", projectId, "failed");
    seedWorkspace(database, "ws-complete", projectId, "complete");
    seedWorkspace(database, "ws-running", projectId, "running");
    // Five sessions sprinkled across the workspaces.
    seedSession(database, "s1", "ws-failed-a", "normal");
    seedSession(database, "s2", "ws-failed-b", "normal");
    seedSession(database, "s3", "ws-complete", "review-ready");
    seedSession(database, "s4", "ws-running", "normal");
    seedSession(database, "s5", "ws-running", "normal");

    const [project] = database.listProjects();
    // workspace_failed=2, no session attention=failed → failed=2.
    expect(project.counts.failed).toBe(2);
    // workspace_complete=1, plus one session attention=review-ready → reviewReady=2.
    expect(project.counts.reviewReady).toBe(2);

    database.connection.close();
  });
});

describe("selectPreferredAttempt atomicity (audit H12, task 10.3)", () => {
  it("two concurrent calls do not interleave; the returned session reflects the just-written preferred state", () => {
    // better-sqlite3 is synchronous, but the contract under test is that
    // each `selectPreferredAttempt` call wraps its read+write+re-read in a
    // single transaction so the returned summary reflects the row that
    // *its* call wrote (no overlap with a sibling call's transaction).
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "atom");
    seedWorkspace(database, "ws-atom", projectId, "running", "task-atom");
    seedSession(database, "session-a", "ws-atom");
    seedSession(database, "session-b", "ws-atom");

    // Issue both calls back-to-back. With the transaction wrap, the second
    // call's UPSERT takes effect for the same `(projectId, taskLabel)` key
    // and the read inside its transaction sees the new row. Without the
    // wrap, we previously returned a stale summary marked preferred=true
    // even though the persisted row pointed at the *other* session.
    const a = database.selectPreferredAttempt("session-a");
    const b = database.selectPreferredAttempt("session-b");

    expect(a.preferred).toBe(true);
    expect(b.preferred).toBe(true);

    // Final state: only session-b is the persisted preference.
    const snapshot = database.loadDashboard();
    const sessionA = snapshot.sessions.find((s) => s.id === "session-a");
    const sessionB = snapshot.sessions.find((s) => s.id === "session-b");
    expect(sessionA?.preferred).toBe(false);
    expect(sessionB?.preferred).toBe(true);

    database.connection.close();
  });
});

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

  it("caps listWorkspaceStatus at 200 rows and returns the newest first", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "limit-200");

    // Insert 250 workspaces with strictly increasing last_activity_at so we
    // can verify the cap drops the OLDEST rows, not the newest.
    for (let i = 0; i < 250; i++) {
      const id = `ws-${String(i).padStart(3, "0")}`;
      seedWorkspace(database, id, projectId, "running", id);
      // Bump last_activity_at to a deterministic per-row value.
      database.connection
        .prepare("UPDATE workspaces SET last_activity_at = ? WHERE id = ?")
        .run(new Date(2026, 0, 1, 0, 0, i).toISOString(), id);
    }

    const snapshot = database.listWorkspaceStatus();
    expect(snapshot.workspaces).toHaveLength(200);
    // Newest 200 are ws-249..ws-050 in DESC order.
    expect(snapshot.workspaces[0]?.id).toBe("ws-249");
    expect(snapshot.workspaces[199]?.id).toBe("ws-050");

    database.close();
  });

  it("loadPreferredSessionIds via range scan ignores neighboring ui_state keys", () => {
    // The range query is `key >= 'preferred-attempt:' AND key <
    // 'preferred-attempt;'`. Keys outside that range must not leak in even
    // if they look related (e.g. a typo like 'preferred-attempts').
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "prefer-range");
    seedWorkspace(database, "ws-prefer-range-a", projectId, "running", "task-a");
    seedSession(database, "session-a", "ws-prefer-range-a");
    seedWorkspace(database, "ws-prefer-range-b", projectId, "running", "task-b");
    seedSession(database, "session-b", "ws-prefer-range-b");

    database.selectPreferredAttempt("session-a");
    // Insert a noise row that LIKE 'preferred-attempt:%' would have caught
    // but the range query must skip — and a row outside the half-open range.
    const now = new Date().toISOString();
    database.connection
      .prepare(
        "INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)"
      )
      .run("preferred-attempts:other", JSON.stringify({ sessionId: "session-b" }), now);
    database.connection
      .prepare(
        "INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)"
      )
      .run("unrelated:key", JSON.stringify({ sessionId: "session-b" }), now);

    expect(database.getSession("session-a").preferred).toBe(true);
    expect(database.getSession("session-b").preferred).toBe(false);

    database.close();
  });

  it("close() clears the prune timer, closes the connection, and is idempotent", () => {
    const database = createDatabase(":memory:", { seed: false });
    expect(database.connection.open).toBe(true);

    database.close();
    expect(database.connection.open).toBe(false);

    // Second call must not throw — the timer is already cleared and the
    // connection is already closed.
    expect(() => database.close()).not.toThrow();
  });

  it("returns a zero cost summary for sessions with no usage rows", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "cost-empty");
    seedWorkspace(database, "ws-cost-empty", projectId, "running");
    seedSession(database, "session-cost-empty", "ws-cost-empty");

    const summary = database.getSessionCostSummary("session-cost-empty");
    expect(summary.costUsd).toBe(0);
    expect(summary.modelId).toBeNull();
    expect(summary.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    database.connection.close();
  });
});
