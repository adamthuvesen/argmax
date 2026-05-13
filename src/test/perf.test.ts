// @vitest-environment node
import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../main/persistence/migrations.js";
import { buildFileTree } from "../renderer/lib/fileTree.js";
import { mergeDashboardDelta, emptySnapshot } from "../renderer/lib/snapshot.js";
import type { DashboardSnapshot, SessionSummary } from "../shared/types.js";

/**
 * SPEC P4.10 — bench harness. Each assertion pins a property documented in
 * `agents/docs/performance.md`. A regression that pushes any of these past
 * the documented budget fails this suite in CI so we notice before users do.
 *
 * The numbers themselves are slack: budgets are 2–5× larger than the
 * measured wall-clock on an M2 Air so transient CI noise doesn't flake. If
 * a measurement gets close enough to fail to be visible noise, raise the
 * budget AND open a follow-up to investigate the regression — don't just
 * tighten the slack without thinking.
 */

function makeSession(i: number): SessionSummary {
  return {
    id: `session-${i}`,
    workspaceId: `workspace-${i}`,
    provider: "claude",
    modelLabel: "Claude Haiku 4.5",
    modelId: "claude-haiku-4-5",
    providerConversationId: null,
    prompt: `prompt ${i}`,
    state: "running",
    attention: "normal",
    startedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    completedAt: null,
    lastActivityAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    preferred: false
  };
}

describe("perf budgets", () => {
  it("mergeDashboardDelta over a 200-session payload completes p95 < 5 ms", () => {
    const base: DashboardSnapshot = {
      ...emptySnapshot,
      sessions: Array.from({ length: 200 }, (_, i) => makeSession(i))
    };
    const delta = { sessions: Array.from({ length: 200 }, (_, i) => makeSession(i + 200)) };

    const durations: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      mergeDashboardDelta(base, delta);
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(5);
  });

  it("buildFileTree over 10 000 entries completes < 50 ms", () => {
    const entries = [];
    for (let dir = 0; dir < 100; dir++) {
      for (let file = 0; file < 100; file++) {
        entries.push({ path: `pkg-${dir}/sub-${dir}/file-${file}.ts` });
      }
    }
    expect(entries).toHaveLength(10_000);

    const start = performance.now();
    const root = buildFileTree(entries);
    const elapsed = performance.now() - start;

    expect(root.children).toHaveLength(100);
    expect(elapsed).toBeLessThan(50);
  });

  it("runMigrations on an empty DB completes < 200 ms", () => {
    const database = new Database(":memory:");
    const start = performance.now();
    runMigrations(database);
    const elapsed = performance.now() - start;
    database.close();
    expect(elapsed).toBeLessThan(200);
  });
});
