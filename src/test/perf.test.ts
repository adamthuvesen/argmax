// @vitest-environment node
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../renderer/lib/diff.js";
import { buildFileTree } from "../renderer/lib/fileTree.js";
import { searchFilePaths } from "../renderer/lib/paletteSearch.js";
import { buildSessionToolCalls } from "../renderer/lib/sessionConversationModel.js";
import { mergeDashboardDelta, emptySnapshot } from "../renderer/lib/snapshot.js";
import { SessionTimelines } from "../renderer/lib/sessionTimelines.js";
import type { DashboardSnapshot, SessionSummary, TimelineEvent } from "../shared/types.js";

/**
 * Bench harness. Each assertion pins a property documented in
 * `docs/performance.md`. Budgets are milliseconds on an unloaded machine,
 * about 5× the median measured on an M2 Air (2026-11-06), so a 10× regression
 * fails. Re-measure before you raise one.
 *
 * `medianMs` keeps them honest on a busy machine (parallel agents, a shared
 * CI runner). Before each sample it times a fixed reference loop. Load slows
 * that loop and the code under test by the same factor, so the result is
 * divided by the reference loop's slowdown. A regression in the code under
 * test does not slow the reference loop, so it still fails. The median
 * ignores the samples a preemption lands on.
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
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextTokens: 0,
    imported: false,
    launchKind: "agent",
  };
}

// Median of referenceLoop() on an unloaded M2 Air. A faster machine clamps
// the slowdown at 1, so budgets never tighten below their stated value.
const REFERENCE_LOOP_MS = 1;

function referenceLoop(): number {
  const rows = Array.from({ length: 4_000 }, (_, i) => ({
    id: `row-${i}`,
    rank: (i * 7_919) % 4_000,
  }));
  rows.sort((a, b) => a.rank - b.rank);
  const byId = new Map(rows.map((row) => [row.id, row]));
  let total = 0;
  for (const row of rows) total += byId.get(row.id)?.rank ?? 0;
  return total;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Median wall time of `run`, scaled back to an unloaded machine. */
function medianMs(samples: number, run: (sample: number) => void): number {
  referenceLoop();
  const runs: number[] = [];
  const references: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let start = performance.now();
    referenceLoop();
    references.push(performance.now() - start);
    start = performance.now();
    run(sample);
    runs.push(performance.now() - start);
  }
  return median(runs) / Math.max(1, median(references) / REFERENCE_LOOP_MS);
}

