// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase } from "./database.js";

describe("createDatabase", () => {
  it("runs migrations and seeds a useful local demo snapshot", () => {
    const database = createDatabase(":memory:");

    const snapshot = database.loadDashboard();

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.workspaces).toHaveLength(4);
    expect(snapshot.sessions.some((session) => session.attention === "approval-needed")).toBe(true);
    expect(snapshot.approvals[0]?.status).toBe("pending");
    expect(snapshot.checks[0]?.status).toBe("passed");

    database.connection.close();
  });

  it("resolves approval requests without deleting the audit record", () => {
    const database = createDatabase(":memory:");
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
    const database = createDatabase(":memory:");
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
});
