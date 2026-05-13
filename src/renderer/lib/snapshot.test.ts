// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../shared/types.js";
import { pruneSupersededDeltas } from "./snapshot.js";

function event(id: string, type: TimelineEvent["type"], createdAt: string): TimelineEvent {
  return { id, sessionId: "session-1", type, message: "", payload: {}, createdAt };
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
});
