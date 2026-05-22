// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase } from "./database.js";
import { seedProject, seedSession, seedWorkspace } from "./databaseTestFixtures.js";

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

  it("persists session agent mode and defaults older writes to edit", () => {
    const database = createDatabase(":memory:", { seed: false });
    seedProject(database);
    seedWorkspace(database, "workspace-1", "p-1", "running");

    const session = database.persistSession({
      id: "session-1",
      workspaceId: "workspace-1",
      provider: "codex",
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.3-codex",
      prompt: "plan this",
      state: "running",
      attention: "normal"
    });
    expect(session.agentMode).toBe("auto");

    const updated = database.updateSessionAgentMode("session-1", { agentMode: "plan" });
    expect(updated.agentMode).toBe("plan");
    expect(database.getSession("session-1").agentMode).toBe("plan");

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

  it("sets wal_autocheckpoint pragma at boot (audit P1.15)", () => {
    // audit-2026-05-11 / SPEC P1.15 — without an explicit
    // `wal_autocheckpoint`, the WAL file can grow without bound on
    // long-running sessions. Pragma is set in `createDatabase` and
    // surfaces in the diagnostics panel (Phase 7).
    const database = createDatabase(":memory:");
    const value = database.connection.pragma("wal_autocheckpoint", { simple: true });
    expect(value).toBe(1000);
    database.connection.close();
  });

  it("loadPreferredSessionIds query uses the ui_state PK index (audit P1.13)", () => {
    // audit-2026-05-11 / SPEC P1.13 — the prior `LIKE 'preferred-attempt:%'`
    // query skipped the PK index unless `case_sensitive_like` was ON. The
    // current half-open range query uses the PK index regardless. This test
    // pins that property via `EXPLAIN QUERY PLAN`.
    const database = createDatabase(":memory:", { seed: true });

    const plan = database.connection
      .prepare(
        "EXPLAIN QUERY PLAN SELECT value_json FROM ui_state WHERE key >= 'preferred-attempt:' AND key < 'preferred-attempt;'"
      )
      .all() as Array<{ detail: string }>;

    const detail = plan.map((row) => row.detail).join(" | ");
    // The PK on ui_state is `key`; SQLite reports the plan as `SEARCH … USING
    // PRIMARY KEY (key>? AND key<?)`. The pre-fix LIKE plan reported `SCAN`.
    expect(detail).toMatch(/SEARCH|PRIMARY KEY/);
    expect(detail).not.toMatch(/^SCAN ui_state\b/);

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
