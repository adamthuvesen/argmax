// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase } from "./database.js";
import { seedProject, seedSession, seedWorkspace } from "./databaseTestFixtures.js";

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

  it("orders projects by the newest session or workspace activity", () => {
    const database = createDatabase(":memory:", { seed: false });
    const sessionHotProject = seedProject(database, "session-hot");
    const workspaceHotProject = seedProject(database, "workspace-hot");
    seedWorkspace(database, "ws-session-hot", sessionHotProject, "running");
    seedWorkspace(database, "ws-workspace-hot", workspaceHotProject, "running");
    seedSession(database, "s-session-hot", "ws-session-hot");

    database.connection
      .prepare("UPDATE workspaces SET last_activity_at = ? WHERE id = ?")
      .run("2026-05-12T10:00:00.000Z", "ws-session-hot");
    database.connection
      .prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?")
      .run("2026-05-12T12:00:00.000Z", "s-session-hot");
    database.connection
      .prepare("UPDATE workspaces SET last_activity_at = ? WHERE id = ?")
      .run("2026-05-12T11:00:00.000Z", "ws-workspace-hot");

    const projects = database.listProjects();

    expect(projects[0]?.id).toBe("session-hot");
    expect(projects[0]?.latestActivityAt).toBe("2026-05-12T12:00:00.000Z");
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
