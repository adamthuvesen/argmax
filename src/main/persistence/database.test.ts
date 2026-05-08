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
});