describe("perf budgets", () => {
  it("updates one of eight session transcripts in median < 1 ms without notifying other panes", () => {
    const timelines = new SessionTimelines();
    const notifications = Array<number>(8).fill(0);
    const subscriptions = notifications.map((_, index) =>
      timelines.subscribe(`session-${index}`, () => {
        notifications[index] += 1;
      }),
    );
    const events: TimelineEvent[] = Array.from({ length: 4000 }, (_, index) => ({
      id: `retained-${index}`,
      sessionId: `session-${Math.floor(index / 500)}`,
      type: "message.delta",
      message: "token",
      payload: {},
      createdAt: "2026-09-05T00:00:00.000Z",
      rowCursor: index + 1,
    }));
    timelines.merge(events, []);
    notifications.fill(0);
    const updates = Array.from({ length: 100 }, (_, index): TimelineEvent => ({
      ...events[0],
      id: `new-${index}`,
      rowCursor: 4001 + index,
    }));
    expect(medianMs(100, (index) => timelines.merge([updates[index]], []))).toBeLessThan(1);
    expect(notifications).toEqual([100, 0, 0, 0, 0, 0, 0, 0]);
    subscriptions.forEach((unsubscribe) => unsubscribe());
  });

  it("mergeDashboardDelta over a 200-session payload completes median < 0.2 ms", () => {
    const base: DashboardSnapshot = {
      ...emptySnapshot,
      sessions: Array.from({ length: 200 }, (_, i) => makeSession(i)),
    };
    const delta = { sessions: Array.from({ length: 200 }, (_, i) => makeSession(i + 200)) };

    expect(medianMs(50, () => mergeDashboardDelta(base, delta))).toBeLessThan(0.2);
  });

  it("mergeDashboardDelta with a 500-delta streamed answer + tool rows stays median < 1 ms", () => {
    // Token streaming floods the event list; the eviction-protection partition
    // (snapshot.ts mergeEventsBounded) runs on the hot merge path. Guard it.
    const base: DashboardSnapshot = {
      ...emptySnapshot,
      events: [
        {
          id: "u1",
          sessionId: "s",
          type: "user.message",
          message: "",
          payload: {},
          createdAt: new Date(2026, 0, 1).toISOString(),
          rowCursor: 1,
        },
        {
          id: "c1",
          sessionId: "s",
          type: "command.started",
          message: "",
          payload: {},
          createdAt: new Date(2026, 0, 1, 0, 0, 1).toISOString(),
          rowCursor: 2,
        },
      ],
    };
    const delta = {
      events: Array.from({ length: 500 }, (_, i): TimelineEvent => ({
        id: `d${i}`,
        sessionId: "s",
        type: "message.delta",
        message: "tok",
        payload: {},
        createdAt: new Date(2026, 0, 1, 0, 1, 0).toISOString(),
        rowCursor: 100 + i,
      })),
    };

    expect(medianMs(50, () => mergeDashboardDelta(base, delta))).toBeLessThan(1);
  });

  it("a 1-event delta onto a 5 000-event snapshot stays median < 2.5 ms", () => {
    // The shape of every streamed chunk: one new row on top of a long
    // transcript, which the renderer pays for once per delta. Measured p95 was
    // 0.23 ms with the append fast path in mergeEventsBounded and 0.47 ms
    // without it, so this budget bounds the cost rather than telling the two
    // apart. The fast path's behaviour is pinned in snapshot.test.ts.
    const base: DashboardSnapshot = {
      ...emptySnapshot,
      events: Array.from({ length: 5_000 }, (_, i): TimelineEvent => ({
        id: `e${4_999 - i}`,
        sessionId: "s",
        type: "command.started",
        message: "",
        payload: {},
        createdAt: new Date(2026, 0, 1, 0, 0, 4_999 - i).toISOString(),
        rowCursor: 5_000 - i,
      })),
    };

    const deltas = Array.from({ length: 50 }, (_, i) => ({
      events: [
        {
          id: `live-${i}`,
          sessionId: "s",
          type: "message.delta" as const,
          message: "tok",
          payload: {},
          createdAt: new Date(2026, 0, 1, 1, 0, i).toISOString(),
          rowCursor: 10_000 + i,
        },
      ],
    }));
    expect(medianMs(50, (i) => mergeDashboardDelta(base, deltas[i]))).toBeLessThan(2.5);
  });

  it("an empty poll against a 5 000-event snapshot stays median < 0.01 ms", () => {
    const base: DashboardSnapshot = {
      ...emptySnapshot,
      events: Array.from({ length: 5_000 }, (_, i): TimelineEvent => ({
        id: `idle-${4_999 - i}`,
        sessionId: "s",
        type: "command.started",
        message: "",
        payload: {},
        createdAt: new Date(2026, 0, 1, 0, 0, 4_999 - i).toISOString(),
        rowCursor: 5_000 - i,
      })),
    };
    expect(
      medianMs(100, () => mergeDashboardDelta(base, { events: [], rawOutputs: [] })),
    ).toBeLessThan(0.01);
  });

  it("buildSessionToolCalls across capped tool and progress rows stays median < 20 ms", () => {
    const createdAt = new Date(2026, 0, 1).toISOString();
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 4_000; i++) {
      events.push({
        id: `progress-${i}`,
        sessionId: "s",
        type: "message.delta",
        message: `Checked ${i}`,
        payload: {},
        createdAt,
        rowCursor: i + 1,
      });
    }
    for (let i = 0; i < 2_000; i++) {
      events.push({
        id: `tool-${i}`,
        sessionId: "s",
        type: "command.started",
        message: "",
        payload: { name: "Read", tool_use_id: `tool-${i}`, input: { path: `src/${i}.ts` } },
        createdAt,
        rowCursor: 4_001 + i,
      });
    }
    events.reverse();

    expect(buildSessionToolCalls(events)).toHaveLength(2_000);
    // Local median sits near 4 ms.
    expect(medianMs(20, () => buildSessionToolCalls(events))).toBeLessThan(20);
  });

  it("buildFileTree over 10 000 entries completes median < 30 ms", () => {
    const entries: Parameters<typeof buildFileTree>[0] = [];
    for (let dir = 0; dir < 100; dir++) {
      for (let file = 0; file < 100; file++) {
        entries.push({ path: `pkg-${dir}/sub-${dir}/file-${file}.ts` });
      }
    }
    expect(entries).toHaveLength(10_000);

    expect(buildFileTree(entries).children).toHaveLength(100);
    expect(medianMs(5, () => buildFileTree(entries))).toBeLessThan(30);
  });

  it("searchFilePaths over 10 000 entries completes median < 1 ms", () => {
    const paths = Array.from({ length: 10_000 }, (_, i) =>
      i === 9_500
        ? "src/renderer/components/NeedlePanel.tsx"
        : `packages/pkg-${i}/src/file-${i}.ts`,
    );

    expect(searchFilePaths(paths, "Needle", 8)[0]).toBe("src/renderer/components/NeedlePanel.tsx");
    expect(medianMs(50, () => searchFilePaths(paths, "Needle", 8))).toBeLessThan(1);
  });

  it("parseUnifiedDiff over a 500-hunk synthetic diff completes median < 3.5 ms", () => {
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
          else if (line % 7 === 0)
            sections.push(`-removed line ${line} in hunk ${hunk} file ${file}`);
          else sections.push(` context line ${line} in hunk ${hunk} file ${file}`);
        }
      }
    }
    const diff = sections.join("\n");

    expect(medianMs(20, () => parseUnifiedDiff(diff))).toBeLessThan(3.5);
  });
});
