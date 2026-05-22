// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "./database.js";
import { listSessionIdsForWorkspace } from "./sessions.js";
import { seedProject, seedSession, seedWorkspace } from "./databaseTestFixtures.js";

describe("preferred session lookup (audit M25 / M20)", () => {
  it("marks preferred via a point ui_state read instead of scanning all keys", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "pref-project");
    seedWorkspace(database, "ws-pref", projectId, "running", "task-alpha");
    seedSession(database, "session-pref", "ws-pref");

    const now = new Date().toISOString();
    database.connection
      .prepare("INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run(
        `preferred-attempt:${projectId}:${encodeURIComponent("task-alpha")}`,
        JSON.stringify({ sessionId: "session-pref" }),
        now
      );

    const prepareSpy = vi.spyOn(database.connection, "prepare");
    const session = database.getSession("session-pref");
    expect(session.preferred).toBe(true);

    const uiStateReads = prepareSpy.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("FROM ui_state") && sql.includes("key = ?")
    );
    expect(uiStateReads.length).toBeGreaterThanOrEqual(1);
    expect(
      prepareSpy.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("FROM ui_state") && sql.includes("LIKE")
      )
    ).toBe(false);

    prepareSpy.mockRestore();
    database.close();
  });

  it("lists session ids for archive-time notification forget (audit M20)", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "archive-forget");
    seedWorkspace(database, "ws-archive", projectId, "running");
    seedSession(database, "session-a", "ws-archive");
    seedSession(database, "session-b", "ws-archive");
    seedSession(database, "session-other", "ws-archive");
    // Different workspace — must not be included.
    seedWorkspace(database, "ws-other", projectId, "running", "other-task");
    seedSession(database, "session-else", "ws-other");

    const ids = listSessionIdsForWorkspace(database.connection, "ws-archive").sort();
    expect(ids).toEqual(["session-a", "session-b", "session-other"]);

    database.close();
  });
});
