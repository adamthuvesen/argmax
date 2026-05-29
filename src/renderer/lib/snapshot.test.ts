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
});
