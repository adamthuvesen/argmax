// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase, pruneOldRawOutputs } from "./database.js";
import { seedProject, seedSession, seedWorkspace } from "./databaseTestFixtures.js";

describe("pruneOldRawOutputs (ralph D4)", () => {
  it("deletes raw_outputs rows older than 7 days and leaves fresh rows alone", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "prune-1");
    seedWorkspace(database, "ws-prune-1", projectId, "running");
    seedSession(database, "session-prune-1", "ws-prune-1");

    // Insert directly with backdated timestamps so we can verify the
    // SQL's "datetime('now', '-7 days')" boundary semantics. The prune SQL
    // compares `created_at < datetime('now', '-7 days')`, so rows at
    // exactly -7 days should be retained (strict <) and older rows
    // deleted.
    const insert = database.connection.prepare(
      "INSERT INTO raw_outputs (id, session_id, stream, content, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    const days = (n: number): string =>
      new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    insert.run("ro-old-10d", "session-prune-1", "stdout", "old", days(10));
    insert.run("ro-old-30d", "session-prune-1", "stdout", "older", days(30));
    insert.run("ro-old-boundary", "session-prune-1", "stdout", "old-boundary", days(7 + 1 / 24));
    insert.run("ro-fresh-boundary", "session-prune-1", "stdout", "fresh-boundary", days(7 - 1 / 24));
    insert.run("ro-fresh-1d", "session-prune-1", "stdout", "fresh", days(1));
    insert.run("ro-fresh-6d", "session-prune-1", "stdout", "near-edge", days(6));

    const countBefore = (
      database.connection.prepare("SELECT COUNT(*) AS c FROM raw_outputs").get() as { c: number }
    ).c;
    expect(countBefore).toBe(6);

    pruneOldRawOutputs(database.connection);

    const remaining = (
      database.connection
        .prepare("SELECT id FROM raw_outputs ORDER BY created_at ASC")
        .all() as Array<{ id: string }>
    ).map((row) => row.id);

    expect(remaining).toEqual(["ro-fresh-boundary", "ro-fresh-6d", "ro-fresh-1d"]);

    database.close();
  });

  it("is a no-op when there are no old rows", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "prune-empty");
    seedWorkspace(database, "ws-prune-empty", projectId, "running");
    seedSession(database, "session-prune-empty", "ws-prune-empty");

    // createDatabase already ran a one-shot prune; this confirms a second
    // call doesn't throw and doesn't touch fresh rows.
    expect(() => pruneOldRawOutputs(database.connection)).not.toThrow();

    database.close();
  });

  it("scales to 10k seeded old rows without timing out", () => {
    const database = createDatabase(":memory:", { seed: false });
    const projectId = seedProject(database, "prune-bulk");
    seedWorkspace(database, "ws-prune-bulk", projectId, "running");
    seedSession(database, "session-prune-bulk", "ws-prune-bulk");

    const insert = database.connection.prepare(
      "INSERT INTO raw_outputs (id, session_id, stream, content, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const tx = database.connection.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        insert.run(`ro-bulk-${i}`, "session-prune-bulk", "stdout", "x", oldTs);
      }
    });
    tx();

    const before = (
      database.connection.prepare("SELECT COUNT(*) AS c FROM raw_outputs").get() as { c: number }
    ).c;
    expect(before).toBe(10_000);

    pruneOldRawOutputs(database.connection);

    const after = (
      database.connection.prepare("SELECT COUNT(*) AS c FROM raw_outputs").get() as { c: number }
    ).c;
    expect(after).toBe(0);

    database.close();
  });
});
