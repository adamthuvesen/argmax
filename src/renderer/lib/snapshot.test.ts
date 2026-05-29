// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { DashboardSnapshot, TimelineEvent } from "../../shared/types.js";
import { emptySnapshot, mergeDashboardDelta, pruneSupersededDeltas } from "./snapshot.js";

function event(
  id: string,
  type: TimelineEvent["type"],
  createdAt: string,
  rowCursor?: number
): TimelineEvent {
  return {
    id,
    sessionId: "session-1",
    type,
    message: "",
    payload: {},
    createdAt,
    ...(rowCursor !== undefined ? { rowCursor } : {})
  };
}

/**
 * audit-2026-05-11 / SPEC P1.12 — `pruneSupersededDeltas` previously
 * always returned a new array. Downstream identity checks (notably
 * `mergeDashboardDelta`) treated that as a real change and forced a
 * snapshot rebuild + re-render per streamed event. The fix returns the
 * input reference when nothing was pruned.
 */
describe("pruneSupersededDeltas — reference stability", () => {
  it("returns the same array reference when there is nothing to prune", () => {
    const events = [
      event("e1", "user.message", "2026-05-12T15:00:00.000Z"),
      event("e2", "message.completed", "2026-05-12T15:00:01.000Z")
    ];
    expect(pruneSupersededDeltas(events)).toBe(events);
  });

  it("returns the same array reference for a single-event input", () => {
    const events = [event("e1", "message.delta", "2026-05-12T15:00:00.000Z")];
    expect(pruneSupersededDeltas(events)).toBe(events);
  });

  it("returns the same array reference when a delta exists but is not superseded yet", () => {
    // Mid-stream: deltas are still arriving, no completion has landed.
    const events = [
      event("e1", "user.message", "2026-05-12T15:00:00.000Z"),
      event("e2", "message.delta", "2026-05-12T15:00:01.000Z"),
      event("e3", "message.delta", "2026-05-12T15:00:02.000Z")
    ];
    expect(pruneSupersededDeltas(events)).toBe(events);
  });

  it("returns a new array (different reference) and drops the superseded deltas", () => {
    const events = [
      event("e1", "user.message", "2026-05-12T15:00:00.000Z"),
      event("e2", "message.delta", "2026-05-12T15:00:01.000Z"),
      event("e3", "message.delta", "2026-05-12T15:00:02.000Z"),
      event("e4", "message.completed", "2026-05-12T15:00:03.000Z")
    ];
    const result = pruneSupersededDeltas(events);
    expect(result).not.toBe(events);
    // user.message + message.completed kept; both message.delta dropped.
    expect(result.map((e) => e.id)).toEqual(["e1", "e4"]);
  });

  it("keeps thinking-flagged message.delta even when a message.completed follows", () => {
    // Claude extended-thinking content is surfaced by the normalizer as
    // a message.delta with payload.thinking === true. The pruner used to
    // drop these the moment the final text answer arrived, leaving the
    // user with no record of the reasoning step. Regression for
    // adam/rust-port streaming-feedback fix.
    const events: TimelineEvent[] = [
      event("e1", "user.message", "2026-05-12T15:00:00.000Z"),
      {
        ...event("e2", "message.delta", "2026-05-12T15:00:01.000Z"),
        payload: { thinking: true }
      },
      event("e3", "message.completed", "2026-05-12T15:00:02.000Z")
    ];
    const result = pruneSupersededDeltas(events);
    expect(result.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  // -------------------------------------------------------------------------
  // audit-2026-05-11 / SPEC P4.06 — mergeDashboardDelta reference stability
  // -------------------------------------------------------------------------

  it("mergeDashboardDelta returns the same snapshot reference for an empty delta", () => {
    const base: DashboardSnapshot = {
      ...emptySnapshot,
      projects: [
        {
          id: "p-1",
          name: "Argmax",
          repoPath: "/tmp/argmax",
          currentBranch: "main",
          defaultBranch: "main",
          settings: {
            defaultProvider: "codex",
            defaultModelLabel: "GPT-5.3 Codex",
            worktreeLocation: "/tmp",
            setupCommand: "",
            checkCommands: []
          },
          counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
          latestActivityAt: "2026-05-12T00:00:00.000Z"
        }
      ]
    };
    expect(mergeDashboardDelta(base, {})).toBe(base);
  });

  it("mergeDashboardDelta returns the same reference when a delta only re-sends already-known events", () => {
    const ev = event("e1", "user.message", "2026-05-12T15:00:00.000Z");
    const base: DashboardSnapshot = { ...emptySnapshot, events: [ev] };
    // Same identity → upsertById returns the same array → mergeSlice returns it
    // → mergeDashboardDelta short-circuits to the input snapshot.
    expect(mergeDashboardDelta(base, { events: [ev] })).toBe(base);
  });

  it("mergeDashboardDelta returns a new reference when any slice actually changes", () => {
    const base: DashboardSnapshot = { ...emptySnapshot };
    const next = mergeDashboardDelta(base, {
      events: [event("e1", "user.message", "2026-05-12T15:00:00.000Z")]
    });
    expect(next).not.toBe(base);
    expect(next.events).toHaveLength(1);
  });

  it("preserves descending input order on a pruning pass", () => {
    // The renderer keeps events sorted descending by createdAt. The function
    // detects that and emits the result in the same order.
    const events = [
      event("e4", "message.completed", "2026-05-12T15:00:03.000Z"),
      event("e3", "message.delta", "2026-05-12T15:00:02.000Z"),
      event("e2", "message.delta", "2026-05-12T15:00:01.000Z"),
      event("e1", "user.message", "2026-05-12T15:00:00.000Z")
    ];
    const result = pruneSupersededDeltas(events);
    expect(result).not.toBe(events);
    expect(result.map((e) => e.id)).toEqual(["e4", "e1"]);
  });

  it("sorts same-timestamp events by row cursor so streaming chunks display in insert order", () => {
    const createdAt = "2026-05-12T15:00:01.000Z";
    const base: DashboardSnapshot = { ...emptySnapshot };
    const next = mergeDashboardDelta(base, {
      events: [
        event("e1", "message.delta", createdAt, 1),
        event("e2", "message.delta", createdAt, 2),
        event("e3", "message.delta", createdAt, 3)
      ]
    });

    expect(next.events.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect([...next.events].reverse().map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("prunes same-timestamp deltas when row cursor shows a later completed event", () => {
    const createdAt = "2026-05-12T15:00:01.000Z";
    const events = [
      event("e4", "message.completed", createdAt, 4),
      event("e3", "message.delta", createdAt, 3),
      event("e2", "message.delta", createdAt, 2),
      event("e1", "user.message", createdAt, 1)
    ];

    const result = pruneSupersededDeltas(events);
    expect(result).not.toBe(events);
    expect(result.map((e) => e.id)).toEqual(["e4", "e1"]);
  });

  // -------------------------------------------------------------------------
  // Token-streaming: a flood of answer deltas must not evict tool/user rows
  // -------------------------------------------------------------------------

  it("keeps user.message and tool rows when a long in-flight answer floods deltas", () => {
    const base: DashboardSnapshot = {
      ...emptySnapshot,
      events: [
        event("u1", "user.message", "2026-05-12T15:00:00.000Z", 1),
        event("c1", "command.started", "2026-05-12T15:00:01.000Z", 2),
        event("c2", "command.completed", "2026-05-12T15:00:02.000Z", 3)
      ]
    };
    // 600 in-flight answer deltas (no completion yet → not prunable). Naive
    // newest-500 capping would push u1/c1/c2 (oldest) out and flicker them.
    const deltas: TimelineEvent[] = Array.from({ length: 600 }, (_, i) =>
      event(`d${i}`, "message.delta", "2026-05-12T15:01:00.000Z", 100 + i)
    );
    const merged = mergeDashboardDelta(base, { events: deltas });
    const ids = new Set(merged.events.map((e) => e.id));
    expect(ids.has("u1")).toBe(true);
    expect(ids.has("c1")).toBe(true);
    expect(ids.has("c2")).toBe(true);
    // The newest 500 answer deltas survive; the oldest 100 are evicted.
    expect(ids.has("d599")).toBe(true);
    expect(ids.has("d0")).toBe(false);
  });

  it("prunes the answer deltas once the turn completes, keeping tool rows", () => {
    const deltas: TimelineEvent[] = Array.from({ length: 500 }, (_, i) =>
      event(`d${i}`, "message.delta", "2026-05-12T15:01:00.000Z", 100 + i)
    );
    const base: DashboardSnapshot = {
      ...emptySnapshot,
      events: [
        event("u1", "user.message", "2026-05-12T15:00:00.000Z", 1),
        event("c1", "command.started", "2026-05-12T15:00:01.000Z", 2),
        ...deltas
      ]
    };
    const merged = mergeDashboardDelta(base, {
      events: [event("done", "message.completed", "2026-05-12T15:02:00.000Z", 9999)]
    });
    const ids = merged.events.map((e) => e.id);
    expect(ids).toContain("u1");
    expect(ids).toContain("c1");
    expect(ids).toContain("done");
    // The 500 answer deltas (ids d0..d499) are superseded by the completion.
    expect(ids.filter((id) => /^d\d/.test(id))).toHaveLength(0);
  });

  it("keeps thinking deltas protected from eviction by a long answer", () => {
    const base: DashboardSnapshot = {
      ...emptySnapshot,
      events: [
        {
          ...event("t1", "message.delta", "2026-05-12T15:00:00.000Z", 5),
          payload: { thinking: true }
        }
      ]
    };
    const deltas: TimelineEvent[] = Array.from({ length: 600 }, (_, i) =>
      event(`d${i}`, "message.delta", "2026-05-12T15:01:00.000Z", 100 + i)
    );
    const merged = mergeDashboardDelta(base, { events: deltas });
    expect(merged.events.some((e) => e.id === "t1")).toBe(true);
  });
});
