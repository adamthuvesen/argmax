// @vitest-environment node
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../renderer/lib/diff.js";
import { buildFileTree } from "../renderer/lib/fileTree.js";
import { searchFilePaths } from "../renderer/lib/paletteSearch.js";
import { mergeDashboardDelta, emptySnapshot } from "../renderer/lib/snapshot.js";
import type { DashboardSnapshot, SessionSummary, TimelineEvent } from "../shared/types.js";

/**
 * SPEC P4.10 — bench harness. Each assertion pins a property documented in
 * `docs/performance.md`. A regression that pushes any of these past
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
    modelLabel: "Haiku 4.5",
    modelId: "claude-haiku-4-5",
    permissionMode: "auto-approve",
    providerConversationId: null,
    prompt: `prompt ${i}`,
    state: "running",
    attention: "normal",
    startedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    completedAt: null,
    lastActivityAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  };
}

function percentile(sortedDurations: number[], ratio: number): number {
  if (sortedDurations.length === 0) return 0;
  const index = Math.ceil(sortedDurations.length * ratio) - 1;
  return sortedDurations[Math.max(0, Math.min(index, sortedDurations.length - 1))] ?? 0;
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
    const p95 = percentile(durations, 0.95);
    expect(p95).toBeLessThan(5);
  });

  it("mergeDashboardDelta with a 500-delta streamed answer + tool rows stays p95 < 5 ms", () => {
    // Token streaming floods the event list; the eviction-protection partition
    // (snapshot.ts mergeEventsBounded) runs on the hot merge path. Guard it.
    const base: DashboardSnapshot = {
      ...emptySnapshot,
      events: [
        { id: "u1", sessionId: "s", type: "user.message", message: "", payload: {}, createdAt: new Date(2026, 0, 1).toISOString(), rowCursor: 1 },
        { id: "c1", sessionId: "s", type: "command.started", message: "", payload: {}, createdAt: new Date(2026, 0, 1, 0, 0, 1).toISOString(), rowCursor: 2 }
      ]
    };
    const delta = {
      events: Array.from({ length: 500 }, (_, i): TimelineEvent => ({
        id: `d${i}`,
        sessionId: "s",
        type: "message.delta",
        message: "tok",
        payload: {},
        createdAt: new Date(2026, 0, 1, 0, 1, 0).toISOString(),
        rowCursor: 100 + i
      }))
    };

    const durations: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      mergeDashboardDelta(base, delta);
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    expect(percentile(durations, 0.95)).toBeLessThan(5);
  });

  it("buildFileTree over 10 000 entries completes < 75 ms", () => {
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
    // 75 ms slack under full-suite load (see parseUnifiedDiff note above).
    expect(elapsed).toBeLessThan(75);
  });

  it("searchFilePaths over 10 000 entries completes p95 < 25 ms", () => {
    const paths = Array.from({ length: 10_000 }, (_, i) =>
      i === 9_500 ? "src/renderer/components/NeedlePanel.tsx" : `packages/pkg-${i}/src/file-${i}.ts`
    );

    const durations: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const hits = searchFilePaths(paths, "Needle", 8);
      durations.push(performance.now() - start);
      expect(hits[0]).toBe("src/renderer/components/NeedlePanel.tsx");
    }
    durations.sort((a, b) => a - b);
    expect(percentile(durations, 0.95)).toBeLessThan(25);
  });

  it("parseUnifiedDiff over a 500-hunk synthetic diff completes p95 < 20 ms", () => {
    // Build a synthetic diff that mirrors what `git diff` would emit for a
    // 50-file changeset with 10 hunks per file and 20 lines per hunk.
    // ReviewPanel parses this exact format on every "open diff" — pinning
    // the budget here means a regression in the parser fails CI.
    const sections: string[] = [];
    for (let file = 0; file < 50; file++) {
      sections.push(`diff --git a/file-${file}.ts b/file-${file}.ts`);
      sections.push(`--- a/file-${file}.ts`);
      sections.push(`+++ b/file-${file}.ts`);
      for (let hunk = 0; hunk < 10; hunk++) {
        const start = hunk * 30 + 1;
        sections.push(`@@ -${start},20 +${start},20 @@ fn ${file}_${hunk}`);
        for (let line = 0; line < 20; line++) {
          // Mix of context, additions, deletions so the parser visits every
          // branch on the hot path, not just the cheap "context" arm.
          if (line % 5 === 0) sections.push(`+added line ${line} in hunk ${hunk} file ${file}`);
          else if (line % 7 === 0) sections.push(`-removed line ${line} in hunk ${hunk} file ${file}`);
          else sections.push(` context line ${line} in hunk ${hunk} file ${file}`);
        }
      }
    }
    const diff = sections.join("\n");

    const durations: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      parseUnifiedDiff(diff);
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    const p95 = percentile(durations, 0.95);
    // 20 ms slack: p95 stays ~3–8 ms in isolation but can spike when the full
    // suite runs hot on a shared CI runner (audit-2026-05-18 perf flake).
    expect(p95).toBeLessThan(20);
  });
});
