// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase } from "./database.js";
import { seedProject, seedSession, seedWorkspace } from "./databaseTestFixtures.js";

describe("database workspace and related features", () => {
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

  it("deleteProject cascades to workspaces, sessions, and dependent rows", () => {
    const database = createDatabase(":memory:", { seed: false });

    seedProject(database, "project-keep");
    seedWorkspace(database, "ws-keep", "project-keep", "running");
    seedSession(database, "session-keep", "ws-keep");

    seedProject(database, "project-delete");
    seedWorkspace(database, "ws-del-1", "project-delete", "running");
    seedWorkspace(database, "ws-del-2", "project-delete", "complete");
    seedSession(database, "session-del-1", "ws-del-1");
    seedSession(database, "session-del-2", "ws-del-2");

    database.deleteProject("project-delete");

    const snapshot = database.listDashboard();

    expect(snapshot.projects.map((p) => p.id)).toEqual(["project-keep"]);
    expect(snapshot.workspaces.map((w) => w.id)).toEqual(["ws-keep"]);
    expect(snapshot.sessions.map((s) => s.id)).toEqual(["session-keep"]);

    // FK cascades are declared on workspaces/sessions/events/etc. — confirm
    // the deletion didn't leave dangling rows in the workspaces or sessions
    // tables either (the public lister filters, but raw counts must be zero).
    const orphanWorkspaces = database.connection
      .prepare("SELECT COUNT(*) AS n FROM workspaces WHERE project_id = ?")
      .get("project-delete") as { n: number };
    expect(orphanWorkspaces.n).toBe(0);
    const orphanSessions = database.connection
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE workspace_id IN ('ws-del-1','ws-del-2')")
      .get() as { n: number };
    expect(orphanSessions.n).toBe(0);

    database.close();
  });

  it("guarantees a session for every shown workspace even when older sessions fall below the 200-row cap", () => {
    // Repro for the "sidebar click does nothing" bug: the workspace list and
    // session list are each capped at 200, independently. With many newer
    // sessions in a few workspaces, the latest session of an older workspace
    // can drop out of the session top-200 while the workspace itself stays
    // in the workspace top-200. The renderer's .find(workspaceId) then
    // returns undefined and the click silently dies.
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "session-coverage");

    // One older workspace with one older session — both in the top-200 by
    // workspace activity, but the session is the oldest.
    seedWorkspace(database, "ws-old", projectId, "complete");
    seedSession(database, "session-old", "ws-old");
    database.connection
      .prepare("UPDATE workspaces SET last_activity_at = ? WHERE id = ?")
      .run(new Date(2026, 0, 1, 0, 0, 0).toISOString(), "ws-old");
    database.connection
      .prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?")
      .run(new Date(2026, 0, 1, 0, 0, 0).toISOString(), "session-old");

    // One very-recent workspace with 250 newer sessions — these will fill the
    // session top-200, pushing session-old below the cap.
    seedWorkspace(database, "ws-busy", projectId, "running");
    database.connection
      .prepare("UPDATE workspaces SET last_activity_at = ? WHERE id = ?")
      .run(new Date(2026, 5, 1, 0, 0, 0).toISOString(), "ws-busy");
    for (let i = 0; i < 250; i++) {
      const id = `session-busy-${String(i).padStart(3, "0")}`;
      seedSession(database, id, "ws-busy");
      database.connection
        .prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?")
        .run(new Date(2026, 5, 1, 0, 0, i).toISOString(), id);
    }

    const snapshot = database.listWorkspaceStatus();

    // Both workspaces are visible.
    const workspaceIds = snapshot.workspaces.map((w) => w.id).sort();
    expect(workspaceIds).toEqual(["ws-busy", "ws-old"]);

    // Crucially: a session exists for ws-old even though session-old's
    // last_activity_at is far older than the 200th newest session for ws-busy.
    expect(snapshot.sessions.some((s) => s.workspaceId === "ws-old")).toBe(true);
    expect(snapshot.sessions.some((s) => s.id === "session-old")).toBe(true);

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

  it("persists and lists learnings ranked by verified, hits, then recency", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "learn-1");

    const older = database.insertLearning({
      projectId,
      kind: "pitfall",
      summary: "Always run prettier before commit"
    });
    const newer = database.insertLearning({
      projectId,
      kind: "convention",
      summary: "Use absolute imports under src/"
    });
    // Force a deterministic time ordering — the helper stamps both inserts
    // with the same millisecond when they happen back-to-back.
    database.connection
      .prepare("UPDATE learnings SET last_seen_at = ? WHERE id = ?")
      .run("2026-05-01T00:00:00.000Z", older.id);
    database.connection
      .prepare("UPDATE learnings SET last_seen_at = ? WHERE id = ?")
      .run("2026-05-02T00:00:00.000Z", newer.id);

    const all = database.listLearnings(projectId);
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe(newer.id); // newest first
    expect(all[1]?.id).toBe(older.id);

    // Bump hits on older — should bubble to top
    database.connection.prepare("UPDATE learnings SET hits = 5 WHERE id = ?").run(older.id);
    const reordered = database.listLearnings(projectId);
    expect(reordered[0]?.id).toBe(older.id);

    database.connection.close();
  });

  it("ranks events FTS5 matches and returns the originating session", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "search-1");
    seedWorkspace(database, "ws-search", projectId, "running");
    seedSession(database, "session-search-1", "ws-search");
    seedSession(database, "session-search-2", "ws-search");

    database.persistTimelineEvent({
      id: "event-search-1",
      sessionId: "session-search-1",
      type: "message.completed",
      message: "Investigate flaky migration in CI",
      payload: {}
    });
    database.persistTimelineEvent({
      id: "event-search-2",
      sessionId: "session-search-2",
      type: "message.completed",
      message: "Refactor session orchestration around lazy loading",
      payload: {}
    });
    database.persistTimelineEvent({
      id: "event-search-3",
      sessionId: "session-search-2",
      type: "message.completed",
      message: "no relevant terms here",
      payload: {}
    });

    const hits = database.searchEvents({ query: "migration" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ eventId: "event-search-1", sessionId: "session-search-1" });
    expect(hits[0]?.snippet).toContain("<b>");

    // Broader query crosses sessions; ranking favors specificity but both
    // should appear since they each contain the term.
    const broad = database.searchEvents({ query: "session" });
    const sessionIds = broad.map((row) => row.sessionId).sort();
    expect(sessionIds).toContain("session-search-2");

    database.connection.close();
  });
});
